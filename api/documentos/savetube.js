// Extractor save-tube (flujo HTTP real del sitio, replicado y verificado en
// vivo contra videos publicos): 100% anonimo, sin cookies ni terceros ajenos
// al propio backend de save-tube.
//
// Flujo real capturado del frontend (chunk 558 de save-tube.com):
//   1. GET  https://media.savetube.vip/api/random-cdn            -> {cdn}
//   2. POST https://<cdn>/v2/info        {url}                   -> {status,data}
//      data = base64: primeros 16 bytes son el IV y el resto el ciphertext
//      AES-128-CBC con la clave hex embebida en el chunk (ver CLAVE). El
//      texto plano descifrado es JSON: {title,duration,key,thumbnail,
//      video_formats[],audio_formats[]}.
//   3. POST https://<cdn>/download {downloadType,quality,key}    -> {data:{downloadUrl}}
//
// Los downloadUrl salen del CDN propio de save-tube (cdnXXX.savetube.vip),
// NO de googlevideo: no estan amarrados a la IP que los resolvio, por lo que
// sirven de rescate cuando la capa 1 recibe bloqueo anti-bot de datacenter.
//
// Limitacion conocida (honestidad de errores): para algunos videos el
// /download responde {status:false} ("Failed to get download URL"), por
// ejemplo el video de Despacito en 360p/720p. En ese caso este extractor
// FALLA (throw) para que la carrera deje ganar al motor propio; aqui no se
// simula exito.

const crypto = require('node:crypto');

const HOST_RANDOM_CDN = 'https://media.savetube.vip/api/random-cdn';
// Clave AES-128-CBC embebida en el frontend de save-tube (string hex de 32
// caracteres de-ofuscado del array rotado del chunk 558).
const CLAVE = Buffer.from('C5D58EF67A7584E4A29F6C35BBC4EB12', 'hex');

const cacheCdn = { host: '', expira: 0 };
const cacheInfo = new Map();
const CACHE_INFO_MS = 10 * 60 * 1000;

function conSenal(ms, signal) {
  const porTimeout = AbortSignal.timeout(ms);
  if (signal && typeof AbortSignal.any === 'function') {
    return AbortSignal.any([signal, porTimeout]);
  }
  return porTimeout;
}

async function obtenerCdn(signal) {
  if (cacheCdn.host && cacheCdn.expira > Date.now()) return cacheCdn.host;
  const r = await fetch(HOST_RANDOM_CDN, { signal: conSenal(6000, signal) });
  if (!r.ok) throw new Error('savetube random-cdn HTTP ' + r.status);
  const j = await r.json();
  const host = typeof j.cdn === 'string' ? j.cdn.trim().replace(/^https?:\/\//, '') : '';
  if (!host) throw new Error('savetube random-cdn sin cdn');
  cacheCdn.host = host;
  cacheCdn.expira = Date.now() + 5 * 60 * 1000;
  return host;
}

function descifrarInfo(b64) {
  const buf = Buffer.from(String(b64).replace(/\s/g, ''), 'base64');
  if (buf.length <= 16) throw new Error('savetube data cifrada demasiado corta');
  const decipher = crypto.createDecipheriv('aes-128-cbc', CLAVE, buf.subarray(0, 16));
  const plano = Buffer.concat([decipher.update(buf.subarray(16)), decipher.final()]).toString('utf8');
  const info = JSON.parse(plano);
  if (!info || !info.key) throw new Error('savetube data sin key');
  return info;
}

async function obtenerInfo({ url, videoId, signal }) {
  const claveCache = videoId || url;
  const cacheado = cacheInfo.get(claveCache);
  if (cacheado && cacheado.expira > Date.now()) return cacheado.info;
  const cdn = await obtenerCdn(signal);
  const r = await fetch('https://' + cdn + '/v2/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
    signal: conSenal(12000, signal),
  });
  if (r.status === 429 || r.status === 401) throw new Error('savetube info HTTP ' + r.status + ' (limite de su backend)');
  if (!r.ok) throw new Error('savetube info HTTP ' + r.status);
  const j = await r.json().catch(() => ({}));
  if (!j || j.status !== true || !j.data) throw new Error('savetube info sin data');
  const info = descifrarInfo(j.data);
  info.__cdn = cdn;
  cacheInfo.set(claveCache, { info, expira: Date.now() + CACHE_INFO_MS });
  if (cacheInfo.size > 100) cacheInfo.delete(cacheInfo.keys().next().value);
  return info;
}

async function pedirLinkDescarga(cdn, cuerpo, signal) {
  const r = await fetch('https://' + cdn + '/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
    signal: conSenal(12000, signal),
  });
  if (!r.ok) throw new Error('savetube download HTTP ' + r.status);
  const j = await r.json().catch(() => ({}));
  const enlace = j && j.data && j.data.downloadUrl;
  if (!enlace) throw new Error('savetube download sin enlace (su backend no genero este archivo)');
  return enlace;
}

function calidadVideoPedida(calidad) {
  const m = /^(144|240|360|480|720|1080|1440|2160)p$/i.exec(String(calidad || ''));
  if (m) return m[1];
  return '';
}

// Devuelve {url, ext, calidad, titulo, duracion, thumbnail, fuente, detalle}
// o THROWS. kind: 'audio' | 'video'.
async function resolverSaveTube({ url, videoId, kind, calidad, timeoutMs, signal }) {
  if (!url && !videoId) throw new Error('savetube sin url ni videoId');
  const tipo = kind === 'video' ? 'video' : 'audio';
  // AbortController de la carrera (default 10s exigido por la mision): al
  // ganar el otro motor, el caller aborta su signal y este extractor Muere.
  let controller = null;
  let senal = signal || undefined;
  if (timeoutMs) {
    controller = new AbortController();
    const t = setTimeout(() => controller.abort(), Math.max(500, timeoutMs));
    if (t.unref) t.unref();
    senal = signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  }
  try {
    const urlCanonica = 'https://www.youtube.com/watch?v=' + (videoId || (url ? (String(url).match(/([a-zA-Z0-9_-]{11})/) || [])[1] : ''));
    const info = await obtenerInfo({ url: videoId ? urlCanonica : url, videoId, signal: senal });
    let enlace = '';
    let detalle = '';
    let ext = tipo === 'audio' ? 'mp3' : 'mp4';
    let calidadEntregada = tipo === 'audio' ? '128' : '360p';
    if (tipo === 'audio') {
      enlace = await pedirLinkDescarga(info.__cdn, { downloadType: 'audio', quality: '128', key: info.key }, senal);
      detalle = 'audio 128';
    } else {
      const pedida = calidadVideoPedida(calidad);
      const formatos = Array.isArray(info.video_formats) ? info.video_formats : [];
      // Escalera de degradacion: si el sitio no expone la calidad pedida para
      // este video, se entrega la mejor inmediatamente inferior disponible
      // (720->480->360) en vez de fallar: cualquier MP4 real sirve al usuario.
      const escalera = pedida
        ? [pedida, '1080', '720', '480', '360'].filter((q, i, a) => a.indexOf(q) === i && q <= pedida)
        : ['360'];
      for (const q of escalera) {
        const directo = formatos.find((f) => f && (String(f.quality) === q || String(f.height) === q) && f.url);
        if (directo) {
          enlace = directo.url;
          detalle = 'video ' + q + ' fast';
          break;
        }
      }
      if (!enlace) {
        for (const q of escalera) {
          if (!formatos.some((f) => f && (String(f.quality) === q || String(f.height) === q))) continue;
          try {
            enlace = await pedirLinkDescarga(info.__cdn, { downloadType: 'video', quality: q, key: info.key }, senal);
            detalle = 'video ' + q;
            break;
          } catch (e) {
            if (q === escalera[escalera.length - 1]) throw e;
          }
        }
      }
      if (!enlace) {
        const cualquiera = formatos.find((f) => f && f.url);
        if (cualquiera) {
          enlace = cualquiera.url;
          detalle = 'video ' + (cualquiera.quality || cualquiera.height || '') + ' fast';
        }
      }
      if (!enlace) throw new Error('savetube no ofrece video descargable para este video');
      const entregada = (/video (\d+)/.exec(detalle) || [])[1] || pedida || '360';
      calidadEntregada = entregada + 'p';
    }
    if (!enlace || !/^https?:\/\//.test(enlace)) throw new Error('savetube enlace invalido');
    return {
      url: enlace,
      headers: {},
      ext,
      calidad: calidadEntregada,
      titulo: typeof info.title === 'string' ? info.title : '',
      duracion: Number(info.duration) > 0 ? Number(info.duration) : 0,
      thumbnail: typeof info.thumbnail === 'string' ? info.thumbnail : '',
      videoId: videoId || '',
      fuente: 'savetube',
      detalle,
    };
  } finally {
    if (controller) controller.abort();
  }
}

module.exports = {
  resolverSaveTube,
  descifrarInfo,
  obtenerCdn,
};
