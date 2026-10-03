const { URL } = require('url');
const { randomUUID } = require('node:crypto');
const secureApi = require('./secure-api');
const axios = require('axios');
const cheerio = require('cheerio');
const { searchYoutube } = require('./documentos/ytsearch');
const { searchTikTok } = require('./documentos/ttsearch');
const { extractTikTokVideo } = require('./documentos/tiktok');
const { getYoutubeAudio, downloadYoutubeAudio } = require('./documentos/ytmp3');
const { getYoutubeVideo, downloadYoutubeVideo } = require('./documentos/ytmp4');
const { fetchXVideo } = require('./documentos/xvideo');
const shared = require('./documentos/shared');
async function scrapeXnxxSearch(q, signal) {
  const { data } = await axios.get(`https://www.xnxx.com/search/${encodeURIComponent(q)}`, {
    headers: { 'User-Agent': shared?.UA || 'Mozilla/5.0' },
    signal
  });
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
  const { data } = await axios.get(`https://www.xvideos.com/?k=${encodeURIComponent(q)}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal
  });
  const $ = cheerio.load(data);
  let res = [];
  $('.thumb-block').each((i, el) => {
    const a = $(el).find('.thumb-under a');
    const img = $(el).find('img').attr('data-src') || $(el).find('img').attr('data-srcover') || $(el).find('img').attr('src');
    if (a.length) res.push({ title: a.attr('title')?.trim() || $(el).find('p a').text().trim(), url: 'https://www.xvideos.com' + a.attr('href'), thumb: img, duration: $(el).find('.duration').text().trim() });
  });
  return res.slice(0, 20);
}
async function scrapeXnxxDl(url, signal) {
  const { data } = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal });
  const $ = cheerio.load(data);
  const html = data.toString();
  const low = (html.match(/html5player\.setVideoUrlLow\('(.*?)'\)/) || [])[1] || '';
  const high = (html.match(/html5player\.setVideoUrlHigh\('(.*?)'\)/) || [])[1] || '';
  const hls = (html.match(/html5player\.setVideoUrlHls\('(.*?)'\)/) || [])[1] || '';
  return { title: $('h1').first().text().trim() || $('.video-hd-mark').text().trim(), thumb: $('meta[property="og:image"]').attr('content'), low, high, hls, download: high || low || hls };
}
async function scrapeXvideosDl(url, signal) {
  const { data } = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal });
  const html = data.toString();
  const low = (html.match(/html5player\.setVideoUrlLow\('(.*?)'\)/) || [])[1] || '';
  const high = (html.match(/html5player\.setVideoUrlHigh\('(.*?)'\)/) || [])[1] || '';
  const hls = (html.match(/html5player\.setVideoUrlHls\('(.*?)'\)/) || [])[1] || '';
  return { title: html.match(/<title>(.*?)<\/title>/)?.[1]?.trim(), low, high, hls, download: high || low || hls };
}
async function scrapeBlackbox(prompt, signal) {
  const { data } = await axios.post('https://www.blackbox.ai/api/chat', {
    messages: [{ role: 'user', content: prompt }],
    id: randomUUID(),
    previewToken: null,
    userId: randomUUID(),
    codeModelMode: true,
    trendingAgentMode: {},
    isMicMode: false,
    isChromeExt: false
  }, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/json' },
    signal
  });
  return typeof data === 'string'? data : data?.response || JSON.stringify(data);
}
module.exports = async function handler(req, res) {
  const requestId = randomUUID();
  const globalController = new AbortController();
  const globalTimeout = setTimeout(() => {
    globalController.abort(secureApi.apiError(504, 'Se agotó el tiempo total de la solicitud.'));
  }, 15000);
  const sendJson = (statusCode, payload) => {
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify(payload));
  };
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
    if (req.method!== 'GET' && req.method!== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return sendJson(405, { ok: false, message: 'Método no permitido. Utiliza GET o HEAD.', requestId });
    }
    if (req.method === 'HEAD') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end();
    }
    const rawQuery = parsedUrl.searchParams.get('query') || parsedUrl.searchParams.get('url') || parsedUrl.searchParams.get('prompt') || '';
    if (rawQuery.length > 500) {
      return sendJson(400, { ok: false, message: 'La longitud de la consulta excede el máximo permitido (500 caracteres).', requestId });
    }
    const query = rawQuery.trim();
    const type = (parsedUrl.searchParams.get('type') || 'video').toLowerCase();
    if (!['video', 'audio'].includes(type)) {
      return sendJson(400, { ok: false, message: 'El parámetro type debe ser video o audio.', requestId });
    }
    const quality = (parsedUrl.searchParams.get('quality') || '720p').toLowerCase();
    if (!['1080p', '720p', '480p', '360p'].includes(quality)) {
      return sendJson(400, { ok: false, message: 'El parámetro quality debe ser 1080p, 720p, 480p o 360p.', requestId });
    }
    const rawLimit = parsedUrl.searchParams.get('limit');
    if (rawLimit!== null &&!/^\d+$/.test(rawLimit)) {
      return sendJson(400, { ok: false, message: 'El parámetro limit debe ser un entero entre 1 y 20.', requestId });
    }
    const limit = rawLimit === null? 5 : Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
      return sendJson(400, { ok: false, message: 'El parámetro limit debe estar entre 1 y 20.', requestId });
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (pathname === '/' || pathname === '') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>ZETA-CORE API</title><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet"><style>:root{--bg:#0a0e14;--surface:#12161f;--border:#232936;--text:#e6e9ef;--muted:#8b93a3;--accent:#6366f1;--accent-2:#22c55e}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;justify-content:center;align-items:center;font-family:'Inter',sans-serif;background:var(--bg);color:var(--text)}.card{background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:48px 36px;max-width:440px;width:90%;text-align:center;box-shadow:0 20px 50px rgba(0,0,0,.45)}.badge{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--accent-2);margin-bottom:18px}.dot{width:7px;height:7px;border-radius:50%;background:var(--accent-2)}h1{font-size:26px;font-weight:800;margin:0 0 12px}p{color:var(--muted);font-size:15px;line-height:1.6;margin:0 0 28px}.btn{display:inline-block;padding:13px 28px;background:var(--accent);color:#fff;font-weight:700;font-size:14px;border:none;border-radius:12px;text-decoration:none}</style></head><body><div class="card"><div class="badge"><span class="dot"></span>Sistema operativo</div><h1>ZETA-CORE API</h1><p>Backend de alto rendimiento para YouTube, TikTok, X, +18 y IAs por scraping puro sin APIs externas.</p><a href="/docs" class="btn">Ver documentación</a></div></body></html>`);
    }
    if (pathname === '/docs') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>ZETA-CORE API | Documentación</title><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet"><style>:root{--bg:#0a0e14;--surface:#12161f;--surface-2:#171c27;--border:#232936;--text:#e6e9ef;--muted:#8b93a3;--accent:#6366f1;--accent-2:#22c55e;--code-bg:#0d1117}*{box-sizing:border-box}body{background:var(--bg);color:var(--text);font-family:'Inter',sans-serif;margin:0;display:flex;width:100%;min-height:100vh}.sidebar{width:280px;background:var(--surface);border-right:1px solid var(--border);display:flex;flex-direction:column;position:fixed;top:0;left:0;height:100vh;overflow-y:auto}.sidebar-header{padding:20px;display:flex;align-items:center;border-bottom:1px solid var(--border)}.logo-dot{width:10px;height:10px;border-radius:50%;background:var(--accent);margin-right:10px}.sidebar-header h1{font-size:15px;margin:0;font-weight:800}.sidebar-menu{padding:12px;display:flex;flex-direction:column;gap:4px;flex:1}.menu-category-title{font-size:11px;text-transform:uppercase;color:var(--muted);margin:16px 0 6px 12px;font-weight:700}.sub-item{padding:10px 14px;color:var(--muted);border-radius:8px;font-size:14px;cursor:pointer;font-weight:600;border-left:3px solid transparent}.sub-item.active{background:var(--surface-2);color:var(--text);border-left-color:var(--accent)}.main-content{width:100%;min-height:100vh;padding:40px 16px 40px 296px;display:flex;justify-content:center}.card-wrapper{width:100%;max-width:720px}.card{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:24px;width:100%;display:none;margin-bottom:18px}.card.active{display:block}.endpoint-block{background:var(--surface-2);border:1px solid var(--border);padding:18px;border-radius:12px;margin-bottom:16px}.route-path-box{display:flex;justify-content:space-between;background:var(--code-bg);border:1px solid var(--border);padding:8px 12px;border-radius:8px;margin-bottom:14px;font-family:monospace;font-size:12px;color:var(--muted)}.btn{padding:12px;border:none;border-radius:10px;font-weight:700;font-size:14px;cursor:pointer;width:100%;background:var(--accent);color:#fff}input,select{width:100%;padding:11px 13px;background:var(--code-bg);border:1px solid var(--border);color:var(--text);border-radius:10px;margin-bottom:14px;font-size:14px}pre{color:#9cdcfe;font-size:12px;overflow-x:auto;max-height:220px;margin:0;white-space:pre-wrap}</style></head><body><div class="sidebar"><div class="sidebar-header"><span class="logo-dot"></span><h1>ZETA-CORE API</h1></div><div class="sidebar-menu"><div class="menu-category-title">Sistema</div><span class="sub-item active" onclick="switchTab('guide',this)">Dashboard</span><div class="menu-category-title">Descargas</div><span class="sub-item" onclick="switchTab('downloaders',this)">YouTube / TikTok / X</span><span class="sub-item" onclick="switchTab('adult',this)">+18 XVideos / XNXX</span><div class="menu-category-title">Busquedas</div><span class="sub-item" onclick="switchTab('search',this)">YT / TT / +18</span><div class="menu-category-title">IAs</div><span class="sub-item" onclick="switchTab('ias',this)">GPT / BlackBox</span></div></div><div class="main-content"><div class="card-wrapper"><div id="guide" class="card active"><h2>ZETA-CORE API</h2><p>API multifuncional full scraping sin APIs externas.</p><p>Endpoints: /ytmp4 /ytmp3 /ytsearch /tiktok /ttsearch /xvideo /xnxxsearch /xvideosearch /xnxxdl /xvideodl /ai/blackbox</p></div><div id="downloaders" class="card"><h2>Descargas Normales</h2><div class="endpoint-block"><p>/ytmp4?query=&quality=1080p | /ytmp3?query= | /tiktok?url= | /xvideo?url=</p></div></div><div id="adult" class="card"><h2>Descargas +18 Full Scraping</h2><div class="endpoint-block"><p>/xnxxsearch?query= | /xvideosearch?query=</p><p>/xnxxdl?url= | /xvideodl?url=</p></div></div><div id="search" class="card"><h2>Busquedas</h2><div class="endpoint-block"><p>/ytsearch?query=&limit= | /ttsearch?query=&limit= | /xnxxsearch | /xvideosearch</p></div></div><div id="ias" class="card"><h2>IAs Sin API</h2><div class="endpoint-block"><p>/ai/blackbox?prompt= | /ai/gpt?prompt= (mismo scraper)</p></div></div></div></div><script>function switchTab(id,el){document.querySelectorAll('.sub-item').forEach(e=>e.classList.remove('active'));el.classList.add('active');document.querySelectorAll('.card').forEach(c=>c.classList.remove('active'));document.getElementById(id).classList.add('active')}</script></body></html>`);
    }
    res.setHeader('Cache-Control', 'no-store');
    const rateLimit = await secureApi.enforceRateLimit(req);
    res.setHeader('X-RateLimit-Remaining', String(rateLimit.remaining));
    if (!rateLimit.success) {
      res.setHeader('Retry-After', '60');
      return sendJson(429, { ok: false, message: 'Límite de solicitudes excedido.', requestId });
    }
    const parentSignal = globalController.signal;
    if (pathname === '/tiktok') {
      if (!query) return sendJson(400, { ok: false, message: 'Falta el parámetro url.', requestId });
      try { return sendJson(200, {...(await extractTikTokVideo(query, parentSignal)), requestId }); }
      catch (e) { return sendJson(e.statusCode || 502, { ok: false, message: secureApi.publicErrorMessage(e), requestId }); }
    }
    if (pathname === '/ytsearch' || pathname === '/ttsearch') {
      if (!query) return sendJson(400, { ok: false, message: 'Falta el parámetro query.', requestId });
      try {
        const results = pathname === '/ytsearch'? await searchYoutube(query, limit, parentSignal) : await searchTikTok(query, limit, parentSignal);
        if (!results.length) return sendJson(404, { ok: false, message: 'No se encontraron resultados.', requestId });
        return sendJson(200, { ok: true, source: pathname === '/ytsearch'? 'youtube' : 'tiktok', query, total_results: results.length, results, requestId });
      } catch (e) { return sendJson(e.statusCode || 502, { ok: false, message: secureApi.publicErrorMessage(e), requestId }); }
    }
    // === FIX YTMP3: DEVUELVE JSON REAL EN VEZ DE STREAM ===
    if (pathname === '/ytmp3') {
      if (!query) return sendJson(400, { ok: false, message: 'Falta el parámetro query o url.', requestId });
      try {
        const { videoId, title, media } = await getYoutubeAudio(query, parentSignal);
        return sendJson(200, {
          ok: true,
          type: 'audio',
          title,
          videoId,
          url: `https://www.youtube.com/watch?v=${videoId}`,
          download_url: media.url,
          download: media.url,
          quality: media.quality,
          thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
          requestId
        });
      } catch (e) {
        if (res.headersSent) return res.end();
        return sendJson(e.statusCode || 502, { ok: false, code: e.code || 'UPSTREAM_ERROR', message: secureApi.publicErrorMessage(e), requestId });
      }
    }
    // === FIX YTMP4: DEVUELVE JSON REAL EN VEZ DE STREAM ===
    if (pathname === '/ytmp4') {
      if (!query) return sendJson(400, { ok: false, message: 'Falta el parámetro query o url.', requestId });
      try {
        const { videoId, title, media } = await getYoutubeVideo(query, quality, parentSignal);
        return sendJson(200, {
          ok: true,
          type: 'video',
          title,
          videoId,
          quality: media.quality,
          url: `https://www.youtube.com/watch?v=${videoId}`,
          download_url: media.url,
          download: media.url,
          thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
          requestId
        });
      } catch (e) {
        if (res.headersSent) return res.end();
        return sendJson(e.statusCode || 502, { ok: false, code: e.code || 'UPSTREAM_ERROR', message: secureApi.publicErrorMessage(e), requestId });
      }
    }
    if (pathname === '/youtube') {
      if (!query) return sendJson(400, { ok: false, message: 'Falta el parámetro query o url.', requestId });
      try {
        const { videoId, title, media } = type === 'audio'? await getYoutubeAudio(query, parentSignal) : await getYoutubeVideo(query, quality, parentSignal);
        return sendJson(200, { ok: true, endpoint: 'youtube', type, quality: media.quality, input: query, title, videoId, resolved_url: `https://www.youtube.com/watch?v=${videoId}`, download_url: media.url, url: media.url, result: { title, type, quality: media.quality, url: `https://www.youtube.com/watch?v=${videoId}`, download: media.url, thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` }, requestId });
      } catch (e) { return sendJson(e.statusCode || 502, { ok: false, code: e.code || 'UPSTREAM_ERROR', message: secureApi.publicErrorMessage(e), requestId }); }
    }
    if (pathname === '/xvideo') {
      if (!query) return sendJson(400, { ok: false, message: 'Falta el enlace.', requestId });
      try { return sendJson(200, {...(await fetchXVideo(query, parentSignal)), requestId }); }
      catch (e) { return sendJson(e.statusCode || 502, { ok: false, message: secureApi.publicErrorMessage(e), requestId }); }
    }
    if (pathname === '/xnxxsearch') {
      if (!query) return sendJson(400, { ok: false, message: 'Falta query.', requestId });
      try { const results = await scrapeXnxxSearch(query, parentSignal); return sendJson(200, { ok: true, source: 'xnxx', query, total: results.length, results, requestId }); }
      catch (e) { return sendJson(502, { ok: false, message: e.message, requestId }); }
    }
    if (pathname === '/xvideosearch') {
      if (!query) return sendJson(400, { ok: false, message: 'Falta query.', requestId });
      try { const results = await scrapeXvideosSearch(query, parentSignal); return sendJson(200, { ok: true, source: 'xvideos', query, total: results.length, results, requestId }); }
      catch (e) { return sendJson(502, { ok: false, message: e.message, requestId }); }
    }
    if (pathname === '/xnxxdl') {
      if (!query) return sendJson(400, { ok: false, message: 'Falta url.', requestId });
      try { const data = await scrapeXnxxDl(query, parentSignal); return sendJson(200, { ok: true, source: 'xnxx', url: query,...data, requestId }); }
      catch (e) { return sendJson(502, { ok: false, message: e.message, requestId }); }
    }
    if (pathname === '/xvideodl') {
      if (!query) return sendJson(400, { ok: false, message: 'Falta url.', requestId });
      try { const data = await scrapeXvideosDl(query, parentSignal); return sendJson(200, { ok: true, source: 'xvideos', url: query,...data, requestId }); }
      catch (e) { return sendJson(502, { ok: false, message: e.message, requestId }); }
    }
    if (pathname === '/ai/blackbox' || pathname === '/ai/gpt' || pathname === '/blackbox' || pathname === '/gpt') {
      if (!query) return sendJson(400, { ok: false, message: 'Falta prompt.', requestId });
      try { const answer = await scrapeBlackbox(query, parentSignal); return sendJson(200, { ok: true, model: 'blackbox-scraped', prompt: query, response: answer, requestId }); }
      catch (e) { return sendJson(502, { ok: false, message: e.message, requestId }); }
    }
    return sendJson(404, { ok: false, message: 'Endpoint no encontrado.', requestId });
  } catch (error) {
    return sendJson(error.statusCode || 500, { ok: false, message: secureApi.publicErrorMessage(error), requestId });
  } finally {
    clearTimeout(globalTimeout);
  }
};