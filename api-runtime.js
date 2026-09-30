const { isIP } = require('node:net');
const { Redis } = require('@upstash/redis');
const { Ratelimit } = require('@upstash/ratelimit');

const MAX_REMOTE_BYTES = 4 * 1024 * 1024;
const REQUEST_DEADLINE_MS = 8500;
const QUALITY_HEIGHTS = { '1080p': 1080, '720p': 720, '480p': 480, '360p': 360 };
const TIKTOK_HOSTS = ['tiktok.com', 'douyin.com'];
const YOUTUBE_HOSTS = ['youtube.com', 'youtu.be'];
const X_HOSTS = ['x.com', 'twitter.com'];
const X_PROVIDER_HOSTS = ['cdn.syndication.twimg.com', 'api.fxtwitter.com'];

class ApiError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function apiError(statusCode, code, message) {
  return new ApiError(statusCode, code, message);
}

function matchesHost(hostname, allowedHosts, allowSubdomains = false) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return allowedHosts.some((domain) => host === domain || (allowSubdomains && host.endsWith(`.${domain}`)));
}

function validateHttpsUrl(input, allowedHosts, { allowSubdomains = false } = {}) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw apiError(400, 'INVALID_URL', 'La URL proporcionada no es válida.');
  }

  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !matchesHost(url.hostname, allowedHosts, allowSubdomains)
  ) {
    throw apiError(400, 'URL_NOT_ALLOWED', 'La URL debe usar HTTPS y pertenecer a un dominio permitido.');
  }
  return url;
}

function extractYoutubeVideoId(input) {
  const url = validateHttpsUrl(input, YOUTUBE_HOSTS, { allowSubdomains: true });
  const host = url.hostname.toLowerCase();
  let id = null;

  if (host === 'youtu.be' || host === 'www.youtu.be') {
    id = url.pathname.match(/^\/([A-Za-z0-9_-]{11})\/?$/)?.[1] || null;
  } else if (url.pathname === '/watch') {
    const values = url.searchParams.getAll('v');
    id = values.length === 1 && /^[A-Za-z0-9_-]{11}$/.test(values[0]) ? values[0] : null;
  } else {
    id = url.pathname.match(/^\/(?:shorts|embed|v)\/([A-Za-z0-9_-]{11})\/?$/)?.[1] || null;
  }

  if (!id) throw apiError(400, 'INVALID_YOUTUBE_URL', 'La URL no contiene una ruta o ID válido de video de YouTube.');
  return id;
}

function extractTweetId(input) {
  const url = validateHttpsUrl(input, X_HOSTS, { allowSubdomains: true });
  const match = url.pathname.match(/^\/(?:i\/status|[A-Za-z0-9_]{1,15}\/status)\/(\d{15,20})\/?$/);
  if (!match) throw apiError(400, 'INVALID_TWEET_URL', 'La URL debe apuntar a un estado válido de X/Twitter.');
  return match[1];
}

function validateTikTokUrl(input) {
  return validateHttpsUrl(input, TIKTOK_HOSTS, { allowSubdomains: true });
}

function validateContentLength(response, maxBytes) {
  const header = response.headers.get('content-length');
  if (header === null) return;
  if (!/^\d+$/.test(header)) throw apiError(502, 'UPSTREAM_INVALID_LENGTH', 'El servicio externo devolvió una respuesta inválida.');
  const length = Number(header);
  if (!Number.isSafeInteger(length) || length > maxBytes) {
    throw apiError(502, 'UPSTREAM_TOO_LARGE', 'El servicio externo devolvió una respuesta demasiado grande.');
  }
}

async function readTextWithLimit(response, maxBytes = MAX_REMOTE_BYTES) {
  validateContentLength(response, maxBytes);
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw apiError(502, 'UPSTREAM_STREAM_UNAVAILABLE', 'No se pudo leer la respuesta externa de forma segura.');
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {}
        throw apiError(502, 'UPSTREAM_TOO_LARGE', 'El servicio externo devolvió una respuesta demasiado grande.');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

function assertAllowedRemoteUrl(input, allowedHosts, allowSubdomains) {
  try {
    return validateHttpsUrl(input, allowedHosts, { allowSubdomains });
  } catch {
    throw apiError(502, 'UPSTREAM_REDIRECT_BLOCKED', 'El servicio externo intentó redirigir a un dominio no permitido.');
  }
}

async function fetchText(input, {
  allowedHosts,
  allowSubdomains = false,
  parentSignal,
  timeoutMs = 3000,
  maxBytes = MAX_REMOTE_BYTES,
  maxRedirects = 0,
  headers = {},
  allowNotFound = false,
} = {}) {
  let currentUrl = assertAllowedRemoteUrl(input, allowedHosts, allowSubdomains);
  let redirects = 0;

  while (true) {
    if (parentSignal?.aborted) throw apiError(504, 'REQUEST_TIMEOUT', 'La solicitud excedió el tiempo límite.');

    const controller = new AbortController();
    const timeoutError = apiError(504, 'REQUEST_TIMEOUT', 'La solicitud excedió el tiempo límite.');
    const onParentAbort = () => controller.abort(parentSignal.reason || timeoutError);
    const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
    if (parentSignal) parentSignal.addEventListener('abort', onParentAbort, { once: true });

    try {
      const response = await fetch(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers,
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        try {
          await response.body?.cancel();
        } catch {}
        if (!location || redirects >= maxRedirects) {
          throw apiError(502, 'UPSTREAM_REDIRECT_LIMIT', 'El servicio externo excedió el límite de redirecciones permitido.');
        }
        let nextUrl;
        try {
          nextUrl = new URL(location, currentUrl);
        } catch {
          throw apiError(502, 'UPSTREAM_REDIRECT_INVALID', 'El servicio externo devolvió una redirección inválida.');
        }
        currentUrl = assertAllowedRemoteUrl(nextUrl.href, allowedHosts, allowSubdomains);
        redirects += 1;
        continue;
      }

      if (allowNotFound && response.status === 404) {
        try {
          await response.body?.cancel();
        } catch {}
        return { status: 404, text: '' };
      }
      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {}
        throw apiError(502, 'UPSTREAM_HTTP_ERROR', 'El servicio externo no pudo completar la solicitud.');
      }

      const text = await readTextWithLimit(response, maxBytes);
      return { status: response.status, text };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (controller.signal.aborted || parentSignal?.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError') {
        throw apiError(504, 'REQUEST_TIMEOUT', 'La solicitud excedió el tiempo límite.');
      }
      throw apiError(502, 'UPSTREAM_NETWORK_ERROR', 'No se pudo conectar con el servicio externo.');
    } finally {
      clearTimeout(timer);
      if (parentSignal) parentSignal.removeEventListener('abort', onParentAbort);
    }
  }
}

function extractYoutubeResults(html, query, limit) {
  const results = [];
  const jsonMatch = html.match(/(?:var ytInitialData|window\["ytInitialData"\])\s*=\s*({[\s\S]*?});<\/script>/);
  if (jsonMatch) {
    try {
      const data = JSON.parse(jsonMatch[1]);
      const sections = data.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
      for (const section of sections) {
        for (const item of section.itemSectionRenderer?.contents || []) {
          const video = item.videoRenderer;
          if (!video || !/^[A-Za-z0-9_-]{11}$/.test(video.videoId || '')) continue;
          if (results.some((result) => result.videoId === video.videoId)) continue;
          results.push({
            type: 'video',
            videoId: video.videoId,
            title: video.title?.runs?.map((run) => run.text || '').join('') || null,
            url: `https://www.youtube.com/watch?v=${video.videoId}`,
          });
          if (results.length >= limit) return results;
        }
      }
    } catch {}
  }

  if (results.length === 0) {
    const ids = new Set();
    for (const match of html.matchAll(/"videoId":"([A-Za-z0-9_-]{11})"/g)) {
      if (ids.has(match[1])) continue;
      ids.add(match[1]);
      results.push({ type: 'video', videoId: match[1], title: null, url: `https://www.youtube.com/watch?v=${match[1]}` });
      if (results.length >= limit) break;
    }
  }
  return results;
}

async function fetchRealSearchResults(query, limit, platform, signal) {
  const isYoutube = platform === 'youtube';
  const url = isYoutube
    ? `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`
    : `https://www.tiktok.com/search?q=${encodeURIComponent(query)}`;
  const { text } = await fetchText(url, {
    allowedHosts: isYoutube ? YOUTUBE_HOSTS : TIKTOK_HOSTS,
    allowSubdomains: true,
    parentSignal: signal,
    timeoutMs: 3500,
    maxBytes: MAX_REMOTE_BYTES,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ZetaCoreAPI/1.0)', 'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8' },
  });

  if (isYoutube) return extractYoutubeResults(text, query, limit);
  const results = [];
  const seen = new Set();
  for (const match of text.matchAll(/"id":"(\d{10,25})","desc":"((?:\\.|[^"\\])*)"/g)) {
    if (seen.has(match[1])) continue;
    seen.add(match[1]);
    let title = match[2];
    try {
      title = JSON.parse(`"${title}"`);
    } catch {}
    results.push({ type: 'video', videoId: match[1], title, url: `https://www.tiktok.com/video/${match[1]}` });
    if (results.length >= limit) break;
  }
  return results;
}

function isGoogleVideoUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && matchesHost(url.hostname, ['googlevideo.com'], true);
  } catch {
    return false;
  }
}

async function fetchYoutubeMedia(videoId, type, quality, signal) {
  const { text } = await fetchText(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, {
    allowedHosts: YOUTUBE_HOSTS,
    allowSubdomains: true,
    parentSignal: signal,
    timeoutMs: 3500,
    maxBytes: MAX_REMOTE_BYTES,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ZetaCoreAPI/1.0)', 'Accept-Language': 'es-ES,es;q=0.9' },
  });
  const match = text.match(/(?:ytInitialPlayerResponse|var ytInitialPlayerResponse)\s*=\s*({[\s\S]*?});<\/script>/);
  if (!match) throw apiError(502, 'YOUTUBE_FORMAT_CHANGED', 'YouTube no devolvió datos multimedia compatibles.');

  let playerData;
  try {
    playerData = JSON.parse(match[1]);
  } catch {
    throw apiError(502, 'YOUTUBE_INVALID_RESPONSE', 'YouTube devolvió datos multimedia inválidos.');
  }
  if (playerData.playabilityStatus?.status && playerData.playabilityStatus.status !== 'OK') {
    throw apiError(404, 'YOUTUBE_UNAVAILABLE', 'El video no está disponible públicamente.');
  }
  const formats = [...(playerData.streamingData?.adaptiveFormats || []), ...(playerData.streamingData?.formats || [])];
  if (type === 'audio') {
    const audio = formats
      .filter((format) => format.mimeType?.startsWith('audio/') && isGoogleVideoUrl(format.url))
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
    if (audio) return { url: audio.url, quality: `audio-${Math.round((audio.bitrate || 128000) / 1000)}kbps`, bitrate: audio.bitrate || null };
  } else {
    const targetHeight = QUALITY_HEIGHTS[quality];
    const candidates = formats.filter((format) => format.mimeType?.startsWith('video/') && Number.isInteger(format.height) && isGoogleVideoUrl(format.url));
    const chosen = candidates.find((format) => format.height === targetHeight)
      || candidates.filter((format) => format.height <= targetHeight).sort((a, b) => b.height - a.height)[0]
      || candidates.sort((a, b) => a.height - b.height)[0];
    if (chosen) return { url: chosen.url, quality: `${chosen.height}p`, bitrate: chosen.bitrate || null };
  }
  throw apiError(502, 'YOUTUBE_FORMAT_UNAVAILABLE', 'No hay un enlace multimedia compatible disponible para este video.');
}

function collectXVideoUrls(value, videos, seen) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectXVideoUrls(item, videos, seen);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'string' && /(?:url|src)/i.test(key) && child.includes('video.twimg.com')) {
      try {
        const url = new URL(child);
        if (url.protocol === 'https:' && url.hostname === 'video.twimg.com' && url.pathname.endsWith('.mp4') && !seen.has(url.href)) {
          seen.add(url.href);
          videos.push({ url: url.href, quality: 'unknown', type: 'video/mp4' });
        }
      } catch {}
    } else if (child && typeof child === 'object') {
      collectXVideoUrls(child, videos, seen);
    }
  }
}

async function fetchXVideo(inputUrl, signal) {
  const tweetId = extractTweetId(inputUrl);
  const result = { ok: true, endpoint: 'xvideo', input: inputUrl, tweet_id: tweetId, videos: [], thumbnail: null, text: null };
  const providers = [
    `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&lang=en`,
    `https://api.fxtwitter.com/status/${tweetId}`,
  ];
  const failures = [];
  let gotValidResponse = false;
  const seen = new Set();

  for (const providerUrl of providers) {
    try {
      const provider = new URL(providerUrl);
      const { status, text } = await fetchText(providerUrl, {
        allowedHosts: [provider.hostname],
        parentSignal: signal,
        timeoutMs: 2500,
        maxBytes: 2 * 1024 * 1024,
        allowNotFound: true,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ZetaCoreAPI/1.0)', Accept: 'application/json' },
      });
      if (status === 404) {
        gotValidResponse = true;
        continue;
      }
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        failures.push(apiError(502, 'X_PROVIDER_INVALID', 'Un proveedor de X devolvió datos inválidos.'));
        continue;
      }
      gotValidResponse = true;
      const tweet = data.tweet || data;
      result.text = result.text || tweet.text || tweet.full_text || null;
      result.thumbnail = result.thumbnail || tweet.media?.photos?.[0]?.url || tweet.media?.videos?.[0]?.thumbnail_url || null;
      collectXVideoUrls(data, result.videos, seen);
    } catch (error) {
      failures.push(error);
    }
  }

  if (result.videos.length) {
    result.total_videos = result.videos.length;
    result.best = result.videos[0].url;
    return result;
  }
  if (failures.some((error) => error.statusCode === 504)) throw apiError(504, 'X_PROVIDER_TIMEOUT', 'La consulta a X excedió el tiempo límite.');
  if (failures.length || !gotValidResponse) throw apiError(502, 'X_PROVIDER_FAILED', 'No fue posible consultar los proveedores de X.');
  throw apiError(404, 'X_VIDEO_NOT_FOUND', 'No se encontraron videos disponibles en el estado indicado.');
}

function parseTikTokData(html) {
  const univMatch = html.match(/id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([^<]+)<\/script>/);
  if (univMatch) {
    try {
      const universal = JSON.parse(univMatch[1]);
      return universal.__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct || null;
    } catch {}
  }
  const sigiMatch = html.match(/window\['SIGI_STATE'\]=(.*?);window\['SIGI_RETRY'\]/);
  if (sigiMatch) {
    try {
      const sigi = JSON.parse(sigiMatch[1]);
      const itemId = Object.keys(sigi.ItemModule || {})[0];
      return itemId ? sigi.ItemModule[itemId] : null;
    } catch {}
  }
  return null;
}

async function fetchTikTokVideo(inputUrl, signal) {
  const initialUrl = validateTikTokUrl(inputUrl);
  const { text } = await fetchText(initialUrl.href, {
    allowedHosts: TIKTOK_HOSTS,
    allowSubdomains: true,
    parentSignal: signal,
    timeoutMs: 3500,
    maxBytes: MAX_REMOTE_BYTES,
    maxRedirects: 4,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ZetaCoreAPI/1.0)', Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8' },
  });
  const video = parseTikTokData(text);
  if (!video) throw apiError(404, 'TIKTOK_VIDEO_NOT_FOUND', 'No se encontraron metadatos públicos para el video.');
  return {
    creator: 'Jxmpier207',
    status: true,
    data: {
      id: video.id || '',
      url: initialUrl.href,
      type: 'video',
      title: video.desc || '',
      cover: video.video?.cover || '',
      duration: video.video?.duration || 0,
      links: {
        hd: video.video?.playAddr || '',
        sd: video.video?.playAddr || '',
        wm: video.video?.downloadAddr || '',
        mp3: video.music?.playUrl || '',
      },
      author: {
        username: video.author?.uniqueId || '',
        nickname: video.author?.nickname || '',
        avatar: video.author?.avatarLarger || '',
      },
    },
  };
}

let standardLimiter;
let expensiveLimiter;
function getRateLimiter(expensive) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw apiError(503, 'RATE_LIMIT_NOT_CONFIGURED', 'El control de tráfico no está configurado.');
  const key = expensive ? 'expensiveLimiter' : 'standardLimiter';
  if (!getRateLimiter[key]) {
    const redis = new Redis({ url, token });
    getRateLimiter[key] = new Ratelimit({
      redis,
      limiter: expensive ? Ratelimit.slidingWindow(15, '1 m') : Ratelimit.slidingWindow(60, '1 m'),
      prefix: expensive ? 'zeta-api:expensive' : 'zeta-api:standard',
      analytics: false,
    });
  }
  if (expensive) expensiveLimiter = getRateLimiter[key];
  else standardLimiter = getRateLimiter[key];
  return expensive ? expensiveLimiter : standardLimiter;
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded !== 'string') return 'unknown';
  const candidate = forwarded.split(',')[0].trim();
  return isIP(candidate) ? candidate : 'unknown';
}

function getPublicError(error) {
  const statusCode = error instanceof ApiError ? error.statusCode : 500;
  const messages = {
    400: error.message,
    404: error.message,
    429: 'Límite de solicitudes excedido. Intenta de nuevo más tarde.',
    502: 'El servicio externo no pudo completar la solicitud.',
    503: 'El servicio está temporalmente no disponible.',
    504: 'La solicitud excedió el tiempo límite.',
  };
  return {
    statusCode,
    body: {
      ok: false,
      error: {
        code: error instanceof ApiError ? error.code : 'INTERNAL_ERROR',
        message: messages[statusCode] || 'Error interno del servidor.',
      },
    },
  };
}

function getSingleParam(params, key) {
  const values = params.getAll(key);
  if (values.length > 1) throw apiError(400, 'DUPLICATE_PARAMETER', `El parámetro "${key}" no puede repetirse.`);
  return values[0] ?? null;
}

function parseRequestUrl(req) {
  let url;
  try {
    url = new URL(req.url || '/', 'https://api.invalid');
  } catch {
    throw apiError(400, 'INVALID_REQUEST_URL', 'La URL de solicitud no es válida.');
  }
  let pathname = url.pathname;
  if (pathname === '/api') pathname = '/';
  else if (pathname.startsWith('/api/')) pathname = pathname.slice(4);
  return { url, pathname: pathname || '/' };
}

async function handleRequest(req, res) {
  const { url, pathname } = parseRequestUrl(req);
  const routes = new Set(['/tiktok', '/ytsearch', '/ttsearch', '/youtube', '/ytmp3', '/ytmp4', '/docs/download/ytmp3', '/docs/download/ytmp4', '/xvideo']);
  const json = (statusCode, body, extraHeaders = {}) => {
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    for (const [name, value] of Object.entries(extraHeaders)) res.setHeader(name, value);
    return res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body));
  };

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (!['GET', 'HEAD'].includes(req.method)) {
    return json(405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Método no permitido.' } }, { Allow: 'GET, HEAD, OPTIONS' });
  }
  if (!routes.has(pathname)) return json(404, { ok: false, error: { code: 'NOT_FOUND', message: 'Endpoint no encontrado.' } });

  if (req.method === 'HEAD') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.end();
  }

  const expensive = !['/ytsearch', '/ttsearch'].includes(pathname);
  try {
    const { success, reset } = await getRateLimiter(expensive).limit(getClientIp(req));
    if (!success) {
      const retryAfter = Math.max(1, Math.ceil((reset - Date.now()) / 1000));
      return json(429, { ok: false, error: { code: 'RATE_LIMITED', message: 'Límite de solicitudes excedido. Intenta de nuevo más tarde.' } }, { 'Retry-After': String(retryAfter) });
    }
  } catch (error) {
    console.error(JSON.stringify({ event: 'rate_limit_unavailable', code: error?.code || error?.name || 'UNKNOWN' }));
    return json(503, { ok: false, error: { code: 'RATE_LIMIT_UNAVAILABLE', message: 'El servicio está temporalmente no disponible.' } });
  }

  const globalController = new AbortController();
  const globalTimer = setTimeout(() => globalController.abort(), REQUEST_DEADLINE_MS);
  try {
    const queryValue = getSingleParam(url.searchParams, 'query');
    const urlValue = getSingleParam(url.searchParams, 'url');
    const query = (queryValue ?? urlValue ?? '').trim();
    if (query.length > 500) throw apiError(400, 'QUERY_TOO_LONG', 'La consulta no puede superar 500 caracteres.');

    const typeParam = getSingleParam(url.searchParams, 'type');
    const qualityParam = getSingleParam(url.searchParams, 'quality');
    const limitParam = getSingleParam(url.searchParams, 'limit');
    const type = (typeParam || 'video').toLowerCase();
    const quality = (qualityParam || '720p').toLowerCase();
    if (!['video', 'audio'].includes(type)) throw apiError(400, 'INVALID_TYPE', 'El parámetro type debe ser video o audio.');
    if (!Object.hasOwn(QUALITY_HEIGHTS, quality)) throw apiError(400, 'INVALID_QUALITY', 'El parámetro quality debe ser 1080p, 720p, 480p o 360p.');

    let limit = 5;
    if (limitParam !== null) {
      if (!/^\d+$/.test(limitParam)) throw apiError(400, 'INVALID_LIMIT', 'El parámetro limit debe ser un entero entre 1 y 20.');
      limit = Number(limitParam);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw apiError(400, 'INVALID_LIMIT', 'El parámetro limit debe ser un entero entre 1 y 20.');
    }

    if (!query) throw apiError(400, 'MISSING_QUERY', 'Falta el parámetro query o url.');

    if (pathname === '/tiktok') {
      const data = await fetchTikTokVideo(query, globalController.signal);
      return json(200, data);
    }
    if (pathname === '/ytsearch' || pathname === '/ttsearch') {
      const platform = pathname === '/ytsearch' ? 'youtube' : 'tiktok';
      const results = await fetchRealSearchResults(query, limit, platform, globalController.signal);
      if (results.length === 0) throw apiError(404, 'NO_RESULTS', 'No se encontraron resultados para la búsqueda solicitada.');
      return json(200, { ok: true, source: platform, query, total_results: results.length, results });
    }
    if (['/youtube', '/ytmp3', '/ytmp4', '/docs/download/ytmp3', '/docs/download/ytmp4'].includes(pathname)) {
      let resolvedType = type;
      if (pathname.endsWith('ytmp3')) resolvedType = 'audio';
      if (pathname.endsWith('ytmp4')) resolvedType = 'video';
      let videoId;
      let title = null;
      if (/^https?:\/\//i.test(query)) {
        videoId = extractYoutubeVideoId(query);
      } else {
        const results = await fetchRealSearchResults(query, 1, 'youtube', globalController.signal);
        if (!results.length) throw apiError(404, 'NO_RESULTS', 'No se encontró ningún video con ese término de búsqueda.');
        videoId = results[0].videoId;
        title = results[0].title;
      }
      const media = await fetchYoutubeMedia(videoId, resolvedType, quality, globalController.signal);
      return json(200, {
        ok: true,
        endpoint: 'youtube',
        type: resolvedType,
        quality: media.quality,
        input: query,
        title,
        videoId,
        resolved_url: `https://www.youtube.com/watch?v=${videoId}`,
        download_url: media.url,
        url: media.url,
        result: {
          title,
          type: resolvedType,
          quality: media.quality,
          url: `https://www.youtube.com/watch?v=${videoId}`,
          download: media.url,
          thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        },
      });
    }
    if (pathname === '/xvideo') {
      return json(200, await fetchXVideo(query, globalController.signal));
    }
    return json(404, { ok: false, error: { code: 'NOT_FOUND', message: 'Endpoint no encontrado.' } });
  } catch (error) {
    const publicError = getPublicError(error);
    if (publicError.statusCode >= 500) {
      console.error(JSON.stringify({ event: 'api_request_failed', path: pathname, code: error?.code || error?.name || 'UNKNOWN' }));
    }
    return json(publicError.statusCode, publicError.body);
  } finally {
    clearTimeout(globalTimer);
  }
}

module.exports = handleRequest;
