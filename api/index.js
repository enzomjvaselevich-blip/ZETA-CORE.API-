const { URL } = require('url');
const { randomUUID } = require('node:crypto');

module.exports = async function handler(req, res) {
  const requestId = randomUUID();
  const sendJson = (c,p) => { res.statusCode=c; res.setHeader('Content-Type','application/json; charset=utf-8'); return res.end(JSON.stringify(p)); };
  try {
    const parsedUrl = new URL(req.url || '/', 'https://api.invalid');
    let pathname = parsedUrl.pathname.replace(/^\/api(?=\/|$)/, '');
    if (!pathname) pathname='/';
    res.setHeader('X-Request-Id',requestId);
    res.setHeader('Access-Control-Allow-Origin','*');

    if (pathname==='/' || pathname==='' || pathname==='/docs') {
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
      return res.end(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ZETA-CORE API - FIXED</title><style>body{background:#0a0e14;color:#fff;font-family:sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh} .card{background:#12161f;border:1px solid #232936;border-radius:20px;padding:40px;text-align:center;max-width:600px} input{width:100%;padding:12px;margin:10px 0;border-radius:10px;border:1px solid #232936;background:#0d1117;color:#fff} .btn{background:#6366f1;color:#fff;padding:12px 24px;border:none;border-radius:12px;font-weight:700;width:100%;cursor:pointer} pre{color:#9cdcfe;text-align:left;white-space:pre-wrap;max-height:400px;overflow:auto;background:#0d1117;padding:12px;border-radius:10px}</style></head><body><div class="card"><h1>ZETA-CORE API - FIXED</h1><p>API funcionando sin 500. Prueba real:</p><input id="q" placeholder="hola beba"><select id="t"><option value="audio">Audio MP3</option><option value="video" selected>Video MP4</option></select><button class="btn" onclick="test()">Probar /ytmp3 y /ytmp4 (JSON REAL)</button><pre id="out">Esperando...</pre></div><script>async function test(){let q=document.getElementById('q').value;let t=document.getElementById('t').value;let url=t==='audio'?'/ytmp3?query='+encodeURIComponent(q):'/ytmp4?query='+encodeURIComponent(q);document.getElementById('out').innerText='Buscando '+q+'...';let r=await fetch(url);let j=await r.json();document.getElementById('out').innerText=JSON.stringify(j,null,2)}</script></body></html>`);
    }

    const rawQuery = parsedUrl.searchParams.get('query') || parsedUrl.searchParams.get('url') || parsedUrl.searchParams.get('prompt') || '';
    const query = rawQuery.trim();
    const quality = (parsedUrl.searchParams.get('quality')||'720p');
    const limit = Number(parsedUrl.searchParams.get('limit')||5);
    if (!query) return sendJson(400,{ok:false,message:'Falta query'});

    if (pathname==='/ytmp3' || pathname==='/ytmp4' || pathname==='/youtube' || pathname==='/ytsearch') {
      const mod = await import('youtubei.js');
      const Innertube = mod.Innertube;
      const yt = await Innertube.create({generate_session:false});
      let videoId = query;
      const m = query.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
      if (m) videoId = m[1];
      else if (!/^[a-zA-Z0-9_-]{11}$/.test(query)) {
        const s = await yt.search(query,{type:'video'});
        const first = s.results?.find(v=>v.id);
        if (!first) return sendJson(404,{ok:false,message:'No se encontró nada para: '+query});
        videoId = first.id;
      }
      if (pathname==='/ytsearch') {
        const s = await yt.search(query,{type:'video'});
        const results = (s.results||[]).filter(v=>v.id).slice(0,limit).map(v=>({videoId:v.id,title:v.title?.text,url:`https://www.youtube.com/watch?v=${v.id}`,thumbnail:`https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`}));
        return sendJson(200,{ok:true,source:'youtube',query,total_results:results.length,results,requestId});
      }
      const info = await yt.getInfo(videoId);
      const type = pathname==='/ytmp3' ? 'audio' : 'video+audio';
      const format = info.chooseFormat({type,quality:'best'});
      if (!format || !format.url) return sendJson(502,{ok:false,code:'YOUTUBE_FORMAT_UNAVAILABLE',message:'YouTube no dio formato'});
      return sendJson(200,{ok:true,type: pathname==='/ytmp3'?'audio':'video',title: info.basic_info.title,videoId,url:`https://www.youtube.com/watch?v=${videoId}`,download_url:format.url,download:format.url,quality:format.quality_label||quality,thumbnail:`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,requestId});
    }

    // Resto de endpoints cargan lazy para no tumbar la API
    if (pathname==='/tiktok' || pathname==='/ttsearch') {
      try {
        const { searchTikTok } = require('./documentos/ttsearch');
        const { extractTikTokVideo } = require('./documentos/tiktok');
        if (pathname==='/ttsearch') return sendJson(200,{ok:true,results:await searchTikTok(query,limit)});
        return sendJson(200,{...(await extractTikTokVideo(query))});
      } catch(e){ return sendJson(502,{ok:false,message:e.message}); }
    }
    if (pathname==='/xvideo' || pathname==='/x') {
      try {
        const { fetchXVideo } = require('./documentos/xvideo');
        return sendJson(200,{...(await fetchXVideo(query))});
      } catch(e){ return sendJson(502,{ok:false,message:e.message}); }
    }

    return sendJson(404,{ok:false,message:'Endpoint no encontrado: '+pathname});
  } catch(error){
    return sendJson(500,{ok:false,code:error.code||'ERR',message:error.message,stack:error.stack?.slice(0,500)});
  }
};