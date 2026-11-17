const { createHash } = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
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
  // Solo se aceptan items de la busqueda real. El feed "Para Ti"
  // (webapp.foryou.video) y el regex legacy traen videos genericos que no
  // tienen relacion con el query y contaminaban los resultados.
  const items = [];
  const universalMatch = text.match(/id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([^<]+)<\/script>/);
  if (universalMatch) {
    try {
      const universal = JSON.parse(universalMatch[1]);
      const scope = universal.__DEFAULT_SCOPE__ || {};
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

  return buscarTikTokMultiFuente(query, limit, parentSignal);
}

const NAVEGADOR_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const TT_SEARCH_HOSTS = ['tiktok.com', 'www.tiktok.com', 'm.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com'];
const TT_SEARCH_CACHE = new Map();
const TT_SEARCH_CACHE_TTL = 5 * 60 * 1000;
let diagnosticoTikTok = null;
function obtenerDiagnosticoTikTok() { return diagnosticoTikTok; }

function senalConLimite(parentSignal, ms) {
  return parentSignal ? AbortSignal.any([parentSignal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}

// Fuente a: scraping directo de las paginas discover/search de TikTok.
// Devuelve resultados completos o [] si TikTok no le muestra nada al scraper.
async function buscarTikTokDirecta(query, limit, parentSignal) {
  const slug = slugifyTikTokQuery(query);
  const pages = [];
  if (slug) pages.push(`https://www.tiktok.com/discover/${encodeURIComponent(slug)}`);
  pages.push(`https://www.tiktok.com/search?q=${encodeURIComponent(query)}`);
  const results = [];
  for (let round = 0; round < 2 && results.length < limit; round += 1) {
    if (round > 0) await new Promise((resolve) => setTimeout(resolve, 400));
    for (const pageUrl of pages) {
      let text;
      try {
        ({ text } = await fetchTextSafe(pageUrl, { allowedHosts: TT_SEARCH_HOSTS, parentSignal, timeoutMs: 4500 }));
      } catch (error) {
        if (parentSignal?.aborted) throw error;
        continue;
      }
      for (const item of parseTikTokEmbeddedItems(text)) {
        const result = mapTikTokItemToResult(item);
        if (!result || results.some((existing) => existing.videoId === result.videoId)) continue;
        results.push(result);
        if (results.length >= limit) return results;
      }
      if (results.length >= limit) return results;
    }
  }
  return results;
}

// Fuente b: buscador de tikwm con headers de navegador real. Si Cloudflare lo
// challengea se marca como bloqueada y no se reintenta.
async function buscarTikwmSearch(query, limit, parentSignal) {
  const endpoint = `https://www.tikwm.com/api/feed/search?q=${encodeURIComponent(query)}&count=${Math.min(Math.max(Number(limit) || 5, 1), 20)}`;
  const response = await fetch(endpoint, {
    headers: {
      'User-Agent': NAVEGADOR_UA,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
      Referer: 'https://www.tiktok.com/',
    },
    signal: senalConLimite(parentSignal, 7000),
  });
  const text = await response.text().catch(() => '');
  if (text.includes('Just a moment') || text.includes('cf-challenge') || text.includes('challenge-platform')) {
    throw new Error('tikwm bloqueado por Cloudflare');
  }
  if (!response.ok) throw new Error(`tikwm respondio HTTP ${response.status}.`);
  let payload = null;
  try { payload = JSON.parse(text); } catch { throw new Error('tikwm no devolvio JSON.'); }
  const videos = payload?.data?.videos;
  if (!payload || payload.code !== 0 || !Array.isArray(videos)) {
    throw new Error(`tikwm sin datos (${String(payload?.msg || 'sin mensaje').slice(0, 60)}).`);
  }
  const results = [];
  for (const video of videos) {
    const videoId = String(video.video_id || '');
    if (!/^\d{10,25}$/.test(videoId)) continue;
    if (results.some((existing) => existing.videoId === videoId)) continue;
    results.push({
      type: 'video',
      videoId,
      title: String(video.title || '').slice(0, 500),
      url: video.author?.unique_id
        ? `https://www.tiktok.com/@${video.author.unique_id}/video/${videoId}`
        : `https://www.tiktok.com/video/${videoId}`,
      thumbnail: video.cover || '',
      duration: Number(video.duration) || 0,
      author: {
        username: video.author?.unique_id || '',
        nickname: video.author?.nickname || '',
      },
      stats: {
        views: Number(video.play_count) || 0,
        likes: Number(video.digg_count) || 0,
        comments: Number(video.comment_count) || 0,
        shares: Number(video.share_count) || 0,
      },
    });
    if (results.length >= limit) break;
  }
  return results;
}

// Extrae pares @usuario/video/<id> de HTML de motores de busqueda, incluyendo
// links redirigidos de DDG (uddg=) y Bing (u=a1<base64url>).
function extraerVideosTikTokDeHtml(text) {
  const encontrados = new Map();
  const limpio = String(text).replace(/\\u002F/gi, '/').replace(/%2F/gi, '/');
  let m;
  const patron = /tiktok\.com\/@([\w.\-]+)\/video\/(\d{10,25})/g;
  while ((m = patron.exec(limpio)) !== null) {
    if (!encontrados.has(m[2])) encontrados.set(m[2], m[1]);
  }
  const uddg = /uddg=([^&"'\s]+)/g;
  while ((m = uddg.exec(limpio)) !== null) {
    try {
      const im = decodeURIComponent(m[1]).match(/tiktok\.com\/@([\w.\-]+)\/video\/(\d{10,25})/);
      if (im && !encontrados.has(im[2])) encontrados.set(im[2], im[1]);
    } catch {}
  }
  const bing = /(?:&|&amp;|\?)u=a1([A-Za-z0-9_\-]+)/g;
  while ((m = bing.exec(limpio)) !== null) {
    try {
      const dec = Buffer.from(m[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      const im = dec.match(/tiktok\.com\/@([\w.\-]+)\/video\/(\d{10,25})/);
      if (im && !encontrados.has(im[2])) encontrados.set(im[2], im[1]);
    } catch {}
  }
  return [...encontrados.entries()].map(([videoId, username]) => ({ videoId, username }));
}

// Fuente searx: instancias publicas de SearXNG con site:tiktok.com. Rota por
// el pool ante 429/challenge (backoff 800ms), maximo 4 instancias, 7s c/u.
const SEARX_INSTANCIAS = [
  'https://kantan.cat',
  'https://failsearx.culturanerd.it',
  'https://anonsearch.win',
  'https://paulgo.io',
  'https://searx.tiekoetter.com',
  'https://priv.au',
  'https://opnxng.com',
  'https://baresearch.org',
  'https://search.rhscz.eu',
  'https://search.inetol.net',
  'https://search.hbubli.cc',
  'https://searx.be',
  'https://etsi.me',
  'https://search.rowie.at',
  'https://grep.vim.wtf',
  'https://find.xenorio.xyz',
  'https://search.im-in.space',
  'https://searx.githo.st',
  'https://www.gruble.de',
  'https://search.bus-hit.me',
  'https://searxng.au',
  'https://searx.baczek.me',
];
let searxOffset = 0;

function candidatoDesdeUrlTikTok(url) {
  const im = String(url || '').match(/tiktok\.com\/@([\w.\-]+)\/video\/(\d{10,25})/);
  return im ? { videoId: im[2], username: im[1] } : null;
}

function limpiarTituloSearx(texto) {
  const limpio = String(texto || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&(aacute|eacute|iacute|oacute|uacute|ntilde|uuml|Ntilde|Aacute|Eacute|Iacute|Oacute|Uacute);?/g,
      (_, e) => ({ aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', uuml: 'ü', Ntilde: 'Ñ', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú' }[e]))
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(Number(n)); } catch { return ' '; } })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return ' '; } })
    .replace(/\s+/g, ' ').trim();
  if (!limpio || /^https?:\/\//.test(limpio)) return '';
  return limpio.slice(0, 500);
}

// Extrae videoId, usuario, titulo y miniatura de los anchors de resultados de
// SearXNG: el primer anchor es el thumbnail (img con src /image?url=...) y el
// titulo llega en un anchor posterior del mismo articulo.
function extraerResultadosSearxDeHtml(text) {
  const resultados = new Map();
  const anchor = /<a\s[^>]*href="(https?:\/\/[^"\s]*tiktok\.com\/@[\w.\-]+\/video\/\d{10,25}[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = anchor.exec(String(text || ''))) !== null) {
    const candidato = candidatoDesdeUrlTikTok(m[1]);
    if (!candidato) continue;
    const title = limpiarTituloSearx(m[2]);
    let thumbnail = '';
    const img = /<img[^>]*src="([^"]+)"/.exec(m[2]);
    if (img) {
      const param = /[?&]url=([^&"\s]+)/.exec(img[1]);
      if (param) {
        try { thumbnail = decodeURIComponent(param[1]); } catch { thumbnail = param[1]; }
        if (!thumbnail.startsWith('http')) thumbnail = '';
      }
    }
    const previo = resultados.get(candidato.videoId);
    if (!previo) {
      resultados.set(candidato.videoId, { ...candidato, title, thumbnail });
    } else {
      if (!previo.title && title) previo.title = title;
      if (!previo.thumbnail && thumbnail) previo.thumbnail = thumbnail;
    }
  }
  if (!resultados.size) {
    for (const { videoId, username } of extraerVideosTikTokDeHtml(text)) {
      resultados.set(videoId, { videoId, username, title: '', thumbnail: '' });
    }
  }
  return [...resultados.values()];
}

async function buscarSearxTikTok(query, limit, parentSignal, presupuestoMs) {
  const variantes = [
    encodeURIComponent(`${query} site:tiktok.com`),
    encodeURIComponent(`${query} tiktok`),
  ];
  const mapear = (videos) => videos.slice(0, limit).map(({ videoId, username, title, thumbnail }) => ({
    type: 'video',
    videoId,
    title: title || '',
    url: `https://www.tiktok.com/@${username}/video/${videoId}`,
    thumbnail: thumbnail || '',
    duration: 0,
    author: { username, nickname: '' },
    stats: { views: 0, likes: 0, comments: 0, shares: 0 },
  }));
  // Pide una pagina a una instancia: JSON nativo primero y HTML de la misma
  // pagina si el JSON no vino (429 o deshabilitado). Registra el resultado.
  const pedirPagina = async (instancia, q, pageno) => {
    const extra = pageno > 1 ? `&pageno=${pageno}` : '';
    let videos = [];
    try {
      const response = await fetch(`${instancia}/search?q=${q}&format=json${extra}`, {
        headers: {
          'User-Agent': NAVEGADOR_UA,
          Accept: 'application/json',
          'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        },
        signal: senalConLimite(parentSignal, 4000),
      });
      const text = await response.text().catch(() => '');
      if (response.ok && text.trim().startsWith('{')) {
        try {
          const payload = JSON.parse(text);
          for (const item of payload.results || []) {
            const candidato = candidatoDesdeUrlTikTok(item?.url);
            if (candidato && !videos.some((v) => v.videoId === candidato.videoId)) {
              videos.push({ ...candidato, title: limpiarTituloSearx(item?.title), thumbnail: '' });
            }
          }
        } catch {}
      }
    } catch {}
    if (videos.length) {
      console.log(`[searx] ${instancia} p${pageno} json -> ${videos.length} videos`);
      return videos;
    }
    try {
      const response = await fetch(`${instancia}/search?q=${q}${extra}`, {
        headers: {
          'User-Agent': NAVEGADOR_UA,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        },
        signal: senalConLimite(parentSignal, 4000),
      });
      const text = await response.text().catch(() => '');
      if (response.status === 429 || text.includes('Just a moment')) {
        console.log(`[searx] ${instancia} p${pageno} -> bloqueada (HTTP ${response.status})`);
        return 'BLOQUEADA';
      }
      for (const { videoId, username, title, thumbnail } of extraerResultadosSearxDeHtml(text)) {
        if (!videos.some((v) => v.videoId === videoId)) videos.push({ videoId, username, title, thumbnail });
      }
    } catch (error) {
      if (parentSignal?.aborted) throw error;
      console.log(`[searx] ${instancia} p${pageno} -> error ${String(error?.message || error).slice(0, 60)}`);
      return 'BLOQUEADA';
    }
    console.log(`[searx] ${instancia} p${pageno} html -> ${videos.length} videos`);
    return videos;
  };
  const acumulados = [];
  const inicio = Date.now();
  const presupuesto = Math.max(3000, Math.min(11000, Number(presupuestoMs) || 11000));
  const vencido = () => Date.now() - inicio > presupuesto;
  let qActiva = variantes[0];
  for (let intento = 0; intento < 5 && acumulados.length < limit; intento += 1) {
    if (vencido()) break;
    const instancia = SEARX_INSTANCIAS[(intento + searxOffset) % SEARX_INSTANCIAS.length];
    // Variante del query sin site: solo cuando la principal no trajo nada.
    if (intento >= 3 && !acumulados.length && qActiva === variantes[0]) {
      qActiva = variantes[1];
      console.log('[searx] cambio a variante sin site: tras intentos sin resultados');
    }
    let videos = [];
    // 2 intentos por instancia con 1.5s de separacion antes de pasar a la siguiente.
    for (let sub = 0; sub < 2 && !videos.length; sub += 1) {
      if (sub > 0) {
        if (vencido()) break;
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      const primera = await pedirPagina(instancia, qActiva, 1);
      if (primera === 'BLOQUEADA') continue;
      videos = primera;
    }
    const fallo = !videos.length;
    // Paginacion: paginas 2 y 3 de la misma instancia.
    for (const pageno of [2, 3]) {
      if (!videos.length || acumulados.length + videos.length >= limit) break;
      if (vencido()) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
      const mas = await pedirPagina(instancia, qActiva, pageno);
      if (mas === 'BLOQUEADA' || !mas.length) break;
      videos = videos.concat(mas.filter((m) => !videos.some((v) => v.videoId === m.videoId)));
    }
    for (const video of videos) {
      if (acumulados.some((v) => v.videoId === video.videoId)) continue;
      acumulados.push(video);
      if (acumulados.length >= limit) break;
    }
    if (acumulados.length >= limit) return mapear(acumulados);
    if (fallo) searxOffset += 1;
    if (vencido()) break;
    await new Promise((resolve) => setTimeout(resolve, fallo ? 800 : 200));
  }
  return mapear(acumulados);
}

// Fuentes c/d/e: motores de busqueda con site:tiktok.com.
async function buscarEnMotorTikTok(motor, query, limit, parentSignal) {
  const q = encodeURIComponent(`site:tiktok.com ${query}`);
  const pageUrls = {
    ddg: `https://html.duckduckgo.com/html/?q=${q}`,
    ddglite: `https://lite.duckduckgo.com/lite/?q=${q}`,
    bing: `https://www.bing.com/search?q=${q}`,
  };
  const pageUrl = pageUrls[motor];
  if (!pageUrl) return [];
  const { text } = await fetchTextSafe(pageUrl, {
    allowedHosts: ['duckduckgo.com', 'html.duckduckgo.com', 'lite.duckduckgo.com', 'www.bing.com', 'bing.com'],
    parentSignal,
    timeoutMs: 4000,
    headers: { 'user-agent': NAVEGADOR_UA, 'accept-language': 'es-ES,es;q=0.9,en;q=0.8' },
  });
  return extraerVideosTikTokDeHtml(text).slice(0, limit).map(({ videoId, username }) => ({
    type: 'video',
    videoId,
    title: '',
    url: `https://www.tiktok.com/@${username}/video/${videoId}`,
    thumbnail: '',
    duration: 0,
    author: { username, nickname: '' },
    stats: { views: 0, likes: 0, comments: 0, shares: 0 },
  }));
}

// Enriquecido en paralelo (8s por video) con fuentes que si responden desde
// datacenter: oEmbed publico de TikTok y el endpoint de descarga de tikwm.
async function enriquecerResultadoTikTok(candidato, parentSignal) {
  const url = candidato.url || `https://www.tiktok.com/video/${candidato.videoId}`;
  const [oembedR, tikwmR] = await Promise.allSettled([
    fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`, {
      headers: { 'User-Agent': NAVEGADOR_UA, Accept: 'application/json' },
      signal: senalConLimite(parentSignal, 4000),
    }).then((r) => (r.ok ? r.json().catch(() => null) : null)),
    fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`, {
      headers: {
        'User-Agent': NAVEGADOR_UA,
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        Referer: 'https://www.tiktok.com/',
      },
      signal: senalConLimite(parentSignal, 4000),
    }).then((r) => (r.ok ? r.json().catch(() => null) : null)),
  ]);
  const oembed = oembedR.status === 'fulfilled' ? oembedR.value : null;
  const tikwm = tikwmR.status === 'fulfilled' && tikwmR.value?.code === 0 ? tikwmR.value.data : null;
  const username = candidato.author?.username
    || (url.match(/tiktok\.com\/@([\w.\-]+)\//) || [])[1]
    || '';
  const title = String(oembed?.title || tikwm?.title || candidato.title || '').slice(0, 500) || 'video de TikTok';
  return {
    type: 'video',
    videoId: candidato.videoId,
    title,
    url: username
      ? `https://www.tiktok.com/@${username}/video/${candidato.videoId}`
      : `https://www.tiktok.com/video/${candidato.videoId}`,
    thumbnail: tikwm?.cover || oembed?.thumbnail_url || candidato.thumbnail || '',
    duration: Number(tikwm?.duration) || Number(candidato.duration) || 0,
    author: {
      username,
      nickname: String(tikwm?.author?.nickname || oembed?.author_name || '').slice(0, 200),
    },
    stats: {
      views: Number(tikwm?.play_count) || Number(candidato.stats?.views) || 0,
      likes: Number(tikwm?.digg_count) || Number(candidato.stats?.likes) || 0,
      comments: Number(tikwm?.comment_count) || Number(candidato.stats?.comments) || 0,
      shares: Number(tikwm?.share_count) || Number(candidato.stats?.shares) || 0,
    },
  };
}

// Orquestador: lanza las 5 fuentes en paralelo (timeout 7s por fuente,
// presupuesto total ~20s), deduplica por videoId con preferencia
// directa > tikwm > ddg > ddglite > bing, enriquece y cachea por query+limit.
// Fuente primaria delegada (opcional): API externa de busqueda de TikTok
// configurada con ZENITH_SEARCH_URL (y ZENITH_SEARCH_KEY si pide clave).
// Responde {ok:true, resultados:[{title, url, author, ...}]}.
// Health-check de la fuente zenith: 2 fallos seguidos (timeout o error) la
// marcan caida por 5 minutos; vencido el plazo, el proximo intento la reactiva.
const ZENITH_HEALTH = { fallos: 0, caidaHasta: 0, razon: '' };

function zenithEstado() {
  const base = String(process.env.ZENITH_SEARCH_URL || '').trim();
  if (!base) return 'no configurada';
  if (Date.now() < ZENITH_HEALTH.caidaHasta) {
    return `saltada por health-check (${Math.ceil((ZENITH_HEALTH.caidaHasta - Date.now()) / 1000)}s restantes)`;
  }
  return 'activa';
}

async function buscarZenithTikTok(query, limit, parentSignal) {
  const base = String(process.env.ZENITH_SEARCH_URL || '').trim();
  if (!base) return [];
  if (Date.now() < ZENITH_HEALTH.caidaHasta) {
    console.log(`[zenith] saltada por health-check (${Math.ceil((ZENITH_HEALTH.caidaHasta - Date.now()) / 1000)}s restantes)`);
    return [];
  }
  const url = `${base.replace(/\/+$/, '')}/search?query=${encodeURIComponent(query)}&limit=${limit}`;
  const headers = {
    'bypass-tunnel-reminder': 'true',
    Accept: 'application/json',
  };
  const clave = String(process.env.ZENITH_SEARCH_KEY || '').trim();
  if (clave) {
    headers['x-api-key'] = clave;
    headers.Authorization = `Bearer ${clave}`;
  }
  try {
    const response = await fetch(url, { headers, signal: senalConLimite(parentSignal, 8000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json().catch(() => null);
    const lista = payload?.resultados || payload?.results;
    if (!Array.isArray(lista)) throw new Error('respuesta sin lista de resultados');
    ZENITH_HEALTH.fallos = 0;
    const resultados = [];
    for (const item of lista) {
      const urlVideo = String(item?.url || item?.link || '');
      const im = urlVideo.match(/\/video\/(\d{10,25})/);
      if (!im) continue;
      const imUser = urlVideo.match(/tiktok\.com\/@([\w.\-]+)/);
      const author = item?.author;
      const authorObj = author && typeof author === 'object' ? author : null;
      resultados.push({
        type: 'video',
        videoId: im[1],
        title: String(item?.title || '').slice(0, 500),
        url: urlVideo,
        thumbnail: String(item?.thumbnail || item?.cover || item?.image || ''),
        duration: Number(item?.duration) || 0,
        author: {
          username: String(authorObj?.username || authorObj?.unique_id || (typeof author === 'string' ? author : '') || imUser?.[1] || ''),
          nickname: String(authorObj?.nickname || authorObj?.name || '').slice(0, 200),
        },
        stats: {
          views: Number(item?.stats?.views ?? item?.views ?? item?.play_count) || 0,
          likes: Number(item?.stats?.likes ?? item?.likes ?? item?.digg_count) || 0,
          comments: Number(item?.stats?.comments ?? item?.comments ?? item?.comment_count) || 0,
          shares: Number(item?.stats?.shares ?? item?.shares ?? item?.share_count) || 0,
        },
      });
    }
    console.log(`[zenith] ${resultados.length} videos para "${String(query).slice(0, 40)}"`);
    return resultados.slice(0, limit);
  } catch (error) {
    if (parentSignal?.aborted) throw error;
    ZENITH_HEALTH.razon = String(error?.message || error).slice(0, 80);
    ZENITH_HEALTH.fallos += 1;
    if (ZENITH_HEALTH.fallos >= 2) {
      ZENITH_HEALTH.caidaHasta = Date.now() + 5 * 60 * 1000;
      ZENITH_HEALTH.fallos = 0;
      console.log(`[zenith] marcada caida por 5 minutos (${ZENITH_HEALTH.razon})`);
    } else {
      console.log(`[zenith] fallo ${ZENITH_HEALTH.fallos}/2: ${ZENITH_HEALTH.razon}`);
    }
    return [];
  }
}

async function buscarTikTokMultiFuente(query, limit, parentSignal) {
  const qNorm = String(query).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
  const cacheKey = qNorm + '|' + limit;
  const cached = TT_SEARCH_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.results;

  const t0 = Date.now();
  const tiempos = {};
  const medir = async (nombre, promesa) => {
    const inicio = Date.now();
    try {
      const value = await promesa;
      tiempos[nombre] = Date.now() - inicio;
      return { status: 'fulfilled', value };
    } catch (reason) {
      tiempos[nombre] = Date.now() - inicio;
      return { status: 'rejected', reason };
    }
  };

  const vistos = new Set();
  const candidatos = [];
  const juntar = (valor) => {
    if (!Array.isArray(valor)) return;
    for (const candidato of valor) {
      if (!candidato?.videoId || vistos.has(candidato.videoId)) continue;
      vistos.add(candidato.videoId);
      candidatos.push(candidato);
      if (candidatos.length >= limit) break;
    }
  };

  let fuentes = [];
  // Fuente primaria delegada: si ZENITH_SEARCH_URL esta configurada y sana es
  // bloqueante y prioritaria; si trae resultados no se lanzan las demas.
  // No configurada o marcada caida por el health-check: salteada al instante
  // (0ms, sin intento de red).
  const zenithConfigurada = Boolean(String(process.env.ZENITH_SEARCH_URL || '').trim());
  const zenithSalteadaPorSalud = zenithConfigurada && Date.now() < ZENITH_HEALTH.caidaHasta;
  if (zenithConfigurada && !zenithSalteadaPorSalud) {
    const zenithR = await medir('zenith', buscarZenithTikTok(query, limit, parentSignal));
    fuentes.push(['zenith', zenithR]);
    juntar(zenithR.value);
  } else {
    tiempos.zenith = 0;
    fuentes.push(['zenith', { status: 'fulfilled', value: null }]);
  }
  if (!candidatos.length) {
    const [directaR, tikwmR, searxR, ddgR, ddgLtR, bingR] = await Promise.all([
      medir('directa', buscarTikTokDirecta(query, limit, parentSignal)),
      medir('tikwm', buscarTikwmSearch(query, limit, parentSignal)),
      medir('searx', buscarSearxTikTok(query, limit, parentSignal)),
      medir('ddg', buscarEnMotorTikTok('ddg', query, limit, parentSignal)),
      medir('ddglite', buscarEnMotorTikTok('ddglite', query, limit, parentSignal)),
      medir('bing', buscarEnMotorTikTok('bing', query, limit, parentSignal)),
    ]);
    fuentes.push(['directa', directaR], ['tikwm', tikwmR], ['searx', searxR], ['ddg', ddgR], ['ddglite', ddgLtR], ['bing', bingR]);
    for (const [, fuente] of fuentes) juntar(fuente.value);
    // Segunda pasada solo si queda presupuesto: las fuentes upstream son
    // intermitentes y un reintento corto suele recuperar resultados.
    if (!candidatos.length && Date.now() - t0 < 7000) {
      await new Promise((resolve) => setTimeout(resolve, 800));
      const restante = Math.max(3000, 11000 - (Date.now() - t0));
      const [tikwmR2, searxR2] = await Promise.all([
        medir('tikwm2', buscarTikwmSearch(query, limit, parentSignal)),
        medir('searx2', buscarSearxTikTok(query, limit, parentSignal, restante)),
      ]);
      fuentes.push(['tikwm2', tikwmR2], ['searx2', searxR2]);
      juntar(tikwmR2.value);
      juntar(searxR2.value);
    }
  }

  // Enriquecido solo para los que no traen titulo (los que ya lo tienen
  // responden rapido); timeout 4s por video, escalonado para no chocar
  // con el rate limit de tikwm.
  const pendientes = candidatos.filter((c) => !c.title);
  const enriquecidos = pendientes.length
    ? await Promise.allSettled(pendientes.map(async (candidato, i) => {
      if (i) await new Promise((resolve) => setTimeout(resolve, i * 300));
      return enriquecerResultadoTikTok(candidato, parentSignal);
    }))
    : [];
  const enriquecidoDe = new Map(pendientes.map((c, i) => [c.videoId, enriquecidos[i]]));
  const results = candidatos.map((candidato) => {
    const enriquecido = enriquecidoDe.get(candidato.videoId);
    if (enriquecido?.status === 'fulfilled' && enriquecido.value) return enriquecido.value;
    return { ...candidato, title: candidato.title || 'video de TikTok' };
  });

  const conteo = fuentes
    .map(([nombre, fuente]) => `${nombre}=${fuente.status === 'fulfilled' && Array.isArray(fuente.value) ? fuente.value.length : 'X'}(${tiempos[nombre] || 0}ms)`)
    .join(' ');
  console.log(`[ttsearch] query="${qNorm.slice(0, 80)}" fuentes: ${conteo} -> resultados=${results.length} total=${Date.now() - t0}ms`);
  diagnosticoTikTok = {
    query: qNorm.slice(0, 80),
    fuentes: Object.fromEntries(fuentes.map(([nombre, fuente]) => [
      nombre,
      fuente.status === 'fulfilled'
        ? (Array.isArray(fuente.value) ? fuente.value.length : 0)
        : String(fuente.reason?.message || fuente.reason || 'error').slice(0, 80),
    ])),
    zenith_estado: zenithEstado(),
    tiempos_fuente: { ...tiempos },
    tiempo_total_ms: Date.now() - t0,
    resultados: results.length,
  };

  if (TT_SEARCH_CACHE.size > 100) TT_SEARCH_CACHE.clear();
  // Los resultados vacios se cachean poco tiempo: las fuentes son intermitentes
  // y una mala ronda no debe dejar la busqueda en cero durante el TTL completo.
  TT_SEARCH_CACHE.set(cacheKey, { results, expiresAt: Date.now() + (results.length ? TT_SEARCH_CACHE_TTL : 30 * 1000) });
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
    const mime = typeof f.mimeType === 'string' ? f.mimeType : typeof f.mime_type === 'string' ? f.mime_type : '';
    return {
      itag: Number(f.itag) || null,
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

const WATCH_PAGE_COOKIES = 'CONSENT=YES+cb.20210328-17-p0.en+FX+678; SOCS=CAI';

async function fetchYoutubeWatchPageMedia(videoId, type, quality, player, parentSignal) {
  const variants = [
    `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=es&bpctr=9999999999&has_verified=1&ucbcb=1`,
    `https://m.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=es&bpctr=9999999999&has_verified=1&ucbcb=1`,
  ];
  const problemas = [];
  for (const watchUrl of variants) {
    let text;
    try {
      ({ text } = await fetchTextSafe(watchUrl, {
        allowedHosts: ['youtube.com', 'www.youtube.com', 'm.youtube.com'],
        parentSignal,
        timeoutMs: 5000,
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'es-ES,es;q=0.9,en;q=0.8',
          cookie: WATCH_PAGE_COOKIES,
        },
      }));
    } catch (error) {
      problemas.push(`fetch: ${String(error.message || error).slice(0, 80)}`);
      continue;
    }
    const playerResponse = extractEmbeddedJson(text, 'ytInitialPlayerResponse');
    if (!playerResponse) {
      problemas.push('sin ytInitialPlayerResponse');
      continue;
    }
    if (!playerResponse.streamingData) {
      problemas.push(`sin streamingData (${playerResponse.playabilityStatus?.status || 'desconocido'})`);
      continue;
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
  const error = apiError(502, 'La pagina de YouTube no expuso datos de reproduccion.', { code: 'YOUTUBE_WATCHPAGE_EMPTY' });
  error.detalles = problemas;
  throw error;
}

async function selectYoutubeMediaFormat(formats, type, quality, player) {
  const resolved = await Promise.all(
    formats.map(async (format) => ({ format, url: await resolveYoutubeFormatUrl(format, player) })),
  );
  const available = resolved.filter((item) => item.url);

  if (type === 'audio') {
    // Prioridad: 1) itag 140 (m4a audio puro), 2) cualquier formato audio/mp4 o
    // audio/webm, 3) ultimo recurso: un formato progresivo con audio (itag 18).
    const audioOnly = available.filter(({ format }) => format.mime_type?.startsWith('audio/'));
    const audioScore = (item) => {
      const itag = String(item.format.itag || '');
      const mime = String(item.format.mime_type || '');
      if (itag === '140') return 3;
      if (mime.startsWith('audio/mp4') || mime.startsWith('audio/webm')) return 2;
      return 1;
    };
    const selected = audioOnly.slice()
      .sort((a, b) => (audioScore(b) - audioScore(a)) || ((b.format.bitrate || 0) - (a.format.bitrate || 0)))[0] ||
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

function normalizeYoutubeCookie(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return '';
  const lines = value.split('\n');
  const looksNetscape = lines.some((line) => line.includes('\t') && !line.startsWith('#'));
  if (!looksNetscape) return value.replace(/\s*\n\s*/g, ' ');
  const now = Math.floor(Date.now() / 1000);
  const pairs = [];
  for (const line of lines) {
    if (!line || line.startsWith('#')) continue;
    const fields = line.split('\t').map((f) => f.trim());
    if (fields.length < 7 || !fields[5] || !fields[6]) continue;
    const expiry = Number(fields[4]);
    if (Number.isFinite(expiry) && expiry > 0 && expiry < now) continue;
    pairs.push(`${fields[5]}=${fields[6]}`);
  }
  return pairs.join('; ');
}

let youtubePoMinterCache = null;

async function acquireYoutubePoMinter(youtube) {
  if (youtubePoMinterCache && youtubePoMinterCache.expiresAt > Date.now()) return youtubePoMinterCache;
  const visitorData = youtube.session.context.client.visitorData;
  if (!visitorData) return null;
  const challengeResponse = await youtube.getAttestationChallenge('ENGAGEMENT_TYPE_UNBOUND');
  const bg = challengeResponse.bg_challenge;
  const interpreterUrl = bg?.interpreter_url?.private_do_not_access_or_else_trusted_resource_url_wrapped_value || bg?.interpreter_url;
  if (!bg?.program || !bg?.global_name || !interpreterUrl) return null;
  const interpreterJavascript = await (await fetch(`https:${interpreterUrl}`, { signal: AbortSignal.timeout(8000) })).text();
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://www.youtube.com/' });
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.screen = dom.window.screen;
  global.location = dom.window.location;
  global.history = dom.window.history;
  new Function(interpreterJavascript)();
  const { BotGuardClient } = await import('bgutils-js/botguard');
  const botguard = await BotGuardClient.create({ program: bg.program, globalName: bg.global_name, globalObject: globalThis });
  const webPoSignalOutput = [];
  const botguardResponse = await botguard.snapshot({ webPoSignalOutput });
  const integrityRaw = await (await fetch('https://jnn-pa.googleapis.com/$rpc/google.internal.waa.v1.Waa/GenerateIT', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json+protobuf',
      'x-goog-api-key': 'AIzaSyDyT5W0Jh49F30Pqqtyfdf7pDLFKLJoAnw',
      'x-user-agent': 'grpc-web-javascript/0.1',
    },
    body: JSON.stringify([botguardResponse]),
    signal: AbortSignal.timeout(8000),
  })).json();
  if (!Array.isArray(integrityRaw) || !integrityRaw[0]) return null;
  const { WebPoMinter } = await import('bgutils-js/webpo');
  const minter = await WebPoMinter.create(
    { integrityToken: integrityRaw[0], estimatedTtlSecs: integrityRaw[1], mintRefreshThreshold: integrityRaw[2], websafeFallbackToken: integrityRaw[3] },
    webPoSignalOutput,
  );
  if (typeof minter?.mintAsWebsafeString !== 'function') return null;
  youtubePoMinterCache = { minter, visitorData, expiresAt: Date.now() + 6 * 60 * 60 * 1000 };
  return youtubePoMinterCache;
}

let dlProxyCache;
function getDlProxy() {
  if (dlProxyCache !== undefined) return dlProxyCache;
  const raw = (process.env.DL_PROXY_URL || process.env.dl_proxy_url || '').trim();
  dlProxyCache = null;
  if (raw) {
    try {
      const u = new URL(raw);
      if (u.protocol === 'http:' && u.hostname) {
        dlProxyCache = {
          host: u.hostname,
          port: Number(u.port) || 80,
          auth: (u.username || u.password)
            ? 'Basic ' + Buffer.from(decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password)).toString('base64')
            : null,
        };
      }
    } catch {}
  }
  return dlProxyCache;
}

function headersToPlainObject(headers) {
  if (!headers) return {};
  if (typeof Headers !== 'undefined' && headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...headers };
}

// Peticion HTTPS a traves del tunel CONNECT del proxy de salida. Devuelve la
// respuesta cruda de node (mediaRes) para que el llamador la consuma.
function requestViaProxy(proxy, targetUrl, { method = 'GET', headers = {}, body = null, signal = null, timeoutMs = 20000 }) {
  return new Promise((resolve, reject) => {
    const target = new URL(targetUrl);
    if (target.protocol !== 'https:') return reject(new Error('El proxy de salida solo soporta destinos https.'));
    let tlsSocket = null;
    let mediaReq = null;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      try { mediaReq && mediaReq.destroy(); } catch {}
      try { tlsSocket && tlsSocket.destroy(); } catch {}
      reject(error);
    };
    const onAbort = () => fail(new Error('La solicitud a traves del proxy fue abortada.'));
    if (signal) {
      if (signal.aborted) return fail(new Error('La solicitud a traves del proxy fue abortada.'));
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const connectReq = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: target.host + ':443',
      headers: { Host: target.host + ':443', ...(proxy.auth ? { 'Proxy-Authorization': proxy.auth } : {}) },
      timeout: timeoutMs,
    });
    connectReq.on('timeout', () => connectReq.destroy(new Error('El proxy tardo demasiado en responder.')));
    connectReq.on('error', fail);
    connectReq.on('connect', (proxyRes, socket) => {
      if (proxyRes.statusCode !== 200) {
        socket.destroy();
        return fail(new Error('El proxy rechazo la conexion (HTTP ' + proxyRes.statusCode + ').'));
      }
      tlsSocket = tls.connect({ socket, servername: target.hostname });
      tlsSocket.once('error', fail);
      tlsSocket.once('secureConnect', () => {
        mediaReq = https.request(targetUrl, { method, headers, agent: false, createConnection: () => tlsSocket });
        mediaReq.on('error', fail);
        mediaReq.on('response', (mediaRes) => {
          if (settled) { mediaRes.destroy(); return; }
          settled = true;
          if (signal) signal.removeEventListener('abort', onAbort);
          resolve({
            mediaRes,
            cleanup: () => {
              try { mediaReq.destroy(); } catch {}
              try { tlsSocket.destroy(); } catch {}
            },
          });
        });
        if (body != null) mediaReq.write(body);
        mediaReq.end();
      });
    });
    connectReq.end();
  });
}

const PROXIED_RESPONSE_MAX_BYTES = 25 * 1024 * 1024;

async function fetchViaProxy(proxy, targetUrl, { method, headers, body, signal, timeoutMs }) {
  const { mediaRes, cleanup } = await requestViaProxy(proxy, targetUrl, { method, headers, body, signal, timeoutMs });
  try {
    const chunks = [];
    let total = 0;
    const buffered = await new Promise((resolve, reject) => {
      mediaRes.on('data', (chunk) => {
        total += chunk.length;
        if (total > PROXIED_RESPONSE_MAX_BYTES) {
          mediaRes.destroy();
          reject(new Error('La respuesta del proveedor excedio el tamano maximo.'));
          return;
        }
        chunks.push(chunk);
      });
      mediaRes.on('end', resolve);
      mediaRes.on('error', reject);
    });
    const flatHeaders = {};
    for (const [name, value] of Object.entries(mediaRes.headers)) {
      flatHeaders[name] = Array.isArray(value) ? value.join(', ') : String(value);
    }
    return new Response(Buffer.concat(chunks), {
      status: mediaRes.statusCode,
      statusText: mediaRes.statusMessage || '',
      headers: flatHeaders,
    });
  } finally {
    cleanup();
  }
}

function makeStableFetch() {
  return async (input, init = {}) => {
    let requestUrl;
    try {
      requestUrl = new URL(input instanceof URL ? input.href : input instanceof Request ? input.url : String(input));
    } catch {
      throw apiError(502, 'YouTube intent\u00f3 consultar un destino no permitido.', { code: 'YOUTUBE_UPSTREAM_BLOCKED' });
    }
    if (
      requestUrl.protocol !== 'https:' || requestUrl.username || requestUrl.password || requestUrl.port ||
      !['youtube.com', 'www.youtube.com'].includes(requestUrl.hostname.toLowerCase())
    ) {
      throw apiError(502, 'YouTube intent\u00f3 consultar un destino no permitido.', { code: 'YOUTUBE_UPSTREAM_BLOCKED' });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(apiError(504, 'La solicitud al proveedor excedi\u00f3 el tiempo l\u00edmite.')), 20000);
    const outer = init.signal;
    if (outer) {
      if (outer.aborted) {
        clearTimeout(timer);
        throw apiError(504, 'La solicitud excedi\u00f3 el tiempo l\u00edmite.');
      }
      outer.addEventListener('abort', () => controller.abort(outer.reason), { once: true });
    }
    try {
      const proxy = getDlProxy();
      if (proxy) {
        // Con DL_PROXY_URL configurada, TODO el trafico del player sale por el
        // proxy: asi la URL firmada de googlevideo queda amarrada a la IP del
        // proxy, la misma IP por la que descarga probeMedia/streamMedia.
        const method = (init.method || (input instanceof Request ? input.method : 'GET') || 'GET').toUpperCase();
        const headers = headersToPlainObject(init.headers || (input instanceof Request ? input.headers : undefined));
        let body = init.body != null ? init.body : null;
        if (body == null && input instanceof Request && input.method !== 'GET' && input.body != null) {
          try { body = Buffer.from(await input.arrayBuffer()); } catch {}
        }
        if (body != null && typeof body !== 'string' && !Buffer.isBuffer(body) && typeof body.arrayBuffer === 'function') {
          try { body = Buffer.from(await body.arrayBuffer()); } catch {}
        }
        return await fetchViaProxy(proxy, requestUrl.href, {
          method,
          headers,
          body,
          signal: controller.signal,
          timeoutMs: 20000,
        });
      }
      return await fetch(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };
}

const youtubeInstanceCache = { conCookie: null, sinCookie: null };

async function getYoutubeInstance(usarCookie) {
  const key = usarCookie ? 'conCookie' : 'sinCookie';
  const cached = youtubeInstanceCache[key];
  if (cached && cached.expiresAt > Date.now()) return cached.instance;
  const ytjs = await import('youtubei.js');
  patchJsEvaluator(ytjs.Platform);
  const cookieRaw = process.env.YOUTUBE_COOKIE || process.env.youtube_cookie || '';
  const visitorRaw = process.env.YOUTUBE_VISITOR_DATA || process.env.youtube_visitor_data || '';
  const instance = await ytjs.Innertube.create({
    fetch: makeStableFetch(),
    ...(usarCookie && cookieRaw ? { cookie: normalizeYoutubeCookie(cookieRaw) } : {}),
    ...(usarCookie && visitorRaw ? { visitor_data: visitorRaw } : {}),
  });
  youtubeInstanceCache[key] = { instance, expiresAt: Date.now() + 6 * 60 * 60 * 1000 };
  return instance;
}

async function fetchYoutubeMedia(videoId, type, quality, parentSignal, options = {}) {
  const videoIdLimpio = String(videoId || '').trim();
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoIdLimpio)) {
    throw apiError(400, `No se pudo resolver un videoId valido a partir de la consulta (se obtuvo: "${videoIdLimpio.slice(0, 60) || 'vacio'}").`, {
      code: 'YOUTUBE_VIDEO_ID_INVALID',
    });
  }
  if (parentSignal?.aborted) throw apiError(504, 'REQUEST_TIMEOUT', 'La solicitud excedió el tiempo límite.');

  const controller = new AbortController();
  const timeoutError = apiError(504, 'REQUEST_TIMEOUT', 'La solicitud excedió el tiempo límite.');
  const abortFromParent = () => controller.abort(parentSignal.reason || timeoutError);
  const timer = setTimeout(() => controller.abort(timeoutError), 24000);
  if (parentSignal) parentSignal.addEventListener('abort', abortFromParent, { once: true });
  try {
    const youtube = options.youtube || await getYoutubeInstance(options.cookie !== false);
    const clients = ['IOS', 'TV', 'ANDROID_VR', 'WEB', 'MWEB', 'VISIONOS', 'TV_SIMPLY', 'YTMUSIC', 'ANDROID'];
    const deadline = Date.now() + 21000;
    let lastFormatError;
    let lastCause;
    let basicInfo;
    let loginRequiredCount = 0;
    const diagnostics = [];
    const attemptClient = async (client, poToken) => {
      if (controller.signal.aborted || parentSignal?.aborted) {
        throw apiError(504, 'YouTube tardó demasiado en responder.', { code: 'REQUEST_TIMEOUT' });
      }
      const clientDiag = { cliente: client, ...(poToken ? { po_token: true } : {}) };
      try {
        const playerData = await youtube.getBasicInfo(videoId, poToken ? { client, po_token: poToken } : { client });
        basicInfo = basicInfo || playerData.basic_info;
        const formats = [
          ...(playerData.streaming_data?.formats || []),
          ...(playerData.streaming_data?.adaptive_formats || []),
        ];
        clientDiag.playability = playerData.playability_status?.status || 'UNKNOWN';
        if (playerData.playability_status?.reason) clientDiag.razon = String(playerData.playability_status.reason).slice(0, 100);
        clientDiag.formatos = formats.length;
        clientDiag.directos = formats.filter((f) => f.url).length;
        if (clientDiag.playability === 'LOGIN_REQUIRED') loginRequiredCount += 1;
        const selected = await selectYoutubeMediaFormat(formats, type, quality, youtube.session.player);
        clientDiag.ok = true;
        diagnostics.push(clientDiag);
        return { ...selected, basic_info: basicInfo };
      } catch (error) {
        if (parentSignal?.aborted || controller.signal.aborted) {
          throw apiError(504, 'YouTube tardó demasiado en responder.', { code: 'REQUEST_TIMEOUT' });
        }
        lastCause = error;
        if (error.code === 'YOUTUBE_FORMAT_UNAVAILABLE') lastFormatError = error;
        diagnostics.push({ ...clientDiag, ok: false, error: String(error.message || error).slice(0, 120) });
        return null;
      }
    };
    const attemptInParallel = async (clientList, poToken) => {
      const results = await Promise.allSettled(clientList.map((client) => attemptClient(client, poToken)));
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) return result.value;
      }
      return null;
    };
    if (typeof options.client === 'string' && options.client) {
      const media = await attemptClient(options.client);
      if (media) return media;
      throw apiError(502, `El cliente ${options.client} no pudo obtener un enlace descargable.`, { code: 'YOUTUBE_CLIENT_FAILED' });
    }
    for (let round = 0; round < 3; round += 1) {
      if (Date.now() > deadline - 3000) break;
      const media = await attemptInParallel(clients.slice(0, 5), undefined);
      if (media) return media;
    }
    for (const client of clients.slice(5)) {
      if (Date.now() > deadline - 2500) break;
      const media = await attemptClient(client);
      if (media) return media;
    }
    if (loginRequiredCount > 0 && Date.now() < deadline - 9000) {
      try {
        const minterData = await acquireYoutubePoMinter(youtube);
        if (minterData) {
          diagnostics.push({ cliente: 'PO_TOKEN', ok: true });
          const videoToken = await minterData.minter.mintAsWebsafeString(videoId);
          for (const client of ['IOS', 'ANDROID_VR', 'WEB', 'MWEB']) {
            if (Date.now() > deadline - 2500) break;
            const media = await attemptClient(client, videoToken);
            if (media) return media;
          }
          const visitorToken = await minterData.minter.mintAsWebsafeString(minterData.visitorData);
          for (const client of ['WEB', 'MWEB']) {
            if (Date.now() > deadline - 2500) break;
            const media = await attemptClient(client, visitorToken);
            if (media) return media;
          }
        } else {
          diagnostics.push({ cliente: 'PO_TOKEN', ok: false, error: 'no se pudo generar' });
        }
      } catch (poError) {
        if (parentSignal?.aborted || controller.signal.aborted || poError.statusCode === 504) {
          throw apiError(504, 'YouTube tardó demasiado en responder.', { code: 'REQUEST_TIMEOUT' });
        }
        diagnostics.push({ cliente: 'PO_TOKEN', ok: false, error: String(poError.message || poError).slice(0, 120) });
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
      diagnostics.push({ cliente: 'WATCH_PAGE', ok: false, error: String(watchError.message || watchError).slice(0, 120), detalle: watchError.detalles });
    }
    if (loginRequiredCount >= clients.length - 1) {
      const loginError = apiError(502, 'Este video tiene restriccion de edad o verificacion anti-bot: YouTube exige inicio de sesion para descargarlo.', {
        code: 'YOUTUBE_LOGIN_REQUIRED',
      });
      loginError.solucion = 'YouTube exige sesion iniciada para este video desde IPs de servidor. Solucion: en Vercel (Settings > Environment Variables) crea YOUTUBE_COOKIE con la cookie de tu navegador logueado en YouTube (F12 > Network > clic en un pedido a youtube.com > Request Headers > Cookie) y haz redeploy.';
      loginError.detalles = diagnostics;
      throw loginError;
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

function parseTikTokVideoData(text) {
  let videoData;
  const universalMatch = text.match(/id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([^<]+)<\/script>/);
  if (universalMatch) {
    try {
      const universal = JSON.parse(universalMatch[1]);
      videoData = universal.__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct;
    } catch {}
  }
  if (!videoData) {
    // SIGI_STATE tolerante: no exige el sufijo window['SIGI_RETRY'].
    const sigiMatch = text.match(/window\[['"]SIGI_STATE['"]\]\s*=\s*({[\s\S]*?})\s*;/);
    if (sigiMatch) {
      try {
        const sigi = JSON.parse(sigiMatch[1]);
        const itemId = Object.keys(sigi.ItemModule || {})[0];
        videoData = itemId ? sigi.ItemModule[itemId] : null;
      } catch {}
    }
  }
  return videoData || null;
}

async function fetchTikTokVideo(initialUrl, parentSignal) {
  validTikTokUrl(initialUrl);
  const allowedHosts = ['tiktok.com', 'www.tiktok.com', 'm.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com', 'douyin.com', 'www.douyin.com', 'v.douyin.com'];
  let lastError;
  // Dos intentos: fetchTextSafe sigue redirects, por lo que una URL corta
  // (vt.tiktok.com) se resuelve sola a la pagina canonica del video.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 700));
    let text;
    let finalUrl = initialUrl;
    try {
      ({ text, url: finalUrl } = await fetchTextSafe(initialUrl, {
        allowedHosts,
        parentSignal,
        timeoutMs: 4500,
      }));
    } catch (error) {
      if (error.statusCode) throw error;
      lastError = error;
      continue;
    }
    const videoData = parseTikTokVideoData(text);
    if (!videoData) {
      lastError = apiError(502, 'TikTok no devolvió metadatos de video reconocibles.');
      continue;
    }
    const play = videoData.video?.playAddr || videoData.video?.downloadAddr || '';
    const download = videoData.video?.downloadAddr || videoData.video?.playAddr || '';
    if (!play) {
      lastError = apiError(502, 'TikTok no expuso una URL de video descargable para este enlace.');
      continue;
    }
    const canonicalUrl = typeof finalUrl === 'string' && /^https:\/\/(www\.)?tiktok\.com\/.+\/video\//.test(finalUrl) ? finalUrl : initialUrl;
    return {
      creator: 'Jxmpier207',
      status: true,
      descarga_headers: { ...UPSTREAM_HEADERS },
      data: {
        id: String(videoData.id || ''),
        url: canonicalUrl,
        type: 'video',
        title: String(videoData.desc || '').slice(0, 2000),
        cover: videoData.video?.cover || '',
        duration: Number(videoData.video?.duration) || 0,
        links: {
          hd: play,
          sd: play,
          wm: download,
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
  try {
    return await fetchTikTokViaTikwm(initialUrl, parentSignal);
  } catch (respaldoError) {
    throw lastError || respaldoError;
  }
}

async function fetchTikTokViaTikwm(initialUrl, parentSignal) {
  const endpoint = `https://www.tikwm.com/api/?url=${encodeURIComponent(initialUrl)}&hd=1`;
  const response = await fetch(endpoint, {
    headers: { 'User-Agent': UPSTREAM_HEADERS['User-Agent'] || 'Mozilla/5.0', Accept: 'application/json' },
    signal: parentSignal ? AbortSignal.any([parentSignal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
  });
  if (!response.ok) throw apiError(502, `El respaldo de TikTok respondió HTTP ${response.status}.`);
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) throw apiError(502, 'El respaldo de TikTok no devolvió JSON.');
  const payload = await response.json().catch(() => null);
  if (!payload || payload.code !== 0 || !payload.data) {
    throw apiError(502, `El respaldo de TikTok no devolvió datos (${String(payload?.msg || 'sin mensaje').slice(0, 80)}).`);
  }
  const d = payload.data;
  const absolutizar = (u) => (typeof u === 'string' && u.startsWith('/') ? `https://www.tikwm.com${u}` : u || '');
  const play = absolutizar(d.hdplay || d.play);
  const download = absolutizar(d.wmplay || d.play);
  if (!play) throw apiError(502, 'El respaldo de TikTok no expuso una URL de video.');
  return {
    creator: 'Jxmpier207',
    status: true,
    descarga_headers: { ...UPSTREAM_HEADERS },
    data: {
      id: String(d.id || ''),
      url: initialUrl,
      type: 'video',
      title: String(d.title || '').slice(0, 2000),
      cover: d.cover || '',
      duration: Number(d.duration) || 0,
      links: {
        hd: play,
        sd: absolutizar(d.play || d.hdplay),
        wm: download,
        mp3: absolutizar(d.music),
      },
      author: {
        username: d.author?.unique_id || '',
        nickname: d.author?.nickname || '',
        avatar: d.author?.avatar || '',
      },
      music: {
        title: d.music_info?.title || '',
        author: d.music_info?.author || '',
        cover: d.music_info?.cover || '',
      },
      stats: {
        views: Number(d.play_count) || 0,
        likes: Number(d.digg_count) || 0,
        comments: Number(d.comment_count) || 0,
        shares: Number(d.share_count) || 0,
        downloads: Number(d.download_count) || 0,
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
      ...(video.url ? [{ url: video.url, quality: video.quality, contentType: video.contentType }] : []),
      ...(video.variants || []).map((variant) => ({
        url: variant.url || variant.src,
        quality: variant.quality || (variant.bitrate ? `${Math.round(variant.bitrate / 1000)}k` : 'unknown'),
        bitrate: variant.bitrate || null,
        contentType: variant.contentType || variant.content_type || variant.type,
      })),
    ]),
    ...(tweet.video?.variants || []).map((variant) => ({
      url: variant.src || variant.url,
      quality: variant.quality || (variant.bitrate ? `${Math.round(variant.bitrate / 1000)}k` : 'unknown'),
      bitrate: variant.bitrate || null,
      contentType: variant.contentType || variant.content_type || variant.type,
    })),
    ...(tweet.extended_entities?.media || []).flatMap((media) => media.video_info?.variants || []),
    ...(tweet.mediaDetails || []).flatMap((media) => media.video_info?.variants || []),
  ];
  const unique = new Map();
  for (const variant of variants) {
    if (!variant || !variant.url) continue;
    const tipo = String(variant.contentType || variant.content_type || variant.type || '').toLowerCase();
    const esM3u8 = tipo.includes('mpegurl') || /\.m3u8($|\?)/i.test(variant.url);
    const esMp4 = tipo.includes('mp4') || /\.mp4($|\?)/i.test(variant.url);
    if (!esMp4 && !esM3u8) continue;
    try {
      const url = new URL(variant.url);
      if (url.protocol !== 'https:' || url.hostname !== 'video.twimg.com') continue;
      const dims = (url.pathname.match(/\d{3,4}x\d{3,4}/) || [])[0] || null;
      unique.set(url.href, {
        url: url.href,
        quality: variant.quality || dims || (variant.bitrate ? `${Math.round(variant.bitrate / 1000)}k` : 'unknown'),
        ...(variant.bitrate ? { bitrate: variant.bitrate } : {}),
        type: esM3u8 ? 'application/vnd.apple.mpegurl' : 'video/mp4',
      });
    } catch {}
  }
  const lista = [...unique.values()];
  lista.sort((a, b) => {
    if ((a.type === 'video/mp4') !== (b.type === 'video/mp4')) return a.type === 'video/mp4' ? -1 : 1;
    return (b.bitrate || 0) - (a.bitrate || 0);
  });
  return lista;
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
  obtenerDiagnosticoTikTok,
  normalizeYoutubeCookie,
  getYoutubeInstance,
  fetchYoutubeMedia,
  fetchYoutubeWatchPageMedia,
  selectYoutubeMediaFormat,
  publicErrorMessage,
};

