const { URL }=require('url');
const { randomUUID }=require('node:crypto');
const secureApi=require('./secure-api');
const VALID_QUALITY=/^(?:best|\d{3,4}p)$/;
const VALID_LIMIT=/^\d+$/;
const LIMIT_MIN=1;
const LIMIT_MAX=20;
module.exports=async function handler(req,res){
const requestId=randomUUID();
const sendJson=(status,payload)=>{
res.statusCode=status;
res.setHeader('Content-Type','application/json; charset=utf-8');
res.setHeader('X-Request-Id',requestId);
res.setHeader('Access-Control-Allow-Origin','*');
return res.end(JSON.stringify({...payload,requestId},null,2));
};
if(req.method!=='GET'&&req.method!=='HEAD'){
res.statusCode=405;
res.setHeader('Allow','GET, HEAD');
res.setHeader('Content-Type','application/json; charset=utf-8');
res.setHeader('X-Request-Id',requestId);
return res.end(JSON.stringify({ok:false,message:'Metodo no permitido. Usa GET o HEAD.',requestId},null,2));
}
try{
const parsedUrl=new URL(req.url||'/',`https://${req.headers.host||'api.invalid'}`);
let pathname=parsedUrl.pathname.replace(/^\/api(?=\/|$)/,'');
if(!pathname)pathname='/';
if(pathname==='/favicon.ico')return res.end();
if(pathname==='/'||pathname===''||pathname==='/docs'){
res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
return res.end(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ZETA-CORE API</title><style>*{box-sizing:border-box}body{background:#0a0e14;color:#fff;font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;padding:16px}.card{background:#12161f;border:1px solid #232936;border-radius:20px;padding:32px;max-width:640px;width:100%}h1{margin:0 0 4px;font-size:26px}h1 span{color:#6366f1}p.sub{margin:0 0 18px;color:#8b93a7;font-size:14px}label{display:block;font-size:12px;color:#8b93a7;margin:12px 0 4px;text-transform:uppercase;letter-spacing:1px}input,select,button{width:100%;padding:12px;border-radius:10px;border:1px solid #232936;background:#0d1117;color:#fff;font-size:14px}button{background:#6366f1;border:none;font-weight:700;cursor:pointer;margin-top:16px}button:disabled{opacity:.6;cursor:wait}pre{color:#9cdcfe;text-align:left;white-space:pre-wrap;word-break:break-all;max-height:420px;overflow:auto;background:#0d1117;padding:12px;border-radius:10px;margin:16px 0 0;font-size:12px}.status{margin-top:10px;font-size:13px;min-height:18px}.ok{color:#4ade80}.err{color:#f87171}.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px;color:#8b93a7;margin-top:16px}.grid code{color:#9cdcfe}</style></head><body><div class="card"><h1>ZETA<span>-CORE</span> API</h1><p class="sub">Scraper puro: YouTube, TikTok y X/Twitter. Sin APIs internas.</p><label>Endpoint</label><select id="t"><option value="/ytmp4">Video MP4 (/ytmp4)</option><option value="/ytmp3">Audio MP3 (/ytmp3)</option><option value="/ytsearch">Buscar en YouTube (/ytsearch)</option><option value="/tiktok">Video de TikTok (/tiktok)</option><option value="/ttsearch">Buscar en TikTok (/ttsearch)</option><option value="/xvideo">Video de X/Twitter (/xvideo)</option></select><label id="ql">Consulta o enlace</label><input id="q" placeholder="Texto de busqueda o enlace del video"><label id="qll">Calidad (solo YouTube)</label><select id="qt"><option value="best">best</option><option value="360p">360p</option><option value="480p">480p</option><option value="720p" selected>720p</option><option value="1080p">1080p</option></select><label id="liml">Limite (solo busquedas)</label><input id="lim" type="number" min="1" max="20" value="5"><button class="btn" id="go" onclick="test()">Probar API</button><div class="status" id="st"></div><pre id="out">Esperando peticion...</pre><div class="grid"><span>GET <code>/ytmp3?query=</code></span><span>GET <code>/ytmp4?query=&quality=</code></span><span>GET <code>/ytsearch?query=&limit=</code></span><span>GET <code>/tiktok?query=</code></span><span>GET <code>/ttsearch?query=&limit=</code></span><span>GET <code>/xvideo?query=</code></span><span>GET <code>/status</code></span></div></div><script>const $=id=>document.getElementById(id);const isSearch=()=>['/ytsearch','/ttsearch'].includes($('t').value);const isYt=()=>['/ytmp3','/ytmp4','/ytsearch'].includes($('t').value);const isUrlOnly=()=>['/tiktok','/xvideo'].includes($('t').value);function sync(){$('qt').style.display=isYt()?'':'none';$('qll').style.display=isYt()?'':'none';$('lim').style.display=isSearch()?'':'none';$('liml').style.display=isSearch()?'':'none';$('q').placeholder=isUrlOnly()?'https://... enlace del video':isSearch()?'Texto a buscar':'Texto o enlace de YouTube'}async function test(){const t=$('t').value,q=$('q').value.trim();if(!q){$('st').className='status err';$('st').textContent='Escribe una consulta o enlace.';return}let url=t+'?query='+encodeURIComponent(q);if(isYt())url+='&quality='+encodeURIComponent($('qt').value);if(isSearch())url+='&limit='+encodeURIComponent($('lim').value||'5');$('go').disabled=true;$('st').className='status';$('st').textContent='Procesando...';$('out').textContent='Procesando '+q+'...';try{const r=await fetch(url);const j=await r.json();$('out').textContent=JSON.stringify(j,null,2);$('st').className='status '+(r.ok?'ok':'err');$('st').textContent='HTTP '+r.status+(j.requestId?' - '+j.requestId:'')}catch(e){$('st').className='status err';$('st').textContent='Error: '+e}$('go').disabled=false}['t','qt','lim'].forEach(id=>$(id).addEventListener('change',sync));sync();</script></body></html>`);
}
const rawQuery=parsedUrl.searchParams.get('query')||parsedUrl.searchParams.get('url')||parsedUrl.searchParams.get('prompt')||'';
const query=rawQuery.trim();
const qualityParam=parsedUrl.searchParams.get('quality')||'best';
const limitParam=parsedUrl.searchParams.get('limit')||'5';
const isSearchRoute=['/ytsearch','/ttsearch'].includes(pathname);
if(!query&&['/ytmp3','/ytmp4','/youtube','/ytsearch','/tiktok','/ttsearch','/xvideo'].includes(pathname)){
return sendJson(400,{ok:false,message:'Falta el parametro query o url'});
}
if(!isSearchRoute&&pathname!=='/'&&!VALID_QUALITY.test(qualityParam)){
return sendJson(400,{ok:false,message:`Calidad invalida: "${qualityParam}". Usa best, 360p, 480p, 720p, 1080p, 1440p o 2160p.`});
}
let limit=Number(limitParam);
if(!VALID_LIMIT.test(limitParam)||limit<LIMIT_MIN||limit>LIMIT_MAX){
return sendJson(400,{ok:false,message:`Limite invalido: "${limitParam}". Usa un numero entre ${LIMIT_MIN} y ${LIMIT_MAX}.`});
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
const {searchTikTok}=require('./documentos/ttsearch');
const {extractTikTokVideo}=require('./documentos/tiktok');
if(pathname==='/ttsearch')return sendJson(200,{ok:true,results:await searchTikTok(query,limit)});
return sendJson(200,{ok:true,...(await extractTikTokVideo(query))});
}catch(e){return sendJson(502,{ok:false,message:'Modulo TikTok no disponible',error:e.message});}
}
if(pathname==='/xvideo'||pathname==='/x'){
try{
const {fetchXVideo}=require('./documentos/xvideo');
return sendJson(200,{ok:true,...(await fetchXVideo(query))});
}catch(e){return sendJson(502,{ok:false,message:'Modulo X no disponible',error:e.message});}
}
if(pathname==='/status'){
return sendJson(200,{ok:true,servicio:'ZETA-CORE API',youtube_cookie_configurada:!!(process.env.YOUTUBE_COOKIE||process.env.youtube_cookie),youtube_visitor_data_configurada:!!(process.env.YOUTUBE_VISITOR_DATA||process.env.youtube_visitor_data),endpoints:['/ytmp4','/ytmp3','/ytsearch','/tiktok','/ttsearch','/xvideo','/status']});
}
return sendJson(404,{ok:false,message:'Ruta no encontrada: '+pathname});
}catch(error){
console.error(error);
return sendJson(error.statusCode||500,{ok:false,code:error.code||'CRITICAL_ERROR',message:error.message,solucion:error.solucion||"Revisa los logs en Vercel.",...(error.detalles?{detalles:error.detalles}:{})});
}
};
