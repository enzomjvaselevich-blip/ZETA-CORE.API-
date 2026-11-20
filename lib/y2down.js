// Extractor y2down (flujo HTTP real del sitio verificado en vivo con bytes):
// backend p.savenow.to con challenge Proof-of-Work propio. 100% anonimo, sin
// cookies ni cuentas; lo unico fijo es el Origin del sitio y la apikey publica
// embebida en su frontend.
//
// Flujo real:
//   1. GET  p.savenow.to/api/pow/challenge -> {salt,difficulty,expires_at,signature}
//   2. PoW: nonce tal que sha256hex(salt+":"+nonce) empieza con `difficulty` ceros
//   3. POST p.savenow.to/api/pow/verify    -> {success,token,expires_at}
//   4. GET  p.savenow.to/api/v2/download?apikey=...&format=fmt&url=...
//      (header Origin: https://y2down.cc/enir exigido por su backend)
//      -> {success,progress_url}
//   5. Poll de progress_url hasta que trae download_url (aparece en ~3-20s)
//   6. Descarga desde SU propio CDN (xxx.savenow.to), no googlevideo: sin
//      bloqueo de IP de datacenter.
//
// Formatos: mp3 | 144 240 360 480 720 1080 1440 ('4k' 8k vitam).
// Limitaciones honestas: sin Content-Length (chunked), velocidad del CDN baja
// (~0.3MB/s), la download_url expira rapido y el poll puede tardar >10s: por
// eso el presupuesto por defecto es 20s, controlado con AbortController.

const crypto = require('node:crypto');

const HOST = 'https://p.savenow.to';
const APIKEY = 'dfcb6d76f2f6a9894gjkege8a4ab232222';
const ORIGEN = 'https://y2down.cc';
const REFERER = 'https://y2down.cc/enir/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

let cacheToken = { token: '', expira: 0 };
let inflightToken = null;

function headersBase(extra) {
  return Object.assign({
    'User-Agent': UA,
    'Origin': ORIGEN,
    'Referer': REFERER,
    'Accept-Language': 'es-AR,es;q=0.9',
    'Accept': 'application/json, text/plain, */*',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'cross-site',
  }, extra || {});
}

function conSenal(ms, signal) {
  const porTimeout = AbortSignal.timeout(ms);
  if (signal && typeof AbortSignal.any === 'function') return AbortSignal.any([signal, porTimeout]);
  return porTimeout;
}

function resolverPoW(salt, difficulty, senal) {
  const objetivo = '0'.repeat(Number(difficulty) || 1);
  let nonce = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    if (senal && senal.aborted) throw new Error('y2down: abortado durante PoW');
    const h = crypto.createHash('sha256').update(salt + ':' + nonce).digest('hex');
    if (h.startsWith(objetivo)) return nonce;
    nonce += 1;
  }
  throw new Error('y2down: PoW sin resolver en 15s (difficulty ' + difficulty + ')');
}

async function obtenerToken(senal) {
  if (cacheToken.token && cacheToken.expira > Date.now() + 30000) return cacheToken.token;
  if (inflightToken) return inflightToken;
  inflightToken = (async () => {
    const ch = await fetch(HOST + '/api/pow/challenge', { headers: headersBase(), signal: conSenal(8000, senal) }).then((r) => r.json());
    if (!ch || !ch.salt || !ch.signature) throw new Error('y2down: challenge sin salt');
    const nonce = resolverPoW(ch.salt, ch.difficulty, senal);
    const v = await fetch(HOST + '/api/pow/verify', {
      method: 'POST',
      headers: headersBase({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ salt: ch.salt, difficulty: ch.difficulty, expires_at: ch.expires_at, signature: ch.signature, nonce }),
      signal: conSenal(8000, senal),
    }).then((r) => r.json());
    if (!v || !v.success || !v.token) throw new Error('y2down: verify fallo');
    cacheToken = { token: v.token, expira: (Number(v.expires_at) > 1e12 ? Number(v.expires_at) : Number(v.expires_at) * 1000) || Date.now() + 8 * 60 * 1000 };
    return cacheToken.token;
  })().finally(() => { inflightToken = null; });
  return inflightToken;
}

function formatoDe(kind, calidad) {
  if (kind !== 'video') return 'mp3';
  const m = /^(144|240|360|480|720|1080|1440|2160)p$/i.exec(String(calidad || ''));
  if (!m) return '360';
  if (m[1] === '2160') return '4k';
  return m[1];
}

// Devuelve {url, headers, ext, calidad, titulo, thumbnail, fuente, detalle}
// o THROWS. kind: 'audio' | 'video'.
async function resolverY2Down({ url, videoId, kind, calidad, timeoutMs, signal }) {
  if (!videoId && !url) throw new Error('y2down sin url ni videoId');
  let controller = null;
  let senal = signal || undefined;
  if (timeoutMs) {
    controller = new AbortController();
    const t = setTimeout(() => controller.abort(), Math.max(500, timeoutMs));
    if (t.unref) t.unref();
    senal = signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  }
  try {
    const formato = formatoDe(kind, calidad);
    const urlVideo = 'https://www.youtube.com/watch?v=' + (videoId || (String(url).match(/([a-zA-Z0-9_-]{11})/) || [])[1]);
    const token = await obtenerToken(senal);
    const pedido = await fetch(HOST + '/api/v2/download?apikey=' + APIKEY + '&format=' + formato + '&url=' + encodeURIComponent(urlVideo), {
      headers: headersBase({ Authorization: 'Bearer ' + token }),
      signal: conSenal(15000, senal),
    }).then((r) => r.json());
    if (!pedido || !pedido.progress_url) throw new Error('y2down: sin progress_url ' + JSON.stringify(pedido).slice(0, 120));
    let enlace = '';
    const t0Poll = Date.now();
    while (!enlace && Date.now() - t0Poll < Math.max(3000, (timeoutMs || 20000) - 6000)) {
      const pr = await fetch(pedido.progress_url, { headers: headersBase({ Authorization: 'Bearer ' + token }), signal: conSenal(5000, senal) }).then((r) => r.json()).catch(() => null);
      if (pr && pr.download_url) { enlace = pr.download_url; break; }
      if (pr && pr.error && pr.status === 'error') throw new Error('y2down: error en conversion');
      if (pr && pr.success === 0 && pr.download_url === null && Number(pr.progress) === 1000) throw new Error('y2down: ' + (pr.message || 'video no disponible'));
      if (controller && controller.signal.aborted) throw new Error('y2down: timeout esperando download_url');
      await new Promise((r) => setTimeout(r, 2500));
    }
    if (!enlace || !/^https?:\/\//.test(enlace)) throw new Error('y2down: download_url invalido');
    return {
      url: enlace,
      headers: {},
      ext: kind === 'video' ? 'mp4' : 'mp3',
      calidad: formato === 'mp3' ? '128' : formato + 'p',
      titulo: typeof pedido.title === 'string' ? pedido.title : '',
      duracion: 0,
      thumbnail: (pedido.info && pedido.info.image) || pedido.thumbnail_url || '',
      videoId: videoId || '',
      fuente: 'y2down',
      detalle: formato === 'mp3' ? 'audio mp3' : 'video ' + formato,
    };
  } finally {
    if (controller) controller.abort();
  }
}

module.exports = {
  resolverY2Down,
  obtenerToken,
};
