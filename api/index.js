const { URL } = require('url');
const { randomUUID } = require('node:crypto');
const secureApi = require('./secure-api');


async function fetchRealSearchResults(query, limit, platform) {
  let results = [];
  const searchUrl = platform === 'youtube'
    ? 'https://www.youtube.com/results?search_query=' + encodeURIComponent(query)
    : 'https://www.tiktok.com/search?q=' + encodeURIComponent(query);
  const { signal, cleanup } = createCombinedSignal(parentSignal, 5000);
  try {
    const response = await fetch(searchUrl, {
      signal: signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8'
      }
    });
    if (!response.ok) {
      const err = new Error(`El servicio de ${platform} respondió con un error remoto HTTP ${response.status}`);
      err.statusCode = 502;
      throw err;
    }
    const html = await readTextWithLimit(response, 4 * 1024 * 1024);
    if (platform === 'youtube') {
      const match = html.match(/var ytInitialData = ({[\s\S]*?});<\/script>/) || html.match(/window\["ytInitialData"\] = ({[\s\S]*?});<\/script>/);
      if (match && match[1]) {
        try {
          const json = JSON.parse(match[1]);
          const contents = json.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents;
          if (contents) {
            for (let i = 0; i < contents.length; i++) {
              const itemRenderer = contents[i]?.itemSectionRenderer?.contents;
              if (itemRenderer) {
                for (let j = 0; j < itemRenderer.length; j++) {
                  const video = itemRenderer[j]?.videoRenderer;
                  if (video && video.videoId) {
                    const vidId = video.videoId;
                    const title = video.title?.runs?.[0]?.text || query;
                    if (!results.some(r => r.videoId === vidId)) {
                      results.push({ type: 'video', videoId: vidId, title: title, url: 'https://www.youtube.com/watch?v=' + vidId });
                    }
                    if (results.length >= limit) break;
                  }
                }
              }
              if (results.length >= limit) break;
            }
          }
        } catch (parseErr) {}
      }
      if (results.length === 0) {
        const regex = /"videoId":"([a-zA-Z0-9_-]{11})"/g;
        let sm;
        while ((sm = regex.exec(html)) !== null) {
          const vidId = sm[1];
          if (!results.some(r => r.videoId === vidId) && vidId !== 'dQw4w9WgXcQ') {
            results.push({ type: 'video', videoId: vidId, title: query + ' - Resultado #' + (results.length + 1), url: 'https://www.youtube.com/watch?v=' + vidId });
          }
          if (results.length >= limit) break;
        }
      }
    } else {
      const regex = /"id":"(\d+)","desc":"([^"]+)"/g;
      let match;
      while ((match = regex.exec(html)) !== null) {
        const tId = match[1];
        const desc = match[2];
        if (!results.some(r => r.videoId === tId)) {
          results.push({ type: 'video', videoId: tId, title: desc, url: 'https://www.tiktok.com/video/' + tId });
        }
        if (results.length >= limit) break;
      }
    }
    return results;
  } catch (e) {
    if (e.name === 'AbortError' || e.statusCode === 504) {
      const err = new Error(`Tiempo de espera agotado al consultar ${platform}.`);
      err.statusCode = 504;
      throw err;
    }
    if (!e.statusCode) e.statusCode = 502;
    throw e;
  } finally {
    cleanup();
  }
}
async function fetchYoutubeMedia(videoId, type, quality, parentSignal) {
  const { signal, cleanup } = createCombinedSignal(parentSignal, 5000);
  try {
    const response = await fetch('https://www.youtube.com/watch?v=' + videoId, {
      signal: signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept-Language': 'es-ES,es;q=0.9'
      }
    });
    if (!response.ok) {
      const err = new Error(`YouTube respondió con un estado de error HTTP ${response.status}`);
      err.statusCode = 502;
      throw err;
    }
    const html = await readTextWithLimit(response, 4 * 1024 * 1024);
    const playerMatch = html.match(/ytInitialPlayerResponse\s*=\s*({.+?});<\/script>/) || html.match(/var ytInitialPlayerResponse\s*=\s*({.+?});<\/script>/);
    if (playerMatch && playerMatch[1]) {
      try {
        const playerData = JSON.parse(playerMatch[1]);
        const streamingData = playerData.streamingData;
        if (streamingData) {
          const allFormats = [...(streamingData.adaptiveFormats || []), ...(streamingData.formats || [])];
          if (type === 'audio') {
            let audioFormats = allFormats.filter(f => f.mimeType && f.mimeType.includes('audio/') && f.url);
            audioFormats.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
            let audioFormat = audioFormats[0] || allFormats.find(f => f.url && f.mimeType && f.mimeType.includes('audio/'));
            if (audioFormat && audioFormat.url) {
              return { url: audioFormat.url, quality: 'audio-128kbps', bitrate: audioFormat.bitrate || 128000 };
            }
          } else {
            let targetHeight = 720;
            if (quality === '1080p') targetHeight = 1080;
            else if (quality === '480p') targetHeight = 480;
            else if (quality === '360p') targetHeight = 360;
            else if (quality === '720p') targetHeight = 720;
            let videoFormat = allFormats.find(f => f.height === targetHeight && f.url && f.mimeType.includes('video/'));
            if (!videoFormat) {
              videoFormat = allFormats.find(f => f.url && f.mimeType.includes('video/'));
            }
            if (videoFormat && videoFormat.url) {
              return { url: videoFormat.url, quality: (videoFormat.height ? videoFormat.height + 'p' : quality), bitrate: videoFormat.bitrate || null };
            }
          }
        }
      } catch (err) {}
    }
    const notFoundErr = new Error("No se pudo extraer el enlace directo de descarga desde el contenido de YouTube.");
    notFoundErr.statusCode = 404;
    throw notFoundErr;
  } catch (e) {
    if (e.name === 'AbortError' || e.statusCode === 504) {
      const err = new Error("Tiempo de espera agotado al comunicarse con YouTube.");
      err.statusCode = 504;
      throw err;
    }
    if (!e.statusCode) e.statusCode = 502;
    throw e;
  } finally {
    cleanup();
  }
}
async function fetchXVideo(inputUrl, parentSignal) {
  let tweetId = null;
  try {
    const u = new URL(inputUrl);
    if (u.protocol !== 'https:') {
      const err = new Error('Solo se aceptan URLs con protocolo HTTPS.');
      err.statusCode = 400;
      throw err;
    }
    const host = u.hostname.toLowerCase();
    const validXHosts = ['twitter.com', 'www.twitter.com', 'x.com', 'www.x.com'];
    if (!validXHosts.includes(host)) {
      const err = new Error('Dominio no permitido. Debe ser x.com o twitter.com.');
      err.statusCode = 400;
      throw err;
    }
    const match = u.pathname.match(/(?:status|i\/status)\/(\d{15,20})/);
    if (match) tweetId = match[1];
  } catch (e) {
    if (e.statusCode) throw e;
    const err = new Error('Estructura de URL de X/Twitter inválida.');
    err.statusCode = 400;
    throw err;
  }
  if (!tweetId) {
    const err = new Error('No se pudo extraer un ID de tweet válido desde la URL proporcionada.');
    err.statusCode = 400;
    throw err;
  }
  const result = { ok: true, endpoint: 'xvideo', input: inputUrl, tweet_id: tweetId, videos: [], thumbnail: null, text: null };
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,es;q=0.8'
  };
  let lastError = null;
  const tryUrls = ['https://cdn.syndication.twimg.com/tweet-result?id=' + tweetId + '&lang=en', 'https://api.fxtwitter.com/status/' + tweetId];
  for (let i = 0; i < tryUrls.length; i++) {
    if (parentSignal && parentSignal.aborted) {
      const err = new Error('Límite de tiempo global alcanzado para la solicitud.');
      err.statusCode = 504;
      throw err;
    }
    const { signal, cleanup } = createCombinedSignal(parentSignal, 3000);
    try {
      const response = await fetch(tryUrls[i], { headers, signal });
      if (response.ok) {
        const textResp = await readTextWithLimit(response, 2 * 1024 * 1024);
        if (tryUrls[i].includes('fxtwitter')) {
          const fxData = JSON.parse(textResp);
          if (fxData.tweet) {
            result.text = fxData.tweet.text || null;
            result.thumbnail = (fxData.tweet.media?.photos?.[0]?.url) || (fxData.tweet.media?.videos?.[0]?.thumbnail_url) || null;
            const vids = fxData.tweet.media?.videos || [];
            for (let v = 0; v < vids.length; v++) {
              if (vids[v].url) result.videos.push({ url: vids[v].url, quality: vids[v].quality || 'unknown', type: 'video/mp4' });
            }
          }
        } else {
          const mp4Regex = /https:\/\/video\.twimg\.com\/[^"'\s\\]+\.mp4[^"'\s\\]*/g;
          const found = {};
          let m;
          while ((m = mp4Regex.exec(textResp)) !== null) {
            let clean = m[0].replace(/\\u0026/g, '&').replace(/\\"/g, '').replace(/\\/g, '');
            if (!found[clean] && clean.includes('video.twimg.com')) {
              found[clean] = true;
              result.videos.push({ url: clean, quality: clean.includes('720') ? '720p' : clean.includes('360') ? '360p' : clean.includes('480') ? '480p' : 'unknown', type: 'video/mp4' });
            }
          }
        }
        if (result.videos.length > 0) {
          cleanup();
          break;
        }
      }
    } catch (e) {
      lastError = e;
    } finally {
      cleanup();
    }
  }
  if (result.videos.length > 0) {
    result.total_videos = result.videos.length;
    result.best = result.videos[0].url;
    return result;
  }
  if (lastError && (lastError.name === 'AbortError' || lastError.statusCode === 504)) {
    const err = new Error('Tiempo de espera agotado al consultar los servidores de X/Twitter.');
    err.statusCode = 504;
    throw err;
  }
  if (lastError && lastError.statusCode && lastError.statusCode !== 404) {
    throw lastError;
  }
  const notFoundErr = new Error('No se encontraron videos disponibles en el tweet indicado.');
  notFoundErr.statusCode = 404;
  throw notFoundErr;
}
async function fetchTikTokVideo(initialUrl, parentSignal) {
  let currentUrl = initialUrl;
  let redirects = 0;
  const maxRedirects = 5;
  while (redirects < maxRedirects) {
    let parsedUrl;
    try {
      parsedUrl = new URL(currentUrl);
    } catch (err) {
      const e = new Error('La URL proporcionada no es válida.');
      e.statusCode = 400;
      throw e;
    }
    if (parsedUrl.protocol !== 'https:' || !isValidTikTokDomain(parsedUrl.hostname) || parsedUrl.port !== '' || parsedUrl.username !== '' || parsedUrl.password !== '') {
      const e = new Error('Bloqueo de seguridad: Solo se permiten conexiones HTTPS directas a dominios oficiales de TikTok.');
      e.statusCode = 400;
      throw e;
    }
    const { signal, cleanup } = createCombinedSignal(parentSignal, 4500);
    try {
      const response = await fetch(currentUrl, {
        signal: signal,
        redirect: 'manual',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8'
        }
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) {
          const e = new Error('Redirección remota sin encabezado Location válido.');
          e.statusCode = 502;
          throw e;
        }
        currentUrl = new URL(location, currentUrl).href;
        redirects++;
        continue;
      }
      if (!response.ok) {
        const e = new Error(`El servidor de TikTok respondió con estado HTTP ${response.status}`);
        e.statusCode = 502;
        throw e;
      }
      const html = await readTextWithLimit(response, 4 * 1024 * 1024);
      let vData = null;
      const univMatch = html.match(/id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([^<]+)<\/script>/);
      if (univMatch) {
        try {
          const univ = JSON.parse(univMatch[1]);
          vData = univ.__DEFAULT_SCOPE__['webapp.video-detail']?.itemInfo?.itemStruct;
        } catch (pErr) {}
      } else {
        const sigiMatch = html.match(/window\['SIGI_STATE'\]=(.*?);window\['SIGI_RETRY'\]/);
        if (sigiMatch) {
          try {
            const sigi = JSON.parse(sigiMatch[1]);
            const itemId = Object.keys(sigi.ItemModule)[0];
            vData = sigi.ItemModule[itemId];
          } catch (pErr) {}
        }
      }
      if (!vData) {
        const e = new Error("No se encontraron metadatos de video válidos en el contenido de TikTok.");
        e.statusCode = 404;
        throw e;
      }
      return {
        creator: "Jxmpier207",
        status: true,
        data: {
          id: vData.id || "",
          url: initialUrl,
          type: "video",
          title: vData.desc || "",
          cover: vData.video?.cover || "",
          duration: vData.video?.duration || 0,
          links: {
            hd: vData.video?.playAddr || "",
            sd: vData.video?.playAddr || "",
            wm: vData.video?.downloadAddr || "",
            mp3: vData.music?.playUrl || ""
          },
          author: {
            username: vData.author?.uniqueId || "",
            nickname: vData.author?.nickname || "",
            avatar: vData.author?.avatarLarger || ""
          }
        }
      };
    } catch (e) {
      if (e.name === 'AbortError' || e.statusCode === 504) {
        const err = new Error('Tiempo de espera agotado al conectar con TikTok.');
        err.statusCode = 504;
        throw err;
      }
      if (!e.statusCode) e.statusCode = 502;
      throw e;
    } finally {
      cleanup();
    }
  }
  const maxRedirErr = new Error('Se superó el límite máximo de redirecciones permitidas.');
  maxRedirErr.statusCode = 400;
  throw maxRedirErr;
}
module.exports = async function handler(req, res) {
  const requestId = randomUUID();
  const globalController = new AbortController();
  const globalTimeout = setTimeout(() => {
    globalController.abort(secureApi.apiError(504, 'Se agotó el tiempo total de la solicitud.'));
  }, 8500);
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

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return sendJson(405, { ok: false, message: 'Método no permitido. Utiliza GET o HEAD.', requestId });
    }
    if (req.method === 'HEAD') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end();
    }

    const rawQuery = parsedUrl.searchParams.get('query') || parsedUrl.searchParams.get('url') || '';
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
    if (rawLimit !== null && !/^\d+$/.test(rawLimit)) {
      return sendJson(400, { ok: false, message: 'El parámetro limit debe ser un entero entre 1 y 20.', requestId });
    }
    const limit = rawLimit === null ? 5 : Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
      return sendJson(400, { ok: false, message: 'El parámetro limit debe estar entre 1 y 20.', requestId });
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    if (pathname === '/' || pathname === '') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ZETA-CORE API</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
:root{--bg:#0a0e14;--surface:#12161f;--border:#232936;--text:#e6e9ef;--muted:#8b93a3;--accent:#6366f1;--accent-2:#22c55e}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;justify-content:center;align-items:center;font-family:'Inter',system-ui,sans-serif;background:var(--bg);color:var(--text)}
.card{background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:48px 36px;max-width:440px;width:90%;text-align:center;box-shadow:0 20px 50px rgba(0,0,0,.45)}
.badge{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--accent-2);margin-bottom:18px}
.dot{width:7px;height:7px;border-radius:50%;background:var(--accent-2)}
h1{font-size:26px;font-weight:800;letter-spacing:-.01em;margin:0 0 12px}
p{color:var(--muted);font-size:15px;line-height:1.6;margin:0 0 28px}
.btn{display:inline-block;padding:13px 28px;background:var(--accent);color:#fff;font-weight:700;font-size:14px;border:none;border-radius:12px;text-decoration:none;transition:background-color .15s ease}
.btn:hover{background:#4f52e0}
</style>
</head>
<body>
<div class="card">
  <div class="badge"><span class="dot"></span>Sistema operativo</div>
  <h1>ZETA-CORE API</h1>
  <p>Backend de alto rendimiento para extracción de medios de YouTube, TikTok y X, con seguridad reforzada y límites de uso integrados.</p>
  <a href="/docs" class="btn">Ver documentación</a>
</div>
</body>
</html>`);
    }
    if (pathname === '/docs') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ZETA-CORE API | Documentación</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
:root{--bg:#0a0e14;--surface:#12161f;--surface-2:#171c27;--border:#232936;--text:#e6e9ef;--muted:#8b93a3;--accent:#6366f1;--accent-2:#22c55e;--code-bg:#0d1117}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--text);font-family:'Inter',system-ui,sans-serif;margin:0;padding:0;display:flex;width:100%;min-height:100vh}
.open-sidebar-btn{position:fixed;top:14px;left:14px;background:var(--surface);border:1px solid var(--border);color:var(--text);width:42px;height:42px;border-radius:10px;display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:100;font-size:18px;line-height:1}
.sidebar{width:280px;background:var(--surface);border-right:1px solid var(--border);display:flex;flex-direction:column;position:fixed;top:0;left:0;height:100vh;overflow-y:auto;z-index:200;transition:transform .25s ease;transform:translateX(-100%)}
.sidebar.open{transform:translateX(0)}
.sidebar-header{padding:20px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border)}
.logo-area{display:flex;align-items:center;gap:10px}
.logo-dot{width:10px;height:10px;border-radius:50%;background:var(--accent)}
.sidebar-header h1{font-size:15px;margin:0;letter-spacing:-.01em;font-weight:800}
.close-btn{background:none;border:none;color:var(--muted);font-size:20px;cursor:pointer;line-height:1}
.sidebar-menu{padding:12px;display:flex;flex-direction:column;gap:4px;flex:1}
.menu-category-title{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:16px 0 6px 12px;font-weight:700}
.sub-item{padding:10px 14px;color:var(--muted);border-radius:8px;font-size:14px;cursor:pointer;font-weight:600;border-left:3px solid transparent}
.sub-item:hover{background:var(--surface-2);color:var(--text)}
.sub-item.active{background:var(--surface-2);color:var(--text);border-left-color:var(--accent)}
.sidebar-footer{padding:16px 20px;border-top:1px solid var(--border);font-size:12px;color:var(--muted);display:flex;justify-content:space-between;align-items:center;font-weight:600}
.status-online{display:inline-flex;align-items:center;gap:6px;color:var(--accent-2)}
.status-dot{width:7px;height:7px;border-radius:50%;background:var(--accent-2)}
.main-content{width:100%;min-height:100vh;padding:70px 16px 40px;display:flex;justify-content:center}
.card-wrapper{width:100%;max-width:720px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:24px;width:100%;box-shadow:0 12px 32px rgba(0,0,0,.3);display:none;margin-bottom:18px}
.card.active{display:block}
.dashboard-banner{background:var(--surface-2);border:1px solid var(--border);border-radius:14px;padding:22px;margin-bottom:20px}
.online-badge{display:inline-flex;align-items:center;gap:6px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--accent-2);font-weight:700;margin-bottom:10px}
.online-dot{width:8px;height:8px;background:var(--accent-2);border-radius:50%}
.banner-title{font-size:24px;font-weight:800;letter-spacing:-.01em;margin:0 0 6px}
.banner-subtitle{font-size:13px;color:var(--muted);margin-bottom:12px;font-weight:500}
.creator-tag{font-size:12px;color:var(--muted);margin-top:10px;display:inline-block}
.stats-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:16px}
.stat-box{background:var(--surface);border:1px solid var(--border);padding:12px 14px;border-radius:10px}
.stat-label{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin-bottom:4px;font-weight:600}
.stat-value{font-size:15px;font-weight:700;color:var(--text)}
h2{margin-top:0;font-size:19px;font-weight:800;letter-spacing:-.01em}
h3{font-weight:700;font-size:15px}
label{font-size:13px;color:var(--muted);display:block;margin-bottom:6px;font-weight:600}
input,select{width:100%;padding:11px 13px;background:var(--code-bg);border:1px solid var(--border);color:var(--text);border-radius:10px;margin-bottom:14px;font-size:14px;font-family:inherit;font-weight:500}
input:focus,select:focus{outline:none;border-color:var(--accent)}
.btn{padding:12px;border:none;border-radius:10px;font-weight:700;font-size:14px;cursor:pointer;width:100%;background:var(--accent);color:#fff;transition:background-color .15s ease}
.btn:hover{background:#4f52e0}
.endpoint-block{background:var(--surface-2);border:1px solid var(--border);padding:18px;border-radius:12px;margin-bottom:16px}
.json-box{margin-top:14px;background:var(--code-bg);border:1px solid var(--border);border-radius:10px;padding:14px;position:relative;display:none}
pre{color:#9cdcfe;font-size:12px;overflow-x:auto;max-height:220px;margin:0;white-space:pre-wrap;font-family:'SFMono-Regular',Consolas,monospace}
.btn-copy{position:absolute;top:8px;right:8px;background:var(--surface);color:var(--muted);border:1px solid var(--border);padding:5px 10px;border-radius:6px;font-size:11px;cursor:pointer;font-weight:600}
.route-path-box{display:flex;align-items:center;justify-content:space-between;background:var(--code-bg);border:1px solid var(--border);padding:8px 12px;border-radius:8px;margin-bottom:14px;font-family:monospace;font-size:12px;color:var(--muted);gap:8px}
.route-path-box span{overflow-x:auto;white-space:nowrap}
.btn-copy-route{background:var(--surface);color:var(--text);border:1px solid var(--border);padding:4px 10px;border-radius:6px;font-size:11px;cursor:pointer;font-weight:600;flex-shrink:0}
.overlay{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.6);z-index:150;display:none}
.overlay.show{display:block}
@media (min-width:900px){.sidebar{transform:translateX(0)}.main-content{padding-left:296px}.open-sidebar-btn,.overlay{display:none}}
</style>
</head>
<body>
<button class="open-sidebar-btn" onclick="toggleSidebar()" aria-label="Abrir menú">&#9776;</button>
<div id="overlay" class="overlay" onclick="toggleSidebar()"></div>
<div id="sidebar" class="sidebar">
<div class="sidebar-header"><div class="logo-area"><span class="logo-dot"></span><h1>ZETA-CORE API</h1></div><button class="close-btn" onclick="toggleSidebar()" aria-label="Cerrar menú">&times;</button></div>
<div class="sidebar-menu">
<div class="menu-category-title">Sistema</div>
<span class="sub-item active" onclick="switchTab('guide',this)">Dashboard</span>
<div class="menu-category-title">Rutas</div>
<span class="sub-item" onclick="switchTab('downloaders',this)">Descargas</span>
<span class="sub-item" onclick="switchTab('search',this)">Búsquedas</span>
</div>
<div class="sidebar-footer"><span>v3.8</span><span class="status-online"><span class="status-dot"></span>Online</span></div>
</div>
<div class="main-content"><div class="card-wrapper">
<div id="guide" class="card active">
<div class="dashboard-banner">
<div class="online-badge"><div class="online-dot"></div>Estado: Operativo</div>
<h2 class="banner-title">ZETA-CORE API</h2>
<div class="banner-subtitle">Infraestructura backend de alto rendimiento</div>
<div class="creator-tag">By FlextOFC</div>
<div class="stats-grid">
<div class="stat-box"><div class="stat-label">Núcleo API</div><div class="stat-value" style="color:var(--accent-2)">Activo</div></div>
  <div class="stat-box"><div class="stat-label">Endpoints</div><div class="stat-value">YouTube · TikTok · X</div></div>
  <div class="stat-box"><div class="stat-label">Protección</div><div class="stat-value">Rate limit compartido</div></div>
</div></div>
<div style="text-align:center"><button class="btn" onclick="switchTab('downloaders', document.querySelectorAll('.sub-item')[1])">Explorar documentación</button></div>
</div>
<div id="downloaders" class="card">
<h2>Panel de descargadores</h2>
<div class="endpoint-block">
<div class="route-path-box"><span id="routeTextYoutube">Ruta: /youtube?query=&type=video&quality=1080p</span><button class="btn-copy-route" onclick="copiarRuta(document.getElementById('routeTextYoutube').innerText.replace('Ruta: ', ''))">Copiar</button></div>
<h3>YouTube Media Engine (/youtube)</h3>
<label>Enlace o término de búsqueda:</label>
<input type="text" id="inputYoutube" placeholder="Ej: phonk music o https://youtu.be/...">
<label>Tipo de multimedia:</label>
<select id="selectYtType" onchange="actualizarInterfazYoutube()"><option value="video" selected>Video</option><option value="audio">Audio (MP3)</option></select>
<div id="groupQualityYoutube">
<label>Calidad de video:</label>
<select id="selectYtQuality"><option value="1080p" selected>1080p (FHD)</option><option value="720p">720p (HD)</option><option value="480p">480p</option><option value="360p">360p</option></select>
</div>
<button class="btn" onclick="ejecutarYoutubeCustom()">Procesar YouTube</button>
<div id="jsonContainerYoutube" class="json-box"><button class="btn-copy" onclick="copiarJson('jsonOutputYoutube')">Copiar</button><pre id="jsonOutputYoutube">Esperando...</pre></div>
</div>
<div class="endpoint-block">
<div class="route-path-box"><span>Ruta: /tiktok?url=</span><button class="btn-copy-route" onclick="copiarRuta('/tiktok?url=')">Copiar</button></div>
<h3>TikTok Video Extractor (/tiktok)</h3>
<label>Enlace del video de TikTok:</label>
<input type="text" id="inputTikTok" placeholder="https://www.tiktok.com/...">
<button class="btn" onclick="ejecutarAccion('tiktok','inputTikTok','jsonContainerTikTok','jsonOutputTikTok')">Extraer TikTok</button>
<div id="jsonContainerTikTok" class="json-box"><button class="btn-copy" onclick="copiarJson('jsonOutputTikTok')">Copiar</button><pre id="jsonOutputTikTok">Esperando...</pre></div>
</div>
<div class="endpoint-block">
<div class="route-path-box"><span>Ruta: /xvideo?url=</span><button class="btn-copy-route" onclick="copiarRuta('/xvideo?url=')">Copiar</button></div>
<h3>X / Twitter Video Extractor (/xvideo)</h3>
<label>Enlace del tweet:</label>
<input type="text" id="inputXVideo" placeholder="https://x.com/user/status/123">
<button class="btn" onclick="ejecutarAccion('xvideo','inputXVideo','jsonContainerXVideo','jsonOutputXVideo')">Extraer Twitter</button>
<div id="jsonContainerXVideo" class="json-box"><button class="btn-copy" onclick="copiarJson('jsonOutputXVideo')">Copiar</button><pre id="jsonOutputXVideo">Esperando...</pre></div>
</div>
</div>
<div id="search" class="card">
<h2>Playground de búsquedas</h2>
<div class="endpoint-block">
<div class="route-path-box"><span>Ruta: /ytsearch?query=&limit=</span><button class="btn-copy-route" onclick="copiarRuta('/ytsearch?query=&limit=')">Copiar</button></div>
<h3>YouTube Search Engine (/ytsearch)</h3>
<label>Término de búsqueda:</label><input type="text" id="inputYt" placeholder="Gaming highlights...">
<label>Cantidad de resultados:</label><select id="limitYt"><option value="1">1 resultado</option><option value="5" selected>5 resultados</option><option value="10">10 resultados</option></select>
<button class="btn" onclick="ejecutarBusqueda('ytsearch')">Buscar en YouTube</button>
<div id="jsonContainerYt" class="json-box"><button class="btn-copy" onclick="copiarJson('jsonOutputYt')">Copiar</button><pre id="jsonOutputYt">Esperando...</pre></div>
</div>
<div class="endpoint-block">
<div class="route-path-box"><span>Ruta: /ttsearch?query=&limit=</span><button class="btn-copy-route" onclick="copiarRuta('/ttsearch?query=&limit=')">Copiar</button></div>
<h3>TikTok Search Engine (/ttsearch)</h3>
<label>Término de búsqueda:</label><input type="text" id="inputTt" placeholder="Anime aesthetic...">
<label>Cantidad de resultados:</label><select id="limitTt"><option value="1">1 resultado</option><option value="5" selected>5 resultados</option><option value="10">10 resultados</option></select>
<button class="btn" onclick="ejecutarBusqueda('ttsearch')">Buscar en TikTok</button>
<div id="jsonContainerTt" class="json-box"><button class="btn-copy" onclick="copiarJson('jsonOutputTt')">Copiar</button><pre id="jsonOutputTt">Esperando...</pre></div>
</div>
</div>
</div></div>
<script>
function toggleSidebar(){document.getElementById('sidebar').classList.toggle('open');document.getElementById('overlay').classList.toggle('show')}
function switchTab(tabId,el){document.querySelectorAll('.sub-item').forEach(function(e){e.classList.remove('active')});if(el)el.classList.add('active');document.querySelectorAll('.card').forEach(function(c){c.classList.remove('active')});document.getElementById(tabId).classList.add('active');history.pushState(null, '', '/docs');if(window.innerWidth<900)document.getElementById('sidebar').classList.remove('open'),document.getElementById('overlay').classList.remove('show')}
function copiarRuta(texto){navigator.clipboard.writeText(texto)}
function actualizarInterfazYoutube(){
  var type=document.getElementById('selectYtType').value;
  var qualityGroup=document.getElementById('groupQualityYoutube');
  var routeText=document.getElementById('routeTextYoutube');
  if(type==='audio'){
    qualityGroup.style.display='none';
    routeText.innerText='Ruta: /ytmp3?query=';
  } else {
    qualityGroup.style.display='block';
    var quality=document.getElementById('selectYtQuality').value;
    routeText.innerText='Ruta: /youtube?query=&type=video&quality='+quality;
  }
}
async function ejecutarAccion(endpoint,inputId,containerId,outputId){var val=document.getElementById(inputId).value.trim();if(!val){alert('Por favor ingresa un enlace o texto válido.');return}var container=document.getElementById(containerId);var output=document.getElementById(outputId);container.style.display='block';output.innerText='Procesando solicitud...';try{var res=await fetch('/'+endpoint+'?url='+encodeURIComponent(val));var data=await res.json();output.innerText=JSON.stringify(data,null,2)}catch(e){output.innerText='Error de ejecución: '+e.message}}
async function ejecutarYoutubeCustom(){var val=document.getElementById('inputYoutube').value.trim();var type=document.getElementById('selectYtType').value;var quality=document.getElementById('selectYtQuality').value;if(!val){alert('Ingresa un término o enlace.');return}var container=document.getElementById('jsonContainerYoutube');var output=document.getElementById('jsonOutputYoutube');container.style.display='block';output.innerText='Extrayendo multimedia de YouTube...';try{var apiUrl=type==='audio'?'/ytmp3?query='+encodeURIComponent(val):'/youtube?query='+encodeURIComponent(val)+'&type='+type+'&quality='+quality;var res=await fetch(apiUrl);var data=await res.json();output.innerText=JSON.stringify(data,null,2)}catch(e){output.innerText='Error: '+e.message}}
async function ejecutarBusqueda(endpoint){var isYt=endpoint==='ytsearch';var val=document.getElementById(isYt?'inputYt':'inputTt').value.trim();var limit=document.getElementById(isYt?'limitYt':'limitTt').value;if(!val){alert('Escribe un término de búsqueda.');return}var container=document.getElementById(isYt?'jsonContainerYt':'jsonContainerTt');var output=document.getElementById(isYt?'jsonOutputYt':'jsonOutputTt');container.style.display='block';output.innerText='Buscando...';try{var res=await fetch('/'+endpoint+'?query='+encodeURIComponent(val)+'&limit='+limit);var data=await res.json();output.innerText=JSON.stringify(data,null,2)}catch(e){output.innerText='Error: '+e.message}}
function copiarJson(id){navigator.clipboard.writeText(document.getElementById(id).innerText)}
</script>
</body></html>`);
    }

    res.setHeader('Cache-Control', 'no-store');
    const rateLimit = await secureApi.enforceRateLimit(req);
    res.setHeader('X-RateLimit-Remaining', String(rateLimit.remaining));
    if (!rateLimit.success) {
      res.setHeader('Retry-After', '60');
      return sendJson(429, { ok: false, message: 'Límite de solicitudes excedido. Intenta de nuevo en un minuto.', requestId });
    }

    const parentSignal = globalController.signal;
    if (pathname === '/tiktok') {
      if (!query) return sendJson(400, { ok: false, message: 'Falta el parámetro url.', requestId });
      try {
        return sendJson(200, await secureApi.fetchTikTokVideo(query, parentSignal));
      } catch (error) {
        console.error(JSON.stringify({ requestId, route: pathname, statusCode: error.statusCode || 502, message: error.message }));
        return sendJson(error.statusCode || 502, { creator: 'Jxmpier207', status: false, message: secureApi.publicErrorMessage(error), requestId });
      }
    }
    if (pathname === '/ytsearch' || pathname === '/ttsearch') {
      if (!query) return sendJson(400, { ok: false, message: 'Falta el parámetro query.', requestId });
      try {
        const platform = pathname === '/ytsearch' ? 'youtube' : 'tiktok';
        const results = await secureApi.fetchRealSearchResults(query, limit, platform, parentSignal);
        if (!results.length) return sendJson(404, { ok: false, message: 'No se encontraron resultados.', requestId });
        return sendJson(200, { ok: true, source: platform, query, total_results: results.length, results, requestId });
      } catch (error) {
        console.error(JSON.stringify({ requestId, route: pathname, statusCode: error.statusCode || 502, message: error.message }));
        return sendJson(error.statusCode || 502, { ok: false, message: secureApi.publicErrorMessage(error), requestId });
      }
    }

    if (['/youtube', '/ytmp3', '/ytmp4', '/docs/download/ytmp3', '/docs/download/ytmp4'].includes(pathname)) {
      if (!query) return sendJson(400, { ok: false, message: 'Falta el parámetro query o url.', requestId });
      try {
        const resolvedType = pathname.endsWith('ytmp3') ? 'audio' : pathname.endsWith('ytmp4') ? 'video' : type;
        let title = query;
        let videoId;
        if (/^https?:\/\//i.test(query)) {
          videoId = secureApi.extractYoutubeVideoId(query);
          if (!videoId) return sendJson(400, { ok: false, message: 'La URL de YouTube no es válida; se requiere HTTPS y una ruta reconocida.', requestId });
        } else if (/^[a-z][a-z\d+.-]*:\/\//i.test(query)) {
          return sendJson(400, { ok: false, message: 'Solo se aceptan enlaces HTTPS de YouTube.', requestId });
        } else {
          const results = await secureApi.fetchRealSearchResults(query, 1, 'youtube', parentSignal);
          if (!results[0]) return sendJson(404, { ok: false, message: 'No se encontró un video para la búsqueda.', requestId });
          title = results[0].title || query;
          videoId = results[0].videoId;
        }
        const media = await secureApi.fetchYoutubeMedia(videoId, resolvedType, quality, parentSignal);
        const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
        return sendJson(200, {
          ok: true,
          endpoint: resolvedType === 'audio' ? 'ytmp3' : 'youtube',
          type: resolvedType,
          quality: media.quality,
          input: query,
          title,
          videoId,
          resolved_url: videoUrl,
          download_url: media.url,
          url: media.url,
          result: {
            title,
            type: resolvedType,
            quality: media.quality,
            url: videoUrl,
            download: media.url,
            thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
          },
          requestId,
        });
      } catch (error) {
        console.error(JSON.stringify({ requestId, route: pathname, statusCode: error.statusCode || 502, code: error.code || null, message: error.message }));
        return sendJson(error.statusCode || 502, { ok: false, code: error.code || 'UPSTREAM_ERROR', message: secureApi.publicErrorMessage(error), requestId });
      }
    }
    if (pathname === '/xvideo') {
      if (!query) return sendJson(400, { ok: false, message: 'Falta el enlace de la publicación.', requestId });
      try {
        return sendJson(200, { ...(await secureApi.fetchXVideo(query, parentSignal)), requestId });
      } catch (error) {
        console.error(JSON.stringify({ requestId, route: pathname, statusCode: error.statusCode || 502, message: error.message }));
        return sendJson(error.statusCode || 502, { ok: false, message: secureApi.publicErrorMessage(error), requestId });
      }
    }

    return sendJson(404, { ok: false, message: 'Endpoint no encontrado.', requestId });
  } catch (error) {
    console.error(JSON.stringify({ requestId, statusCode: error.statusCode || 500, message: error.message }));
    return sendJson(error.statusCode || 500, { ok: false, message: secureApi.publicErrorMessage(error), requestId });
  } finally {
    clearTimeout(globalTimeout);
  }
};
