// Pagina de documentacion de la API (ruta /). Tema oscuro con acentos RGB
// animados moderados, tester integrado y fondo personalizable desde el panel
// de admin (se aplica via /fondo). El beacon a /ping registra visitantes.
function paginaDocs(){
return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ZETA-CORE API</title><style>
@property --ang{syntax:'<angle>';initial-value:0deg;inherits:false}
:root{--bg:#05070d;--panel:rgba(13,17,28,.88);--panel2:#0d1119;--borde:#1d2536;--texto:#e8ecf6;--tenue:#8b93a7;--a1:#7c3aed;--a2:#06b6d4;--a3:#f472b6}
*{box-sizing:border-box}html,body{margin:0}
body{background:var(--bg);color:var(--texto);font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;min-height:100vh}
#bg{position:fixed;inset:0;z-index:-2;background-size:cover;background-position:center;display:none}
#bg::after{content:'';position:absolute;inset:0;background:linear-gradient(180deg,rgba(5,7,13,.87),rgba(5,7,13,.95))}
#aurora{position:fixed;inset:-20%;z-index:-3;background:radial-gradient(42% 42% at 18% 18%,rgba(124,58,237,.16),transparent 62%),radial-gradient(38% 38% at 82% 26%,rgba(6,182,212,.13),transparent 62%),radial-gradient(32% 32% at 50% 88%,rgba(244,114,182,.10),transparent 62%);animation:deriva 26s ease-in-out infinite alternate}
@keyframes deriva{from{transform:translate3d(0,0,0) scale(1)}to{transform:translate3d(2%,3%,0) scale(1.06)}}
.wrap{max-width:1060px;margin:0 auto;padding:20px 18px 60px}
header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 0 22px;flex-wrap:wrap}
.logo{font-size:22px;font-weight:800;letter-spacing:.5px}
.logo b{background:linear-gradient(90deg,#a78bfa,#22d3ee,#f472b6,#a78bfa);background-size:300% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:brillo 7s linear infinite}
@keyframes brillo{to{background-position:300% 0}}
.chip{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--tenue);background:var(--panel2);border:1px solid var(--borde);border-radius:999px;padding:6px 12px}
.dot{width:8px;height:8px;border-radius:50%;background:#facc15;box-shadow:0 0 8px currentColor;flex:none}
.dot.ok{background:#4ade80;box-shadow:0 0 8px #4ade8088}
.dot.err{background:#f87171;box-shadow:0 0 8px #f8717188}
a.mini{color:var(--tenue);font-size:12px;text-decoration:none;border:1px solid var(--borde);border-radius:999px;padding:6px 12px;transition:.2s}
a.mini:hover{color:#fff;border-color:#3b4a6b}
.rgb{border:1px solid transparent;border-radius:18px;background:linear-gradient(var(--panel),var(--panel)) padding-box,conic-gradient(from var(--ang),var(--a1),var(--a2),var(--a3),var(--a1)) border-box;animation:girar 9s linear infinite}
@keyframes girar{to{--ang:360deg}}
@supports not (background:conic-gradient(from var(--ang),red,blue)){.rgb{border-color:var(--borde);background:var(--panel)}}
.hero{padding:34px 30px;margin-bottom:22px}
.hero h1{margin:0 0 8px;font-size:40px;line-height:1.1;letter-spacing:-.5px}
.hero h1 b{background:linear-gradient(90deg,#a78bfa,#22d3ee,#f472b6,#a78bfa);background-size:300% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:brillo 7s linear infinite}
.hero p{margin:0 0 18px;color:var(--tenue);font-size:15px;max-width:640px}
.badges{display:flex;gap:8px;flex-wrap:wrap}
.badge{font-size:12px;color:#c7d0e6;background:rgba(124,58,237,.10);border:1px solid rgba(124,58,237,.35);border-radius:999px;padding:5px 12px}
.badge.c{background:rgba(6,182,212,.10);border-color:rgba(6,182,212,.35)}
.badge.m{background:rgba(244,114,182,.10);border-color:rgba(244,114,182,.35)}
section{margin-bottom:26px}
h2{font-size:15px;text-transform:uppercase;letter-spacing:2px;color:var(--tenue);margin:0 0 14px;display:flex;align-items:center;gap:10px}
h2::after{content:'';flex:1;height:1px;background:linear-gradient(90deg,var(--borde),transparent)}
.card{background:var(--panel);border:1px solid var(--borde);border-radius:18px;padding:24px}
.tester label{display:block;font-size:11px;color:var(--tenue);margin:12px 0 5px;text-transform:uppercase;letter-spacing:1px}
.tester input,.tester select{width:100%;padding:11px 13px;border-radius:11px;border:1px solid var(--borde);background:var(--panel2);color:#fff;font-size:14px;outline:none;transition:.2s}
.tester input:focus,.tester select:focus{border-color:#7c3aed;box-shadow:0 0 0 3px rgba(124,58,237,.18)}
.tester button{width:100%;padding:13px;border-radius:11px;border:none;font-weight:800;font-size:15px;cursor:pointer;margin-top:18px;color:#fff;background:linear-gradient(90deg,var(--a1),var(--a2));box-shadow:0 4px 18px rgba(124,58,237,.30);transition:.2s}
.tester button:hover{filter:brightness(1.12);box-shadow:0 4px 26px rgba(6,182,212,.35)}
.tester button:disabled{opacity:.55;cursor:wait}
.fila{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media(max-width:640px){.fila{grid-template-columns:1fr}.hero h1{font-size:30px}}
.status{margin-top:10px;font-size:13px;min-height:18px}
.ok{color:#4ade80}.err{color:#f87171}
pre{color:#9cdcfe;text-align:left;white-space:pre-wrap;word-break:break-all;max-height:420px;overflow:auto;background:#070a12;border:1px solid var(--borde);padding:14px;border-radius:12px;margin:14px 0 0;font-size:12px;line-height:1.5}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
.ep{background:var(--panel);border:1px solid var(--borde);border-radius:14px;padding:16px;transition:.2s}
.ep:hover{border-color:#3d4a6b;transform:translateY(-2px)}
.ep .met{display:inline-block;font-size:10px;font-weight:800;color:#4ade80;background:rgba(74,222,128,.10);border:1px solid rgba(74,222,128,.30);border-radius:6px;padding:2px 7px;letter-spacing:1px}
.ep code{display:block;margin:8px 0 6px;color:#c4b5fd;font-size:13px;word-break:break-all}
.ep p{margin:0;color:var(--tenue);font-size:12.5px;line-height:1.5}
footer{margin-top:40px;padding-top:18px;border-top:1px solid var(--borde);display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;color:var(--tenue);font-size:12px}
footer a{color:var(--tenue)}
#player{position:fixed;top:14px;right:14px;z-index:60;display:none;align-items:center;gap:10px;background:var(--panel);border:1px solid var(--borde);border-radius:999px;padding:7px 14px 7px 8px;backdrop-filter:blur(10px);box-shadow:0 6px 24px rgba(0,0,0,.5)}
#player button{width:34px;height:34px;border-radius:50%;border:none;cursor:pointer;color:#fff;background:linear-gradient(90deg,var(--a1),var(--a2));font-size:13px;display:flex;align-items:center;justify-content:center;padding:0;box-shadow:0 2px 10px rgba(124,58,237,.4)}
#player button:hover{filter:brightness(1.15)}
#player .peq{width:110px;height:4px;border-radius:2px;background:#232c42;cursor:pointer;position:relative;flex:none}
#player .peq i{position:absolute;left:0;top:0;bottom:0;width:0;border-radius:2px;background:linear-gradient(90deg,var(--a1),var(--a2))}
#player .tt{font-size:11px;color:var(--tenue);max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media(max-width:640px){#player{top:auto;bottom:14px;right:12px}.hero{padding:26px 20px}}
</style></head><body>
<div id="aurora"></div><div id="bg"></div>
<div class="wrap">
<header>
<div class="logo">ZETA<b>-CORE</b> API</div>
<div style="display:flex;gap:8px;align-items:center">
<span class="chip" id="chip"><i class="dot" id="cdot"></i><span id="ctxt">Verificando...</span></span>
<a class="mini" href="/admin" title="Panel de administracion">Admin</a>
</div>
</header>
<section class="hero rgb">
<h1>Scraper puro.<br><b>YouTube, TikTok y X.</b></h1>
<p>API de scraping directo sin APIs internas ni servicios pagos. Instagram y Facebook incluidos. Probá cualquier endpoint desde acá.</p>
<div class="badges"><span class="badge">10 endpoints</span><span class="badge c">Streaming directo</span><span class="badge m">Sin APIs de pago</span><span class="badge c">JSON estable</span></div>
</section>
<section>
<h2>Probador</h2>
<div class="card tester">
<label>Endpoint</label>
<select id="t">
<option value="/ytmp4">Video MP4 (/ytmp4)</option>
<option value="/ytmp3">Audio MP3 (/ytmp3)</option>
<option value="/ytsearch">Buscar en YouTube (/ytsearch)</option>
<option value="/tiktok">Video de TikTok (/tiktok)</option>
<option value="/ttsearch">Buscar en TikTok (/ttsearch)</option>
<option value="/xvideo">Video de X/Twitter (/xvideo)</option>
<option value="/instagram">Video de Instagram (/instagram)</option>
<option value="/facebook">Video de Facebook (/facebook)</option>
<option value="/dl">Descarga directa (/dl)</option>
</select>
<label id="ql">Consulta o enlace</label>
<input id="q" placeholder="Texto de busqueda o enlace del video">
<label id="kl" style="display:none">Tipo (/dl)</label>
<select id="kd" style="display:none">
<option value="video">Video de YouTube</option>
<option value="audio">Audio de YouTube</option>
<option value="tiktok">TikTok</option>
<option value="x">X/Twitter</option>
<option value="instagram">Instagram</option>
<option value="facebook">Facebook</option>
</select>
<label id="kyl" style="display:none">Clave DL_KEY (solo /dl)</label>
<input id="ky" style="display:none" placeholder="Tu DL_KEY">
<label id="qll">Calidad (solo YouTube)</label>
<select id="qt">
<option value="best">best</option>
<option value="360p">360p</option>
<option value="480p">480p</option>
<option value="720p" selected>720p</option>
<option value="1080p">1080p</option>
</select>
<label id="liml">Limite (solo busquedas)</label>
<input id="lim" type="number" min="1" max="20" value="5">
<button id="go" onclick="test()">Probar API</button>
<div class="status" id="st"></div>
<pre id="out">Esperando peticion...</pre>
</div>
</section>
<section>
<h2>Endpoints</h2>
<div class="grid" id="eps"></div>
</section>
<footer>
<span>ZETA-CORE API · scraper puro · sin APIs de pago</span>
<a href="/status">/status</a>
</footer>
</div>
<script>
const $=id=>document.getElementById(id);
const GRUPOS=[
{n:'YouTube',items:[
{p:'/ytmp3',d:'Audio MP3 de un video de YouTube.',a:'query, quality'},
{p:'/ytmp4',d:'Video MP4 de YouTube con calidad elegida.',a:'query, quality'},
{p:'/ytsearch',d:'Busqueda de videos en YouTube.',a:'query, limit'}]},
{n:'TikTok',items:[
{p:'/tiktok',d:'Metadatos y links de un video de TikTok.',a:'query'},
{p:'/ttsearch',d:'Busqueda multi-fuente de videos de TikTok.',a:'query, limit'}]},
{n:'X / Twitter',items:[
{p:'/xvideo',d:'Videos de un tweet, con MP4 real en "best".',a:'query'}]},
{n:'Instagram',items:[
{p:'/instagram',d:'Video o carrusel de un post/reel publico.',a:'query'}]},
{n:'Facebook',items:[
{p:'/facebook',d:'Video de un post, watch, reel o fb.watch.',a:'query'}]},
{n:'Descargas y estado',items:[
{p:'/dl',d:'Descarga binaria en streaming. Requiere DL_KEY.',a:'query, kind, key'},
{p:'/status',d:'Estado del servicio y configuracion.',a:'-'}]}
];
$('eps').innerHTML=GRUPOS.map(g=>'<div style="grid-column:1/-1;font-size:12px;color:#8b93a7;letter-spacing:1px;text-transform:uppercase;margin-top:6px">'+g.n+'</div>'+g.items.map(e=>'<div class="ep"><span class="met">GET</span><code>'+e.p+'</code><p>'+e.d+'</p><p style="margin-top:6px;color:#5b6478">params: '+e.a+'</p></div>').join('')).join('');
const isSearch=()=>['/ytsearch','/ttsearch'].includes($('t').value);
const isYt=()=>['/ytmp3','/ytmp4','/ytsearch'].includes($('t').value)||($('t').value==='/dl'&&['video','audio'].includes($('kd').value));
const isUrlOnly=()=>['/tiktok','/xvideo','/instagram','/facebook'].includes($('t').value);
const isDl=()=>$('t').value==='/dl';
function sync(){
$('kl').style.display=isDl()?'':'none';
$('kd').style.display=isDl()?'':'none';
$('kyl').style.display=isDl()?'':'none';
$('ky').style.display=isDl()?'':'none';
$('qt').style.display=isYt()?'':'none';
$('qll').style.display=isYt()?'':'none';
$('lim').style.display=isSearch()?'':'none';
$('liml').style.display=isSearch()?'':'none';
$('q').placeholder=isUrlOnly()?'https://... enlace del video':isSearch()?'Texto a buscar':'Texto o enlace de YouTube';
}
async function test(){
const t=$('t').value,q=$('q').value.trim();
if(!q){$('st').className='status err';$('st').textContent='Escribe una consulta o enlace.';return}
let url=t+'?query='+encodeURIComponent(q);
if(isDl()){url+='&kind='+encodeURIComponent($('kd').value);const k=$('ky').value.trim();if(k)url+='&key='+encodeURIComponent(k);}
if(isYt()&&!isDl())url+='&quality='+encodeURIComponent($('qt').value);
if(isYt()&&isDl()&&['video','audio'].includes($('kd').value))url+='&quality='+encodeURIComponent($('qt').value);
if(isSearch())url+='&limit='+encodeURIComponent($('lim').value||'5');
$('go').disabled=true;$('st').className='status';$('st').textContent='Procesando...';$('out').textContent='Procesando '+q+'...';
try{
const r=await fetch(url);const ct=r.headers.get('content-type')||'';
if(ct.includes('application/json')){$('out').textContent=JSON.stringify(await r.json(),null,2)}
else{$('out').textContent='Respuesta binaria: '+ct+' ('+r.status+')'}
$('st').className='status '+(r.ok?'ok':'err');$('st').textContent='HTTP '+r.status;
}catch(e){$('st').className='status err';$('st').textContent='Error: '+e}
$('go').disabled=false;
}
['t','qt','lim','kd'].forEach(id=>$(id).addEventListener('change',sync));sync();
(async function estado(){
try{
const r=await fetch('/status');const j=await r.json();
if(r.ok&&j.ok){$('cdot').className='dot ok';$('ctxt').textContent='API en linea'}
else{$cdot.className='dot err';$('ctxt').textContent='API degradada'}
}catch(e){$('cdot').className='dot err';$('ctxt').textContent='Sin respuesta'}
})();
(async function fondo(){
try{
const r=await fetch('/fondo');const j=await r.json();
if(j&&j.ok&&j.url){const b=$('bg');b.style.backgroundImage='url("'+j.url+'")';b.style.display='block'}
}catch(e){}
})();
(function beacon(){
let vid=null;try{vid=localStorage.getItem('zeta_vid')}catch(e){}
if(!vid){try{vid=(crypto.randomUUID?crypto.randomUUID():String(Math.random()).slice(2)+Date.now());localStorage.setItem('zeta_vid',vid)}catch(e){vid='anon'}}
const ping=()=>{try{fetch('/ping?v='+encodeURIComponent(vid),{keepalive:true}).catch(()=>{})}catch(e){}};
ping();setInterval(ping,15000);
})();
(async function musica(){
try{
const r=await fetch('/musica');const j=await r.json();
if(!(j&&j.ok&&j.activa&&j.url))return;
const p=document.createElement('div');p.id='player';
p.innerHTML='<button id="pbtn" title="Reproducir / pausar">▶</button><div class="peq" id="pseek"><i id="pfill"></i></div><span class="tt">'+String(j.nombre||'música').replace(/[<>&"]/g,'')+'</span>';
document.body.appendChild(p);
const audio=new Audio();audio.src=j.url;audio.volume=0.5;audio.preload='none';
const btn=p.querySelector('#pbtn'),fill=p.querySelector('#pfill'),seek=p.querySelector('#pseek');
const icono=()=>{btn.textContent=audio.paused?'▶':'⏸'};
btn.onclick=()=>{if(audio.paused){audio.play().catch(()=>{})}else{audio.pause()}};
audio.addEventListener('play',icono);audio.addEventListener('pause',icono);
audio.addEventListener('timeupdate',()=>{if(audio.duration)fill.style.width=(audio.currentTime/audio.duration*100)+'%'});
audio.addEventListener('ended',()=>{fill.style.width='0%';icono()});
seek.onclick=(e)=>{if(!audio.duration)return;const r2=seek.getBoundingClientRect();audio.currentTime=Math.max(0,Math.min(1,(e.clientX-r2.left)/r2.width))*audio.duration};
p.style.display='flex';
audio.play().catch(()=>{});
}catch(e){}
})();
</script></body></html>`;
}
module.exports={paginaDocs};
