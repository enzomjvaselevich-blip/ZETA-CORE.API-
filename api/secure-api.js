const { createHash } = require('node:crypto');
const { Redis } = require('@upstash/redis');
const { Ratelimit } = require('@upstash/ratelimit');
const vm = require('node:vm');

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
  if (options.code) error.code = options.code;
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

function slugifyTikTokQuery(query) {
  return String(query)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function parseTikTokEmbeddedItems(text) {
  const items = [];
  const universalMatch = text.match(/id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([^<]+)<\/script>/);
  if (universalMatch) {
    try {
      const universal = JSON.parse(universalMatch[1]);
      const scope = universal.__DEFAULT_SCOPE__ || {};
      const forYouList = scope['webapp.foryou.video']?.itemList;
      if (Array.isArray(forYouList)) items.push(...forYouList);
      const searchScope = scope['webapp.search-page'];
      const searchLists = [
        searchScope?.data?.itemList,
        searchScope?.itemList,
      ];
      for (const list of searchLists) {
        if (Array.isArray(list)) items.push(...list);
      }
    } catch {}
  }
  const sigiMatch = text.match(/window\[['"]SIGI_STATE['"]\]\s*=\s*({[\s\S]*?})\s*;/);
  if (sigiMatch) {
    try {
      const sigi = JSON.parse(sigiMatch[1]);
      items.push(...Object.values(sigi.ItemModule || {}));
    } catch {}
  }
  const legacyRegex = /"id":"(\d{10,25})","desc":"((?:\\.|[^"\\])*)"/g;
  let legacyMatch;
  while ((legacyMatch = legacyRegex.exec(text)) !== null) {
    items.push({ id: legacyMatch[1], desc: decodeJsonString(legacyMatch[2]) });
  }
  return items;
}

function mapTikTokItemToResult(item) {
  const videoId = String(item.id || '');
  if (!/^\d{10,25}$/.test(videoId)) return null;
  const author = item.author || {};
  const stats = item.stats || {};
  const video = item.video || {};
  return {
    type: 'video',
    videoId,
    title: String(item.desc || '').slice(0, 500),
    url: author.uniqueId
      ? `https://www.tiktok.com/@${author.uniqueId}/video/${videoId}`
      : `https://www.tiktok.com/video/${videoId}`,
    thumbnail: video.cover || '',
    duration: Number(video.duration) || 0,
    author: {
      username: author.uniqueId || '',
      nickname: author.nickname || '',
    },
    stats: {
      views: Number(stats.playCount) || 0,
      likes: Number(stats.diggCount) || 0,
      comments: Number(stats.commentCount) || 0,
      shares: Number(stats.shareCount) || 0,
    },
  };
}

async function fetchRealSearchResults(query, limit, platform, parentSignal) {
  const isYoutube = platform === 'youtube';
  if (isYoutube) {
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    const allowedHosts = ['youtube.com', 'www.youtube.com'];
    const { text } = await fetchTextSafe(url, { allowedHosts, parentSignal, timeoutMs: 4500 });
    const results = [];
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

  const allowedHosts = ['tiktok.com', 'www.tiktok.com', 'm.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com', 'douyin.com', 'www.douyin.com', 'v.douyin.com'];
  const slug = slugifyTikTokQuery(query);
  const pages = [];
  if (slug) pages.push(`https://www.tiktok.com/discover/${encodeURIComponent(slug)}`);
  pages.push(`https://www.tiktok.com/search?q=${encodeURIComponent(query)}`);

  const results = [];
  let sawKnownMarkup = false;
  for (const pageUrl of pages) {
    let text;
    try {
      ({ text } = await fetchTextSafe(pageUrl, { allowedHosts, parentSignal, timeoutMs: 4500 }));
    } catch (error) {
      if (error.statusCode === 504) throw error;
      continue;
    }
    if (text.includes('__UNIVERSAL_DATA_FOR_REHYDRATION__') || text.includes('SIGI_STATE')) {
      sawKnownMarkup = true;
    }
    for (const item of parseTikTokEmbeddedItems(text)) {
      const result = mapTikTokItemToResult(item);
      if (!result || results.some((existing) => existing.videoId === result.videoId)) continue;
      results.push(result);
      if (results.length >= limit) return results;
    }
    if (results.length >= limit) break;
  }
  if (!results.length && !sawKnownMarkup) {
    throw apiError(502, 'TikTok devolvió una página de búsqueda inesperada.');
  }
  return results;
}

function sanitizeGoogleVideoUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:' || !(url.hostname === 'googlevideo.com' || url.hostname.endsWith('.googlevideo.com'))) return null;
    return url.href;
  } catch {
    return null;
  }
}

async function resolveYoutubeFormatUrl(format, player) {
  // Plain formats already expose a direct url; ciphered ones need the player to decipher them.
  if (format.url) return sanitizeGoogleVideoUrl(format.url);
  const signatureCipher = format.signature_cipher || format.signatureCipher;
  const cipher = format.cipher;
  if (!signatureCipher && !cipher) return null;
  if (!player) return null;
  try {
    if (typeof format.decipher === 'function') return sanitizeGoogleVideoUrl(await format.decipher(player));
    return sanitizeGoogleVideoUrl(await player.decipher(format.url, signatureCipher, cipher));
  } catch {
    return null;
  }
}

function extractEmbeddedJson(html, marker) {
  const markerIndex = html.indexOf(marker);
  if (markerIndex === -1) return null;
  const braceStart = html.indexOf('{', markerIndex);
  if (braceStart === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = braceStart; i < html.length; i += 1) {
    const char = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(braceStart, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function mapWatchPageFormats(streamingData) {
  const progressive = Array.isArray(streamingData?.formats) ? streamingData.formats : [];
  const adaptive = Array.isArray(streamingData?.adaptiveFormats) ? streamingData.adaptiveFormats : [];
  const progressiveItags = new Set(progressive.map((f) => String(f.itag)));
  const mapFormat = (f, isProgressive) => {
    const mime = typeof f.mimeType === 'string' ? f.mimeType : '';
    return {
      mime_type: mime,
      bitrate: Number(f.bitrate) || 0,
      height: Number(f.height) || 0,
      quality_label: f.qualityLabel || null,
      url: typeof f.url === 'string' ? f.url : undefined,
      signature_cipher: typeof f.signatureCipher === 'string' ? f.signatureCipher : undefined,
      has_audio: isProgressive || mime.includes('audio/'),
      has_video: isProgressive || mime.includes('video/'),
    };
  };
  return [
    ...progressive.map((f) => mapFormat(f, true)),
    ...adaptive.filter((f) => !progressiveItags.has(String(f.itag))).map((f) => mapFormat(f, false)),
  ];
}

async function fetchYoutubeWatchPageMedia(videoId, type, quality, player, parentSignal) {
  const { text } = await fetchTextSafe(
    `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=es&bpctr=9999999999&has_verified=1`,
    {
      allowedHosts: ['youtube.com', 'www.youtube.com'],
      parentSignal,
      timeoutMs: 5000,
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'es-ES,es;q=0.9,en;q=0.8',
      },
    },
  );
  const playerResponse = extractEmbeddedJson(text, 'ytInitialPlayerResponse');
  if (!playerResponse?.streamingData) {
    throw apiError(502, 'La pagina de YouTube no expuso datos de reproduccion.', { code: 'YOUTUBE_WATCHPAGE_EMPTY' });
  }
  const formats = mapWatchPageFormats(playerResponse.streamingData);
  const selected = await selectYoutubeMediaFormat(formats, type, quality, player);
  const details = playerResponse.videoDetails || {};
  return {
    ...selected,
    basic_info: {
      title: typeof details.title === 'string' ? details.title : undefined,
      author: typeof details.author === 'string' ? details.author : undefined,
      view_count: Number(details.viewCount) || 0,
      like_count: 0,
      duration: Number(details.lengthSeconds) || 0,
    },
  };
}

async function selectYoutubeMediaFormat(formats, type, quality, player) {
  const resolved = await Promise.all(
    formats.map(async (format) => ({ format, url: await resolveYoutubeFormatUrl(format, player) })),
  );
  const available = resolved.filter((item) => item.url);

  if (type === 'audio') {
    const audioOnly = available.filter(({ format }) => format.mime_type?.startsWith('audio/'));
    const selected = audioOnly.sort((a, b) => (b.format.bitrate || 0) - (a.format.bitrate || 0))[0] ||
      available.filter(({ format }) => format.has_audio)
        .sort((a, b) => (b.format.bitrate || 0) - (a.format.bitrate || 0))[0];
    if (selected) {
      return {
        url: selected.url,
        quality: selected.format.quality_label || `audio-${Math.round((selected.format.bitrate || 128000) / 1000)}kbps`,
        bitrate: selected.format.bitrate || null,
      };
    }
  } else {
    const requestedHeight = Number.parseInt(quality, 10) || 720;
    const candidates = available.filter(({ format }) => format.mime_type?.startsWith('video/'));
    const progressive = candidates.filter(({ format }) => format.has_audio);
    const pool = progressive.length ? progressive : candidates;
    const selected = pool.find(({ format }) => format.height === requestedHeight) ||
      pool.filter(({ format }) => format.height && format.height <= requestedHeight)
        .sort((a, b) => (b.format.height || 0) - (a.format.height || 0))[0] ||
      pool.sort((a, b) => (a.format.height || 0) - (b.format.height || 0))[0];
    if (selected) {
      return {
        url: selected.url,
        quality: selected.format.height ? `${selected.format.height}p` : quality,
        bitrate: selected.format.bitrate || null,
      };
    }
  }
  throw apiError(502, 'No hay un enlace multimedia directo compatible disponible para este video.', {
    code: 'YOUTUBE_FORMAT_UNAVAILABLE',
  });
}

let jsEvaluatorPatched = false;
function patchJsEvaluator(Platform) {
  if (jsEvaluatorPatched) return;
  Platform.load({
    ...Platform.shim,
    eval(data, evalArgs) {
      const context = vm.createContext({});
      return vm.runInContext(
        `(function(){\n${data.output}\nreturn process(${JSON.stringify(evalArgs?.n ?? '')}, ${JSON.stringify(evalArgs?.sp ?? '')}, ${JSON.stringify(evalArgs?.sig ?? '')});\n})()`,
        context,
        { timeout: 5000 },
      );
    },
  });
  jsEvaluatorPatched = true;
}

async function fetchYoutubeMedia(videoId, type, quality, parentSignal) {
  if (parentSignal?.aborted) throw apiError(504, 'REQUEST_TIMEOUT', 'La solicitud excedió el tiempo límite.');

  const controller = new AbortController();
  const timeoutError = apiError(504, 'REQUEST_TIMEOUT', 'La solicitud excedió el tiempo límite.');
  const abortFromParent = () => controller.abort(parentSignal.reason || timeoutError);
  const timer = setTimeout(() => controller.abort(timeoutError), 24000);
  if (parentSignal) parentSignal.addEventListener('abort', abortFromParent, { once: true });
  const fetchWithTimeout = (input, init = {}) => {
    let requestUrl;
    try {
      requestUrl = new URL(input instanceof URL ? input.href : typeof input === 'string' ? input : input.url);
    } catch {
      throw apiError(502, 'YouTube intentó consultar un destino no permitido.', { code: 'YOUTUBE_UPSTREAM_BLOCKED' });
    }
    if (
      requestUrl.protocol !== 'https:' || requestUrl.username || requestUrl.password || requestUrl.port ||
      !['youtube.com', 'www.youtube.com'].includes(requestUrl.hostname.toLowerCase())
    ) {
      throw apiError(502, 'YouTube intentó consultar un destino no permitido.', { code: 'YOUTUBE_UPSTREAM_BLOCKED' });
    }

    const requestController = new AbortController();
    const abortRequest = (signal) => requestController.abort(signal.reason);
    const abortFromDeadline = () => abortRequest(controller.signal);
    const abortFromRequest = () => abortRequest(init.signal);
    if (parentSignal?.aborted) abortFromParent();
    if (controller.signal.aborted) abortFromDeadline();
    else controller.signal.addEventListener('abort', abortFromDeadline, { once: true });
    if (init.signal?.aborted) abortFromRequest();
    else init.signal?.addEventListener('abort', abortFromRequest, { once: true });
    return fetch(input, { ...init, signal: requestController.signal }).finally(() => {
      controller.signal.removeEventListener('abort', abortFromDeadline);
      init.signal?.removeEventListener('abort', abortFromRequest);
    });
  };

  try {
    const ytjs = await import('youtubei.js');
    patchJsEvaluator(ytjs.Platform);
    const youtube = await ytjs.Innertube.create({ fetch: fetchWithTimeout });
    const clients = ['IOS', 'ANDROID_VR', 'VISIONOS', 'ANDROID', 'MWEB', 'WEB', 'TV', 'WEB_EMBEDDED', 'TV_EMBEDDED'];
    let lastFormatError;
    let lastCause;
    let basicInfo;
    const diagnostics = [];
    for (const client of clients) {
      if (controller.signal.aborted || parentSignal?.aborted) {
        throw apiError(504, 'YouTube tardó demasiado en responder.', { code: 'REQUEST_TIMEOUT' });
      }
      try {
        const playerData = await youtube.getBasicInfo(videoId, { client });
        basicInfo = basicInfo || playerData.basic_info;
        const formats = [
          ...(playerData.streaming_data?.formats || []),
          ...(playerData.streaming_data?.adaptive_formats || []),
        ];
        const selected = await selectYoutubeMediaFormat(formats, type, quality, youtube.session.player);
        diagnostics.push({ cliente: client, formatos: formats.length, ok: true });
        return { ...selected, basic_info: basicInfo };
      } catch (error) {
        if (parentSignal?.aborted || controller.signal.aborted) {
          throw apiError(504, 'YouTube tardó demasiado en responder.', { code: 'REQUEST_TIMEOUT' });
        }
        lastCause = error;
        if (error.code === 'YOUTUBE_FORMAT_UNAVAILABLE') lastFormatError = error;
        diagnostics.push({ cliente: client, ok: false, error: String(error.message || error).slice(0, 120) });
      }
    }
    try {
      const watchMedia = await fetchYoutubeWatchPageMedia(videoId, type, quality, youtube.session.player, controller.signal);
      diagnostics.push({ cliente: 'WATCH_PAGE', ok: true });
      return { ...watchMedia, basic_info: basicInfo?.title ? basicInfo : { ...watchMedia.basic_info, ...basicInfo } };
    } catch (watchError) {
      if (parentSignal?.aborted || controller.signal.aborted) {
        throw apiError(504, 'YouTube tardó demasiado en responder.', { code: 'REQUEST_TIMEOUT' });
      }
      diagnostics.push({ cliente: 'WATCH_PAGE', ok: false, error: String(watchError.message || watchError).slice(0, 120) });
    }
    const failure = lastFormatError || apiError(502, `YouTube no pudo proporcionar los formatos multimedia en este momento${lastCause?.message ? ` (${String(lastCause.message).slice(0, 140)})` : ''}.`, {
      code: 'YOUTUBE_UPSTREAM_FAILED',
    });
    failure.detalles = diagnostics;
    throw failure;
  } catch (error) {
    if (error.statusCode) throw error;
    if (parentSignal?.aborted || controller.signal.aborted) {
      throw apiError(504, 'YouTube tardó demasiado en responder.', { code: 'REQUEST_TIMEOUT' });
    }
    throw apiError(502, `YouTube no pudo proporcionar los formatos multimedia en este momento${error?.message ? ` (${String(error.message).slice(0, 140)})` : ''}.`, {
      code: 'YOUTUBE_UPSTREAM_FAILED',
    });
  } finally {
    clearTimeout(timer);
    if (parentSignal) parentSignal.removeEventListener('abort', abortFromParent);
  }
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

// Tweet-video extraction lives in `api/documentos/xvideo.js`. It reuses
// `getVideoVariants` and `extractTweetId` below but only scrapes X/Twitter's
// own public syndication endpoint — no third-party proxy APIs (e.g. fxtwitter).
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
    ...(tweet.mediaDetails || []).flatMap((media) => media.video_info?.variants || []),
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

function publicErrorMessage(error) {
  if (error.code === 'YOUTUBE_FORMAT_UNAVAILABLE') {
    return 'YouTube no ofreció un enlace directo de audio compatible para este video. Prueba con otro video.';
  }
  if (error.code === 'YOUTUBE_UPSTREAM_FAILED') {
    return 'No fue posible consultar YouTube. Intenta de nuevo en unos segundos.';
  }
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
  parseJson,
  extractTweetId,
  getVideoVariants,
  enforceRateLimit,
  extractYoutubeVideoId,
  fetchRealSearchResults,
  fetchTikTokVideo,
  fetchYoutubeMedia,
  fetchYoutubeWatchPageMedia,
  selectYoutubeMediaFormat,
  publicErrorMessage,
};
