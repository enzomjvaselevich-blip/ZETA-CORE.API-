// Panel de administracion (/admin) y utilidades publicas (/ping, /fondo).
// Seguridad sin costo: contrasena por env var ADMIN_PASSWORD, comparacion
// timing-safe, token de sesion HMAC-SHA256, cookie HttpOnly/Secure/SameSite=Strict,
// rate limit de login (5 fallos/min) y validacion estricta del fondo (solo pinimg.com).
// Persistencia gratis con Upstash Redis si esta configurado; fallback en memoria.
const crypto=require('node:crypto');
const { Redis }=require('@upstash/redis');

const COOKIE_NAME='zeta_admin';
const SALSA_SESION='zeta-core-admin|v1';
const DURACION_SESION_MS=12*60*60*1000;
const TTL_VISITA_MS=90*1000;
const MAX_INTENTOS=5;
const CLAVE_FONDO='zeta:admin:fondo';
const CLAVE_ONLINE='zeta:admin:online';
const CLAVE_TOTAL='zeta:admin:visitas_total';

let redis=null;
let redisIntentado=false;
function getRedis(){
if(redisIntentado)return redis;
redisIntentado=true;
const url=process.env.KV_REST_API_URL||process.env.UPSTASH_REDIS_REST_URL;
const token=process.env.KV_REST_API_TOKEN||process.env.UPSTASH_REDIS_REST_TOKEN;
if(url&&token){
try{redis=new Redis({url,token});}catch(e){redis=null;}
}
return redis;
}

const estado={
fondo:'',
fondoCargado:false,
fondoPersistente:false,
visitantes:new Map(),
totalMemoria:0,
intentos:new Map(),
};

function contrasenaAdmin(){
return String(process.env.ADMIN_PASSWORD||process.env.admin_password||'');
}

function hashTexto(texto){
return crypto.createHash('sha256').update(String(texto)).digest();
}

function comparacionSegura(a,b){
const ha=hashTexto(a);
const hb=hashTexto(b);
return ha.length===hb.length&&crypto.timingSafeEqual(ha,hb);
}

function claveSesion(){
return hashTexto(contrasenaAdmin()+'|'+SALSA_SESION);
}

function firmarToken(caducidadMs){
const payload=caducidadMs.toString(36);
const firma=crypto.createHmac('sha256',claveSesion()).update(payload).digest('base64url');
return payload+'.'+firma;
}

function verificarToken(token){
const pass=contrasenaAdmin();
if(!pass||!token||typeof token!=='string')return false;
const partes=token.split('.');
if(partes.length!==2)return false;
const [payload,firma]=partes;
if(!/^[a-z0-9]+$/.test(payload))return false;
const esperada=crypto.createHmac('sha256',claveSesion()).update(payload).digest('base64url');
const a=Buffer.from(firma);
const b=Buffer.from(esperada);
if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return false;
const caducidad=parseInt(payload,36);
return Number.isFinite(caducidad)&&caducidad>Date.now();
}

function obtenerCookie(req,nombre){
const crudo=req.headers.cookie||'';
for(const parte of crudo.split(';')){
const i=parte.indexOf('=');
if(i<0)continue;
if(parte.slice(0,i).trim()===nombre)return decodeURIComponent(parte.slice(i+1).trim());
}
return '';
}

function sesionValida(req){
return verificarToken(obtenerCookie(req,COOKIE_NAME));
}

function ipDe(req){
const fwd=req.headers['x-vercel-forwarded-for']||req.headers['x-forwarded-for'];
const candidato=Array.isArray(fwd)?fwd[0]:String(fwd||'').split(',')[0];
const ip=(candidato||'').trim()||req.socket?.remoteAddress||'desconocida';
return ip.replace(/[^a-zA-Z0-9:.]/g,'').slice(0,64)||'desconocida';
}

function origenValido(req){
const origen=req.headers.origin;
if(!origen)return true;
try{
return new URL(origen).host===(req.headers.host||'');
}catch(e){return false;}
}

function leerCuerpo(req,maxBytes=10240){
return new Promise((resolver)=>{
let datos='';
let excedido=false;
req.on('data',(chunk)=>{
datos+=chunk;
if(datos.length>maxBytes){excedido=true;try{req.destroy();}catch(e){}}
});
req.on('end',()=>resolver(excedido?null:datos));
req.on('error',()=>resolver(null));
});
}

function parsearJson(crudo){
try{return JSON.parse(crudo||'{}');}catch(e){return null;}
}

function registrarIntentoLocal(ip){
const ahora=Date.now();
const lista=(estado.intentos.get(ip)||[]).filter(t=>ahora-t<60000);
lista.push(ahora);
estado.intentos.set(ip,lista);
if(estado.intentos.size>500){
for(const [k,v] of estado.intentos){if(v.every(t=>ahora-t>=60000))estado.intentos.delete(k);}
}
}

function intentosLocales(ip){
const ahora=Date.now();
return (estado.intentos.get(ip)||[]).filter(t=>ahora-t<60000).length;
}

async function intentosFallidos(ip){
let total=intentosLocales(ip);
const r=getRedis();
if(r){
try{
const n=await r.get('zeta:admin:intentos:'+ip);
total=Math.max(total,Number(n)||0);
}catch(e){}
}
return total;
}

async function anotarIntentoFallido(ip){
registrarIntentoLocal(ip);
const r=getRedis();
if(r){
try{
const n=await r.incr('zeta:admin:intentos:'+ip);
if(n===1)await r.expire('zeta:admin:intentos:'+ip,60);
}catch(e){}
}
}

async function limpiarIntentos(ip){
estado.intentos.delete(ip);
const r=getRedis();
if(r){try{await r.del('zeta:admin:intentos:'+ip);}catch(e){}}
}

function urlFondoValida(crudo){
const u=(crudo||'').trim();
if(!u)return {ok:false,motivo:'Falta el enlace de la imagen.'};
if(u.length>600)return {ok:false,motivo:'El enlace es demasiado largo.'};
let url;
try{url=new URL(u);}catch(e){return {ok:false,motivo:'El enlace no es una URL valida.'};}
if(url.protocol!=='https:')return {ok:false,motivo:'El enlace debe empezar con https://'};
const host=url.hostname.toLowerCase();
const esPin=host==='i.pinimg.com'||host==='pinimg.com'||host.endsWith('.pinimg.com');
if(!esPin)return {ok:false,motivo:'Solo se aceptan imagenes de Pinterest (pinimg.com).'};
if(!/\.(jpe?g|png|webp|gif)(\?|$)/i.test(url.pathname))return {ok:false,motivo:'El enlace debe apuntar a una imagen (.jpg, .png, .webp o .gif).'};
return {ok:true,url:url.href};
}

async function resolverEnlaceFondo(crudo){
const u=(crudo||'').trim();
if(/^https:\/\/(i\.)?pin\.it\//i.test(u)){
// Los links cortos pin.it redirigen a la imagen real de i.pinimg.com.
try{
const r=await fetch(u,{redirect:'follow',signal:AbortSignal.timeout(8000),headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36'}});
try{await r.body?.cancel();}catch(e){}
if(r.url)return urlFondoValida(r.url);
}catch(e){}
return {ok:false,motivo:'No se pudo resolver el link corto de pin.it. Pega el enlace directo de i.pinimg.com.'};
}
return urlFondoValida(u);
}

async function cargarFondo(){
if(estado.fondoCargado)return estado.fondo;
estado.fondoCargado=true;
const r=getRedis();
if(r){
try{
const v=await r.get(CLAVE_FONDO);
if(typeof v==='string'&&v.startsWith('https://')){
estado.fondo=v;
estado.fondoPersistente=true;
}
}catch(e){}
}
return estado.fondo;
}

async function guardarFondo(url){
estado.fondo=url;
estado.fondoPersistente=!!getRedis();
const r=getRedis();
if(r){
try{
if(url)await r.set(CLAVE_FONDO,url);
else await r.del(CLAVE_FONDO);
}catch(e){}
}
return estado.fondoPersistente;
}

function hashVisitante(crudo){
return crypto.createHash('sha256').update(String(crudo||'').slice(0,128)+'|zeta-v1').digest('hex').slice(0,10);
}

async function registrarVisita(idHash){
const ahora=Date.now();
estado.visitantes.set(idHash,ahora);
estado.totalMemoria+=1;
if(estado.visitantes.size>1000){
for(const [k,t] of estado.visitantes){if(ahora-t>TTL_VISITA_MS)estado.visitantes.delete(k);}
}
const r=getRedis();
if(r){
try{
await r.zadd(CLAVE_ONLINE,{score:ahora,member:idHash});
await r.incr(CLAVE_TOTAL);
}catch(e){}
}
}

async function instantaneaVisitas(){
const ahora=Date.now();
const r=getRedis();
if(r){
try{
await r.zremrangebyscore(CLAVE_ONLINE,'-inf',ahora-TTL_VISITA_MS);
const miembros=await r.zrange(CLAVE_ONLINE,ahora-TTL_VISITA_MS,'+inf',{byScore:true});
const total=await r.get(CLAVE_TOTAL);
const lista=(Array.isArray(miembros)?miembros:[]).slice(-50).reverse();
return {online:(Array.isArray(miembros)?miembros:[]).length,lista,total:Number(total)||0,fuente:'redis'};
}catch(e){}
}
const lista=[];
for(const [id,t] of estado.visitantes){
if(ahora-t<=TTL_VISITA_MS)lista.push({id,hace:Math.round((ahora-t)/1000)});
else estado.visitantes.delete(id);
}
lista.sort((a,b)=>a.hace-b.hace);
return {online:lista.length,lista:lista.slice(0,50),total:estado.totalMemoria,fuente:'memoria'};
}

function enviarHtml(res,status,html,extraHeaders={}){
res.statusCode=status;
res.setHeader('Content-Type','text/html; charset=utf-8');
res.setHeader('Cache-Control','no-store');
for(const [k,v] of Object.entries(extraHeaders))res.setHeader(k,v);
return res.end(html);
}

function estiloComun(){
return `@property --ang{syntax:'<angle>';initial-value:0deg;inherits:false}
:root{--bg:#05070d;--panel:rgba(13,17,28,.88);--panel2:#0d1119;--borde:#1d2536;--texto:#e8ecf6;--tenue:#8b93a7;--a1:#7c3aed;--a2:#06b6d4;--a3:#f472b6}
*{box-sizing:border-box}html,body{margin:0}
body{background:var(--bg);color:var(--texto);font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;min-height:100vh}
#aurora{position:fixed;inset:-20%;z-index:-3;background:radial-gradient(42% 42% at 18% 18%,rgba(124,58,237,.16),transparent 62%),radial-gradient(38% 38% at 82% 26%,rgba(6,182,212,.13),transparent 62%),radial-gradient(32% 32% at 50% 88%,rgba(244,114,182,.10),transparent 62%);animation:deriva 26s ease-in-out infinite alternate}
@keyframes deriva{from{transform:translate3d(0,0,0) scale(1)}to{transform:translate3d(2%,3%,0) scale(1.06)}}
.rgb{border:1px solid transparent;border-radius:18px;background:linear-gradient(var(--panel),var(--panel)) padding-box,conic-gradient(from var(--ang),var(--a1),var(--a2),var(--a3),var(--a1)) border-box;animation:girar 9s linear infinite}
@keyframes girar{to{--ang:360deg}}
@supports not (background:conic-gradient(from var(--ang),red,blue)){.rgb{border-color:var(--borde);background:var(--panel)}}
.wrap{max-width:900px;margin:0 auto;padding:24px 18px 60px}
.logo{font-size:20px;font-weight:800;letter-spacing:.5px}
.logo b{background:linear-gradient(90deg,#a78bfa,#22d3ee,#f472b6,#a78bfa);background-size:300% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:brillo 7s linear infinite}
@keyframes brillo{to{background-position:300% 0}}
h1{font-size:26px;margin:0 0 6px}
h2{font-size:13px;text-transform:uppercase;letter-spacing:2px;color:var(--tenue);margin:0 0 14px}
.card{background:var(--panel);border:1px solid var(--borde);border-radius:18px;padding:24px;margin-bottom:18px}
.tenue{color:var(--tenue);font-size:13px;line-height:1.6}
label{display:block;font-size:11px;color:var(--tenue);margin:12px 0 5px;text-transform:uppercase;letter-spacing:1px}
input{width:100%;padding:11px 13px;border-radius:11px;border:1px solid var(--borde);background:var(--panel2);color:#fff;font-size:14px;outline:none;transition:.2s}
input:focus{border-color:#7c3aed;box-shadow:0 0 0 3px rgba(124,58,237,.18)}
button{padding:12px 18px;border-radius:11px;border:none;font-weight:800;font-size:14px;cursor:pointer;color:#fff;background:linear-gradient(90deg,var(--a1),var(--a2));box-shadow:0 4px 18px rgba(124,58,237,.30);transition:.2s}
button:hover{filter:brightness(1.12)}
button:disabled{opacity:.55;cursor:wait}
button.gris{background:var(--panel2);border:1px solid var(--borde);box-shadow:none;color:var(--tenue)}
.msg{margin-top:12px;font-size:13px;min-height:18px}
.ok{color:#4ade80}.err{color:#f87171}
.chips{display:flex;gap:8px;flex-wrap:wrap}
.chip{font-size:12px;color:#c7d0e6;background:var(--panel2);border:1px solid var(--borde);border-radius:999px;padding:6px 12px}
.chip b{color:#fff}
.chip.v{border-color:rgba(74,222,128,.4);background:rgba(74,222,128,.08)}
.chip.r{border-color:rgba(248,113,113,.4);background:rgba(248,113,113,.08)}
.numeros{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:14px}
.num{background:var(--panel2);border:1px solid var(--borde);border-radius:14px;padding:16px;text-align:center}
.num .v{font-size:30px;font-weight:800;background:linear-gradient(90deg,#a78bfa,#22d3ee);-webkit-background-clip:text;background-clip:text;color:transparent}
.num .l{font-size:11px;color:var(--tenue);text-transform:uppercase;letter-spacing:1px;margin-top:4px}
table{width:100%;border-collapse:collapse;font-size:13px}
td,th{padding:8px 10px;border-bottom:1px solid var(--borde);text-align:left;color:var(--tenue)}
th{font-size:11px;text-transform:uppercase;letter-spacing:1px}
td{color:#c7d0e6}
header.pb{display:flex;justify-content:space-between;align-items:center;margin-bottom:22px;gap:10px;flex-wrap:wrap}
#prev{max-width:100%;max-height:180px;border-radius:12px;border:1px solid var(--borde);margin-top:12px;display:none}`;
}

function paginaLogin(advertencia){
return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Admin · ZETA-CORE API</title><style>${estiloComun()}
.centro{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:18px}
.login{max-width:400px;width:100%;padding:30px}</style></head><body>
<div id="aurora"></div>
<div class="centro"><div class="login rgb">
<div class="logo" style="margin-bottom:14px">ZETA<b>-CORE</b> <span style="color:var(--tenue);font-weight:600;font-size:14px">· Admin</span></div>
<h1>Panel privado</h1>
<p class="tenue">Acceso exclusivo del administrador. Sesión protegida con cookie firmada.</p>
${advertencia?`<div class="msg err">⚠️ Falta configurar la variable <b>ADMIN_PASSWORD</b> en Vercel (Settings → Environment Variables → Production) y hacer redeploy para poder entrar.</div>`:`
<label>Contraseña de administrador</label>
<input id="pw" type="password" placeholder="Tu contraseña" autocomplete="current-password">
<button id="go" style="width:100%;margin-top:16px">Entrar</button>
<div class="msg" id="m"></div>
<script>
const $=id=>document.getElementById(id);
async function entrar(){
$('go').disabled=true;$('m').className='msg';$('m').textContent='Verificando...';
try{
const r=await fetch('/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:$('pw').value})});
const j=await r.json().catch(()=>({}));
if(r.ok&&j.ok){location.reload();return}
$('m').className='msg err';$('m').textContent=j.message||('Error HTTP '+r.status);
}catch(e){$('m').className='msg err';$('m').textContent='Error de red: '+e}
$('go').disabled=false;
}
$('go').onclick=entrar;
$('pw').addEventListener('keydown',e=>{if(e.key==='Enter')entrar()});
</script>`}
</div></div></body></html>`;
}

function paginaPanel(){
return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Admin · ZETA-CORE API</title><style>${estiloComun()}</style></head><body>
<div id="aurora"></div>
<div class="wrap">
<header class="pb">
<div class="logo">ZETA<b>-CORE</b> <span style="color:var(--tenue);font-weight:600;font-size:14px">· Panel de Admin</span></div>
<div style="display:flex;gap:8px">
<a class="chip" href="/" style="text-decoration:none">Ver web</a>
<button class="gris" id="salir">Cerrar sesión</button>
</div>
</header>
<section class="card rgb">
<h2>Estado del servicio</h2>
<div class="chips" id="chips"><span class="chip">Cargando...</span></div>
</section>
<section class="card">
<h2>Usuarios y visitas</h2>
<div class="numeros">
<div class="num"><div class="v" id="nOnline">—</div><div class="l">Navegando ahora</div></div>
<div class="num"><div class="v" id="nTotal">—</div><div class="l">Visitas totales</div></div>
<div class="num"><div class="v" id="nFuente">—</div><div class="l">Almacenamiento</div></div>
</div>
<table><thead><tr><th>Visitante</th><th>Visto hace</th></tr></thead><tbody id="vis"><tr><td colspan="2">Sin visitantes registrados todavía.</td></tr></tbody></table>
</section>
<section class="card">
<h2>Fondo de la web</h2>
<p class="tenue">Pega un enlace de imagen de Pinterest (i.pinimg.com) o un link corto pin.it. Se aplica a toda la web con un velo oscuro para que el texto se siga leyendo.</p>
<label>Enlace de Pinterest</label>
<input id="furl" placeholder="https://i.pinimg.com/originals/...">
<img id="prev" alt="Vista previa del fondo">
<div style="display:flex;gap:10px;margin-top:14px;flex-wrap:wrap">
<button id="gf">Guardar fondo</button>
<button class="gris" id="qf">Quitar fondo</button>
</div>
<div class="msg" id="mf"></div>
</section>
<section class="card">
<h2>Seguridad</h2>
<p class="tenue">· Contraseña protegida con comparación timing-safe.<br>· Sesión firmada con HMAC-SHA256 y cookie HttpOnly + Secure + SameSite=Strict (12 h).<br>· Máximo 5 intentos de login fallidos por minuto por IP.<br>· El fondo solo acepta imágenes de pinimg.com.<br>· Los datos del panel (visitas, fondo) nadie más los puede leer ni cambiar.</p>
</section>
</div>
<script>
const $=id=>document.getElementById(id);
function chip(texto,clase){return '<span class="chip '+(clase||'')+'">'+texto+'</span>'}
async function cargarEstado(){
try{
const [rs,ra]=await Promise.all([fetch('/status'),fetch('/admin/stats')]);
const js=await rs.json().catch(()=>({}));
if(ra.status===401){location.reload();return}
const ja=await ra.json().catch(()=>({}));
const c=[];
c.push(chip('API '+(rs.ok&&js.ok?'en línea':'caída'),rs.ok&&js.ok?'v':'r'));
if(js.secureApi_cargada!==undefined)c.push(chip('Módulo secure-api: '+(js.secureApi_cargada?'OK':'ERROR'),js.secureApi_cargada?'v':'r'));
if(js.youtube_cookie_configurada!==undefined)c.push(chip('YOUTUBE_COOKIE: '+(js.youtube_cookie_configurada?'sí':'no'),js.youtube_cookie_configurada?'v':'r'));
if(js.dl_key_configurada!==undefined)c.push(chip('DL_KEY: '+(js.dl_key_configurada?'sí':'no'),js.dl_key_configurada?'v':'r'));
if(js.dl_proxy_configurada!==undefined)c.push(chip('DL_PROXY: '+(js.dl_proxy_configurada?'sí':'no')));
if(ja&&ja.ok){
$('nOnline').textContent=ja.visitas.online;
$('nTotal').textContent=ja.visitas.total;
$('nFuente').textContent=ja.visitas.fuente==='redis'?'Redis':'Memoria';
const filas=(ja.visitas.lista||[]).map(v=>'<tr><td>'+v.id+'</td><td>hace '+v.hace+' s</td></tr>').join('');
$('vis').innerHTML=filas||'<tr><td colspan="2">Sin visitantes activos en los últimos 90 s.</td></tr>';
if(ja.fondo&&ja.fondo.url){$('furl').value=ja.fondo.url;mostrarPrev(ja.fondo.url)}
}
$('chips').innerHTML=c.join('');
}catch(e){$('chips').innerHTML=chip('Error cargando estado','r')}
}
function mostrarPrev(url){
const p=$('prev');
if(url&&/pinimg\\.com/i.test(url)){p.src=url;p.style.display='block'}
else{p.style.display='none';p.removeAttribute('src')}
}
$('furl').addEventListener('input',()=>mostrarPrev($('furl').value.trim()));
async function guardarFondo(quitar){
$('gf').disabled=true;$('qf').disabled=true;
$('mf').className='msg';$('mf').textContent='Guardando...';
try{
const r=await fetch('/admin/fondo',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:quitar?'':$('furl').value.trim()})});
const j=await r.json().catch(()=>({}));
if(r.ok&&j.ok){
$('mf').className='msg ok';
$('mf').textContent=quitar?'Fondo quitado.':'Fondo guardado'+(j.persistente?' (persistente en Redis).':' (solo en memoria: configura Upstash Redis para que sobreviva entre despliegues).');
if(!quitar)mostrarPrev(j.url||'');
else{$('furl').value='';mostrarPrev('')}
}else{$('mf').className='msg err';$('mf').textContent=j.motivo||j.message||('Error HTTP '+r.status)}
}catch(e){$('mf').className='msg err';$('mf').textContent='Error de red: '+e}
$('gf').disabled=false;$('qf').disabled=false;
}
$('gf').onclick=()=>guardarFondo(false);
$('qf').onclick=()=>guardarFondo(true);
$('salir').onclick=async()=>{try{await fetch('/admin/logout',{method:'POST'})}catch(e){}location.reload()};
cargarEstado();setInterval(cargarEstado,10000);
</script></body></html>`;
}

async function manejar(req,res,pathname,parsedUrl,requestId,sendJson){
if(pathname==='/ping'){
if(req.method!=='GET'&&req.method!=='HEAD')return sendJson(405,{ok:false,message:'Metodo no permitido.'});
const bruto=parsedUrl.searchParams.get('v')||req.headers['x-zeta-vid']||'';
const idHash=hashVisitante(String(bruto).slice(0,128));
registrarVisita(idHash).catch(()=>{});
return sendJson(200,{ok:true});
}
if(pathname==='/fondo'){
if(req.method!=='GET'&&req.method!=='HEAD')return sendJson(405,{ok:false,message:'Metodo no permitido.'});
const url=await cargarFondo();
return sendJson(200,{ok:true,url:url||'',persistente:estado.fondoPersistente});
}
if(pathname==='/admin'||pathname==='/admin/'){
if(req.method!=='GET'&&req.method!=='HEAD')return sendJson(405,{ok:false,message:'Metodo no permitido.'});
if(!contrasenaAdmin())return enviarHtml(res,200,paginaLogin(true));
if(sesionValida(req))return enviarHtml(res,200,paginaPanel());
return enviarHtml(res,200,paginaLogin(false));
}
if(pathname==='/admin/login'){
if(req.method!=='POST')return sendJson(405,{ok:false,message:'Metodo no permitido. Usa POST.'});
if(!origenValido(req))return sendJson(403,{ok:false,message:'Origen no permitido.'});
const pass=contrasenaAdmin();
if(!pass)return sendJson(503,{ok:false,message:'El panel no esta activo: configura la variable ADMIN_PASSWORD en Vercel y haz redeploy.'});
const ip=ipDe(req);
const fallidos=await intentosFallidos(ip);
if(fallidos>=MAX_INTENTOS)return sendJson(429,{ok:false,message:'Demasiados intentos fallidos. Espera un minuto y vuelve a probar.'});
const cuerpo=parsearJson(await leerCuerpo(req));
const password=String(cuerpo&&cuerpo.password||'');
if(!password||!comparacionSegura(password,pass)){
await anotarIntentoFallido(ip);
return sendJson(401,{ok:false,message:'Contraseña incorrecta.'+(MAX_INTENTOS-fallidos-1<=0?'':' Intentos restantes: '+(MAX_INTENTOS-fallidos-1)+'.')});
}
await limpiarIntentos(ip);
const caducidad=Date.now()+DURACION_SESION_MS;
return enviarHtml(res,200,JSON.stringify({ok:true,caducidad}),{'Content-Type':'application/json; charset=utf-8','Set-Cookie':COOKIE_NAME+'='+firmarToken(caducidad)+'; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age='+Math.floor(DURACION_SESION_MS/1000)});
}
if(pathname==='/admin/logout'){
if(req.method!=='POST')return sendJson(405,{ok:false,message:'Metodo no permitido. Usa POST.'});
return enviarHtml(res,200,JSON.stringify({ok:true}),{'Content-Type':'application/json; charset=utf-8','Set-Cookie':COOKIE_NAME+'=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0'});
}
if(pathname==='/admin/fondo'){
if(req.method!=='POST')return sendJson(405,{ok:false,message:'Metodo no permitido. Usa POST.'});
if(!origenValido(req))return sendJson(403,{ok:false,message:'Origen no permitido.'});
if(!contrasenaAdmin())return sendJson(503,{ok:false,message:'El panel no esta activo: configura ADMIN_PASSWORD en Vercel.'});
if(!sesionValida(req))return sendJson(401,{ok:false,message:'Sesion expirada o invalida. Vuelve a iniciar sesion.'});
const cuerpo=parsearJson(await leerCuerpo(req));
const crudo=String(cuerpo&&typeof cuerpo.url==='string'?cuerpo.url:'').trim();
if(!crudo){
await guardarFondo('');
return sendJson(200,{ok:true,url:'',persistente:estado.fondoPersistente,message:'Fondo quitado.'});
}
const validacion=await resolverEnlaceFondo(crudo);
if(!validacion.ok)return sendJson(400,{ok:false,motivo:validacion.motivo});
const persistente=await guardarFondo(validacion.url);
return sendJson(200,{ok:true,url:validacion.url,persistente});
}
if(pathname==='/admin/stats'){
if(req.method!=='GET'&&req.method!=='HEAD')return sendJson(405,{ok:false,message:'Metodo no permitido.'});
if(!contrasenaAdmin())return sendJson(503,{ok:false,message:'El panel no esta activo: configura ADMIN_PASSWORD en Vercel.'});
if(!sesionValida(req))return sendJson(401,{ok:false,message:'Sesion expirada o invalida. Vuelve a iniciar sesion.'});
const visitas=await instantaneaVisitas();
const fondo=await cargarFondo();
const mem=process.memoryUsage();
return sendJson(200,{
ok:true,
visitas:{online:visitas.online,total:visitas.total,fuente:visitas.fuente,lista:visitas.lista},
fondo:{url:fondo,persistente:estado.fondoPersistente},
redis_disponible:!!getRedis(),
admin_password_configurada:!!contrasenaAdmin(),
uptime_segundos:Math.round(process.uptime()),
memoria_mb:Math.round((mem.heapUsed/1048576)*10)/10,
});
}
return sendJson(404,{ok:false,message:'Ruta de administracion no encontrada.'});
}

module.exports={manejar};
