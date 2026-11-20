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
  return url.pathname.match(/^\/(?:shorts|v|embed|live)\/([\w-]{11})$/)?.[1] || null;
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
    // Carrera de la ronda 1 contra un tope de 6.5s: si una fuente se clava,
    // se prosigue con lo que haya y el resto del presupuesto va a la ronda 2.
    const ronda1 = await Promise.race([
      Promise.all([
        medir('directa', buscarTikTokDirecta(query, limit, parentSignal)),
        medir('tikwm', buscarTikwmSearch(query, limit, parentSignal)),
        medir('searx', buscarSearxTikTok(query, limit, parentSignal)),
        medir('ddg', buscarEnMotorTikTok('ddg', query, limit, parentSignal)),
        medir('ddglite', buscarEnMotorTikTok('ddglite', query, limit, parentSignal)),
        medir('bing', buscarEnMotorTikTok('bing', query, limit, parentSignal)),
      ]),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 6500)),
    ]);
    if (Array.isArray(ronda1)) {
      const nombres = ['directa', 'tikwm', 'searx', 'ddg', 'ddglite', 'bing'];
      nombres.forEach((nombre, i) => fuentes.push([nombre, ronda1[i] || { status: 'rejected', reason: new Error('sin resultado') }]));
    } else {
      fuentes.push(['ronda1', { status: 'rejected', reason: new Error('ronda 1 supero 6.5s') }]);
    }
    for (const [, fuente] of fuentes) juntar(fuente && fuente.value);
    // Segunda ronda (FALLA 2/3): se reintentan TODAS las fuentes dentro del
    // mismo pedido, con el presupuesto restante (~11.5s totales). Las fuentes
    // upstream son intermitentes y un reintento corto suele recuperar
    // resultados.
    if (!candidatos.length && Date.now() - t0 < 8500) {
      await new Promise((resolve) => setTimeout(resolve, 800));
      const restante = Math.max(2500, 11500 - (Date.now() - t0));
      const segunda = [
        ['directa2', buscarTikTokDirecta(query, limit, parentSignal)],
        ['tikwm2', buscarTikwmSearch(query, limit, parentSignal)],
        ['searx2', buscarSearxTikTok(query, limit, parentSignal, restante)],
        ['ddg2', buscarEnMotorTikTok('ddg', query, limit, parentSignal)],
        ['ddglite2', buscarEnMotorTikTok('ddglite', query, limit, parentSignal)],
        ['bing2', buscarEnMotorTikTok('bing', query, limit, parentSignal)],
      ].map(([nombre, promesa]) => medir(nombre, promesa));
      const lote = await Promise.race([
        Promise.all(segunda),
        new Promise((resolve) => setTimeout(() => resolve([]), restante)),
      ]);
      if (Array.isArray(lote)) {
        for (const fuente of lote) if (fuente) fuentes.push(fuente);
        for (const [, fuente] of lote) juntar(fuente && fuente.value);
      }
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
  // FALLA 2: si TODO fallo o vino vacio (cada fuente con 0 resultados o
  // rechazada), se marca todoFallo para que /ttsearch responda
  // BUSQUEDA_INESTABLE con reintentar:true en vez de un 200 vacio que esconde
  // el fallo. En ese caso NO se cachea: el reintento corre las fuentes de
  // vuelta (nueva ronda, nueva suerte).
  const fuenteVacia = (f) => (!f || f.status === 'fulfilled'
    ? (!f || !Array.isArray(f.value) || f.value.length === 0)
    : true);
  const fuentesReales = fuentes.filter(([nombre]) => nombre !== 'zenith');
  const todoFallo = results.length === 0 && fuentesReales.length > 0 && fuentesReales.every(([, fuente]) => fuenteVacia(fuente));

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
    todo_fallo: todoFallo,
  };

  if (results.length) {
    if (TT_SEARCH_CACHE.size > 100) TT_SEARCH_CACHE.clear();
    TT_SEARCH_CACHE.set(cacheKey, { results, expiresAt: Date.now() + TT_SEARCH_CACHE_TTL });
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

async function selectYoutubeMediaFormat(formats, type, quality, player, opciones = {}) {
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
        esAudioPuro: String(selected.format.mime_type || '').startsWith('audio/'),
      };
    }
  } else {
    const requestedHeight = Number.parseInt(quality, 10) || 720;
    const candidates = available.filter(({ format }) => format.mime_type?.startsWith('video/'));
    const progressive = candidates.filter(({ format }) => format.has_audio);
    // Pedido itag 18 (mp4 360p progresivo con audio integrado): elegirlo
    // explicitamente si existe. Nunca entregar un video-only sin audio en
    // este camino; si no hay progresivo, cae a la logica general de abajo.
    if (requestedHeight === 18) {
      const especifico = available.find(({ format }) => String(format.itag) === '18')
        || progressive.slice().sort((a, b) => (b.format.height || 0) - (a.format.height || 0))[0];
      if (especifico) {
        return {
          url: especifico.url,
          quality: especifico.format.height ? `${especifico.format.height}p` : '360p',
          bitrate: especifico.format.bitrate || null,
        };
      }
      throw apiError(502, 'No hay un enlace multimedia directo compatible disponible para este video.', {
        code: 'YOUTUBE_FORMAT_UNAVAILABLE',
      });
    }
    // aceptarSoloVideo: el buscador de mux (capa de ffmpeg) pide el stream
    // video-only de la altura pedida para combinarlo con el audio ait-140.
    if (opciones.aceptarSoloVideo && !progressive.some(({ format }) => format.height === requestedHeight)) {
      const videoSolo = candidates.filter(({ format }) => format.height === requestedHeight)[0];
      if (videoSolo) {
        return {
          url: videoSolo.url,
          quality: videoSolo.format.height ? `${videoSolo.format.height}p` : quality,
          bitrate: videoSolo.format.bitrate || null,
          conAudio: false,
          soloVideo: true,
        };
      }
    }
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
        conAudio: !!selected.format.has_audio,
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

// ============================================================================
// Sesión anónima auto-gestionada (TAREA 1): la API crea y mantiene su PROPIA
// sesión de YouTube sin login. Se hace scraping de youtube.com como navegador
// real (UA Chrome, Accept-Language es, cookie SOCS=CAI), se recogen las
// Set-Cookie (VISITOR_INFO1_LIVE, YSC, GPS...) y se extrae VISITOR_DATA del
// HTML/contexto. TTL 6h, renovación inmediata bajo demanda (LOGIN_REQUIRED o
// reintento interno). Cero configuración del dueño.
// ============================================================================
const SESION_ANONIMA_TTL = 6 * 60 * 60 * 1000;
const UA_SESION_ANONIMA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
let sesionAnonima = null;
let renovandoSesion = null;

// Puro: convierte la lista de Set-Cookie de una respuesta en una cabecera
// "name=value; ..." sin duplicados (se conserva la primera aparición).
function parseSetCookies(lista) {
  const pares = [];
  const vistos = new Set();
  for (const crudo of Array.isArray(lista) ? lista : []) {
    const par = String(crudo || '').split(';')[0];
    const eq = par.indexOf('=');
    if (eq <= 0) continue;
    const nombre = par.slice(0, eq).trim();
    if (!nombre || vistos.has(nombre)) continue;
    vistos.add(nombre);
    pares.push(par);
  }
  return { cookie: pares.join('; '), pares };
}

// Puro: extrae VISITOR_DATA del HTML de youtube.com (viene escapado como JSON).
function extraerVisitorData(html) {
  const texto = String(html || '');
  const m = texto.match(/"visitorData":"((?:[^"\\]|\\.)*)"/) || texto.match(/"VISITOR_DATA":"((?:[^"\\]|\\.)*)"/);
  if (!m) return '';
  try {
    const valor = JSON.parse('"' + m[1] + '"');
    return typeof valor === 'string' ? valor : '';
  } catch {
    return m[1];
  }
}

// Puro: garantiza que la cabecera de cookies de sesión incluya SOCS=CAI
// (consentimiento de YouTube ya aceptado, evita el muro de consentimiento).
function asegurarCookieSesion(cookie) {
  const pares = String(cookie || '').split(';').map((s) => s.trim()).filter(Boolean);
  const nombres = pares.map((p) => p.split('=')[0]);
  if (!nombres.includes('SOCS')) pares.unshift('SOCS=CAI');
  return pares.join('; ');
}

async function scrapearSesionAnonima() {
  const variantes = [
    { url: 'https://www.youtube.com/?hl=es&gl=US', cookie: 'SOCS=CAI' },
    { url: 'https://www.youtube.com/?hl=es&gl=ES', cookie: 'CONSENT=YES+cb.20210328-17-p0.es+FX+678; SOCS=CAI' },
  ];
  for (const variante of variantes) {
    try {
      const res = await fetch(variante.url, {
        headers: {
          'user-agent': UA_SESION_ANONIMA,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'es-ES,es;q=0.9,en;q=0.8',
          cookie: variante.cookie,
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(10000),
      });
      if (res.status !== 200) {
        try { await res.body?.cancel(); } catch {}
        continue;
      }
      const html = await res.text();
      const { cookie } = parseSetCookies(typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []);
      const visitorData = extraerVisitorData(html);
      if (visitorData) {
        return { cookies: asegurarCookieSesion([variante.cookie, cookie].filter(Boolean).join('; ')), visitorData };
      }
    } catch {}
  }
  return null;
}

async function obtenerSesionAnonima(forzar = false) {
  if (sesionAnonima && !forzar && Date.now() - sesionAnonima.createdAt < SESION_ANONIMA_TTL) return sesionAnonima;
  if (renovandoSesion) return renovandoSesion;
  renovandoSesion = (async () => {
    try {
      const nueva = await scrapearSesionAnonima();
      if (!nueva) {
        if (sesionAnonima) return sesionAnonima;
        throw apiError(502, 'No se pudo generar una sesion anonima de YouTube (youtube.com no expuso VISITOR_DATA).', { code: 'YOUTUBE_SESION_ANONIMA' });
      }
      sesionAnonima = {
        cookies: nueva.cookies,
        visitorData: nueva.visitorData,
        version: (sesionAnonima ? sesionAnonima.version : 0) + 1,
        createdAt: Date.now(),
      };
      console.log('[sesion-anonima] v' + sesionAnonima.version + ' creada sola (' + nueva.cookies.split(';').length + ' cookies, visitor data auto-generado)');
      return sesionAnonima;
    } finally {
      renovandoSesion = null;
    }
  })();
  return renovandoSesion;
}

function estadoSesionAnonima() {
  if (!sesionAnonima) return { activa: false };
  return { activa: true, version: sesionAnonima.version, edad_min: Math.round((Date.now() - sesionAnonima.createdAt) / 60000) };
}

// ============================================================================
// Cookie manual vencida (TAREA 1b): si la cookie configurada por variable de
// entorno ya no tiene sesion (o provoca LOGIN_REQUIRED en todo), se marca como
// invalida por 30 minutos y las peticiones pasan a la sesion anonima
// auto-generada sin envolvernos en errores que la cookie ni siquiera arregla.
// Cero configuracion del dueno: si la cookie vuelve a servir sesion, se reusa.
// ============================================================================
const COOKIE_INVALIDA_TTL = 30 * 60 * 1000;
let cookieManualInvalidoHasta = 0;

function marcarCookieManualInvalida() {
  cookieManualInvalidoHasta = Date.now() + COOKIE_INVALIDA_TTL;
  console.log('[cookie-manual] vencida o sin sesion: desactivada 30 min (la sesion anonima toma el relevo)');
}

// true = usable (o sin senal todavia), false = no usable (no hay cookie o esta
// marcada invalida). Nunca lanza.
function cookieManualVigente() {
  if (!(process.env.YOUTUBE_COOKIE || process.env.youtube_cookie)) return false;
  if (Date.now() < cookieManualInvalidoHasta) return false;
  return true;
}

// Validacion pasiva: NO pide inicio de sesion a nadie, solo mira si la cookie
// configurada sigue sosteniendo una sesion de YouTube. Si el marcador dice
// logged out, se desactiva por TTL y todo sigue con la sesion anonima.
async function validarCookieManual(cookieRaw) {
  try {
    const cookie = normalizeYoutubeCookie(cookieRaw);
    if (!cookie) {
      marcarCookieManualInvalida();
      return false;
    }
    const res = await fetch('https://www.youtube.com/?hl=es&gl=US', {
      headers: {
        'user-agent': UA_SESION_ANONIMA,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'es-ES,es;q=0.9,en;q=0.8',
        cookie,
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });
    if (res.status !== 200) {
      try { await res.body?.cancel(); } catch {}
      return null;
    }
    const body = await res.text();
    if (body.includes('"loggedIn":true')) return true;
    if (body.includes('"loggedIn":false')) {
      marcarCookieManualInvalida();
      return false;
    }
    return null;
  } catch {
    return null;
  }
}

let youtubePoMinterCache = null;

async function acquireYoutubePoMinter(youtube) {
  if (youtubePoMinterCache && youtubePoMinterCache.expiresAt > Date.now()) return youtubePoMinterCache;
  const visitorData = youtube.session.context.client.visitorData;
  if (!visitorData) return null;
  if (youtubePoMinterCache && youtubePoMinterCache.visitorData !== visitorData) {
    youtubePoMinterCache = null;
  }
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

function makeStableFetch() {
  // Scraping 100% directo desde la IP de salida de Vercel (sin proxy, sin
  // relay): la URL firmada de googlevideo queda amarrada a esa IP y el probe y
  // el stream de /dl salen por la misma ruta.
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
      return await fetch(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };
}

const youtubeInstanceCache = { conCookie: null, sinCookie: null, anonima: new Map() };

async function getYoutubeInstance(usarCookie, opciones = {}) {
  const cookieRaw = process.env.YOUTUBE_COOKIE || process.env.youtube_cookie || '';
  if (!(usarCookie && cookieRaw && cookieManualVigente())) {
    // Instancia anónima con la sesión auto-generada (cero configuración del
    // dueño). La instancia se cachea por versión de sesión: al renovar la
    // sesión, se crea una instancia nueva.
    let sesion = opciones.sesionAnonima || null;
    if (!sesion) sesion = await obtenerSesionAnonima(false).catch(() => null);
    if (sesion) {
      const key = 'v' + sesion.version;
      const cached = youtubeInstanceCache.anonima.get(key);
      if (cached && cached.expiresAt > Date.now()) return cached.instance;
      const ytjs = await import('youtubei.js');
      patchJsEvaluator(ytjs.Platform);
      const instance = await ytjs.Innertube.create({
        fetch: makeStableFetch(),
        cookie: sesion.cookies,
        visitor_data: sesion.visitorData,
      });
      youtubeInstanceCache.anonima.set(key, { instance, expiresAt: Date.now() + 60 * 60 * 1000 });
      if (youtubeInstanceCache.anonima.size > 3) {
        const primera = youtubeInstanceCache.anonima.keys().next().value;
        youtubeInstanceCache.anonima.delete(primera);
      }
      return instance;
    }
  }
  const key = usarCookie && cookieRaw ? 'conCookie' : 'sinCookie';
  const cached = youtubeInstanceCache[key];
  if (cached && cached.expiresAt > Date.now()) return cached.instance;
  const ytjs = await import('youtubei.js');
  patchJsEvaluator(ytjs.Platform);
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
  const inicioMs = Date.now();

  const controller = new AbortController();
  const timeoutError = apiError(504, 'REQUEST_TIMEOUT', 'La solicitud excedió el tiempo límite.');
  const abortFromParent = () => controller.abort(parentSignal.reason || timeoutError);
  const presupuesto = Math.max(3000, Number(options.presupuestoMs) || 24000);
  // Debug (solo con debug=1 en la URL): loguea por cliente el conteo de
  // formatos (total/soloVideo/progresivos), playability y si se uso PO token:
  // permite ver por que la capa 1 produce audio pero no video.
  const debug = options.debug === true;
  const timer = setTimeout(() => controller.abort(timeoutError), presupuesto);
  if (parentSignal) parentSignal.addEventListener('abort', abortFromParent, { once: true });
  try {
    const youtube = options.youtube || await getYoutubeInstance(options.cookie !== false);
    // Clientes embebidos primero: su contexto (clientScreen EMBED + embedUrl
    // de tercero, ver HTTPClient.js de youtubei.js) es lo que evita el
    // anti-bot "Sign in to confirm you're not a bot" SIN cookies, incluso desde
    // IPs de datacenter. IOS/TV puros son los que primero caen en LOGIN_REQUIRED.
    const clients = ['TV_EMBEDDED', 'WEB_EMBEDDED', 'IOS', 'TV', 'ANDROID_VR', 'WEB', 'MWEB', 'VISIONOS', 'TV_SIMPLY', 'YTMUSIC', 'ANDROID'];
    const deadline = Date.now() + Math.min(21000, presupuesto - 3000);
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
        // Diagnostico de video (solo en debug): conteos por tipo para ver por
        // que cliente la capa 1 no produce formatos de video (solo audio).
        clientDiag.soloVideo = formats.filter((f) => f.mime_type?.startsWith('video/') && !f.has_audio && f.url).length;
        clientDiag.progresivos = formats.filter((f) => f.mime_type?.startsWith('video/') && f.has_audio && f.url).length;
        if (debug) {
          console.log(`[dl][capa1][debug] cliente=${client} type=${type} quality=${quality} playability=${clientDiag.playability} formatos=${clientDiag.formatos} directos=${clientDiag.directos} soloVideo=${clientDiag.soloVideo} progresivos=${clientDiag.progresivos} po_token=${poToken ? 'si' : 'no'} (${Date.now() - inicioMs}ms)`);
        }
        if (clientDiag.playability === 'LOGIN_REQUIRED') loginRequiredCount += 1;
        const selected = await selectYoutubeMediaFormat(formats, type, quality, youtube.session.player, options.aceptarSoloVideo ? { aceptarSoloVideo: true } : {});
        if (debug) {
          console.log(`[dl][capa1][debug] cliente=${client} seleccionado quality=${selected.quality} bitrate=${selected.bitrate || '-'}`);
        }
        clientDiag.ok = true;
        diagnostics.push(clientDiag);
        // Con debug: exponer el diagnostico por cliente (conteos de formatos,
        // playability, PO token) para ver en el JSON donde muere el video.
        return { ...selected, basic_info: basicInfo, ...(debug ? { diagnostico: diagnostics } : {}) };
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
    // Para audio: preferir un cliente que exponga formato audio-only (itag 140)
    // antes que aceptar el primer progresivo (itag 18); el progresivo queda de
    // ultimo recurso si NINGUN cliente da audio puro.
    const preferirAudioPuro = type === 'audio';
    let audioFallback = null;
    // Video: un formato video-only (sin audio, ej. itag 137/133 hermano del
    // esquema altern) solo se acepta como ULTIMO recurso si ningun cliente dio
    // uno con audio; para audio no se toca el comportamiento de antes.
    const mediaAceptable = (media) => {
      if (!media) return false;
      if (preferirAudioPuro) return media.esAudioPuro;
      if (options.aceptarSoloVideo && media.soloVideo) return true;
      return media.conAudio !== false;
    };
    const aceptarMedia = (media) => {
      if (!media) return null;
      if (mediaAceptable(media)) return media;
      if (!audioFallback) audioFallback = media;
      return null;
    };
    const attemptInParallel = async (clientList, poToken) => {
      const results = await Promise.allSettled(clientList.map((client) => attemptClient(client, poToken)));
      const ok = results.filter((r) => r.status === 'fulfilled' && r.value).map((r) => r.value);
      // Audio: preferir formato audio puro; video: preferir formato CON audio
      // (progresivo, ej. itag 18) en vez del primer video-only que llegue.
      return ok.find((m) => m.esAudioPuro) || ok.find((m) => m.conAudio) || ok[0] || null;
    };
    if (typeof options.client === 'string' && options.client) {
      const media = await attemptClient(options.client);
      if (media) return media;
      if (type === 'video') {
        // PO token TAMBIEN para video en el camino de cliente puntual: los
        // URLs de video de googlevideo suelen exigir pot y devuelven 403 sin
        // el (el audio itag 140 pasa sin el; por eso audio sale y video no).
        try {
          const minterData = await acquireYoutubePoMinter(youtube);
          if (debug) {
            console.log(`[dl][capa1][debug] cliente=${options.client} minter bgutil ${minterData ? 'ok' : 'no disponible'}: minteo PO token para video`);
          }
          if (minterData) {
            const token = await minterData.minter.mintAsWebsafeString(videoId);
            const mediaPo = await attemptClient(options.client, token);
            if (debug) {
              console.log(`[dl][capa1][debug] cliente=${options.client} con PO token: ${mediaPo ? 'seleccionado ' + mediaPo.quality : 'sin formato util'}`);
            }
            if (mediaPo) return mediaPo;
          }
        } catch (poError) {
          if (debug) {
            console.log(`[dl][capa1][debug] cliente=${options.client} PO video fallo: ${String(poError && poError.message || poError).slice(0, 120)}`);
          }
        }
      }
      throw apiError(502, `El cliente ${options.client} no pudo obtener un enlace descargable.`, { code: 'YOUTUBE_CLIENT_FAILED' });
    }
    // El minteo del PO token corre EN PARALELO con la primera ola para que
    // la escalada no gaste segundos esperandolo justo cuando el presupuesto
    // es mas corto.
    const minterEnMarcha = (async () => {
      try { return await acquireYoutubePoMinter(youtube); } catch { return null; }
    })();
    for (let round = 0; round < 3; round += 1) {
      if (Date.now() > deadline - 3000) break;
      const media = aceptarMedia(await attemptInParallel(clients.slice(0, 5), undefined));
      if (media) return media;
      if (audioFallback) break;
      // Si la ola cayo en LOGIN/BOT, repetirla sin PO es quemar presupuesto:
      // la respuesta de la IP no cambia entre rondas identicas. Se corta a la
      // escalada real (PO token + watch page) con lo que queda de deadline.
      if (loginRequiredCount > 0) break;
    }
    for (const client of clients.slice(5)) {
      if (Date.now() > deadline - 2500) break;
      const media = aceptarMedia(await attemptClient(client));
      if (media) return media;
    }
    if (audioFallback) return audioFallback;
    // PO token para video SIEMPRE (no solo bajo LOGIN_REQUIRED): playability
    // OK no garantiza que googlevideo acepte las URLs de video sin pot; ese
    // es el sintoma visto (audio probe 200, video probe 403 en la misma IP).
    const necesitaPo = loginRequiredCount > 0 || type === 'video';
    // El minteo ya venia corriendo en paralelo con las olas: aqui solo se
    // recoge el resultado (0 - 1s extra), por eso el umbral baja de 9s a 6s.
    if (necesitaPo && Date.now() < deadline - 6000) {
      try {
        if (debug) {
          console.log(`[dl][capa1][debug] ronda PO token (type=${type} loginRequired=${loginRequiredCount})`);
        }
        const minterData = await minterEnMarcha;
        if (minterData) {
          diagnostics.push({ cliente: 'PO_TOKEN', ok: true });
          const videoToken = await minterData.minter.mintAsWebsafeString(videoId);
          for (const client of ['TV_EMBEDDED', 'WEB_EMBEDDED', 'IOS', 'ANDROID_VR', 'WEB', 'MWEB']) {
            if (Date.now() > deadline - 2500) break;
            const media = aceptarMedia(await attemptClient(client, videoToken));
            if (media) return media;
          }
          const visitorToken = await minterData.minter.mintAsWebsafeString(minterData.visitorData);
          for (const client of ['WEB', 'MWEB']) {
            if (Date.now() > deadline - 2500) break;
            const media = aceptarMedia(await attemptClient(client, visitorToken));
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
    // Reintento interno (TAREA 4): si los clientes devolvieron LOGIN_REQUIRED
    // (cookie manual vencida o bloqueo anti-bot de la IP), se renueva la sesión
    // anónima AHORA y se reintenta en el mismo pedido con una instancia fresca.
    if (loginRequiredCount > 0 && !options.sesionRenovada && !options.youtube && Date.now() - inicioMs < presupuesto * 0.5) {
      try {
        console.log('[dl][capa1] LOGIN_REQUIRED x' + loginRequiredCount + ': reintento en el mismo pedido con sesion anonima renovada');
        await obtenerSesionAnonima(true).catch(() => null);
        const anonima = await getYoutubeInstance(false);
        const media = await fetchYoutubeMedia(videoId, type, quality, parentSignal, { ...options, youtube: anonima, cookie: false, sesionRenovada: true });
        return media;
      } catch (e) {
        lastCause = e;
        diagnostics.push({ cliente: 'REINTENTO_SESION', ok: false, error: String(e && e.message || e).slice(0, 120) });
      }
    }
    if (loginRequiredCount >= clients.length - 1) {
      // Si se estaba usando la instancia con cookie manual y TODO devolvio
      // LOGIN_REQUIRED, lo mas probable es que la cookie este vencida: se
      // desactiva por TTL y el proximo pedido (y la CAPA 4 de aqui abajo) va
      // con la sesion anonima auto-generada.
      if (options.cookie !== false && cookieManualVigente()) {
        marcarCookieManualInvalida();
      }
      // Clasificacion REAL por razon de playability: 'confirm your age' es una
      // restriccion PERMANENTE del video (reintentar no cambia nada); 'not a
      // bot' es bloqueo anti-bot de IP (reintentar va porque Vercel rota IP);
      const razones = diagnostics.map((d) => String(d.razon || '')).join(' | ');
      // SOLO la razon textual define indisponibilidad: TV_SIMPLY devuelve
      // playability UNPLAYABLE incluso cuando el video es publico y el resto
      // de clientes cayo en LOGIN_REQUIRED, por eso un UNPLAYABLE aislado NO
      // prueba nada (lo demostro Gangnam Style en produccion).
      const esEdad = /confirm you?r age|age.restricted|inappropriate for/i.test(razones);
      // Guarda anti-falso-404: cuando hay clientes diciendo 'Sign in to
      // confirm your not a bot', un 'Video unavailable' aislado (ej. YTMUSIC
      // bajo throttling, demostrado con jNQXAC9IVRw en produccion) es un
      // efecto secundario, NO una indisponibilidad real.
      const hayLogin = /sign in|confirm you|not a bot/i.test(razones);
      const esIndisponible = !hayLogin && /unavailable|private video|video privado|removed|terminated|no longer available/i.test(razones);
      const codigoFallo = esEdad ? 'YOUTUBE_AGE_CHECK_REQUIRED' : esIndisponible ? 'YOUTUBE_VIDEO_UNAVAILABLE' : 'YOUTUBE_BOT_DETECTION';
      const mensajeFallo = esEdad
        ? 'Este video tiene restriccion de edad: YouTube exige inicio de sesion para verlo o descargarlo.'
        : esIndisponible
          ? 'Este video no esta disponible: fue eliminado, es privado o da de baja la cuenta.'
          : "YouTube exige verificacion anti-bot para este video desde la IP del hosting (sin cookies no hay mas capas para este caso).";
      const loginError = apiError(esIndisponible ? 404 : 502, mensajeFallo, {
        code: codigoFallo,
      });
      loginError.reintentar = !esEdad && !esIndisponible;
      loginError.solucion = loginError.reintentar
        ? 'La API ya gestiona su propia sesion anonima: reintentar suele funcionar porque Vercel rota la IP de salida en cada pedido. No requiere configurar nada.'
        : 'Este fallo es permanente para este video: reintentar no cambiaria el resultado.';
      loginError.detalles = diagnostics;
      throw loginError;
    }
    // Fallo SIN login: videos inexistentes/privados/eliminados hacen fallar
    // a TODOS los clientes con 'This video is unavailable' (el WATCH_PAGE
    // aporta un texto generico sin streamingData: se ignora). Regla: alguien
    // dice unavailable y NADIE dice sign-in/bot/age => PERMANENTE (404,
    // reintentar:false). Cualquier otra cosa queda como UPSTREAM_FAILED.
    const diagTextos = diagnostics.map((d) => String(d.razon || d.error || ''));
    const diagIndisponible = /unavailable|private|removed|terminated|no longer available/i.test(diagTextos.filter(Boolean).join(' | ')) && !/sign in|confirm you|age|bot/i.test(diagTextos.join(' | '));
    if (diagIndisponible) {
      const noDisponible = apiError(404, 'Este video no esta disponible: fue eliminado, es privado o no existe.', { code: 'YOUTUBE_VIDEO_UNAVAILABLE' });
      noDisponible.reintentar = false;
      noDisponible.detalles = diagnostics;
      throw noDisponible;
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
    // Video inexistente/privado/eliminado: el fallo llega aqui SI ningun
    // cliente proceso la respuesta completa (ej. VideoInfo lanza al parsear).
    // Es un fallo PERMANENTE: 404 con reintentar:false, no 502 generico.
    // Con la misma guarda anti-falso-404: si hay 'Sign in'/'not a bot' en los
    // diagnosticos, el 'unavailable' es efecto del throttling y NO permanente.
    const msgFallo = String(error?.message || error);
    const diagLoginActivo = /sign in|not a bot|confirm you|age/i.test(diagnostics.map((d) => String(d.razon || d.error || '')).join(' | '));
    if (!diagLoginActivo && /unavailable|private|removed|terminated|not found|no longer available|does not exist/i.test(msgFallo)) {
      const noDisponible = apiError(404, 'Este video no esta disponible: fue eliminado, es privado o no existe.', { code: 'YOUTUBE_VIDEO_UNAVAILABLE' });
      noDisponible.reintentar = false;
      noDisponible.detalles = diagnostics;
      throw noDisponible;
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

// ============================================================================
// ============================================================================
// BUSQUEDA ROBUSTA: la busqueda por texto usaba una instancia Innertube
// pelada (generate_session:false) que YouTube bloquea con el mismo anti-bot
// que al player (0 resultados -> 404). Estrategia en cascada:
//  1) Innertube con la sesion anonima auto-generada (2 intentos, 8s c/u)
//  2) scraping del HTML de /results (videoRenderer)
// Nunca lanza: devuelve lista (posiblemente vacia) de {videoId,titulo,...}.
// ============================================================================
function parsearDuracionTexto(texto) {
  const partes = String(texto || '').split(':').map(Number).filter((n) => !Number.isNaN(n));
  return partes.length >= 2 ? partes.reduce((a, b) => a * 60 + b, 0) : 0;
}

async function conLimite(promesa, ms) {
  let timer;
  try {
    return await Promise.race([
      promesa,
      new Promise((_, rechazar) => { timer = setTimeout(() => rechazar(new Error('timeout')), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function buscarYoutubeInnertube(texto, limit) {
  for (let intento = 0; intento < 2; intento += 1) {
    if (intento > 0) {
      try { await conLimite(new Promise((r) => setTimeout(r, 700)), 1000); } catch {}
    }
    try {
      const youtube = await conLimite(getYoutubeInstance(false), 8000);
      const res = await conLimite(youtube.search(texto, { type: 'video' }), 8000);
      const lista = (Array.isArray(res.videos) ? res.videos : [])
        .filter((v) => v && /^[a-zA-Z0-9_-]{11}$/.test(String(v.id || '')));
      if (lista.length) {
        return lista.slice(0, limit).map((v) => ({
          videoId: String(v.id),
          titulo: v.title?.text || v.title || '',
          canal: v.author?.name || '',
          visitas: Number(String(v.view_count?.text || v.view_count || '').replace(/[^0-9]/g, '')) || 0,
          duracion: parsearDuracionTexto(v.duration?.text) || Number(v.duration?.seconds) || 0,
        }));
      }
    } catch {}
  }
  return [];
}

async function buscarYoutubeHtml(texto, limit) {
  const url = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(texto) + '&sp=EgIQAQ%3D%3D';
  const res = await fetch(url, {
    headers: {
      'user-agent': UA_SESION_ANONIMA,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'es-ES,es;q=0.9,en;q=0.8',
      cookie: 'SOCS=CAI',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(10000),
  });
  if (res.status !== 200) {
    try { await res.body?.cancel(); } catch {}
    return [];
  }
  const html = await res.text();
  const salida = [];
  const vistos = new Set();
  const reVideo = /"(?:videoRenderer|compactVideoRenderer)":\{"videoId":"([a-zA-Z0-9_-]{11})"/g;
  const reTitulo = /"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"\}\]/;
  const reCanal = /"(?:ownerText|longBylineText)":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/;
  let m;
  while ((m = reVideo.exec(html)) && salida.length < limit) {
    const id = m[1];
    if (vistos.has(id)) continue;
    const tramo = html.slice(m.index, m.index + 2500);
    const tm = tramo.match(reTitulo);
    let titulo = '';
    if (tm) {
      try { titulo = JSON.parse('"' + tm[1] + '"'); } catch { titulo = tm[1]; }
    }
    const cm = tramo.match(reCanal);
    vistos.add(id);
    salida.push({ videoId: id, titulo: titulo || texto, canal: cm ? String(cm[1]) : '', visitas: 0, duracion: 0 });
  }
  return salida;
}

async function buscarVideoYoutube(texto, limit = 5) {
  const limpio = String(texto || '').trim();
  if (!limpio || limpio.length > 120) return [];
  const salida = await buscarYoutubeInnertube(limpio, limit);
  if (salida.length) return salida;
  const html = await buscarYoutubeHtml(limpio, limit).catch(() => []);
  if (html.length) return html;
  // Con 0 resultados reales en ambas capas, YouTube suele estar rechazando la
  // query exacta (page vacia anti-bot o menos resultados organicos). Se
  // reintenta con las correcciones del autocompletado publico de YouTube
  // (suggestqueries): mismo pedido del usuario, redaccion que YouTube si
  // resuelve._aborta en el primer conjunto con resultados.
  try {
    const sugs = await fetch('https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&hl=es&q=' + encodeURIComponent(limpio), {
      headers: { 'User-Agent': UA_SESION_ANONIMA, Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    }).then((r) => r.json()).then((j) => (Array.isArray(j) && Array.isArray(j[1]) ? j[1] : [])).catch(() => []);
    for (const s of sugs.slice(0, 3)) {
      if (!s || s.toLowerCase() === limpio.toLowerCase()) continue;
      const r2 = await buscarYoutubeInnertube(String(s), limit);
      if (r2.length) return r2;
      const r3 = await buscarYoutubeHtml(String(s), limit).catch(() => []);
      if (r3.length) return r3;
    }
  } catch {}
  return [];
}

// ============================================================================
// Precalentamiento (TAREA 1 + TAREA 2): se corre UNA vez por proceso (cold
// start de Vercel) en segundo plano, sin bloquear la primera peticion. Deja:
//  1. la sesion anonima auto-generada lista (visitor data + cookies),
//  2. la cookie manual validada (si esta vencida, desactivada por TTL).
// ============================================================================
let precalentamiento = null;
let precalentamientoEstado = null;

function precalentar() {
  if (precalentamiento) return precalentamiento;
  const t0 = Date.now();
  precalentamientoEstado = { iniciado: true, listo: false };
  precalentamiento = (async () => {
    const resultados = await Promise.allSettled([
      obtenerSesionAnonima(true)
        .then((s) => {
          console.log('[precal] sesion anonima lista v' + s.version);
          return 'ok';
        })
        .catch((e) => {
          console.log('[precal] sesion anonima fallo: ' + String(e && e.message || e).slice(0, 100));
          return 'fallo';
        }),
      (async () => {
        const cookieRaw = process.env.YOUTUBE_COOKIE || process.env.youtube_cookie || '';
        if (!cookieRaw) return 'sin cookie';
        const vigente = await validarCookieManual(cookieRaw);
        console.log('[precal] cookie manual validada: ' + (vigente === true ? 'sesion activa' : vigente === false ? 'vencida -> desactivada' : 'sin senal'));
        return vigente === false ? 'invalida' : 'ok';
      })(),
    ]);
    precalentamientoEstado = {
      iniciado: true,
      listo: true,
      ms: Date.now() - t0,
      sesion: resultados[0].status === 'fulfilled' ? resultados[0].value : 'fallo',
      cookie: resultados[1].status === 'fulfilled' ? resultados[1].value : 'fallo',
      instancias: 'eliminadas',
    };
    return precalentamientoEstado;
  })();
  return precalentamiento;
}

function estadoPrecalentamiento() {
  return precalentamientoEstado || { iniciado: false };
}

function alturaDeCalidad(texto) {
  const m = String(texto || '').match(/(\d{3,4})p/);
  return m ? Number(m[1]) : 0;
}

// Puro (TAREA 3): escalera de calidades a recorrer en /dl cuando la calidad
// pedida falla en todas las capas. Las calidades bajas pasan los filtros de
// googlevideo con más frecuencia; solo se responde IP_BLOQUEADA cuando ni la
// calidad mínima obtiene nada. El audio ya degrada solo dentro de
// fetchYoutubeMedia (itag 140 -> cualquier audio -> progresivo itag 18).
function escaleraCalidades(kind, calidad) {
  const pedido = String(calidad || '').trim();
  if (kind === 'audio') {
    return pedido && pedido !== 'best' ? [pedido, 'best'] : ['best'];
  }
  // Video: itag 18 PRIMERO (mp4 360p progresivo con audio integrado: el
  // formato combinado menos bloqueado por googlevideo y que no necesita
  // DASH ni separar streams). Si itag 18 sale, se streamea ese. El audio
  // NO se toca (su escalera vive arriba).
  const escalera = ['18', 'best', '480', '360', '240', '144'];
  if (pedido && pedido !== 'best' && pedido !== '18' && /^\d+$/.test(pedido)) {
    const salida = ['18', pedido];
    for (const q of escalera) {
      if (q !== '18' && q !== pedido) salida.push(q);
    }
    return salida;
  }
  return escalera;
}

// Funcion pura: elige el formato de una respuesta de Invidious

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
  obtenerSesionAnonima,
  estadoSesionAnonima,
  validarCookieManual,
  marcarCookieManualInvalida,
  cookieManualVigente,
  precalentar,
  estadoPrecalentamiento,
  parseSetCookies,
  extraerVisitorData,
  escaleraCalidades,
  fetchYoutubeMedia,
  buscarVideoYoutube,
  fetchYoutubeWatchPageMedia,
  selectYoutubeMediaFormat,
  publicErrorMessage,
};

