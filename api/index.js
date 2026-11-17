const { URL }=require('url');
const { randomUUID }=require('node:crypto');
const http=require('node:http');
const https=require('node:https');
const tls=require('node:tls');
// Carga blindada: si secure-api falla al cargarse en el runtime de Vercel
// (bundling/tracing), la funcion NO crashea en cold start; el error real se
// expone en /status y como JSON en las rutas que lo necesitan.
let secureApi=null;
let secureApiLoadError=null;
try{
secureApi=require('./secure-api');
}catch(e){
secureApiLoadError=e;
}
let adminApi=null;
let adminApiLoadError=null;
try{
adminApi=require('../lib/admin');
}catch(e){
adminApiLoadError=e;
}
const { paginaDocs }=require('../lib/paginas');
const VALID_QUALITY=/^(?:best|\d{3,4}p)$/;
const VALID_LIMIT=/^\d+$/;
const LIMIT_MIN=1;
const LIMIT_MAX=20;
const BROWSER_UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const DL_KINDS=['audio','video','tiktok','x','instagram','facebook'];
// Cache de la resolucion del player de YouTube para /dl: los enlaces de
// googlevideo duran ~6h; guardarlos 30 min evita re-resolver en cada pedido.
const dlMediaCache=new Map();
const IP_BLOCKED_MESSAGE='El hosting (Vercel) está bloqueado por YouTube/TikTok para descargas. La descarga debe hacerse desde una IP residencial.';

function parseDlProxy(raw){
try{
const u=new URL(raw);
if(u.protocol!=='http:'||!u.hostname)return null;
const auth=(u.username||u.password)?'Basic '+Buffer.from(decodeURIComponent(u.username)+':'+decodeURIComponent(u.password)).toString('base64'):null;
return {host:u.hostname,port:Number(u.port)||80,auth};
}catch(e){return null;}
}

function requestMediaViaProxy(proxy,targetUrl,headers){
return new Promise((resolve,reject)=>{
const target=new URL(targetUrl);
if(target.protocol!=='https:')return reject(new Error('El proxy de salida solo soporta destinos https.'));
const connectReq=http.request({
host:proxy.host,
port:proxy.port,
method:'CONNECT',
path:target.host+':443',
headers:{Host:target.host+':443',...(proxy.auth?{'Proxy-Authorization':proxy.auth}:{})},
timeout:15000,
});
connectReq.on('connect',(proxyRes,socket)=>{
if(proxyRes.statusCode!==200){
socket.destroy();
return reject(new Error('El proxy rechazo la conexion (HTTP '+proxyRes.statusCode+').'));
}
const tlsSocket=tls.connect({socket,servername:target.hostname});
tlsSocket.once('secureConnect',()=>{
const mediaReq=https.request(targetUrl,{
method:'GET',
headers,
agent:false,
createConnection:()=>tlsSocket,
},(mediaRes)=>resolve({mediaRes,cleanup:()=>{try{mediaReq.destroy();}catch(e){}try{tlsSocket.destroy();}catch(e){}}}));
mediaReq.on('error',(e)=>{try{tlsSocket.destroy();}catch(e2){}reject(e);});
mediaReq.end();
});
tlsSocket.once('error',(e)=>{try{socket.destroy();}catch(e2){}reject(e);});
});
connectReq.on('timeout',()=>connectReq.destroy(new Error('El proxy tardo demasiado en responder.')));
connectReq.on('error',(e)=>reject(e));
connectReq.end();
});
}

// Pedido HTTPS directo con node:https y agent:false: conexion nueva por
// pedido, sin el pool keep-alive de undici. Los CDN de Meta (lookaside de
// Facebook) contestan con su HTML de redirect cuando el pedido reutiliza una
// conexion donde la respuesta anterior se aborto.
function pedirHttps(targetUrl,headers,timeoutMs=10000){
return new Promise((resolve,reject)=>{
const pedido=https.request(targetUrl,{method:'GET',headers,agent:false},(respuesta)=>resolve(respuesta));
pedido.on('error',reject);
pedido.setTimeout(timeoutMs,()=>pedido.destroy(new Error('timeout de pedido')));
pedido.end();
});
}

// Transmite en streaming un archivo de media (googlevideo, tiktokcdn, twimg)
// desde la misma invocacion de la funcion, para que la IP coincida con la que
// genero la URL firmada. Pasa el header Range del cliente y copia los headers
// de respuesta relevantes (200 o 206).
async function streamMedia(req,res,sendJson,requestId,mediaUrl,options={}){
const fetchHeaders={
'User-Agent':BROWSER_UA,
'Accept':'*/*',
'Accept-Language':'es-ES,es;q=0.9,en;q=0.8',
};
if(options.referer)fetchHeaders.Referer=options.referer;
if(options.headers)Object.assign(fetchHeaders,options.headers);
const range=req.headers&&typeof req.headers.range==='string'&&req.headers.range.length<200?req.headers.range:'';
if(range)fetchHeaders.Range=range;
const ipBlocked=()=>sendJson(502,{ok:false,error:'IP_BLOQUEADA',message:options.mensajeBloqueo||IP_BLOCKED_MESSAGE});
const applyMediaHeaders=(status,contentType,extra={})=>{
res.statusCode=status;
res.setHeader('Content-Type',contentType||'application/octet-stream');
res.setHeader('Accept-Ranges',extra.acceptRanges||'bytes');
if(extra.contentLength)res.setHeader('Content-Length',extra.contentLength);
if(extra.contentRange)res.setHeader('Content-Range',extra.contentRange);
if(options.filename)res.setHeader('Content-Disposition','attachment; filename="'+String(options.filename).replace(/[^a-zA-Z0-9._-]/g,'_')+'"');
};
const proxyRaw=(process.env.DL_PROXY_URL||process.env.dl_proxy_url||'').trim();
const proxy=options.sinProxy?null:(proxyRaw?parseDlProxy(proxyRaw):null);
if(proxyRaw&&!proxy&&!options.sinProxy){
return sendJson(500,{ok:false,error:'PROXY_INVALIDO',message:'DL_PROXY_URL no es una URL de proxy valida. Formato esperado: http://usuario:pass@host:puerto'});
}
if(proxy){
let destino=mediaUrl;
let resultado=null;
try{
for(let salto=0;salto<4;salto+=1){
resultado=await requestMediaViaProxy(proxy,destino,{...fetchHeaders,Range:range||'bytes=0-0'});
const st=resultado.mediaRes.statusCode;
const loc=resultado.mediaRes.headers.location;
if([301,302,303,307,308].includes(st)&&loc){
resultado.cleanup();
destino=new URL(loc,destino).href;
continue;
}
break;
}
}catch(e){
return sendJson(502,{ok:false,message:'No se pudo descargar a traves del proxy de salida.',error:String(e&&e.message||e).slice(0,140)});
}
const up0=resultado.mediaRes;
if(up0.statusCode===403){
resultado.cleanup();
return ipBlocked();
}
if(up0.statusCode!==200&&up0.statusCode!==206){
const status=up0.statusCode;
resultado.cleanup();
return sendJson(502,{ok:false,message:'El servidor de medios rechazo la descarga (HTTP '+status+').'});
}
const totalCrudo=String(up0.headers['content-range']||'').match(/\/(\d+)\s*$/);
const total=totalCrudo?Number(totalCrudo[1]):0;
const porRangos=!range&&up0.statusCode===206&&total>1024*1024;
try{resultado.cleanup();}catch(e){}
if(porRangos){
// Descarga por rangos en paralelo: 6-8 tramos pedidos a la vez por el proxy
// (cada uno con su tunel CONNECT) y entregados al cliente EN ORDEN. Multiplica
// el throughput del proxy sin cambiar el contrato: el cliente recibe un 200
// con el archivo completo.
const partes=total>8*1024*1024?8:6;
const tam=Math.ceil(total/partes);
const tramos=[];
for(let i=0;i<partes;i+=1){
const desde=i*tam;
if(desde>total-1)break;
tramos.push({desde,hasta:Math.min(total-1,desde+tam-1)});
}
const limpiezas=tramos.map(()=>null);
const pedidos=tramos.map(({desde,hasta},i)=>new Promise((resolverParte)=>{
let cerrado=false;
const fin=(valor)=>{if(!cerrado){cerrado=true;clearTimeout(temporizador);resolverParte(valor);}};
const temporizador=setTimeout(()=>fin(null),40000);
let destinoParte=destino;
(async()=>{
try{
for(let salto=0;salto<4;salto+=1){
const parte=await requestMediaViaProxy(proxy,destinoParte,{...fetchHeaders,Range:'bytes='+desde+'-'+hasta});
limpiezas[i]=parte.cleanup;
const st=parte.mediaRes.statusCode;
const loc=parte.mediaRes.headers.location;
if([301,302,303,307,308].includes(st)&&loc&&salto<3){
parte.cleanup();
limpiezas[i]=null;
destinoParte=new URL(loc,destinoParte).href;
continue;
}
fin(parte);
return;
}
fin(null);
}catch(e){fin(null);}
})();
}));
const parte0=await pedidos[0];
if(!parte0||![200,206].includes(parte0.mediaRes.statusCode)){
for(const limpieza of limpiezas)try{limpieza&&limpieza();}catch(e){}
return sendJson(502,{ok:false,message:'El servidor de medios rechazo la descarga por rangos.'});
}
applyMediaHeaders(200,parte0.mediaRes.headers['content-type'],{acceptRanges:'bytes',contentLength:total});
res.on('close',()=>{for(const limpieza of limpiezas)try{limpieza&&limpieza();}catch(e){}});
for(let i=0;i<pedidos.length;i+=1){
const parte=i===0?parte0:await pedidos[i];
if(!parte||![200,206].includes(parte.mediaRes.statusCode)){
try{res.destroy();}catch(e){}
return;
}
const up=parte.mediaRes;
await new Promise((terminar,romper)=>{
up.on('data',(chunk)=>{
if(!res.write(chunk))up.pause();
});
res.on('drain',()=>up.resume());
up.on('end',terminar);
up.on('error',romper);
res.on('close',terminar);
});
try{parte.cleanup();}catch(e){}
limpiezas[i]=null;
}
res.end();
return;
}
let up=up0;
if(range||up0.statusCode===200){
try{
resultado.cleanup();
resultado=await requestMediaViaProxy(proxy,destino,fetchHeaders);
up=resultado.mediaRes;
if(up.statusCode===403){
resultado.cleanup();
return ipBlocked();
}
if(up.statusCode!==200&&up.statusCode!==206){
const status=up.statusCode;
resultado.cleanup();
return sendJson(502,{ok:false,message:'El servidor de medios rechazo la descarga (HTTP '+status+').'});
}
}catch(e){
return sendJson(502,{ok:false,message:'No se pudo descargar a traves del proxy de salida.',error:String(e&&e.message||e).slice(0,140)});
}
}
applyMediaHeaders(up.statusCode,up.headers['content-type'],{acceptRanges:up.headers['accept-ranges'],contentLength:up.headers['content-length'],contentRange:up.headers['content-range']});
res.on('close',resultado.cleanup);
up.on('data',(chunk)=>{
if(!res.write(chunk))up.pause();
});
res.on('drain',()=>up.resume());
up.on('end',()=>res.end());
up.on('error',()=>{try{res.destroy();}catch(e){}});
return;
}
if(options.exigirVideo){
// Stream por node:https con agent:false: misma conexion fresca que el probe;
// por undici (pool reutilizado) el lookaside de Facebook contesta HTML.
let destinoStream=mediaUrl;
let respuesta=null;
try{
for(let salto=0;salto<4;salto+=1){
respuesta=await pedirHttps(destinoStream,fetchHeaders);
const st=respuesta.statusCode;
const loc=respuesta.headers.location;
if([301,302,303,307,308].includes(st)&&loc){
respuesta.resume();
destinoStream=new URL(loc,destinoStream).href;
continue;
}
break;
}
}catch(e){
return sendJson(502,{ok:false,message:'No se pudo conectar con el servidor de medios.',error:String(e&&e.message||e).slice(0,140)});
}
const tipoStream=String(respuesta.headers['content-type']||'');
if(!tipoStream.includes('video')&&!tipoStream.includes('octet-stream')){
respuesta.resume();
return sendJson(404,{ok:false,error:'SIN_MEDIA_DESCARGABLE',message:'El servidor de medios respondio HTML en vez de video (ventana temporal de la plataforma). Reintenta en unos segundos.'});
}
if(respuesta.statusCode===403){
respuesta.resume();
return ipBlocked();
}
if(respuesta.statusCode!==200&&respuesta.statusCode!==206){
const status=respuesta.statusCode;
respuesta.resume();
return sendJson(502,{ok:false,message:'El servidor de medios rechazo la descarga (HTTP '+status+').'});
}
applyMediaHeaders(respuesta.statusCode,tipoStream,{acceptRanges:respuesta.headers['accept-ranges'],contentLength:respuesta.headers['content-length'],contentRange:respuesta.headers['content-range']});
res.on('close',()=>{try{respuesta.destroy();}catch(e){}});
respuesta.on('data',(chunk)=>{
if(!res.write(chunk))respuesta.pause();
});
res.on('drain',()=>respuesta.resume());
respuesta.on('end',()=>res.end());
respuesta.on('error',()=>{try{res.destroy();}catch(e){}});
return;
}
let upstream;
try{
upstream=await fetch(mediaUrl,{headers:fetchHeaders,redirect:'follow'});
}catch(e){
return sendJson(502,{ok:false,message:'No se pudo conectar con el servidor de medios.',error:String(e&&e.message||e).slice(0,140)});
}
if(upstream.status===403){
try{await upstream.body?.cancel();}catch(e){}
return ipBlocked();
}
if(!upstream.ok&&upstream.status!==206){
try{await upstream.body?.cancel();}catch(e){}
return sendJson(502,{ok:false,message:'El servidor de medios rechazo la descarga (HTTP '+upstream.status+').'});
}
applyMediaHeaders(upstream.status,upstream.headers.get('content-type'),{acceptRanges:upstream.headers.get('accept-ranges'),contentLength:upstream.headers.get('content-length'),contentRange:upstream.headers.get('content-range')});
try{
if(upstream.body&&typeof upstream.body.getReader==='function'){
const reader=upstream.body.getReader();
for(;;){
const chunk=await reader.read();
if(chunk.done)break;
if(!res.write(Buffer.from(chunk.value))){
await new Promise((resolve)=>res.once('drain',resolve));
}
}
res.end();
}else{
res.end(Buffer.from(await upstream.arrayBuffer()));
}
}catch(e){
try{res.destroy();}catch(e2){}
}
}

async function probeMedia(mediaUrl,headers,options={}){
const probeHeaders={...headers,Range:'bytes=0-0'};
const proxyRaw=(process.env.DL_PROXY_URL||process.env.dl_proxy_url||'').trim();
const proxy=options.sinProxy?null:(proxyRaw?parseDlProxy(proxyRaw):null);
if(proxy){
// googlevideo suele responder 302: hay que seguir el redirect dentro del
// mismo tunel, igual que hace streamMedia, para no descartar URLs validas.
let destino=mediaUrl;
try{
for(let salto=0;salto<4;salto+=1){
const {mediaRes,cleanup}=await requestMediaViaProxy(proxy,destino,probeHeaders);
const status=mediaRes.statusCode;
const loc=mediaRes.headers.location;
if([301,302,303,307,308].includes(status)&&loc){
cleanup();
destino=new URL(loc,destino).href;
continue;
}
cleanup();
return status;
}
return 0;
}catch(e){return 0;}
}
try{
const r=await fetch(mediaUrl,{headers:probeHeaders,redirect:'follow'});
try{await r.body?.cancel();}catch(e){}
return r.status;
}catch(e){return 0;}
}

// Probe directo (sin proxy) que ademas valida el content-type: los CDN de Meta
// a veces responden HTML (muro de login / lookaside) con status 200; transmitir
// eso al cliente seria entregar basura. OJO: el lookaside de Facebook responde
// HTML con Range bytes=0-0 pero video/mp4 con bytes=0-99, por eso 0-99.
// Usa node:https con agent:false (conexion nueva por pedido, sin el pool de
// undici): reutilizar la conexion del probe anterior hace que el lookaside
// conteste con su HTML de redirect. Devuelve {ok,status,tipo}.
async function probeMediaTipo(mediaUrl,headers){
const destino=new URL(mediaUrl);
if(destino.protocol!=='https:')return {ok:false,status:0,tipo:''};
try{
let respuesta=await pedirHttps(destino.href,{...headers,Range:'bytes=0-99'});
for(let salto=0;salto<4&&[301,302,303,307,308].includes(respuesta.statusCode)&&respuesta.headers.location;salto+=1){
respuesta.resume();
respuesta=await pedirHttps(new URL(respuesta.headers.location,destino).href,{...headers,Range:'bytes=0-99'});
}
const tipo=String(respuesta.headers['content-type']||'');
const ok=(respuesta.statusCode===200||respuesta.statusCode===206)&&(tipo.includes('video')||tipo.includes('octet-stream'));
respuesta.resume();
return {ok,status:respuesta.statusCode,tipo};
}catch(e){return {ok:false,status:0,tipo:''};}
}

module.exports=async function handler(req,res){
const requestId=randomUUID();
const sendJson=(status,payload)=>{
res.statusCode=status;
res.setHeader('Content-Type','application/json; charset=utf-8');
res.setHeader('X-Request-Id',requestId);
res.setHeader('Access-Control-Allow-Origin','*');
return res.end(JSON.stringify({...payload,requestId},null,2));
};
try{
const parsedUrl=new URL(req.url||'/',`https://${req.headers.host||'api.invalid'}`);
let pathname=parsedUrl.pathname.replace(/^\/api(?=\/|$)/,'');
if(!pathname)pathname='/';
if(pathname==='/favicon.ico')return res.end();
const esRutaAdmin=pathname==='/admin'||pathname.startsWith('/admin/')||pathname==='/ping'||pathname==='/fondo'||pathname==='/fondo-archivo'||pathname==='/musica'||pathname==='/musica-archivo';
if(req.method!=='GET'&&req.method!=='HEAD'&&!esRutaAdmin){
res.setHeader('Allow','GET, HEAD');
return sendJson(405,{ok:false,message:'Metodo no permitido. Usa GET o HEAD.'});
}
if(esRutaAdmin){
if(!adminApi){
return sendJson(500,{ok:false,code:'MODULE_LOAD_ERROR',message:'Error interno cargando el modulo de administracion.',error:String(adminApiLoadError&&adminApiLoadError.message||adminApiLoadError).slice(0,300)});
}
try{
return await adminApi.manejar(req,res,pathname,parsedUrl,requestId,sendJson);
}catch(e){
console.error(e);
return sendJson(500,{ok:false,message:'Error interno del panel de administracion.',error:String(e&&e.message||e).slice(0,200)});
}
}
if(pathname==='/'||pathname===''||pathname==='/docs'){
res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
return res.end(paginaDocs());
}
// Diagnostico de carga de modulos: si secure-api no cargo, las rutas que lo
// usan devuelven el error real en JSON en lugar de un 500 opaco de Vercel.
if(secureApiLoadError&&pathname!=='/'&&pathname!==''&&pathname!=='/docs'&&pathname!=='/status'){
return sendJson(500,{ok:false,code:'MODULE_LOAD_ERROR',message:'Error interno cargando un modulo de la API.',error:String(secureApiLoadError&&secureApiLoadError.message||secureApiLoadError).slice(0,300)});
}
const rawQuery=parsedUrl.searchParams.get('query')||parsedUrl.searchParams.get('url')||parsedUrl.searchParams.get('prompt')||'';
const query=rawQuery.trim();
const qualityParam=parsedUrl.searchParams.get('quality')||'best';
const limitParam=parsedUrl.searchParams.get('limit')||'5';
const isSearchRoute=['/ytsearch','/ttsearch'].includes(pathname);
if(!query&&['/ytmp3','/ytmp4','/youtube','/ytsearch','/tiktok','/ttsearch','/xvideo','/instagram','/facebook','/dl'].includes(pathname)){
return sendJson(400,{ok:false,message:'Falta el parametro query o url'});
}
if(!isSearchRoute&&pathname!=='/'&&!VALID_QUALITY.test(qualityParam)){
return sendJson(400,{ok:false,message:`Calidad invalida: "${qualityParam}". Usa best, 360p, 480p, 720p, 1080p, 1440p o 2160p.`});
}
let limit=Number(limitParam);
if(!VALID_LIMIT.test(limitParam)||limit<LIMIT_MIN||limit>LIMIT_MAX){
return sendJson(400,{ok:false,message:`Limite invalido: "${limitParam}". Usa un numero entre ${LIMIT_MIN} y ${LIMIT_MAX}.`});
}
if(pathname==='/dl'){
// Proteccion por clave: si DL_KEY esta definida, exigir ?key= o header x-api-key.
const dlKey=process.env.DL_KEY||'';
if(dlKey){
const provided=parsedUrl.searchParams.get('key')||(Array.isArray(req.headers['x-api-key'])?req.headers['x-api-key'][0]:req.headers['x-api-key'])||'';
if(provided!==dlKey){
return sendJson(401,{ok:false,message:'Clave invalida o ausente. Pasa ?key= o el header x-api-key.'});
}
}
const kind=(parsedUrl.searchParams.get('kind')||'video').toLowerCase();
if(!DL_KINDS.includes(kind)){
return sendJson(400,{ok:false,message:'Parametro kind invalido. Usa audio, video, tiktok, x, instagram o facebook.'});
}
if(kind==='tiktok'||kind==='x'){
const {extractTikTokVideo}=require('./documentos/tiktok');
const {fetchXVideo}=require('./documentos/xvideo');
let data;
try{
data=kind==='tiktok'?await extractTikTokVideo(query):await fetchXVideo(query);
}catch(e){
return sendJson(502,{ok:false,message:'No se pudo resolver el video solicitado.',error:String(e&&e.message||e).slice(0,140)});
}
const scrapeHeaders=kind==='tiktok'?(data?.descarga_headers||{}):{};
const referer=kind==='tiktok'?'https://www.tiktok.com/':'https://x.com/';
const extraerUrls=(d)=>kind==='tiktok'
?[d?.data?.links?.hd,d?.data?.links?.wm,d?.data?.links?.sd].filter(Boolean)
:(d?.best?[d.best]:[]);
let candidatos=extraerUrls(data);
if(!candidatos.length){
return sendJson(502,{ok:false,message:'No se encontro una URL de media descargable para ese enlace.'});
}
const dlDeadline=Date.now()+45000;
let reScrapeado=false;
for(let ronda=0;ronda<2;ronda+=1){
for(const mediaUrl of candidatos){
if(Date.now()>dlDeadline)break;
let probeStatus=await probeMedia(mediaUrl,{...scrapeHeaders,Referer:referer});
if(probeStatus===403&&kind==='x'){
probeStatus=await probeMedia(mediaUrl,scrapeHeaders);
}
if(probeStatus===200||probeStatus===206){
return streamMedia(req,res,sendJson,requestId,mediaUrl,{referer,headers:scrapeHeaders});
}
}
if(ronda===0&&kind==='tiktok'&&!reScrapeado&&Date.now()<dlDeadline){
try{
data=await extractTikTokVideo(query);
candidatos=extraerUrls(data);
reScrapeado=true;
}catch(e){break;}
}else break;
}
return sendJson(502,{ok:false,error:'IP_BLOQUEADA',message:'Ningun cliente pudo descargar desde este hosting.'});
}
// kind instagram|facebook: resuelve el media con el MISMO scraping de los
// endpoints /instagram y /facebook y streamea con el pipeline de rangos
// paralelos. Sin proxy: los CDN de Meta amarran la URL a la IP que la pidio
// (la de Vercel en el scraping de esta misma invocacion), asi que la descarga
// debe salir por la misma ruta directa.
if(kind==='instagram'||kind==='facebook'){
const {fetchInstagramVideo,headersDePeticion}=require('./documentos/instagram');
const {fetchFacebookVideo,headersDeDescarga}=require('./documentos/facebook');
const referer=kind==='instagram'?'https://www.instagram.com/':'https://www.facebook.com/';
const scrapeHeaders=kind==='instagram'?headersDePeticion():headersDeDescarga();
// Para descargar hay que usar el MISMO User-Agent (y cookie, si hay) del
// scraping: los CDN de Meta amarran la respuesta a como fue pedida y con otro
// UA devuelven HTML o 403.
const resolver=()=>kind==='instagram'?fetchInstagramVideo(query):fetchFacebookVideo(query);
let ultimoError=null;
const debugProbes=parsedUrl.searchParams.get('debug')==='1'?[]:null;
// Dos rondas: si los candidatos no pasan el probe (el lookaside de Facebook
// alterna entre servir el video y un HTML de redirect), re-scrapear una vez
// antes de fallar; la segunda vuelta suele exponer URLs de video.xx.fbcdn.net.
for(let ronda=0;ronda<2;ronda+=1){
if(ronda>0)await new Promise(r=>setTimeout(r,1500));
let data;
try{
data=await resolver();
}catch(e){
ultimoError=e;
break;
}
if(!data||data.tipo!=='video'||!data.descarga_directa){
return sendJson(404,{ok:false,error:'SIN_VIDEO',message:'El post no contiene un video descargable (es una imagen, es privado o la plataforma no expuso el archivo).'});
}
const candidatos=[data.descarga_directa,...(Array.isArray(data.candidatos)?data.candidatos:[])]
.filter((u,i,a)=>typeof u==='string'&&/^https?:\/\//.test(u)&&a.indexOf(u)===i);
for(const mediaUrl of candidatos){
// Mismos headers exactos que los probes internos del scraping (sin Referer
// extra): cualquier diferencia entre el probe y la descarga es una chance de
// que el CDN de Meta cambie la respuesta.
const probe=await probeMediaTipo(mediaUrl,scrapeHeaders);
if(debugProbes)debugProbes.push({ronda,url:mediaUrl.slice(0,70),status:probe.status,tipo:probe.tipo});
if(probe.ok){
return streamMedia(req,res,sendJson,requestId,mediaUrl,{sinProxy:true,headers:scrapeHeaders,exigirVideo:true,mensajeBloqueo:'El CDN de '+(kind==='instagram'?'Instagram':'Facebook')+' rechazo la descarga desde este hosting (HTTP 403).'});
}
}
}
if(ultimoError){
return sendJson(404,{ok:false,error:'SIN_MEDIA',message:String(ultimoError&&ultimoError.message||ultimoError).slice(0,200)});
}
return sendJson(404,debugProbes?{ok:false,error:'SIN_MEDIA_DESCARGABLE',message:'La plataforma expuso el video pero el archivo no responde como video descargable desde este hosting (puede requerir sesion iniciada).',probes:debugProbes}:{ok:false,error:'SIN_MEDIA_DESCARGABLE',message:'La plataforma expuso el video pero el archivo no responde como video descargable desde este hosting (puede requerir sesion iniciada).'});
}
// kind audio|video -> YouTube: prueba de 1 KB por candidato; solo transmite
// cuando la prueba responde 200/206. Orden: web (con cookies), web (sin
// cookies), WEB_EMBEDDED, TV_SIMPLY (TVHTML5_SIMPLY_EMBEDDED_PLAYER),
// ANDROID_VR, IOS, ANDROID, mweb.
let videoId=query;
const match=query.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|v\/|embed\/|shorts\/))([a-zA-Z0-9_-]{11})/);
if(match){
videoId=match[1];
}else if(!/^[a-zA-Z0-9_-]{11}$/.test(query)){
let Innertube;
try{
const mod=await import('youtubei.js');
Innertube=mod.Innertube;
}catch(e){
return sendJson(500,{ok:false,message:'Error interno: Modulo youtubei.js no encontrado.',details:e.message});
}
const yt=await Innertube.create({generate_session:false});
let primerVideo=null;
for(let intento=0;intento<2&&!primerVideo;intento+=1){
if(intento>0)await new Promise(r=>setTimeout(r,800));
const search=await yt.search(query,{type:'video'});
const videos=Array.isArray(search.videos)?search.videos:[];
primerVideo=videos.find(v=>v&&/^[a-zA-Z0-9_-]{11}$/.test(String(v.id||'')))||null;
}
if(!primerVideo)return sendJson(404,{ok:false,message:'No se encontraron resultados para la busqueda: '+query});
videoId=String(primerVideo.id);
}
const cookieHeader=secureApi.normalizeYoutubeCookie(process.env.YOUTUBE_COOKIE||process.env.youtube_cookie||'');
const hayCookie=!!cookieHeader;
const cacheKey=videoId+'|'+kind+'|'+(qualityParam==='best'?'best':qualityParam);
const cacheado=dlMediaCache.get(cacheKey);
if(cacheado&&cacheado.expiresAt>Date.now()){
const probeCacheado=await probeMedia(cacheado.url,cacheado.headers);
if(probeCacheado===200||probeCacheado===206){
return streamMedia(req,res,sendJson,requestId,cacheado.url,{referer:'https://www.youtube.com/',headers:cacheado.headers,filename:videoId+'.'+(kind==='audio'?'m4a':'mp4')});
}
dlMediaCache.delete(cacheKey);
}
const candidatos=[
{cliente:'WEB',cookie:true},
...(hayCookie?[{cliente:'WEB',cookie:false}]:[]),
{cliente:'WEB_EMBEDDED',cookie:true},
{cliente:'TV_SIMPLY',cookie:true},
{cliente:'ANDROID_VR',cookie:true},
{cliente:'IOS',cookie:true},
{cliente:'ANDROID',cookie:true},
{cliente:'MWEB',cookie:true},
{cliente:null,cookie:true},
];
const dlDeadline=Date.now()+45000;
for(const c of candidatos){
if(Date.now()>dlDeadline)break;
let media;
try{
media=await secureApi.fetchYoutubeMedia(videoId,kind==='audio'?'audio':'video',qualityParam==='best'?'best':qualityParam,null,c.cliente?{client:c.cliente,cookie:c.cookie}:{});
}catch(e){
continue;
}
if(!media||!media.url)continue;
const dlHeaders=c.cookie&&hayCookie?{Cookie:cookieHeader}:{};
const probeStatus=await probeMedia(media.url,dlHeaders);
if(probeStatus!==200&&probeStatus!==206)continue;
dlMediaCache.set(cacheKey,{url:media.url,headers:dlHeaders,expiresAt:Date.now()+30*60*1000});
if(dlMediaCache.size>50)dlMediaCache.delete(dlMediaCache.keys().next().value);
return streamMedia(req,res,sendJson,requestId,media.url,{referer:'https://www.youtube.com/',headers:dlHeaders,filename:videoId+'.'+(kind==='audio'?'m4a':'mp4')});
}
return sendJson(502,{ok:false,error:'IP_BLOQUEADA',message:'Ningun cliente pudo descargar desde este hosting.'});
}
if(pathname==='/ytmp3'||pathname==='/ytmp4'||pathname==='/youtube'||pathname==='/ytsearch'){
let Innertube;
try{
const mod=await import('youtubei.js');
Innertube=mod.Innertube;
}catch(e){
return sendJson(500,{ok:false,message:'Error interno: Modulo youtubei.js no encontrado.',details:e.message});
}
const yt=await Innertube.create({generate_session:false});
let videoId=query;
let searchMeta=null;
const match=query.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|v\/|embed\/|shorts\/))([a-zA-Z0-9_-]{11})/);
if(match){
videoId=match[1];
}else if(!/^[a-zA-Z0-9_-]{11}$/.test(query)){
let primerVideo=null;
for(let intento=0;intento<2&&!primerVideo;intento+=1){
if(intento>0)await new Promise(r=>setTimeout(r,800));
const search=await yt.search(query,{type:'video'});
const videos=Array.isArray(search.videos)?search.videos:[];
primerVideo=videos.find(v=>v&&/^[a-zA-Z0-9_-]{11}$/.test(String(v.id||'')))||null;
}
if(!primerVideo)return sendJson(404,{ok:false,message:'No se encontraron resultados para la busqueda: '+query});
videoId=String(primerVideo.id);
const vistasTexto=String(primerVideo.view_count?.text||primerVideo.view_count||'').replace(/[^0-9]/g,'');
const partesDur=String(primerVideo.duration?.text||'').split(':').map(Number).filter(n=>!Number.isNaN(n));
searchMeta={titulo:primerVideo.title?.text||primerVideo.title||'',canal:primerVideo.author?.name||'',visitas:Number(vistasTexto)||0,duracion:partesDur.length>=2?partesDur.reduce((a,b)=>a*60+b,0):0};
}
if(pathname==='/ytsearch'){
const search=await yt.search(query,{type:'video'});
const results=(search.videos||[]).filter(v=>v&&/^[a-zA-Z0-9_-]{11}$/.test(String(v.id||''))).slice(0,limit).map(v=>({
videoId:v.id,
title:v.title?.text||v.title,
canal:v.author?.name||'Desconocido',
visitas:v.view_count?.text||'0',
duracion:v.duration?.text||'N/A',
publicado:v.published?.text||'N/A',
url:`https://www.youtube.com/watch?v=${v.id}`,
thumbnail:`https://i.ytimg.com/vi/${v.id}/maxresdefault.jpg`
}));
return sendJson(200,{ok:true,source:'youtube',query,total_resultados:results.length,resultados:results});
}
const isAudio=pathname==='/ytmp3';
const media=await secureApi.fetchYoutubeMedia(videoId,isAudio?'audio':'video',qualityParam==='best'?'best':qualityParam);
const basic=media.basic_info||{};
const canal=(typeof basic.author==='string'&&basic.author)?basic.author:(searchMeta?.canal||'Desconocido');
const titulo=(typeof basic.title==='string'&&basic.title)?basic.title:(searchMeta?.titulo||'Desconocido');
const link=`https://www.youtube.com/watch?v=${videoId}`;
let tituloFinal=titulo,canalFinal=canal;
if(tituloFinal==='Desconocido'||canalFinal==='Desconocido'){
try{
const oe=await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(link)}&format=json`,{signal:AbortSignal.timeout(3000)}).then(r=>r.json());
if(typeof oe.title==='string'&&oe.title)tituloFinal=oe.title;
if(typeof oe.author_name==='string'&&oe.author_name)canalFinal=oe.author_name;
}catch(e){}
}
return sendJson(200,{
ok:true,
tipo:isAudio?'Audio MP3':'Video MP4',
titulo:tituloFinal,
canal:canalFinal,
link,
visitas:Number(basic.view_count)||searchMeta?.visitas||0,
likes:Number(basic.like_count)||0,
duracion_segundos:Number(basic.duration)||searchMeta?.duracion||0,
videoId:videoId,
url_original:link,
descarga_directa:media.url,
calidad:media.quality||'Audio/Best',
miniatura:`https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`
});
}
if(pathname==='/tiktok'||pathname==='/ttsearch'){
try{
const {searchTikTok,obtenerDiagnosticoTikTok}=require('./documentos/ttsearch');
const {extractTikTokVideo}=require('./documentos/tiktok');
if(pathname==='/ttsearch'){let r;try{r=await searchTikTok(query,limit);}catch(e){r=[];}const diag=parsedUrl.searchParams.get('debug')==='1'?obtenerDiagnosticoTikTok():undefined;return sendJson(200,diag?{ok:true,results:Array.isArray(r)?r:[],diagnostico:diag}:{ok:true,results:Array.isArray(r)?r:[]});}
return sendJson(200,{ok:true,...(await extractTikTokVideo(query))});
}catch(e){return sendJson(502,{ok:false,message:'Modulo TikTok no disponible',error:e.message});}
}
if(pathname==='/xvideo'||pathname==='/x'){
try{
const {fetchXVideo}=require('./documentos/xvideo');
return sendJson(200,{ok:true,...(await fetchXVideo(query))});
}catch(e){return sendJson(502,{ok:false,message:'Modulo X no disponible',error:e.message});}
}
if(pathname==='/instagram'||pathname==='/facebook'){
try{
const {fetchInstagramVideo}=require('./documentos/instagram');
const {fetchFacebookVideo}=require('./documentos/facebook');
const data=pathname==='/instagram'?await fetchInstagramVideo(query):await fetchFacebookVideo(query);
return sendJson(200,data);
}catch(e){
return sendJson(404,{ok:false,error:{message:String(e&&e.message||e).slice(0,220)}});
}
}
if(pathname==='/status'){
return sendJson(200,{ok:true,servicio:'ZETA-CORE API',secureApi_cargada:!secureApiLoadError,secureApi_error:secureApiLoadError?String(secureApiLoadError&&secureApiLoadError.message||secureApiLoadError).slice(0,300):undefined,youtube_cookie_configurada:!!(process.env.YOUTUBE_COOKIE||process.env.youtube_cookie),youtube_visitor_data_configurada:!!(process.env.YOUTUBE_VISITOR_DATA||process.env.youtube_visitor_data),dl_key_configurada:!!(process.env.DL_KEY||process.env.dl_key),dl_proxy_configurada:!!(process.env.DL_PROXY_URL||process.env.dl_proxy_url),admin_password_configurada:!!(process.env.ADMIN_PASSWORD||process.env.admin_password),endpoints:['/ytmp4','/ytmp3','/ytsearch','/tiktok','/ttsearch','/xvideo','/instagram','/facebook','/dl','/status']});
}
return sendJson(404,{ok:false,message:'Ruta no encontrada: '+pathname});
}catch(error){
console.error(error);
return sendJson(error.statusCode||500,{ok:false,code:error.code||'CRITICAL_ERROR',message:error.message,solucion:error.solucion||"Revisa los logs en Vercel.",...(error.detalles?{detalles:error.detalles}:{})});
}
};
