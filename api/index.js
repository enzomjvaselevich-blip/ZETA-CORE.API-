const { URL } = require('url');

const startTime = Date.now();

const rateLimitMap = new Map();
function applyRateLimit(ip, limit = 60, windowMs = 60000) {
  const now = Date.now();
  if (rateLimitMap.size > 500) {
    for (const [key, value] of rateLimitMap.entries()) {
      if (now > value.resetTime) {
        rateLimitMap.delete(key);
      }
    }
  }
  const record = rateLimitMap.get(ip) || { count: 0, resetTime: now + windowMs };
  if (now > record.resetTime) {
    record.count = 1;
    record.resetTime = now + windowMs;
  } else {
    record.count++;
  }
  rateLimitMap.set(ip, record);
  return record.count <= limit;
}

async function readTextWithLimit(response, maxBytes = 5 * 1024 * 1024) {
  const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
  if (contentLength > maxBytes) {
    throw new Error('La respuesta del servidor remoto superó el límite de tamaño permitido.');
  }

  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let accumulated = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      accumulated += value.byteLength || value.length;
      if (accumulated > maxBytes) {
        try { await reader.cancel(); } catch (e) {}
        throw new Error('La respuesta del servidor remoto superó el límite de tamaño permitido.');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf-8');
  }

  const text = await response.text();
  const actualBytes = Buffer.byteLength(text, 'utf-8');
  if (actualBytes > maxBytes) {
    throw new Error('La respuesta del servidor remoto superó el límite de tamaño permitido.');
  }
  return text;
}

function isValidTikTokDomain(hostname) {
  if (!hostname) return false;
  const h = hostname.toLowerCase();
  return h === 'tiktok.com' || h.endsWith('.tiktok.com') || h === 'douyin.com' || h.endsWith('.douyin.com');
}

function extractYoutubeVideoId(inputUrl) {
  try {
    const u = new URL(inputUrl);
    const host = u.hostname.toLowerCase();
    const allowedHosts = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtu.be', 'music.youtube.com'];
    
    if (!allowedHosts.includes(host)) return null;

    let videoId = null;
    if (host.includes('youtu.be')) {
      videoId = u.pathname.slice(1).split('/')[0];
    } else if (u.pathname === '/watch') {
      videoId = u.searchParams.get('v');
    } else if (u.pathname.startsWith('/shorts/') || u.pathname.startsWith('/v/') || u.pathname.startsWith('/embed/')) {
      const parts = u.pathname.split('/');
      videoId = parts[2];
    }

    if (videoId && /^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
      return videoId;
    }
    return null;
  } catch (e) {
    return null;
  }
}

async function fetchRealSearchResults(query, limit, platform) {
  let results = [];
  const searchUrl = platform === 'youtube' 
    ? 'https://www.youtube.com/results?search_query=' + encodeURIComponent(query) 
    : 'https://www.tiktok.com/search?q=' + encodeURIComponent(query);
    
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);

  try {
    const response = await fetch(searchUrl, { 
      signal: controller.signal,
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36', 
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8' 
      } 
    });

    if (!response.ok) {
      throw new Error(`Servidor de ${platform} respondió con código HTTP ${response.status}`);
    }
    
    const html = await readTextWithLimit(response, 5 * 1024 * 1024);
    
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
    throw new Error(`Fallo al consultar ${platform}: ${e.message}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchYoutubeMedia(videoId, type, quality) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);

  try {
    const response = await fetch('https://www.youtube.com/watch?v=' + videoId, { 
      signal: controller.signal,
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept-Language': 'es-ES,es;q=0.9'
      } 
    });

    if (!response.ok) {
      throw new Error(`YouTube devolvió un código de estado HTTP ${response.status}`);
    }

    const html = await readTextWithLimit(response, 5 * 1024 * 1024);

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
  } catch (e) {
    throw new Error(`Error obteniendo media de YouTube: ${e.message}`);
  } finally {
    clearTimeout(timeout);
  }
  
  throw new Error("No se pudo extraer el enlace de descarga multimedia de YouTube.");
}

async function fetchXVideo(url) {
  const result = { ok: false, endpoint: 'xvideo', input: url, tweet_id: null, videos: [], thumbnail: null, text: null };
  try {
    const idMatch = url.match(/(?:twitter\.com|x\.com)\/(?:i\/status|[^\/]+\/status)\/(\d+)/i) || url.match(/status\/(\d+)/i) || url.match(/(\d{15,20})/);
    if (!idMatch) {
      result.message = 'No se pudo extraer el ID del tweet de la URL';
      return result;
    }
    const tweetId = idMatch[1];
    result.tweet_id = tweetId;
    const headers = { 
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36', 
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 
      'Accept-Language': 'en-US,en;q=0.9,es;q=0.8' 
    };
    let html = '';
    const tryUrls = [ 'https://cdn.syndication.twimg.com/tweet-result?id=' + tweetId + '&lang=en', 'https://x.com/i/status/' + tweetId ];
    
    for (let i = 0; i < tryUrls.length; i++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3500);
      try {
        const response = await fetch(tryUrls[i], { headers, signal: controller.signal });
        if (response.ok) {
          html = await readTextWithLimit(response, 3 * 1024 * 1024);
          if (html.length > 300) break;
        }
      } catch (e) {
      } finally {
        clearTimeout(timeout);
      }
    }
    
    if (!html || html.length < 200) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3500);
      try {
        const fxRes = await fetch('https://api.fxtwitter.com/status/' + tweetId, { headers, signal: controller.signal });
        if (fxRes.ok) {
          const textResp = await readTextWithLimit(fxRes, 2 * 1024 * 1024);
          const fxData = JSON.parse(textResp);
          if (fxData.tweet) {
            result.text = fxData.tweet.text || null;
            result.thumbnail = (fxData.tweet.media?.photos?.[0]?.url) || (fxData.tweet.media?.videos?.[0]?.thumbnail_url) || null;
            const vids = fxData.tweet.media?.videos || [];
            for (let v = 0; v < vids.length; v++) {
              if (vids[v].url) result.videos.push({ url: vids[v].url, quality: vids[v].quality || 'unknown', type: 'video/mp4' });
              if (vids[v].variants) {
                for (let k = 0; k < vids[v].variants.length; k++) {
                  const variant = vids[v].variants[k];
                  if (variant.url && variant.content_type === 'video/mp4') {
                    result.videos.push({ url: variant.url, quality: variant.quality || (variant.bitrate ? Math.round(variant.bitrate / 1000) + 'k' : 'unknown'), bitrate: variant.bitrate || null, type: 'video/mp4' });
                  }
                }
              }
            }
          }
        }
      } catch (e) {
      } finally {
        clearTimeout(timeout);
      }
    }
    
    if (result.videos.length === 0 && html) {
      const mp4Regex = /https:\/\/video\.twimg\.com\/[^"'\s\\]+\.mp4[^"'\s\\]*/g;
      const found = {};
      let m;
      while ((m = mp4Regex.exec(html)) !== null) {
        let clean = m[0].replace(/\\u0026/g, '&').replace(/\\"/g, '').replace(/\\/g, '');
        if (!found[clean] && clean.includes('video.twimg.com')) {
          found[clean] = true;
          result.videos.push({ url: clean, quality: clean.includes('720') ? '720p' : clean.includes('360') ? '360p' : clean.includes('480') ? '480p' : 'unknown', type: 'video/mp4' });
        }
      }
    }
    if (result.videos.length > 0) {
      result.ok = true;
      result.total_videos = result.videos.length;
      result.best = result.videos[0].url;
    } else {
      result.message = 'No se encontraron videos en este tweet';
    }
  } catch (e) {
    result.message = 'Error en scraper: ' + e.message;
  }
  return result;
}

async function fetchTikTokVideo(initialUrl) {
  let currentUrl = initialUrl;
  let redirects = 0;
  const maxRedirects = 5;

  while (redirects < maxRedirects) {
    let parsedUrl;
    try {
      parsedUrl = new URL(currentUrl);
    } catch (err) {
      throw new Error('La URL proporcionada no es válida.');
    }

    if (parsedUrl.protocol !== 'https:' || !isValidTikTokDomain(parsedUrl.hostname)) {
      throw new Error('Bloqueo de seguridad: Solo se permiten conexiones HTTPS hacia dominios oficiales de TikTok.');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    try {
      const response = await fetch(currentUrl, { 
        signal: controller.signal,
        redirect: 'manual',
        headers: { 
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36', 
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 
          'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8' 
        } 
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw new Error('Redirección recibida sin encabezado Location.');
        currentUrl = new URL(location, currentUrl).href;
        redirects++;
        continue;
      }

      if (!response.ok) {
        throw new Error(`Servidor de TikTok respondió con estado HTTP ${response.status}`);
      }

      const html = await readTextWithLimit(response, 5 * 1024 * 1024);

      let vData = null;
      const univMatch = html.match(/id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([^<]+)<\/script>/);
      if (univMatch) {
        const univ = JSON.parse(univMatch[1]);
        vData = univ.__DEFAULT_SCOPE__['webapp.video-detail']?.itemInfo?.itemStruct;
      } else {
        const sigiMatch = html.match(/window\['SIGI_STATE'\]=(.*?);window\['SIGI_RETRY'\]/);
        if (sigiMatch) {
          const sigi = JSON.parse(sigiMatch[1]);
          const itemId = Object.keys(sigi.ItemModule)[0];
          vData = sigi.ItemModule[itemId];
        }
      }

      if (!vData) throw new Error("No se pudo extraer la información del video de TikTok.");

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
          size: "",
          hd_size: "",
          images: [],
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
          },
          music: {
            title: vData.music?.title || "",
            author: vData.music?.authorName || "",
            cover: vData.music?.coverLarge || ""
          },
          stats: {
            views: vData.stats?.playCount || 0,
            likes: vData.stats?.diggCount || 0,
            comments: vData.stats?.commentCount || 0,
            shares: vData.stats?.shareCount || 0,
            downloads: vData.stats?.downloadCount || 0
          }
        }
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error('Se superó el límite máximo de redirecciones.');
}

module.exports = async function handler(req, res) {
  try {
    const clientIp = req.headers['x-real-ip'] || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '127.0.0.1';
    if (!applyRateLimit(clientIp)) {
      res.statusCode = 429;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify({ ok: false, message: 'Límite de peticiones excedido (60/min). Intenta de nuevo en un minuto.' }));
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405;
      res.setHeader('Allow', 'GET, HEAD');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify({ ok: false, message: 'Método no permitido. Utiliza GET o HEAD.' }));
    }

    if (req.method === 'HEAD') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end();
    }

    const host = req.headers['x-forwarded-host'] || req.headers.host || 'zeta-core-api.vercel.app';
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const parsedUrl = new URL(req.url, `${protocol}://${host}`);
    
    let pathname = parsedUrl.pathname.replace(/^\/api/, '');
    if (!pathname) pathname = '/';

    const rawQuery = parsedUrl.searchParams.get('query') || parsedUrl.searchParams.get('url') || '';
    
    if (rawQuery.length > 500) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify({ ok: false, message: 'La longitud de la consulta excede el máximo permitido (500 caracteres).' }));
    }
    const query = rawQuery.trim();

    let type = 'video';
    if (parsedUrl.searchParams.has('type')) {
      const rawType = parsedUrl.searchParams.get('type').toLowerCase();
      if (!['video', 'audio'].includes(rawType)) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        return res.end(JSON.stringify({ ok: false, message: 'El parámetro "type" es inválido. Valores permitidos: "video", "audio".' }));
      }
      type = rawType;
    }

    let quality = '720p';
    if (parsedUrl.searchParams.has('quality')) {
      const rawQuality = parsedUrl.searchParams.get('quality').toLowerCase();
      if (!['1080p', '720p', '480p', '360p'].includes(rawQuality)) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        return res.end(JSON.stringify({ ok: false, message: 'El parámetro "quality" es inválido. Valores permitidos: "1080p", "720p", "480p", "360p".' }));
      }
      quality = rawQuality;
    }

    let limit = 5;
    if (parsedUrl.searchParams.has('limit')) {
      const rawLimit = parsedUrl.searchParams.get('limit');
      if (!/^\d+$/.test(rawLimit)) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        return res.end(JSON.stringify({ ok: false, message: 'El parámetro "limit" debe ser un número entero válido.' }));
      }
      const parsedLimit = parseInt(rawLimit, 10);
      if (parsedLimit < 1 || parsedLimit > 20) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        return res.end(JSON.stringify({ ok: false, message: 'El parámetro "limit" debe estar entre 1 y 20.' }));
      }
      limit = parsedLimit;
    }

    if (pathname === '/' || pathname === '') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ZETA-CORE.API ⚡ | Cyber Anime Edition</title>
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700;900&family=Rajdhani:wght@600;700&display=swap" rel="stylesheet">
<style>
@keyframes rgbGlow{0%{border-color:#00f0ff;box-shadow:0 0 30px rgba(0,240,255,.5),inset 0 0 20px rgba(0,240,255,.2)}33%{border-color:#b026ff;box-shadow:0 0 30px rgba(176,38,255,.5),inset 0 0 20px rgba(176,38,255,.2)}66%{border-color:#00ff66;box-shadow:0 0 30px rgba(0,255,102,.5),inset 0 0 20px rgba(0,255,102,.2)}100%{border-color:#00f0ff;box-shadow:0 0 30px rgba(0,240,255,.5),inset 0 0 20px rgba(0,240,255,.2)}}
@keyframes rgbText{0%{color:#00f0ff;text-shadow:0 0 12px rgba(0,240,255,.8)}33%{color:#b026ff;text-shadow:0 0 12px rgba(176,38,255,.8)}66%{color:#00ff66;text-shadow:0 0 12px rgba(0,255,102,.8)}100%{color:#00f0ff;text-shadow:0 0 12px rgba(0,240,255,.8)}}
body{margin:0;padding:0;width:100vw;height:100vh;display:flex;justify-content:center;align-items:center;font-family:'Rajdhani',sans-serif;overflow:hidden;
background:linear-gradient(rgba(5,3,10,0.75),rgba(5,3,10,0.85)), url('https://images.unsplash.com/photo-1607604276583-eef5d076aa5f?q=80&w=1920&auto=format&fit=crop') no-repeat center center fixed;background-size:cover;}
.welcome-card{background:rgba(10,8,18,0.85);backdrop-filter:blur(16px);border:2px solid #00f0ff;border-radius:28px;padding:45px 35px;max-width:480px;width:90%;text-align:center;box-shadow:0 25px 60px rgba(0,0,0,.9);animation:rgbGlow 6s infinite alternate}
h1{font-family:'Orbitron',sans-serif;font-size:30px;font-weight:900;animation:rgbText 5s infinite;margin-bottom:15px;letter-spacing:2px}
p{color:#b8b2d1;font-size:15px;margin-bottom:30px;line-height:1.6;font-weight:600}
.btn-doc{display:inline-block;padding:15px 35px;background:linear-gradient(135deg,#00f0ff,#b026ff,#00ff66);background-size:200% 200%;color:#05040a;font-family:'Orbitron',sans-serif;font-weight:900;font-size:16px;border:none;border-radius:16px;cursor:pointer;text-decoration:none;box-shadow:0 8px 25px rgba(176,38,255,.5);transition:transform .3s,box-shadow .3s;letter-spacing:1px}
.btn-doc:hover{transform:scale(1.08);box-shadow:0 12px 35px rgba(0,240,255,.7)}
</style>
</head>
<body>
<div class="welcome-card">
  <h1>⚡ ZETA-CORE.API ⚡</h1>
  <p>🔮 Núcleo backend de alto rendimiento activado con seguridad reforzada. ¡Bienvenido al sistema principal! ✨</p>
  <a href="/docs" class="btn-doc">🚀 DOCUMENTACIÓN 🔮</a>
</div>
</body>
</html>`);
    }

    if (pathname === '/docs') {
      const uptimeMinutes = Math.floor((Date.now() - startTime) / 60000);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>ZETA-CORE.API ⚡ | Dashboard & Documentación</title>
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700;900&family=Rajdhani:wght@600;700&display=swap" rel="stylesheet">
<style>
@keyframes rgbGlow{0%{border-color:#00f0ff;box-shadow:0 0 25px rgba(0,240,255,.4),inset 0 0 15px rgba(0,240,255,.15)}33%{border-color:#b026ff;box-shadow:0 0 25px rgba(176,38,255,.4),inset 0 0 15px rgba(176,38,255,.15)}66%{border-color:#00ff66;box-shadow:0 0 25px rgba(0,255,102,.4),inset 0 0 15px rgba(0,255,102,.15)}100%{border-color:#00f0ff;box-shadow:0 0 25px rgba(0,240,255,.4),inset 0 0 15px rgba(0,240,255,.15)}}
@keyframes rgbText{0%{color:#00f0ff;text-shadow:0 0 10px rgba(0,240,255,.7)}33%{color:#b026ff;text-shadow:0 0 10px rgba(176,38,255,.7)}66%{color:#00ff66;text-shadow:0 0 10px rgba(0,255,102,.7)}100%{color:#00f0ff;text-shadow:0 0 10px rgba(0,240,255,.7)}}
:root{--card-bg:rgba(12,10,22,0.92);--text-main:#f2eeff;--text-muted:#aba3cc}
*{box-sizing:border-box}
body{background:linear-gradient(rgba(4,2,8,0.7),rgba(6,4,12,0.85)), url('https://images.unsplash.com/photo-1607604276583-eef5d076aa5f?q=80&w=1920&auto=format&fit=crop') no-repeat center center fixed;background-size:cover;color:var(--text-main);font-family:'Rajdhani',sans-serif;margin:0;padding:0;display:flex;width:100vw;min-height:100vh;overflow-x:hidden}
.open-sidebar-btn{position:fixed;top:15px;left:15px;background:rgba(16,13,28,.9);border:2px solid #00f0ff;color:#00f0ff;width:46px;height:46px;border-radius:14px;display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:100;font-size:22px;animation:rgbGlow 6s infinite}
.sidebar{width:300px;background:rgba(8,6,15,0.96);backdrop-filter:blur(25px);border-right:2px solid rgba(0,240,255,.3);display:flex;flex-direction:column;position:fixed;top:0;left:0;height:100vh;overflow-y:auto;z-index:200;transition:transform .35s ease;transform:translateX(-100%);box-shadow:15px 0 50px rgba(0,0,0,.95)}
.sidebar.open{transform:translateX(0)}
.sidebar-header{padding:22px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(255,255,255,.1)}
.logo-area{display:flex;align-items:center;gap:10px}.logo-area span{font-size:22px;animation:rgbText 5s infinite}
.sidebar-header h1{font-family:'Orbitron',sans-serif;font-size:15px;margin:0;letter-spacing:1.5px;font-weight:900;animation:rgbText 5s infinite}
.close-btn{background:none;border:none;color:var(--text-muted);font-size:22px;cursor:pointer}
.sidebar-menu{padding:12px;display:flex;flex-direction:column;gap:6px;flex:1}
.menu-category-title{font-family:'Orbitron',sans-serif;font-size:11px;text-transform:uppercase;letter-spacing:1.5px;animation:rgbText 6s infinite;margin:18px 0 6px 10px;font-weight:bold}
.sub-item{padding:10px 14px;color:var(--text-muted);border-radius:8px;font-size:14px;cursor:pointer;font-weight:600;transition:all .2s}.sub-item:hover,.sub-item.active{background:linear-gradient(90deg,rgba(176,38,255,.3),transparent);color:#00f0ff;border-left:4px solid #00f0ff}
.main-content{width:100%;min-height:100vh;padding:75px 15px 35px;display:flex;justify-content:center;align-items:flex-start;z-index:2;position:relative}
.card-wrapper{width:100%;max-width:720px}
.card{background:var(--card-bg);backdrop-filter:blur(25px);border:2px solid rgba(0,240,255,.45);border-radius:24px;padding:26px;width:100%;box-shadow:0 25px 60px rgba(0,0,0,.85),inset 0 0 35px rgba(176,38,255,.12);display:none;margin-bottom:20px;animation:rgbGlow 8s infinite alternate}
.card.active{display:block}
.dashboard-banner{background:linear-gradient(135deg,rgba(0,240,255,.12),rgba(176,38,255,.18));border:1px solid rgba(0,240,255,.4);border-radius:18px;padding:22px;margin-bottom:22px}
.online-badge{display:inline-flex;align-items:center;gap:6px;font-family:'Orbitron',sans-serif;font-size:11px;letter-spacing:1.5px;color:#00ff66;font-weight:800;margin-bottom:8px}
.online-dot{width:9px;height:9px;background:#00ff66;border-radius:50%;box-shadow:0 0 10px #00ff66}
.banner-title{font-family:'Orbitron',sans-serif;font-size:26px;font-weight:900;letter-spacing:1.5px;animation:rgbText 5s infinite;margin:0 0 6px}
.banner-subtitle{font-size:13px;color:var(--text-muted);letter-spacing:1px;margin-bottom:14px;text-transform:uppercase;font-weight:700}
.creator-tag{font-family:'Orbitron',sans-serif;font-size:13px;color:#00f0ff;font-weight:bold;margin-top:12px;display:inline-block;letter-spacing:1px}
.stats-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:18px}
.stat-box{background:rgba(10,8,18,.8);border:1px solid rgba(176,38,255,.35);padding:14px;border-radius:12px}
.stat-label{font-size:11px;text-transform:uppercase;color:var(--text-muted);letter-spacing:1px;margin-bottom:4px;font-weight:700}
.stat-value{font-size:16px;font-weight:bold;color:#00f0ff;font-family:'Orbitron',monospace}
h2{font-family:'Orbitron',sans-serif;animation:rgbText 5s infinite;margin-top:0;font-size:22px;font-weight:900;letter-spacing:1px}
label{font-size:14px;color:var(--text-muted);display:block;margin-bottom:6px;font-weight:700}
input,select{width:100%;padding:13px;background:rgba(15,12,26,.95);border:1px solid rgba(0,240,255,.35);color:var(--text-main);border-radius:14px;margin-bottom:16px;font-size:15px;font-family:'Rajdhani',sans-serif;font-weight:600}
.btn{padding:13px;border:none;border-radius:14px;font-weight:bold;font-size:15px;cursor:pointer;width:100%;transition:all .3s}
.btn-rgb{background:linear-gradient(135deg,#00f0ff,#b026ff,#00ff66);background-size:200% 200%;color:#05040a;font-family:'Orbitron',sans-serif;font-weight:900;box-shadow:0 6px 22px rgba(176,38,255,.45);animation:rgbGlow 4s infinite;letter-spacing:1px}
.json-box{margin-top:16px;background:#040308;border:1px solid rgba(0,255,102,.35);border-radius:14px;padding:14px;position:relative;display:none}
pre{color:#00ff66;font-size:12px;overflow-x:auto;max-height:220px;margin:0;white-space:pre-wrap;font-family:'Courier New',monospace}
.btn-copy{position:absolute;top:10px;right:10px;background:rgba(0,255,102,.25);color:#00ff66;border:1px solid rgba(0,255,102,.5);padding:5px 12px;border-radius:8px;font-size:11px;cursor:pointer;font-weight:bold;font-family:'Orbitron',sans-serif}
.route-path-box{display:flex;align-items:center;justify-content:space-between;background:rgba(0,240,255,.08);border:1px dashed rgba(0,240,255,.45);padding:8px 14px;border-radius:10px;margin-bottom:14px;font-family:monospace;font-size:12px;color:#00f0ff}
.btn-copy-route{background:rgba(0,240,255,.25);color:#00f0ff;border:none;padding:4px 10px;border-radius:6px;font-size:11px;cursor:pointer;font-weight:bold;font-family:'Orbitron',sans-serif}
.sidebar-footer{padding:18px;border-top:1px solid rgba(255,255,255,.1);font-size:12px;color:var(--text-muted);display:flex;justify-content:space-between;align-items:center;font-weight:700}
.overlay{position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,.75);backdrop-filter:blur(6px);z-index:150;display:none}
.overlay.show{display:block}
</style>
</head>
<body>
<button class="open-sidebar-btn" onclick="toggleSidebar()">⚡</button>
<div id="overlay" class="overlay" onclick="toggleSidebar()"></div>
<div id="sidebar" class="sidebar">
<div class="sidebar-header"><div class="logo-area"><span>🔮</span><h1>ZETA-CORE.API</h1></div><button class="close-btn" onclick="toggleSidebar()">✕</button></div>
<div class="sidebar-menu">
<div class="menu-category-title">✨ Sistema Principal</div>
<span class="sub-item active" onclick="switchTab('guide',this)">🚀 Dashboard & Stats</span>
<div class="menu-category-title">⚡ Motores & Rutas</div>
<span class="sub-item" onclick="switchTab('downloaders',this)">📥 Panel Descargas</span>
<span class="sub-item" onclick="switchTab('search',this)">🔍 Playground Búsquedas</span>
</div>
<div class="sidebar-footer"><span>CYBERPUNK v3.8</span><span style="color:#00ff66">● ONLINE</span></div>
</div>
<div class="main-content"><div class="card-wrapper">
<div id="guide" class="card active">
<div class="dashboard-banner">
<div class="online-badge"><div class="online-dot"></div>ESTADO: OPERATIVO</div>
<h2 class="banner-title">ZETA-CORE.API ⚡</h2>
<div class="banner-subtitle">Infraestructura Backend de Alto Rendimiento 🔮</div>
<div class="creator-tag">By: FlextOFC ✨</div>
<div class="stats-grid">
<div class="stat-box"><div class="stat-label">Núcleo API</div><div class="stat-value" style="color:#00ff66">● Activo</div></div>
<div class="stat-box"><div class="stat-label">Tiempo Instancia</div><div class="stat-value">${uptimeMinutes} min</div></div>
</div></div>
<div style="text-align:center"><button class="btn btn-rgb" onclick="switchTab('downloaders', document.querySelectorAll('.sub-item')[1])">📄 EXPLORAR DOCUMENTACIÓN</button></div>
</div>

<div id="downloaders" class="card">
<h2>📥 Panel de Descargadores 🎬</h2>

<div style="background:rgba(16,12,28,.65);border:1px solid rgba(0,240,255,.35);padding:18px;border-radius:16px;margin-bottom:18px">
<div class="route-path-box"><span id="routeTextYoutube">Ruta: /youtube?query=&type=video&quality=1080p</span><button class="btn-copy-route" onclick="copiarRuta(document.getElementById('routeTextYoutube').innerText.replace('Ruta: ', ''))">Copiar Ruta</button></div>
<h3 style="color:#00f0ff;margin-top:0;font-size:16px;font-family:'Orbitron',sans-serif">YouTube Media Engine (/youtube)</h3>
<label>Enlace o término de búsqueda:</label>
<input type="text" id="inputYoutube" placeholder="Ej: phonk music o https://youtu.be/...">
<label>Tipo de multimedia:</label>
<select id="selectYtType" onchange="actualizarInterfazYoutube()"><option value="video" selected>Video</option><option value="audio">Audio (MP3)</option></select>

<div id="groupQualityYoutube">
<label>Calidad de Video:</label>
<select id="selectYtQuality"><option value="1080p" selected>1080p (FHD)</option><option value="720p">720p (HD)</option><option value="480p">480p</option><option value="360p">360p</option></select>
</div>

<button class="btn btn-rgb" onclick="ejecutarYoutubeCustom()">🚀 PROCESAR YOUTUBE</button>
<div id="jsonContainerYoutube" class="json-box"><button class="btn-copy" onclick="copiarJson('jsonOutputYoutube')">Copiar</button><pre id="jsonOutputYoutube">Esperando...</pre></div>
</div>

<div style="background:rgba(16,12,28,.65);border:1px solid rgba(255,50,100,.35);padding:18px;border-radius:16px;margin-bottom:18px">
<div class="route-path-box"><span>Ruta: /tiktok?url=</span><button class="btn-copy-route" onclick="copiarRuta('/tiktok?url=')">Copiar Ruta</button></div>
<h3 style="color:#ff3264;margin-top:0;font-size:16px;font-family:'Orbitron',sans-serif">TikTok Video Extractor (/tiktok)</h3>
<label>Enlace del video de TikTok:</label>
<input type="text" id="inputTikTok" placeholder="https://www.tiktok.com/...">
<button class="btn btn-rgb" onclick="ejecutarAccion('tiktok','inputTikTok','jsonContainerTikTok','jsonOutputTikTok')">✨ EXTRAER TIKTOK</button>
<div id="jsonContainerTikTok" class="json-box"><button class="btn-copy" onclick="copiarJson('jsonOutputTikTok')">Copiar</button><pre id="jsonOutputTikTok">Esperando...</pre></div>
</div>

<div style="background:rgba(16,12,28,.65);border:1px solid rgba(0,255,102,.35);padding:18px;border-radius:16px">
<div class="route-path-box"><span>Ruta: /xvideo?url=</span><button class="btn-copy-route" onclick="copiarRuta('/xvideo?url=')">Copiar Ruta</button></div>
<h3 style="color:#00ff66;margin-top:0;font-size:16px;font-family:'Orbitron',sans-serif">X / Twitter Video Extractor (/xvideo)</h3>
<label>Enlace del tweet:</label>
<input type="text" id="inputXVideo" placeholder="https://x.com/user/status/123">
<button class="btn btn-rgb" onclick="ejecutarAccion('xvideo','inputXVideo','jsonContainerXVideo','jsonOutputXVideo')">🔮 EXTRAER TWITTER</button>
<div id="jsonContainerXVideo" class="json-box"><button class="btn-copy" onclick="copiarJson('jsonOutputXVideo')">Copiar</button><pre id="jsonOutputXVideo">Esperando...</pre></div>
</div>
</div>

<div id="search" class="card">
<h2>🔍 Playground de Búsquedas 🔎</h2>

<div style="background:rgba(16,12,28,.65);border:1px solid rgba(0,240,255,.35);padding:18px;border-radius:16px;margin-bottom:18px">
<div class="route-path-box"><span>Ruta: /ytsearch?query=&limit=</span><button class="btn-copy-route" onclick="copiarRuta('/ytsearch?query=&limit=')">Copiar Ruta</button></div>
<h3 style="color:#00f0ff;margin-top:0;font-size:16px;font-family:'Orbitron',sans-serif">YouTube Search Engine (/ytsearch)</h3>
<label>Término de búsqueda:</label><input type="text" id="inputYt" placeholder="Gaming highlights...">
<label>Cantidad de resultados:</label><select id="limitYt"><option value="1">1 resultado</option><option value="5" selected>5 resultados</option><option value="10">10 resultados</option></select>
<button class="btn btn-rgb" onclick="ejecutarBusqueda('ytsearch')">🚀 BUSCAR EN YOUTUBE</button>
<div id="jsonContainerYt" class="json-box"><button class="btn-copy" onclick="copiarJson('jsonOutputYt')">Copiar</button><pre id="jsonOutputYt">Esperando...</pre></div>
</div>

<div style="background:rgba(16,12,28,.65);border:1px solid rgba(176,38,255,.35);padding:18px;border-radius:16px">
<div class="route-path-box"><span>Ruta: /ttsearch?query=&limit=</span><button class="btn-copy-route" onclick="copiarRuta('/ttsearch?query=&limit=')">Copiar Ruta</button></div>
<h3 style="color:#b026ff;margin-top:0;font-size:16px;font-family:'Orbitron',sans-serif">TikTok Search Engine (/ttsearch)</h3>
<label>Término de búsqueda:</label><input type="text" id="inputTt" placeholder="Anime aesthetic...">
<label>Cantidad de resultados:</label><select id="limitTt"><option value="1">1 resultado</option><option value="5" selected>5 resultados</option><option value="10">10 resultados</option></select>
<button class="btn btn-rgb" onclick="ejecutarBusqueda('ttsearch')">✨ BUSCAR EN TIKTOK</button>
<div id="jsonContainerTt" class="json-box"><button class="btn-copy" onclick="copiarJson('jsonOutputTt')">Copiar</button><pre id="jsonOutputTt">Esperando...</pre></div>
</div>
</div>
</div></div>
<script>
function toggleSidebar(){document.getElementById('sidebar').classList.toggle('open');document.getElementById('overlay').classList.toggle('show')}
function switchTab(tabId,el){document.querySelectorAll('.sub-item').forEach(function(e){e.classList.remove('active')});if(el)el.classList.add('active');document.querySelectorAll('.card').forEach(function(c){c.classList.remove('active')});document.getElementById(tabId).classList.add('active');history.pushState(null, '', '/docs');if(window.innerWidth<=900)toggleSidebar()}
function copiarRuta(texto){navigator.clipboard.writeText(texto);alert('🔮 ¡Ruta copiada al portapapeles exitosamente!');}
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
async function ejecutarAccion(endpoint,inputId,containerId,outputId){var val=document.getElementById(inputId).value.trim();if(!val){alert('⚠️ ¡Por favor ingresa un enlace o texto válido!');return}var container=document.getElementById(containerId);var output=document.getElementById(outputId);container.style.display='block';output.innerText='⚡ Procesando solicitud en el núcleo...';try{var res=await fetch('/'+endpoint+'?url='+encodeURIComponent(val));var data=await res.json();output.innerText=JSON.stringify(data,null,2)}catch(e){output.innerText='❌ Error de ejecución: '+e.message}}
async function ejecutarYoutubeCustom(){var val=document.getElementById('inputYoutube').value.trim();var type=document.getElementById('selectYtType').value;var quality=document.getElementById('selectYtQuality').value;if(!val){alert('⚠️️ ¡Ingresa un término o enlace!');return}var container=document.getElementById('jsonContainerYoutube');var output=document.getElementById('jsonOutputYoutube');container.style.display='block';output.innerText='⚡ Extrayendo multimedia de YouTube...';try{var apiUrl=type==='audio'?'/ytmp3?query='+encodeURIComponent(val):'/youtube?query='+encodeURIComponent(val)+'&type='+type+'&quality='+quality;var res=await fetch(apiUrl);var data=await res.json();output.innerText=JSON.stringify(data,null,2)}catch(e){output.innerText='❌ Error: '+e.message}}
async function ejecutarBusqueda(endpoint){var isYt=endpoint==='ytsearch';var val=document.getElementById(isYt?'inputYt':'inputTt').value.trim();var limit=document.getElementById(isYt?'limitYt':'limitTt').value;if(!val){alert('⚠ ¡Escribe un término de búsqueda!');return}var container=document.getElementById(isYt?'jsonContainerYt':'jsonContainerTt');var output=document.getElementById(isYt?'jsonOutputYt':'jsonOutputTt');container.style.display='block';output.innerText='🔍 Buscando en la red...';try{var res=await fetch('/'+endpoint+'?query='+encodeURIComponent(val)+'&limit='+limit);var data=await res.json();output.innerText=JSON.stringify(data,null,2)}catch(e){output.innerText='❌ Error: '+e.message}}
function copiarJson(id){navigator.clipboard.writeText(document.getElementById(id).innerText);alert('✨ ¡JSON copiado al portapapeles!')}
</script>
</body></html>`);
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    if (pathname === '/tiktok') {
      if (!query) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ creator: "Jxmpier207", status: false, message: 'Falta el parámetro url' }));
      }
      try {
        const data = await fetchTikTokVideo(query);
        return res.end(JSON.stringify(data, null, 2));
      } catch (err) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ creator: "Jxmpier207", status: false, message: err.message }));
      }
    }

    if (pathname === '/ytsearch' || pathname === '/ttsearch') {
      if (!query) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ ok: false, message: 'Falta el parámetro query' }));
      }
      const platform = pathname === '/ytsearch' ? 'youtube' : 'tiktok';
      
      try {
        const results = await fetchRealSearchResults(query, limit, platform);
        
        if (results.length === 0) {
          res.statusCode = 404;
          return res.end(JSON.stringify({ ok: false, message: 'No se encontraron resultados para la búsqueda solicitada.' }));
        }

        return res.end(JSON.stringify({ ok: true, source: platform, query: query, total_results: results.length, results: results }, null, 2));
      } catch (searchErr) {
        res.statusCode = 502;
        return res.end(JSON.stringify({ ok: false, message: searchErr.message }));
      }
    }

    if (pathname === '/youtube' || pathname === '/ytmp3' || pathname === '/ytmp4' || pathname === '/docs/download/ytmp3' || pathname === '/docs/download/ytmp4') {
      if (!query) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ ok: false, message: 'Falta el parámetro query o url' }));
      }
      
      let resolvedType = type;
      if (pathname === '/ytmp3' || pathname === '/docs/download/ytmp3') resolvedType = 'audio';
      if (pathname === '/ytmp4' || pathname === '/docs/download/ytmp4') resolvedType = 'video';

      let title = query;
      let videoId = null;

      if (query.includes('http://') || query.includes('https://')) {
        videoId = extractYoutubeVideoId(query);
        if (!videoId) {
          res.statusCode = 400;
          return res.end(JSON.stringify({ ok: false, message: 'URL de YouTube no válida. Se requiere una ruta o formato de video válido (watch?v=, youtu.be/, shorts/, embed/).' }));
        }
      } else {
        try {
          const ytResults = await fetchRealSearchResults(query, 1, 'youtube');
          if (ytResults[0] && ytResults[0].videoId) {
            title = ytResults[0].title || query;
            videoId = ytResults[0].videoId;
          } else {
            res.statusCode = 404;
            return res.end(JSON.stringify({ ok: false, message: 'No se encontró ningún video con ese término de búsqueda.' }));
          }
        } catch (searchErr) {
          res.statusCode = 502;
          return res.end(JSON.stringify({ ok: false, message: 'Error al realizar la búsqueda en YouTube: ' + searchErr.message }));
        }
      }

      try {
        let mediaData = await fetchYoutubeMedia(videoId, resolvedType, quality);
        
        return res.end(JSON.stringify({ 
          ok: true, 
          endpoint: 'youtube', 
          type: resolvedType, 
          quality: mediaData.quality, 
          input: query, 
          title: title, 
          videoId: videoId, 
          resolved_url: 'https://www.youtube.com/watch?v=' + videoId, 
          download_url: mediaData.url, 
          url: mediaData.url, 
          result: { 
            title: title, 
            type: resolvedType,
            quality: mediaData.quality,
            url: 'https://www.youtube.com/watch?v=' + videoId, 
            download: mediaData.url, 
            thumbnail: 'https://i.ytimg.com/vi/' + videoId + '/hqdefault.jpg' 
          } 
        }, null, 2));
      } catch (mediaErr) {
        res.statusCode = 502;
        return res.end(JSON.stringify({ ok: false, message: mediaErr.message }));
      }
    }

    if (pathname === '/xvideo') {
      if (!query) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ ok: false, message: 'Falta el enlace del tweet' }));
      }
      const data = await fetchXVideo(query);
      return res.end(JSON.stringify(data, null, 2));
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, message: 'Endpoint no encontrado: ' + pathname }));
  } catch (error) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: 'Error interno del servidor: ' + error.message }));
  }
};
