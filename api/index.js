const { URL } = require('url');
const { randomUUID } = require('node:crypto');
const secureApi = require('./secure-api');
const axios = require('axios');
const cheerio = require('cheerio');
const ytdl = require('@distube/ytdl-core');
const { searchYoutube } = require('./documentos/ytsearch');
const { searchTikTok } = require('./documentos/ttsearch');
const { extractTikTokVideo } = require('./documentos/tiktok');
const { fetchXVideo } = require('./documentos/xvideo');
const shared = require('./documentos/shared');

async function getYoutubeAudioFIX(query, signal) {
  let videoId = query;
  if (ytdl.validateURL(query)) videoId = ytdl.getVideoID(query);
  else {
    const s = await searchYoutube(query, 1, signal);
    if (!s.length) throw Object.assign(new Error('No se encontró video'), { statusCode: 404 });
    videoId = s[0].videoId || s[0].id;
  }
  const info = await ytdl.getInfo(`https://www.youtube.com/watch?v=${videoId}`, { requestOptions: { signal } });
  const format = ytdl.chooseFormat(info.formats, { quality: 'highestaudio', filter: 'audioonly' });
  if (!format ||!format.url) throw Object.assign(new Error('YouTube no ofreció audio compatible'), { statusCode: 502, code: 'YOUTUBE_FORMAT_UNAVAILABLE' });
  return { videoId, title: info.videoDetails.title, media: { url: format.url, quality: format.audioBitrate + 'kbps', mimeType: format.mimeType } };
}
async function getYoutubeVideoFIX(query, quality, signal) {
  let videoId = query;
  if (ytdl.validateURL(query)) videoId = ytdl.getVideoID(query);
  else {
    const s = await searchYoutube(query, 1, signal);
    if (!s.length) throw Object.assign(new Error('No se encontró video'), { statusCode: 404 });
    videoId = s[0].videoId || s[0].id;
  }
  const info = await ytdl.getInfo(`https://www.youtube.com/watch?v=${videoId}`, { requestOptions: { signal } });
  let format = ytdl.chooseFormat(info.formats, { quality: 'highest', filter: f => f.hasVideo && f.hasAudio });
  if (!format) format = ytdl.chooseFormat(info.formats, { quality: 'highest' });
  if (!format ||!format.url) throw Object.assign(new Error('YouTube no ofreció formato'), { statusCode: 502, code: 'YOUTUBE_FORMAT_UNAVAILABLE' });
  return { videoId, title: info.videoDetails.title, media: { url: format.url, quality: format.qualityLabel || quality, mimeType: format.mimeType } };
}
async function scrapeXnxxSearch(q, signal) {
  const { data } = await axios.get(`https://www.xnxx.com/search/${encodeURIComponent(q)}`, { headers: { 'User-Agent': shared?.UA || 'Mozilla/5.0' }, signal });
  const $ = cheerio.load(data);
  let res = [];
  $('.mozaique.thumb-block').each((i, el) => {
    const a = $(el).find('.thumb-under a');
    const img = $(el).find('img').attr('data-src') || $(el).find('img').attr('src');
    if (a.length) res.push({ title: a.attr('title')?.trim(), url: 'https://www.xnxx.com' + a.attr('href'), thumb: img, duration: $(el).find('.duration').text().trim() });
  });
  return res.slice(0, 20);
}
async function scrapeXvideosSearch(q, signal) {
  const { data } = await axios.get(`https://www.xvideos.com/?k=${encodeURIComponent(q)}`, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal });
  const $ = cheerio.load(data);
  let res = [];
  $('.thumb-block').each((i, el) => {
    const a = $(el).find('.thumb-under a');
    const img = $(el).find('img').attr('data-src') || $(el).find('img').attr('src');
    if (a.length) res.push({ title: a.attr('title')?.trim() || $(el).find('p a').text().trim(), url: 'https://www.xvideos.com' + a.attr('href'), thumb: img, duration: $(el).find('.duration').text().trim() });
  });
  return res.slice(0, 20);
}
async function scrapeXnxxDl(url, signal) {
  const { data } = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal });
  const low = (data.match(/html5player\.setVideoUrlLow\('(.*?)'\)/) || [])[1] || '';
  const high = (data.match(/html5player\.setVideoUrlHigh\('(.*?)'\)/) || [])[1] || '';
  const hls = (data.match(/html5player\.setVideoUrlHls\('(.*?)'\)/) || [])[1] || '';
  return { low, high, hls, download: high || low || hls };
}
async function scrapeXvideosDl(url, signal) {
  const { data } = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal });
  const low = (data.match(/html5player\.setVideoUrlLow\('(.*?)'\)/) || [])[1] || '';
  const high = (data.match(/html5player\.setVideoUrlHigh\('(.*?)'\)/) || [])[1] || '';
  const hls = (data.match(/html5player\.setVideoUrlHls\('(.*?)'\)/) || [])[1] || '';
  return { low, high, hls, download: high || low || hls };
}
async function scrapeBlackbox(prompt, signal) {
  const { data } = await axios.post('https://www.blackbox.ai/api/chat', { messages: [{ role: 'user', content: prompt }], id: randomUUID(), userId: randomUUID(), codeModelMode: true, trendingAgentMode: {} }, { headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' }, signal });
  return typeof data === 'string'? data : data?.response || JSON.stringify(data);
}

module.exports = async function handler(req, res) {
  const requestId = randomUUID();
  const globalController = new AbortController();
  const globalTimeout = setTimeout(() => { globalController.abort(secureApi.apiError(504, 'Timeout')); }, 15000);
  const sendJson = (statusCode, payload) => { res.statusCode = statusCode; res.setHeader('Content-Type', 'application/json; charset=utf-8'); return res.end(JSON.stringify(payload)); };
  try {
    const parsedUrl = new URL(req.url || '/', 'https://api.invalid');
    let pathname = parsedUrl.pathname.replace(/^\/api(?=\/|$)/, '');
    if (!pathname) pathname = '/';
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Strict-Transport-Security', 'max-age=63072000');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method!== 'GET' && req.method!== 'HEAD') { res.setHeader('Allow', 'GET, HEAD'); return sendJson(405, { ok: false, message: 'Método no permitido.', requestId }); }
    if (req.method === 'HEAD') { res.statusCode = 200; return res.end(); }
    const rawQuery = parsedUrl.searchParams.get('query') || parsedUrl.searchParams.get('url') || parsedUrl.searchParams.get('prompt') || '';
    if (rawQuery.length > 500) return sendJson(400, { ok: false, message: 'Consulta muy larga.', requestId });
    const query = rawQuery.trim();
    const quality = (parsedUrl.searchParams.get('quality') || '720p').toLowerCase();
    const rawLimit = parsedUrl.searchParams.get('limit');
    const limit = rawLimit === null? 5 : Number(rawLimit);
    if (pathname === '/' || pathname === '') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ZETA-CORE API</title><style>body{background:#0a0e14;color:#fff;font-family:Inter,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh}.card{background:#12161f;border:1px solid #232936;border-radius:20px;padding:40px;text-align:center} a{background:#6366f1;color:#fff;padding:12px 24px;border-radius:12px;text-decoration:none;font-weight:700}</style></head><body><div class="card"><h1>ZETA-CORE API</h1><p>Backend full scraping</p><a href="/docs">Ver docs</a></div></body></html>`);
    }
    if (pathname === '/docs') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>ZETA-CORE API | Docs</title><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet"><style>:root{--bg:#0a0e14;--surface:#12161f;--surface-2:#171c27;--border:#232936;--text:#e6e9ef;--muted:#8b93a3;--accent:#6366f1;--code-bg:#0d1117}*{box-sizing:border-box}body{background:var(--bg);color:var(--text);font-family:Inter,sans-serif;margin:0;display:flex}.sidebar{width:280px;background:var(--surface);border-right:1px solid var(--border);position:fixed;height:100vh;overflow-y:auto}.sidebar-header{padding:20px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px}.logo-dot{width:10px;height:10px;background:var(--accent);border-radius:50%}.sidebar-menu{padding:12px;display:flex;flex-direction:column;gap:4px}.menu-category-title{font-size:11px;text-transform:uppercase;color:var(--muted);margin:16px 0 6px 12px;font-weight:700}.sub-item{padding:10px 14px;color:var(--muted);border-radius:8px;font-size:14px;cursor:pointer;font-weight:600;border-left:3px solid transparent}.sub-item.active{background:var(--surface-2);color:var(--text);border-left-color:var(--accent)}.main-content{width:100%;padding:30px 16px 40px 296px;display:flex;justify-content:center}.card-wrapper{width:100%;max-width:720px}.card{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:24px;width:100%;display:none;margin-bottom:18px}.card.active{display:block}.endpoint-block{background:var(--surface-2);border:1px solid var(--border);padding:18px;border-radius:12px;margin-bottom:16px}.route-path-box{display:flex;justify-content:space-between;background:var(--code-bg);border:1px solid var(--border);padding:8px 12px;border-radius:8px;margin-bottom:14px;font-family:monospace;font-size:12px;color:var(--muted)}.btn{padding:12px;border:none;border-radius:10px;font-weight:700;font-size:14px;cursor:pointer;width:100%;background:var(--accent);color:#fff}input,select{width:100%;padding:11px 13px;background:var(--code-bg);border:1px solid var(--border);color:var(--text);border-radius:10px;margin-bottom:14px;font-size:14px}pre{color:#9cdcfe;font-size:12px;overflow-x:auto;max-height:300px;white-space:pre-wrap;margin:0}.json-box{background:var(--code-bg);border:1px solid var(--border);border-radius:10px;padding:14px;margin-top:14px;display:none;position:relative}.btn-copy{position:absolute;top:8px;right:8px;background:var(--surface);color:var(--muted);border:1px solid var(--border);padding:5px 10px;border-radius:6px;font-size:11px;cursor:pointer}</style></head><body><div class="sidebar"><div class="sidebar-header"><span class="logo-dot"></span><h1>ZETA-CORE API</h1></div><div class="sidebar-menu"><div class="menu-category-title">Sistema</div><span class="sub-item active" onclick="switchTab('guide',this)">Dashboard</span><div class="menu-category-title">Descargas</div><span class="sub-item" onclick="switchTab('downloaders',this)">YouTube / TikTok / X</span><span class="sub-item" onclick="switchTab('adult',this)">+18 XVideos / XNXX</span><div class="menu-category-title">Busquedas</div><span class="sub-item" onclick="switchTab('search',this)">YT / TT</span><div class="menu-category-title">IAs</div><span class="sub-item" onclick="switchTab('ias',this)">GPT / BlackBox</span></div></div><div class="main-content"><div class="card-wrapper"><div id="guide" class="card active"><h2>ZETA-CORE API</h2><p>API full scraping sin APIs externas. Endpoints: /ytmp3 /ytmp4 /ytsearch /tiktok /ttsearch /xvideo /xnxxsearch /xvideosearch /xnxxdl /xvideodl /ai/blackbox</p></div><div id="downloaders" class="card"><h2>Panel de descargadores</h2><div class="endpoint-block"><div class="route-path-box"><span id="routeTextYoutube">Ruta: /ytmp4?query=&quality=1080p</span><button class="btn-copy" onclick="copiarRuta(document.getElementById('routeTextYoutube').innerText.replace('Ruta: ',''))">Copiar</button></div><h3>YouTube Downloader (/ytmp3 y /ytmp4)</h3><label>Enlace o término:</label><input type="text" id="inputYoutube" placeholder="hola remix"><label>Tipo:</label><select id="selectYtType" onchange="actualizarInterfazYoutube()"><option value="video" selected>Video</option><option value="audio">Audio (MP3)</option></select><div id="groupQualityYoutube"><label>Calidad:</label><select id="selectYtQuality"><option value="1080p" selected>1080p (FHD)</option><option value="720p">720p (HD)</option><option value="480p">480p</option><option value="360p">360p</option></select></div><button class="btn" onclick="ejecutarYoutubeCustom()">Procesar YouTube</button><div id="jsonContainerYoutube" class="json-box"><button class="btn-copy" onclick="copiarJson('jsonOutputYoutube')">Copiar</button><pre id="jsonOutputYoutube">Esperando...</pre></div></div><div class="endpoint-block"><div class="route-path-box"><span>Ruta: /tiktok?url=</span><button class="btn-copy" onclick="copiarRuta('/tiktok?url=')">Copiar</button></div><h3>TikTok (/tiktok)</h3><input type="text" id="inputTikTok" placeholder="https://www.tiktok.com/..."><button class="btn" onclick="ejecutarAccion('tiktok','inputTikTok','jsonContainerTikTok','jsonOutputTikTok')">Extraer TikTok</button><div id="jsonContainerTikTok" class="json-box"><button class="btn-copy" onclick="copiarJson('jsonOutputTikTok')">Copiar</button><pre id="jsonOutputTikTok">Esperando...</pre></div></div></div><div id="search" class="card"><h2>Busquedas</h2><div class="endpoint-block"><div class="route-path-box"><span>Ruta: /ytsearch?query=&limit=</span><button class="btn-copy" onclick="copiarRuta('/ytsearch?query=&limit=')">Copiar</button></div><h3>YouTube Search</h3><input type="text" id="inputYt" placeholder="hola remix"><button class="btn" onclick="ejecutarBusqueda('ytsearch')">Buscar</button><div id="jsonContainerYt" class="json-box" style="display:block"><pre id="jsonOutputYt">Esperando...</pre></div></div></div><div id="adult" class="card"><h2>+18 Full Scraping</h2><div class="endpoint-block"><p>/xnxxsearch?query= | /xvideosearch?query= | /xnxxdl?url= | /xvideodl?url=</p></div></div><div id="ias" class="card"><h2>IAs</h2><div class="endpoint-block"><p>/ai/blackbox?prompt= | /ai/gpt?prompt=</p></div></div></div></div><script>function switchTab(id,el){document.querySelectorAll('.sub-item').forEach(e=>e.classList.remove('active'));el.classList.add('active');document.querySelectorAll('.card').forEach(c=>c.classList.remove('active'));document.getElementById(id).classList.add('active')}function copiarRuta(t){navigator.clipboard.writeText(t)}function copiarJson(id){navigator.clipboard.writeText(document.getElementById(id).innerText)}function actualizarInterfazYoutube(){var type=document.getElementById('selectYtType').value;var q=document.getElementById('groupQualityYoutube');var r=document.getElementById('routeTextYoutube');if(type==='audio'){q.style.display='none';r.innerText='Ruta: /ytmp3?query='}else{q.style.display='block';var qual=document.getElementById('selectYtQuality').value;r.innerText='Ruta: /ytmp4?query=&quality='+qual}}async function ejecutarYoutubeCustom(){var val=document.getElementById('inputYoutube').value.trim();var type=document.getElementById('selectYtType').value;var qual=document.getElementById('selectYtQuality').value;if(!val){alert('Ingresa texto');return}var c=document.getElementById('jsonContainerYoutube');var o=document.getElementById('jsonOutputYoutube');c.style.display='block';o.innerText='Procesando...';var url=type==='audio'?'/ytmp3?query='+encodeURIComponent(val):'/ytmp4?query='+encodeURIComponent(val)+'&quality='+qual;try{var res=await fetch(url);var data=await res.json();o.innerText=JSON.stringify(data,null,2)}catch(e){o.innerText='Error: '+e.message}}async function ejecutarAccion(ep,inputId,containerId,outputId){var val=document.getElementById(inputId).value.trim();if(!val){alert('Ingresa url');return}var c=document.getElementById(containerId);var o=document.getElementById(outputId);c.style.display='block';o.innerText='Procesando...';try{var res=await fetch('/'+ep+'?url='+encodeURIComponent(val));var data=await res.json();o.innerText=JSON.stringify(data,null,2)}catch(e){o.innerText='Error: '+e.message}}async function ejecutarBusqueda(ep){var val=document.getElementById(ep==='ytsearch'?'inputYt':'inputTt').value.trim();if(!val)return;var c=document.getElementById(ep==='ytsearch'?'jsonContainerYt':'jsonContainerTt');var o=document.getElementById(ep==='ytsearch'?'jsonOutputYt':'jsonOutputTt');c.style.display='block';o.innerText='Buscando...';try{var res=await fetch('/'+ep+'?query='+encodeURIComponent(val)+'&limit=5');var data=await res.json();o.innerText=JSON.stringify(data,null,2)}catch(e){o.innerText='Error: '+e.message}}</script></body></html>`);
    }
    res.setHeader('Cache-Control', 'no-store');
    const rateLimit = await secureApi.enforceRateLimit(req);
    res.setHeader('X-RateLimit-Remaining', String(rateLimit.remaining));
    if (!rateLimit.success) { res.setHeader('Retry-After', '60'); return sendJson(429, { ok: false, message: 'Límite excedido.', requestId }); }
    const parentSignal = globalController.signal;
    if (pathname === '/tiktok') {
      if (!query) return sendJson(400, { ok: false, message: 'Falta url.', requestId });
      try { return sendJson(200, {...(await extractTikTokVideo(query, parentSignal)), requestId }); } catch (e) { return sendJson(e.statusCode || 502, { ok: false, message: secureApi.publicErrorMessage(e), requestId }); }
    }
    if (pathname === '/ytsearch' || pathname === '/ttsearch') {
      if (!query) return sendJson(400, { ok: false, message: 'Falta query.', requestId });
      try {
        const results = pathname === '/ytsearch'? await searchYoutube(query, limit, parentSignal) : await searchTikTok(query, limit, parentSignal);
        return sendJson(200, { ok: true, source: pathname === '/ytsearch'? 'youtube' : 'tiktok', query, total_results: results.length, results, requestId });
      } catch (e) { return sendJson(e.statusCode || 502, { ok: false, message: secureApi.publicErrorMessage(e), requestId }); }
    }
    if (pathname === '/ytmp3') {
      if (!query) return sendJson(400, { ok: false, message: 'Falta query.', requestId });
      try {
        const { videoId, title, media } = await getYoutubeAudioFIX(query, parentSignal);
        return sendJson(200, { ok: true, type: 'audio', title, videoId, url: `https://www.youtube.com/watch?v=${videoId}`, download_url: media.url, download: media.url, quality: media.quality, thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`, requestId });
      } catch (e) { return sendJson(e.statusCode || 502, { ok: false, code: e.code || 'UPSTREAM_ERROR', message: secureApi.publicErrorMessage(e), requestId }); }
    }
    if (pathname === '/ytmp4') {
      if (!query) return sendJson(400, { ok: false, message: 'Falta query.', requestId });
      try {
        const { videoId, title, media } = await getYoutubeVideoFIX(query, quality, parentSignal);
        return sendJson(200, { ok: true, type: 'video', title, videoId, quality: media.quality, url: `https://www.youtube.com/watch?v=${videoId}`, download_url: media.url, download: media.url, thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`, requestId });
      } catch (e) { return sendJson(e.statusCode || 502, { ok: false, code: e.code || 'UPSTREAM_ERROR', message: secureApi.publicErrorMessage(e), requestId }); }
    }
    if (pathname === '/youtube') {
      if (!query) return sendJson(400, { ok: false, message: 'Falta query.', requestId });
      try {
        const data = (parsedUrl.searchParams.get('type') || 'video') === 'audio'? await getYoutubeAudioFIX(query, parentSignal) : await getYoutubeVideoFIX(query, quality, parentSignal);
        return sendJson(200, { ok: true,...data, requestId });
      } catch (e) { return sendJson(e.statusCode || 502, { ok: false, message: secureApi.publicErrorMessage(e), requestId }); }
    }
    if (pathname === '/xvideo') { if (!query) return sendJson(400, { ok: false, message: 'Falta url.', requestId }); try { return sendJson(200, {...(await fetchXVideo(query, parentSignal)), requestId }); } catch (e) { return sendJson(502, { ok: false, message: secureApi.publicErrorMessage(e), requestId }); } }
    if (pathname === '/xnxxsearch') { if (!query) return sendJson(400, { ok: false, message: 'Falta query.', requestId }); try { const r = await scrapeXnxxSearch(query, parentSignal); return sendJson(200, { ok: true, source: 'xnxx', query, total: r.length, results: r, requestId }); } catch (e) { return sendJson(502, { ok: false, message: e.message, requestId }); } }
    if (pathname === '/xvideosearch') { if (!query) return sendJson(400, { ok: false, message: 'Falta query.', requestId }); try { const r = await scrapeXvideosSearch(query, parentSignal); return sendJson(200, { ok: true, source: 'xvideos', query, total: r.length, results: r, requestId }); } catch (e) { return sendJson(502, { ok: false, message: e.message, requestId }); } }
    if (pathname === '/xnxxdl') { if (!query) return sendJson(400, { ok: false, message: 'Falta url.', requestId }); try { const d = await scrapeXnxxDl(query, parentSignal); return sendJson(200, { ok: true, source: 'xnxx', url: query,...d, requestId }); } catch (e) { return sendJson(502, { ok: false, message: e.message, requestId }); } }
    if (pathname === '/xvideodl') { if (!query) return sendJson(400, { ok: false, message: 'Falta url.', requestId }); try { const d = await scrapeXvideosDl(query, parentSignal); return sendJson(200, { ok: true, source: 'xvideos', url: query,...d, requestId }); } catch (e) { return sendJson(502, { ok: false, message: e.message, requestId }); } }
    if (pathname === '/ai/blackbox' || pathname === '/ai/gpt' || pathname === '/blackbox' || pathname === '/gpt') { if (!query) return sendJson(400, { ok: false, message: 'Falta prompt.', requestId }); try { const ans = await scrapeBlackbox(query, parentSignal); return sendJson(200, { ok: true, model: 'blackbox-scraped', prompt: query, response: ans, requestId }); } catch (e) { return sendJson(502, { ok: false, message: e.message, requestId }); } }
    return sendJson(404, { ok: false, message: 'Endpoint no encontrado.', requestId });
  } catch (error) { return sendJson(error.statusCode || 500, { ok: false, message: secureApi.publicErrorMessage(error), requestId }); } finally { clearTimeout(globalTimeout); }
};