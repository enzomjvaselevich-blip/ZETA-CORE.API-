// /instagram — Extractor de posts y reels de Instagram por scraping casero.
// Sin APIs externas: usa el HTML publico del embed oficial de Instagram
// (instagram.com/p/<code>/embed/captioned) y la pagina directa del post.
// Instagram solo sirve el HTML con datos a crawlers (Googlebot, etc.); con un
// User-Agent comun de navegador responde un shell JS sin datos de media.
const secureApi = require('../secure-api');

const BOT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const NAVEGADOR_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Con IG_COOKIE configurada (cookie de navegador logueado, misma mecanica que
// YOUTUBE_COOKIE) se pide con sesion: desbloquea el mp4 de posts que sin ella
// solo devuelven metadatos.
function headersDePeticion() {
  const cookie = String(process.env.IG_COOKIE || process.env.ig_cookie || '').trim();
  if (!cookie) return { 'User-Agent': BOT_UA, 'Accept-Language': 'es-ES,es;q=0.9' };
  return { 'User-Agent': NAVEGADOR_UA, 'Accept-Language': 'es-ES,es;q=0.9', Cookie: cookie };
}

function extraerShortcode(inputUrl) {
  const m = String(inputUrl || '').match(/instagram\.com\/(?:[^/?#]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

function desescaparJson(texto) {
  return String(texto || '').replace(/\\\\/g, '\\').replace(/\\"/g, '"').replace(/\\u0025/g, '%').replace(/\\u0026/g, '&');
}

function extraerObjetoBalanceado(texto, desde) {
  const inicio = texto.indexOf('{', Math.max(0, desde));
  if (inicio < 0) return null;
  let depth = 0;
  let enCadena = false;
  let esc = false;
  for (let i = inicio; i < texto.length; i += 1) {
    const c = texto[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') enCadena = !enCadena;
    if (enCadena) continue;
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return texto.slice(inicio, i + 1);
    }
  }
  return null;
}

// Las URLs de video/imagen llegan con escapes JSON residuales (\/, \u0026);
// el parser de URLs las tolera pero deja el path con barras dobles y el CDN
// responde 403. Hay que desescaparlas ANTES de usarlas.
function desescaparUrl(url) {
  return String(url || '')
    .replace(/\\\//g, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u0025/gi, '%')
    .replace(/&amp;/g, '&');
}

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

async function pedir(url, parentSignal, timeoutMs = 10000) {
  const senal = parentSignal ? AbortSignal.any([parentSignal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  const r = await fetch(url, {
    headers: headersDePeticion(),
    redirect: 'follow',
    signal: senal,
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

function tituloDeShortcodeMedia(sm) {
  const caption = sm?.edge_media_to_caption?.edges?.[0]?.node?.text || sm?.title || '';
  return decodificarEntidades(String(caption)).slice(0, 300) || null;
}

function mediaDesdeShortcodeMedia(sm) {
  if (!sm || typeof sm !== 'object') return null;
  const titulo = tituloDeShortcodeMedia(sm);
  if (sm.video_url) {
    return { ok: true, tipo: 'video', titulo: titulo || 'video de Instagram', descarga_directa: desescaparUrl(sm.video_url), miniatura: sm.display_url ? desescaparUrl(sm.display_url) : null };
  }
  const hijos = sm.edge_sidecar_to_children?.edges || [];
  if (hijos.length) {
    const links = hijos.map((e) => e?.node?.video_url || e?.node?.display_url).filter(Boolean).map(desescaparUrl);
    if (links.length) {
      const primerVideo = hijos.find((e) => e?.node?.video_url);
      if (primerVideo) {
        return { ok: true, tipo: 'video', titulo: titulo || 'video de Instagram', descarga_directa: desescaparUrl(primerVideo.node.video_url), links, miniatura: sm.display_url ? desescaparUrl(sm.display_url) : null };
      }
      return { ok: true, tipo: 'image', titulo: titulo || 'post de Instagram', links };
    }
    return null;
  }
  if (sm.display_url && (sm.__typename === 'GraphImage' || sm.__typename === 'GraphSidecar')) {
    return { ok: true, tipo: 'image', titulo: titulo || 'post de Instagram', links: [desescaparUrl(sm.display_url)] };
  }
  return null;
}

async function fetchInstagramVideo(inputUrl, parentSignal) {
  const shortcode = extraerShortcode(inputUrl);
  if (!shortcode) {
    throw secureApi.apiError(404, 'No se reconoce el enlace de Instagram. Acepta posts (instagram.com/p/...) y reels (instagram.com/reel/...).');
  }
  let esVideo = false;

  // Estrategia 1: embed oficial con UA de crawler (expone gql_data.shortcode_media).
  try {
    const html = await pedir(`https://www.instagram.com/p/${shortcode}/embed/captioned/`, parentSignal);
    const bruto = desescaparJson(html);
    const i = bruto.indexOf('gql_data');
    if (i >= 0) {
      const objeto = extraerObjetoBalanceado(bruto, i);
      if (objeto) {
        const gql = JSON.parse(objeto);
        const sm = gql.shortcode_media || gql.data?.shortcode_media;
        esVideo = Boolean(sm && (sm.video_url || sm.is_video || sm.__typename === 'GraphVideo'));
        const media = mediaDesdeShortcodeMedia(sm);
        if (media) return media;
      }
    }
  } catch (error) {
    if (parentSignal?.aborted) throw error;
  }

  // Estrategia 2: pagina directa con UA de crawler (meta tags og:video / og:image).
  try {
    const html = await pedir(`https://www.instagram.com/p/${shortcode}/`, parentSignal);
    const ogVideo = (html.match(/<meta[^>]+property="og:video(?::secure_url)?"[^>]+content="([^"]+)"/) || [])[1];
    const ogTitle = decodificarEntidades((html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]*)"/) || [])[1] || '');
    if (ogVideo) {
      return { ok: true, tipo: 'video', titulo: ogTitle || 'video de Instagram', descarga_directa: desescaparUrl(ogVideo) };
    }
    if (!esVideo) {
      const ogImage = (html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/) || [])[1];
      if (ogImage) {
        return { ok: true, tipo: 'image', titulo: ogTitle || 'post de Instagram', links: [desescaparUrl(ogImage)] };
      }
    }
  } catch (error) {
    if (parentSignal?.aborted) throw error;
  }

  throw secureApi.apiError(404, esVideo
    ? 'El post es un video/reel pero Instagram no expone el archivo mp4 sin sesion iniciada (solo ofrece metadatos y miniatura a crawlers).'
    : 'Instagram no expuso el contenido del post: el post no existe o es privado.');
}

module.exports = { fetchInstagramVideo, headersDePeticion };
