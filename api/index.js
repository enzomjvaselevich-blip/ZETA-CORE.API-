const { URL }=require('url');
const { randomUUID }=require('node:crypto');
module.exports=async function handler(req,res){
const requestId=randomUUID();
const sendJson=(status,payload)=>{
res.statusCode=status;
res.setHeader('Content-Type','application/json; charset=utf-8');
res.setHeader('X-Request-Id',requestId);
res.setHeader('Access-Control-Allow-Origin','*');
return res.end(JSON.stringify(payload,null,2));
};
try{
const parsedUrl=new URL(req.url||'/',`https://${req.headers.host||'api.invalid'}`);
let pathname=parsedUrl.pathname.replace(/^\/api(?=\/|$)/,'');
if(!pathname)pathname='/';
if(pathname==='/favicon.ico')return res.end();
if(pathname==='/'||pathname===''||pathname==='/docs'){
res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
return res.end(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ZETA-CORE API - FIXED</title><style>body{background:#0a0e14;color:#fff;font-family:sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh} .card{background:#12161f;border:1px solid #232936;border-radius:20px;padding:40px;text-align:center;max-width:600px;width:100%} input{width:90%;padding:12px;margin:10px 0;border-radius:10px;border:1px solid #232936;background:#0d1117;color:#fff} select{width:95%;padding:12px;margin:10px 0;border-radius:10px;border:1px solid #232936;background:#0d1117;color:#fff} .btn{background:#6366f1;color:#fff;padding:12px 24px;border:none;border-radius:12px;font-weight:700;width:95%;cursor:pointer;margin-top:10px} pre{color:#9cdcfe;text-align:left;white-space:pre-wrap;max-height:400px;overflow:auto;background:#0d1117;padding:12px;border-radius:10px;margin-top:20px}</style></head><body><div class="card"><h1>ZETA-CORE API</h1><p>API Operativa - JSON Real con Datos Completos</p><input id="q" placeholder="Ej: hola beba o link de YouTube"><select id="t"><option value="audio">Audio MP3</option><option value="video" selected>Video MP4</option><option value="search">Buscar Varios (/ytsearch)</option></select><button class="btn" onclick="test()">Probar API</button><pre id="out">Esperando petición...</pre></div><script>async function test(){let q=document.getElementById('q').value;let t=document.getElementById('t').value;let url; if(t==='audio') url='/ytmp3?query='+encodeURIComponent(q); else if(t==='video') url='/ytmp4?query='+encodeURIComponent(q); else url='/ytsearch?query='+encodeURIComponent(q); document.getElementById('out').innerText='Procesando '+q+'...';try{let r=await fetch(url);let j=await r.json();document.getElementById('out').innerText=JSON.stringify(j,null,2)}catch(e){document.getElementById('out').innerText='Error: '+e}}</script></body></html>`);
}
const rawQuery=parsedUrl.searchParams.get('query')||parsedUrl.searchParams.get('url')||parsedUrl.searchParams.get('prompt')||'';
const query=rawQuery.trim();
const qualityParam=parsedUrl.searchParams.get('quality')||'best';
const limit=Number(parsedUrl.searchParams.get('limit')||5);
if(!query&&['/ytmp3','/ytmp4','/youtube','/ytsearch'].includes(pathname)){
return sendJson(400,{ok:false,message:'Falta el parametro query o url'});
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
const match=query.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|v\/|embed\/|shorts\/))([a-zA-Z0-9_-]{11})/);
if(match){
videoId=match[1];
}else if(!/^[a-zA-Z0-9_-]{11}$/.test(query)){
const search=await yt.search(query,{type:'video'});
const firstVideo=search.videos?.[0];
if(!firstVideo)return sendJson(404,{ok:false,message:'No se encontraron resultados para la busqueda: '+query});
videoId=firstVideo.id;
}
if(pathname==='/ytsearch'){
const search=await yt.search(query,{type:'video'});
const results=(search.videos||[]).slice(0,limit).map(v=>({
videoId:v.id,
title:v.title?.text||v.title,
canal:v.author?.name||'Desconocido',
visitas:v.view_count?.text||'0',
duracion:v.duration?.text||'N/A',
publicado:v.published?.text||'N/A',
url:`https://www.youtube.com/watch?v=${v.id}`,
thumbnail:`https://i.ytimg.com/vi/${v.id}/maxresdefault.jpg`
}));
return sendJson(200,{ok:true,source:'youtube',query,total_resultados:results.length,resultados:results,requestId});
}
const info=await yt.getInfo(videoId);
const basic=info.basic_info;
const isAudio=pathname==='/ytmp3';
const type=isAudio?'audio':'video+audio';
let format;
try{
format=info.chooseFormat({type,quality:qualityParam==='best'?'best':qualityParam});
}catch(err){
format=info.chooseFormat({type:'audio',quality:'best'});
}
if(!format||!format.url){
return sendJson(502,{ok:false,code:'FORMAT_UNAVAILABLE',message:'YouTube no proporciono un enlace directo para este formato.'});
}
return sendJson(200,{
ok:true,
tipo:isAudio?'Audio MP3':'Video MP4',
titulo:basic.title,
canal:basic.author||'Desconocido',
visitas:basic.view_count||0,
likes:basic.like_count||0,
duracion_segundos:basic.duration||0,
videoId:videoId,
url_original:`https://www.youtube.com/watch?v=${videoId}`,
descarga_directa:format.url,
calidad:format.quality_label||'Audio/Best',
miniatura:`https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
requestId
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
return sendJson(404,{ok:false,message:'Ruta no encontrada: /'+pathname});
}catch(error){
console.error(error);
return sendJson(500,{ok:false,code:error.code||'CRITICAL_ERROR',message:error.message,solucion:"Revisa los logs en Vercel."});
}
};
