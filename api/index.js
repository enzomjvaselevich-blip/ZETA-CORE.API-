const { URL } = require('url');
const { randomUUID } = require('node:crypto');
const secureApi = require('./secure-api');
const { searchYoutube } = require('./documentos/ytsearch');
const { searchTikTok } = require('./documentos/ttsearch');
const { extractTikTokVideo } = require('./documentos/tiktok');
const { getYoutubeAudio } = require('./documentos/ytmp3');
const { getYoutubeVideo } = require('./documentos/ytmp4');
const { fetchXVideo } = require('./documentos/xvideo');

module.exports = async function handler(req, res) {
  const requestId = randomUUID();
  const globalController = new AbortController();
  const globalTimeout = setTimeout(() => globalController.abort(), 15000);
  const sendJson = (c,p) => { res.statusCode=c; res.setHeader('Content-Type','application/json; charset=utf-8'); return res.end(JSON.stringify(p)); };
  try {
    const parsedUrl = new URL(req.url || '/', 'https://api.invalid');
    let pathname = parsedUrl.pathname.replace(/^\/api(?=\/|$)/, '');
    if (!pathname) pathname='/';
    res.setHeader('X-Request-Id',requestId);
    res.setHeader('Access-Control-Allow-Origin','*');
    const rawQuery = parsedUrl.searchParams.get('query') || parsedUrl.searchParams.get('url') || '';
    const query = rawQuery.trim();
    const type = (parsedUrl.searchParams.get('type')||'video').toLowerCase();
    const quality = (parsedUrl.searchParams.get('quality')||'720p').toLowerCase();
    const limit = Number(parsedUrl.searchParams.get('limit')||5);

    if (pathname==='/'||pathname==='') {
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
      return res.end(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>ZETA-CORE API</title><style>body{background:#0a0e14;color:#fff;font-family:Inter,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh}.card{background:#12161f;border:1px solid #232936;border-radius:20px;padding:40px;text-align:center}.btn{background:#6366f1;color:#fff;padding:12px 24px;border-radius:12px;text-decoration:none;font-weight:700;display:inline-block}</style></head><body><div class="card"><h1>ZETA-CORE API</h1><p>Backend operativo con youtubei.js</p><a href="/docs" class="btn">Ver docs</a></div></body></html>`);
    }
    if (pathname==='/docs') {
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
      return res.end(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ZETA-CORE API | Docs</title><style>:root{--bg:#0a0e14;--surface:#12161f;--surface-2:#171c27;--border:#232936;--text:#e6e9ef;--muted:#8b93a3;--accent:#6366f1;--code-bg:#0d1117}*{box-sizing:border-box}body{background:var(--bg);color:var(--text);font-family:Inter,sans-serif;margin:0;display:flex}.sidebar{width:280px;background:var(--surface);border-right:1px solid var(--border);position:fixed;height:100vh}.sidebar-header{padding:20px;border-bottom:1px solid var(--border);display:flex;gap:10px;align-items:center}.logo-dot{width:10px;height:10px;background:var(--accent);border-radius:50%}.sidebar-menu{padding:12px;display:flex;flex-direction:column;gap:4px}.sub-item{padding:10px 14px;color:var(--muted);border-radius:8px;cursor:pointer;font-weight:600;border-left:3px solid transparent}.sub-item.active{background:var(--surface-2);color:var(--text);border-left-color:var(--accent)}.main-content{width:100%;padding:30px 16px 40px 296px;display:flex;justify-content:center}.card-wrapper{max-width:720px;width:100%}.card{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:24px;display:none;margin-bottom:18px}.card.active{display:block}.endpoint-block{background:var(--surface-2);border:1px solid var(--border);padding:18px;border-radius:12px;margin-bottom:16px}.route-path-box{display:flex;justify-content:space-between;background:var(--code-bg);border:1px solid var(--border);padding:8px 12px;border-radius:8px;margin-bottom:14px;font-family:monospace;font-size:12px;color:var(--muted)}.btn{padding:12px;border:none;border-radius:10px;font-weight:700;width:100%;background:var(--accent);color:#fff;cursor:pointer}input,select{width:100%;padding:11px 13px;background:var(--code-bg);border:1px solid var(--border);color:var(--text);border-radius:10px;margin-bottom:14px}pre{color:#9cdcfe;font-size:12px;overflow-x:auto;white-space:pre-wrap;margin:0;max-height:350px}.json-box{background:var(--code-bg);border:1px solid var(--border);border-radius:10px;padding:14px;margin-top:14px;display:none;position:relative}.btn-copy{position:absolute;top:8px;right:8px;background:var(--surface);color:var(--muted);border:1px solid var(--border);padding:5px 10px;border-radius:6px;font-size:11px;cursor:pointer}</style></head><body><div class="sidebar"><div class="sidebar-header"><span class="logo-dot"></span><h1>ZETA-CORE API</h1></div><div class="sidebar-menu"><span class="sub-item active" onclick="switchTab('guide',this)">Dashboard</span><span class="sub-item" onclick="switchTab('downloaders',this)">Descargadores</span><span class="sub-item" onclick="switchTab('search',this)">Búsquedas</span></div></div><div class="main-content"><div class="card-wrapper"><div id="guide" class="card active"><h2>ZETA-CORE API v3.8 con youtubei.js</h2><p>Backend real, búsqueda real, videos reales. /ytmp3 /ytmp4 /ytsearch</p></div><div id="downloaders" class="card"><h2>Panel descargadores - JSON REAL</h2><div class="endpoint-block"><div class="route-path-box"><span id="routeTextYoutube">Ruta: /ytmp4?query=&quality=1080p</span></div><label>Termino o link:</label><input id="inputYoutube" placeholder="hola beba"><label>Tipo:</label><select id="selectYtType" onchange="actualizarInterfazYoutube()"><option value="video" selected>Video</option><option value="audio">Audio MP3</option></select><div id="groupQualityYoutube"><label>Calidad:</label><select id="selectYtQuality"><option value="1080p" selected>1080p</option><option value="720p">720p</option></select></div><button class="btn" onclick="ejecutarYoutubeCustom()">Procesar YouTube (devuelve JSON real)</button><div id="jsonContainerYoutube" class="json-box"><button class="btn-copy" onclick="copiarJson('jsonOutputYoutube')">Copiar JSON</button><pre id="jsonOutputYoutube">Esperando...</pre></div></div></div><div id="search" class="card"><h2>Búsquedas reales</h2><div class="endpoint-block"><input id="inputYt" placeholder="hola beba"><button class="btn" onclick="ejecutarBusqueda('ytsearch')">Buscar real en YouTube</button><div id="jsonContainerYt" class="json-box" style="display:block"><pre id="jsonOutputYt">Esperando...</pre></div></div></div></div></div><script>function switchTab(id,el){document.querySelectorAll('.sub-item').forEach(e=>e.classList.remove('active'));el.classList.add('active');document.querySelectorAll('.card').forEach(c=>c.classList.remove('active'));document.getElementById(id).classList.add('active')}function copiarJson(id){navigator.clipboard.writeText(document.getElementById(id).innerText)}function actualizarInterfazYoutube(){var t=document.getElementById('selectYtType').value;var q=document.getElementById('groupQualityYoutube');var r=document.getElementById('routeTextYoutube');if(t==='audio'){q.style.display='none';r.innerText='Ruta: /ytmp3?query='}else{q.style.display='block';r.innerText='Ruta: /ytmp4?query=&quality='+document.getElementById('selectYtQuality').value}}async function ejecutarYoutubeCustom(){var val=document.getElementById('inputYoutube').value.trim();var type=document.getElementById('selectYtType').value;var qual=document.getElementById('selectYtQuality').value;if(!val)return alert('Ingresa texto');var c=document.getElementById('jsonContainerYoutube');var o=document.getElementById('jsonOutputYoutube');c.style.display='block';o.innerText='Buscando video real para: '+val+'...';var url=type==='audio'?'/ytmp3?query='+encodeURIComponent(val):'/ytmp4?query='+encodeURIComponent(val)+'&quality='+qual;try{var res=await fetch(url);var data=await res.json();o.innerText=JSON.stringify(data,null,2)}catch(e){o.innerText='Error: '+e.message}}async function ejecutarBusqueda(ep){var val=document.getElementById('inputYt').value.trim();if(!val)return;var c=document.getElementById('jsonContainerYt');var o=document.getElementById('jsonOutputYt');c.style.display='block';o.innerText='Buscando...';try{var res=await fetch('/'+ep+'?query='+encodeURIComponent(val)+'&limit=5');var data=await res.json();o.innerText=JSON.stringify(data,null,2)}catch(e){o.innerText='Error: '+e.message}}</script></body></html>`);
    }

    res.setHeader('Cache-Control','no-store');
    const rateLimit = await secureApi.enforceRateLimit(req);
    if (!rateLimit.success) return sendJson(429,{ok:false,message:'Limite excedido'});
    const parentSignal = globalController.signal;

    if (pathname==='/ytsearch' || pathname==='/ttsearch') {
      if(!query) return sendJson(400,{ok:false,message:'Falta query'});
      try {
        const results = pathname==='/ytsearch'? await searchYoutube(query, limit) : await require('./documentos/ttsearch').searchTikTok(query, limit, parentSignal);
        return sendJson(200,{ok:true, source: pathname==='/ytsearch'?'youtube':'tiktok', query, total_results: results.length, results, requestId});
      } catch(e){ return sendJson(502,{ok:false,message:e.message, requestId}); }
    }
    if (pathname==='/ytmp3') {
      if(!query) return sendJson(400,{ok:false,message:'Falta query'});
      try {
        const {videoId,title,media}= await getYoutubeAudio(query);
        return sendJson(200,{ok:true,type:'audio',title,videoId,url:`https://www.youtube.com/watch?v=${videoId}`,download_url:media.url,download:media.url,quality:media.quality,thumbnail:`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,requestId});
      } catch(e){ return sendJson(e.statusCode||502,{ok:false,code:e.code||'UPSTREAM_ERROR',message:e.message,requestId}); }
    }
    if (pathname==='/ytmp4') {
      if(!query) return sendJson(400,{ok:false,message:'Falta query'});
      try {
        const {videoId,title,media}= await getYoutubeVideo(query, quality);
        return sendJson(200,{ok:true,type:'video',title,videoId,quality:media.quality,url:`https://www.youtube.com/watch?v=${videoId}`,download_url:media.url,download:media.url,thumbnail:`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,requestId});
      } catch(e){ return sendJson(e.statusCode||502,{ok:false,code:e.code||'UPSTREAM_ERROR',message:e.message,requestId}); }
    }
    if (pathname==='/tiktok') {
      if(!query) return sendJson(400,{ok:false,message:'Falta url'});
      try { return sendJson(200,{...(await extractTikTokVideo(query,parentSignal)),requestId}); } catch(e){ return sendJson(502,{ok:false,message:e.message}); }
    }
    if (pathname==='/xvideo') {
      if(!query) return sendJson(400,{ok:false,message:'Falta url'});
      try { return sendJson(200,{...(await fetchXVideo(query,parentSignal)),requestId}); } catch(e){ return sendJson(502,{ok:false,message:e.message}); }
    }
    return sendJson(404,{ok:false,message:'Endpoint no encontrado',requestId});
  } catch(error){
    return sendJson(500,{ok:false,message:error.message,requestId});
  } finally { clearTimeout(globalTimeout); }
};