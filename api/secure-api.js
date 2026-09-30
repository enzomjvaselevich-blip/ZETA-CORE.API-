const { createHash } = require('node:crypto');
const { Redis } = require('@upstash/redis');
const { Ratelimit } = require('@upstash/ratelimit');

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const UPSTREAM_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; ZetaCoreAPI/1.0)',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
};

let rateLimiter;

function apiError(statusCode, message, options = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (options.upstreamStatus) error.upstreamStatus = options.upstreamStatus;
  return error;
}

function createCombinedSignal(parentSignal, timeoutMs) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal.reason);
  const timer = setTimeout(() => {
    controller.abort(apiError(504, 'La solicitud al proveedor excedió el tiempo límite.'));
  }, timeoutMs);

  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true });

  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', abortFromParent);
    },
  };
}

function isAllowedHost(hostname, allowedHosts) {
  return allowedHosts.includes(hostname.toLowerCase());
}

function validateUpstreamUrl(value, allowedHosts) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw apiError(502, 'El proveedor devolvió una URL inválida.');
  }
  if (
    url.protocol !== 'https:' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    !isAllowedHost(url.hostname, allowedHosts)
  ) {
    throw apiError(502, 'El proveedor intentó redirigir la solicitud a un destino no permitido.');
  }
  return url;
}

async function readTextWithLimit(response, maxBytes, signal) {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) {
      throw apiError(502, 'El proveedor devolvió un tamaño de contenido inválido.');
    }
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maxBytes) {
      throw apiError(502, 'La respuesta del proveedor excede el tamaño permitido.');
    }
  }

  if (!response.body || typeof response.body.getReader !== 'function') {
    throw apiError(502, 'No se pudo leer de forma limitada la respuesta del proveedor.');
  }

  const reader = response.body.getReader();
  const chunks = [];
  let receivedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw apiError(502, 'La respuesta del proveedor excede el tamaño permitido.');
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error.statusCode) throw error;
    if (signal?.aborted || error.name === 'AbortError') {
      throw apiError(504, 'La lectura de la respuesta del proveedor excedió el tiempo límite.');
    }
    throw apiError(502, 'No se pudo leer la respuesta del proveedor.');
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
  return Buffer.concat(chunks, receivedBytes).toString('utf8');
}

async function fetchTextSafe(initialUrl, options = {}) {
  const {
    allowedHosts,
    parentSignal,
    timeoutMs = 3500,
    maxBytes = MAX_RESPONSE_BYTES,
    acceptedStatuses = [],
    headers = {},
  } = options;
  let currentUrl = validateUpstreamUrl(initialUrl, allowedHosts);

  for (let redirects = 0; ; redirects += 1) {
    if (parentSignal?.aborted) {
      throw apiError(504, 'Se agotó el tiempo total de la solicitud.');
    }
    const combined = createCombinedSignal(parentSignal, timeoutMs);
    try {
      let response;
      try {
        response = await fetch(currentUrl, {
          method: 'GET',
          redirect: 'manual',
          signal: combined.signal,
          headers: { ...UPSTREAM_HEADERS, ...headers },
        });
      } catch (error) {
        if (combined.signal.aborted || error.name === 'AbortError') {
          throw apiError(504, 'El proveedor excedió el tiempo límite.');
        }
        throw apiError(502, 'No fue posible comunicarse con el proveedor.');
      }

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => {});
        if (!location || redirects >= MAX_REDIRECTS) {
          throw apiError(502, 'El proveedor devolvió una redirección inválida o excedió el límite.');
        }
        currentUrl = validateUpstreamUrl(new URL(location, currentUrl).href, allowedHosts);
        continue;
      }

      if (!response.ok && !acceptedStatuses.includes(response.status)) {
        await response.body?.cancel().catch(() => {});
        throw apiError(502, 'El proveedor respondió con un error.', { upstreamStatus: response.status });
      }

      if (acceptedStatuses.includes(response.status)) {
        await response.body?.cancel().catch(() => {});
        return { response, text: '', url: currentUrl };
      }
      const text = await readTextWithLimit(response, maxBytes, combined.signal);
      return { response, text, url: currentUrl };
    } finally {
      combined.cleanup();
    }
  }
}

function parseJson(text, message = 'El proveedor devolvió datos inválidos.') {
  try {
    return JSON.parse(text);
  } catch {
    throw apiError(502, message);
  }
}

function extractYoutubeVideoId(inputUrl) {
  let url;
  try {
    url = new URL(inputUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return null;
  const hostname = url.hostname.toLowerCase();
  const youtubeHosts = new Set([
    'youtube.com',
    'www.youtube.com',
    'm.youtube.com',
    'music.youtube.com',
    'youtu.be',
    'www.youtu.be',
  ]);
  if (!youtubeHosts.has(hostname)) return null;

  if (hostname === 'youtu.be' || hostname === 'www.youtu.be') {
    return url.pathname.match(/^\/([\w-]{11})$/)?.[1] || null;
  }
  if (url.pathname === '/watch') {
    const values = url.searchParams.getAll('v');
    return values.length === 1 && /^[\w-]{11}$/.test(values[0]) ? values[0] : null;
  }
  return url.pathname.match(/^\/(?:shorts|v|embed)\/([\w-]{11})$/)?.[1] || null;
}

function getRateLimiter() {
  if (rateLimiter) return rateLimiter;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw apiError(503, 'El servicio de protección de solicitudes no está configurado.');
  }
  const redis = new Redis({ url, token });
  rateLimiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(60, '60 s'),
    prefix: 'zeta-core-api',
  });
  return rateLimiter;
}

function getClientIp(req) {
  const forwarded = req.headers['x-vercel-forwarded-for'];
  const candidate = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0]?.trim();
  if (candidate && candidate.length <= 64 && /^[\da-fA-F:.]+$/.test(candidate)) return candidate;
  const socketAddress = req.socket?.remoteAddress;
  if (socketAddress && socketAddress.length <= 64) return socketAddress;
  return 'unknown';
}

async function enforceRateLimit(req) {
  const ipKey = createHash('sha256').update(getClientIp(req)).digest('hex');
  try {
    const result = await getRateLimiter().limit(ipKey);
    return {
      success: result.success,
      remaining: result.remaining,
      reset: result.reset,
    };
  } catch (error) {
    if (error.statusCode) throw error;
    throw apiError(503, 'El servicio de protección de solicitudes no está disponible.');
  }
}

function decodeJsonString(value) {
  try {
    return JSON.parse(`"${value}"`);
  } catch {
    return value;
  }
}

async function fetchRealSearchResults(query, limit, platform, parentSignal) {
  const isYoutube = platform === 'youtube';
  const host = isYoutube ? 'www.youtube.com' : 'www.tiktok.com';
  const url = isYoutube
    ? `https://${host}/results?search_query=${encodeURIComponent(query)}`
    : `https://${host}/search?q=${encodeURIComponent(query)}`;
  const allowedHosts = isYoutube
    ? ['youtube.com', 'www.youtube.com']
    : ['tiktok.com', 'www.tiktok.com', 'm.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com', 'douyin.com', 'www.douyin.com', 'v.douyin.com'];
  const { text } = await fetchTextSafe(url, { allowedHosts, parentSignal, timeoutMs: 4500 });
  const results = [];

  if (isYoutube) {
    const match = text.match(/(?:var ytInitialData|window\["ytInitialData"\])\s*=\s*({[\s\S]*?})\s*;?\s*<\/script>/);
    if (match) {
      const data = parseJson(match[1]);
      const sections = data.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
      for (const section of sections) {
        for (const item of section.itemSectionRenderer?.contents || []) {
          const video = item.videoRenderer;
          if (!video || !/^[\w-]{11}$/.test(video.videoId || '')) continue;
          if (results.some((result) => result.videoId === video.videoId)) continue;
          results.push({
            type: 'video',
            videoId: video.videoId,
            title: String(video.title?.runs?.[0]?.text || query).slice(0, 500),
            url: `https://www.youtube.com/watch?v=${video.videoId}`,
          });
          if (results.length >= limit) return results;
        }
      }
    } else if (!text.includes('ytInitialData')) {
      throw apiError(502, 'YouTube devolvió una página de búsqueda inesperada.');
    }
    return results;
  }

  const regex = /"id":"(\d{10,25})","desc":"((?:\\.|[^"\\])*)"/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const videoId = match[1];
    if (results.some((result) => result.videoId === videoId)) continue;
    results.push({
      type: 'video',
      videoId,
      title: String(decodeJsonString(match[2])).slice(0, 500),
      url: `https://www.tiktok.com/video/${videoId}`,
    });
    if (results.length >= limit) break;
  }
  if (!results.length && !text.includes('__UNIVERSAL_DATA_FOR_REHYDRATION__') && !text.includes('SIGI_STATE')) {
    throw apiError(502, 'TikTok devolvió una página de búsqueda inesperada.');
  }
  return results;
}

function getYoutubeFormatUrl(format) {
  if (!format?.url || typeof format.url !== 'string') return null;
  try {
    const url = new URL(format.url);
    if (url.protocol !== 'https:' || !(url.hostname === 'googlevideo.com' || url.hostname.endsWith('.googlevideo.com'))) return null;
    return url.href;
  } catch {
    return null;
  }
}

async function fetchYoutubeMedia(videoId, type, quality, parentSignal) {
  const { text } = await fetchTextSafe(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, {
    allowedHosts: ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'],
    parentSignal,
    timeoutMs: 4500,
  });
  const match = text.match(/(?:ytInitialPlayerResponse|var ytInitialPlayerResponse)\s*=\s*({[\s\S]*?})\s*;?\s*<\/script>/);
  if (!match) throw apiError(502, 'YouTube no proporcionó metadatos de reproducción compatibles.');
  const playerData = parseJson(match[1]);
  const formats = [
    ...(playerData.streamingData?.adaptiveFormats || []),
    ...(playerData.streamingData?.formats || []),
  ];
  const available = formats
    .map((format) => ({ format, url: getYoutubeFormatUrl(format) }))
    .filter((item) => item.url);

  if (type === 'audio') {
    const candidates = available
      .filter(({ format }) => format.mimeType?.startsWith('audio/'))
      .sort((a, b) => (b.format.bitrate || 0) - (a.format.bitrate || 0));
    const selected = candidates[0];
    if (selected) {
      return {
        url: selected.url,
        quality: `audio-${Math.round((selected.format.bitrate || 128000) / 1000)}kbps`,
        bitrate: selected.format.bitrate || null,
      };
    }
  } else {
    const requestedHeight = Number.parseInt(quality, 10) || 720;
    const candidates = available.filter(({ format }) => format.mimeType?.startsWith('video/'));
    const selected = candidates.find(({ format }) => format.height === requestedHeight) ||
      candidates.sort((a, b) => Math.abs((a.format.height || 0) - requestedHeight) - Math.abs((b.format.height || 0) - requestedHeight))[0];
    if (selected) {
      return {
        url: selected.url,
        quality: selected.format.height ? `${selected.format.height}p` : quality,
        bitrate: selected.format.bitrate || null,
      };
    }
  }
  throw apiError(502, 'No se encontró un enlace directo de medios compatible.');
}

function validTikTokUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw apiError(400, 'La URL proporcionada no es válida.');
  }
  if (
    url.protocol !== 'https:' || url.port || url.username || url.password ||
    !isAllowedHost(url.hostname, ['tiktok.com', 'www.tiktok.com', 'm.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com', 'douyin.com', 'www.douyin.com', 'v.douyin.com'])
  ) {
    throw apiError(400, 'Solo se aceptan enlaces HTTPS de TikTok o Douyin.');
  }
  return url;
}

async function fetchTikTokVideo(initialUrl, parentSignal) {
  validTikTokUrl(initialUrl);
  const { text } = await fetchTextSafe(initialUrl, {
    allowedHosts: ['tiktok.com', 'www.tiktok.com', 'm.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com', 'douyin.com', 'www.douyin.com', 'v.douyin.com'],
    parentSignal,
    timeoutMs: 4500,
  });
  let videoData;
  const universalMatch = text.match(/id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([^<]+)<\/script>/);
  if (universalMatch) {
    try {
      const universal = JSON.parse(universalMatch[1]);
      videoData = universal.__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct;
    } catch {}
  }
  if (!videoData) {
    const sigiMatch = text.match(/window\[['"]SIGI_STATE['"]\]\s*=\s*({[\s\S]*?})\s*;window\[['"]SIGI_RETRY['"]\]/);
    if (sigiMatch) {
      try {
        const sigi = JSON.parse(sigiMatch[1]);
        const itemId = Object.keys(sigi.ItemModule || {})[0];
        videoData = itemId ? sigi.ItemModule[itemId] : null;
      } catch {}
    }
  }
  if (!videoData) throw apiError(502, 'TikTok no devolvió metadatos de video reconocibles.');
  return {
    creator: 'Jxmpier207',
    status: true,
    data: {
      id: String(videoData.id || ''),
      url: initialUrl,
      type: 'video',
      title: String(videoData.desc || '').slice(0, 2000),
      cover: videoData.video?.cover || '',
      duration: Number(videoData.video?.duration) || 0,
      links: {
        hd: videoData.video?.playAddr || '',
        sd: videoData.video?.playAddr || '',
        wm: videoData.video?.downloadAddr || '',
        mp3: videoData.music?.playUrl || '',
      },
      author: {
        username: videoData.author?.uniqueId || '',
        nickname: videoData.author?.nickname || '',
        avatar: videoData.author?.avatarLarger || '',
      },
      music: {
        title: videoData.music?.title || '',
        author: videoData.music?.authorName || '',
        cover: videoData.music?.coverLarge || '',
      },
      stats: {
        views: Number(videoData.stats?.playCount) || 0,
        likes: Number(videoData.stats?.diggCount) || 0,
        comments: Number(videoData.stats?.commentCount) || 0,
        shares: Number(videoData.stats?.shareCount) || 0,
        downloads: Number(videoData.stats?.downloadCount) || 0,
      },
    },
  };
}

function getVideoVariants(tweet) {
  const variants = [
    ...(tweet.media?.videos || []).flatMap((video) => [
      ...(video.url ? [{ url: video.url, quality: video.quality }] : []),
      ...(video.variants || []).map((variant) => ({
        url: variant.url,
        quality: variant.quality || (variant.bitrate ? `${Math.round(variant.bitrate / 1000)}k` : 'unknown'),
        bitrate: variant.bitrate || null,
        contentType: variant.content_type,
      })),
    ]),
    ...(tweet.extended_entities?.media || []).flatMap((media) => media.video_info?.variants || []),
  ];
  const unique = new Map();
  for (const variant of variants) {
    if (!variant.url || (variant.contentType && variant.contentType !== 'video/mp4')) continue;
    try {
      const url = new URL(variant.url);
      if (url.protocol !== 'https:' || url.hostname !== 'video.twimg.com') continue;
      unique.set(url.href, {
        url: url.href,
        quality: variant.quality || 'unknown',
        ...(variant.bitrate ? { bitrate: variant.bitrate } : {}),
        type: 'video/mp4',
      });
    } catch {}
  }
  return [...unique.values()];
}

function extractTweetId(inputUrl) {
  let url;
  try {
    url = new URL(inputUrl);
  } catch {
    throw apiError(400, 'La URL de X/Twitter no es válida.');
  }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) {
    throw apiError(400, 'Solo se aceptan URLs HTTPS válidas de X/Twitter.');
  }
  if (!['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname.toLowerCase())) {
    throw apiError(400, 'El dominio debe ser x.com o twitter.com.');
  }
  const match = url.pathname.match(/^\/(?:i\/status\/(\d{15,20})|[^/]+\/status\/(\d{15,20}))\/?$/);
  const id = match?.[1] || match?.[2];
  if (!id) throw apiError(400, 'La URL no contiene un ID de publicación válido.');
  return id;
}

async function fetchXVideo(inputUrl, parentSignal) {
  const tweetId = extractTweetId(inputUrl);
  const sources = [
    {
      url: `https://api.fxtwitter.com/status/${tweetId}`,
      hosts: ['api.fxtwitter.com'],
      maxBytes: 2 * 1024 * 1024,
    },
    {
      url: `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&lang=en`,
      hosts: ['cdn.syndication.twimg.com'],
      maxBytes: 2 * 1024 * 1024,
    },
  ];
  let validResponses = 0;
  let lastFailure = null;
  let text = null;
  let thumbnail = null;
  const videosByUrl = new Map();

  for (const source of sources) {
    if (parentSignal?.aborted) throw apiError(504, 'Se agotó el tiempo total de la solicitud.');
    try {
      const { response, text: body } = await fetchTextSafe(source.url, {
        allowedHosts: source.hosts,
        parentSignal,
        timeoutMs: 2800,
        maxBytes: source.maxBytes,
        acceptedStatuses: [404],
      });
      if (response.status === 404) {
        validResponses += 1;
        continue;
      }
      const data = parseJson(body, 'X/Twitter devolvió datos inválidos.');
      const tweet = data.tweet || data;
      if (!tweet || typeof tweet !== 'object') throw apiError(502, 'X/Twitter devolvió datos inesperados.');
      validResponses += 1;
      text = text || tweet.text || null;
      thumbnail = thumbnail || tweet.media?.photos?.[0]?.url || tweet.media?.videos?.[0]?.thumbnail_url || null;
      for (const video of getVideoVariants(tweet)) videosByUrl.set(video.url, video);
    } catch (error) {
      lastFailure = error;
      if (error.statusCode === 504) break;
    }
  }

  const videos = [...videosByUrl.values()];
  if (videos.length) {
    return {
      ok: true,
      endpoint: 'xvideo',
      input: inputUrl,
      tweet_id: tweetId,
      videos,
      total_videos: videos.length,
      best: videos[0].url,
      thumbnail,
      text,
    };
  }
  if (lastFailure?.statusCode === 504) throw lastFailure;
  if (validResponses === 0 && lastFailure) throw apiError(502, 'No fue posible consultar los proveedores de X/Twitter.');
  if (validResponses === 0) throw apiError(502, 'Los proveedores de X/Twitter no devolvieron una respuesta válida.');
  throw apiError(404, 'No se encontraron videos disponibles en la publicación indicada.');
}

function publicErrorMessage(error) {
  switch (error.statusCode) {
    case 400:
      return error.message;
    case 404:
      return error.message;
    case 429:
      return 'Límite de solicitudes excedido. Intenta de nuevo más tarde.';
    case 503:
      return 'El servicio no está disponible temporalmente.';
    case 504:
      return 'El proveedor tardó demasiado en responder.';
    default:
      return 'No se pudo completar la solicitud por un error del proveedor.';
  }
}

module.exports = {
  apiError,
  fetchTextSafe,
  extractTweetId,
  enforceRateLimit,
  extractYoutubeVideoId,
  fetchRealSearchResults,
  fetchTikTokVideo,
  fetchXVideo,
  fetchYoutubeMedia,
  publicErrorMessage,
};
