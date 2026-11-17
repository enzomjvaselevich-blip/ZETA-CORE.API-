// /facebook — Extractor de videos de Facebook por scraping casero.
// Sin APIs externas: Facebook sirve el HTML completo de la pagina de video a
// crawlers (User-Agent Googlebot), exponiendo browser_native_hd_url /
// browser_native_sd_url (y en algunos casos hd_src / playable_url). Con un
// User-Agent comun de navegador responde 400 o un muro de login.
const secureApi = require('../secure-api');

const BOT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

const CLAVES_URL_VIDEO = [
  'browser_native_hd_url',
  'hd_src',
  'playable_url_quality_hd',
  'browser_native_sd_url',
  'sd_src',
  'playable_url',
];

function decodificarEntidades(texto) {
  return String(texto || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => {
      try { return String.fromCodePoint(Number(n)); } catch { return ''; }
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => {
      try { return String.fromCodePoint(parseInt(n, 16)); } catch { return ''; }
    });
}

function extraerValorJson(html, clave) {
  const m = html.match(new RegExp('"' + clave + '":"((?:[^"\\\\]|\\\\.)*)"'));
  if (!m) return null;
  try { return JSON.parse('"' + m[1] + '"'); } catch { return null; }
}

function extraerTitulo(html) {
  const og = (html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]*)"/) || [])[1];
  if (og) return decodificarEntidades(og).replace(/\s*\\u00b7\s*\|?\s*Facebook\s*$/i, '').trim().slice(0, 300);
  const title = (html.match(/<title[^>]*>([^<]+)<\/title>/) || [])[1];
  return title ? decodificarEntidades(title).replace(/\s*-\s*Facebook\s*$/i, '').trim().slice(0, 300) : null;
}

async function pedirTexto(url, parentSignal, timeoutMs = 12000) {
  const senal = parentSignal ? AbortSignal.any([parentSignal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  const r = await fetch(url, {
    headers: { 'User-Agent': BOT_UA, 'Accept-Language': 'es-ES,es;q=0.9' },
    redirect: 'follow',
    signal: senal,
  });
  const texto = await r.text();
  return { ok: r.ok, urlFinal: r.url || url, texto, status: r.status };
}

function idsDesdeUrl(url) {
  const ids = new Set();
  for (const m of String(url || '').matchAll(/(?:watch\/?\?v=|\/videos\/(?:[^/]*\/)?|\/reel\/|media_id=)(\d{5,25})/g)) ids.add(m[1]);
  return [...ids];
}

async function probeEsVideo(url, parentSignal) {
  try {
    const senal = parentSignal ? AbortSignal.any([parentSignal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000);
    const r = await fetch(url, { headers: { 'User-Agent': BOT_UA, Range: 'bytes=0-99' }, redirect: 'follow', signal: senal });
    const tipo = String(r.headers.get('content-type') || '');
    try { await r.body?.cancel(); } catch {}
    return (r.status === 200 || r.status === 206) && (tipo.includes('video') || tipo.includes('octet-stream'));
  } catch {
    return false;
  }
}

async function fetchFacebookVideo(inputUrl, parentSignal) {
  const crudo = String(inputUrl || '').trim();
  if (!/(^|\.)facebook\.com$|^fb\.watch$|(facebook\.com|fb\.watch)\//i.test(crudo)) {
    throw secureApi.apiError(404, 'No se reconoce el enlace de Facebook. Acepta facebook.com/share/v/..., watch, reels y fb.watch.');
  }

  const paginas = [];
  // Resuelve redirects (share/v, share/r, fb.watch) y usa el HTML ya obtenido.
  try {
    const primera = await pedirTexto(crudo, parentSignal, 12000);
    if (primera.ok) paginas.push({ url: primera.urlFinal, texto: primera.texto });
  } catch (error) {
    if (parentSignal?.aborted) throw error;
  }

  const urlBase = paginas[0]?.url || crudo;
  const candidatosPagina = new Set();
  for (const id of idsDesdeUrl(urlBase)) {
    candidatosPagina.add(`https://www.facebook.com/watch/?v=${id}`);
    candidatosPagina.add(`https://mbasic.facebook.com/watch/?v=${id}`);
  }
  const reelId = urlBase.match(/\/reel\/(\d+)/);
  if (reelId) candidatosPagina.add(`https://www.facebook.com/reel/${reelId[1]}`);
  candidatosPagina.add(urlBase.split('?')[0]);

  for (const urlPagina of [...candidatosPagina].slice(0, 4)) {
    if (paginas.some((p) => p.url === urlPagina)) continue;
    try {
      const r = await pedirTexto(urlPagina, parentSignal, 12000);
      if (r.ok) paginas.push({ url: r.urlFinal, texto: r.texto });
    } catch (error) {
      if (parentSignal?.aborted) throw error;
    }
  }

  for (const pagina of paginas) {
    for (const clave of CLAVES_URL_VIDEO) {
      const urlVideo = extraerValorJson(pagina.texto, clave);
      if (!urlVideo || !/^https?:\/\//.test(urlVideo)) continue;
      if (await probeEsVideo(urlVideo, parentSignal)) {
        return {
          ok: true,
          tipo: 'video',
          titulo: extraerTitulo(pagina.texto) || 'video de Facebook',
          descarga_directa: urlVideo,
          calidad: /hd/i.test(clave) ? 'hd' : 'sd',
        };
      }
    }
  }

  throw secureApi.apiError(404, 'No se pudo extraer el video de Facebook: el enlace no es publico, no contiene video, o Facebook no expuso el archivo a crawlers.');
}

module.exports = { fetchFacebookVideo };
