// Snapsave.app — extractores de videos de Facebook por scraping del sitio
// publico. 100% anonimo (sin cookies ni cuentas): replica el flujo real del
// navegador, verificado en vivo con bytes:
//   1. POST multipart a https://snapsave.app/action.php?lang=en con campo url.
//   2. La respuesta NO es JSON: es JS ofuscado (payload eval) que el navegador
//      ejecuta via insertAndExecute(). Se decodifica con vm capturando el eval.
//   3. El script decodificado trae la tabla de calidades con enlaces
//      https://d.rapidcdn.app/v2?token=...  que sirven el MP4 real con soporte
//      de Range (HTTP 206), desde su propio CDN: sin bloqueo de IP datacenter.
const vm = require('node:vm');
const crypto = require('node:crypto');

const HOST = 'https://snapsave.app';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function entropia() {
  return crypto.randomBytes(4).toString('hex');
}

// Decodifica el payload ofuscado: devuelve el JS plano o '' si no se pudo.
function decodificarPayload(codigo) {
  const capturado = [];
  const sandbox = {
    document: new Proxy({
      querySelector: () => null,
      querySelectorAll: () => [],
      getElementById: () => null,
      createElement: () => ({ appendChild: () => {} }),
      getElementsByTagName: () => [{ insertBefore: () => {}, removeChild: () => {} }],
      body: {},
    }, {
      get: (t, k) => (k in t ? t[k] : (() => null)),
      set: () => true,
    }),
    eval: (s) => { capturado.push(String(s)); },
    location: { href: 'https://snapsave.app/', hostname: 'snapsave.app', reload: () => {} },
    alert: () => {},
    gtag: () => {},
    setTimeout: () => {},
    setInterval: () => {},
    clearTimeout: () => {},
    clearInterval: () => {},
    console,
  };
  sandbox.window = sandbox;
  try {
    vm.runInNewContext(String(codigo), sandbox, { timeout: 3000 });
  } catch {}
  return capturado.join('\n');
}

function desembarcar(texto) {
  return String(texto || '')
    .replace(/\\(["'])/g, '$1')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&');
}

// Parsea la tabla de calidades del script decodificado. Devuelve lista en el
// orden del payload (suele ser de mayor a menor calidad).
function extraerOpciones(scriptDecodificado) {
  const plano = desembarcar(scriptDecodificado);
  const salida = [];
  const filas = plano.split(/<tr[^>]*>/).slice(1);
  for (const fila of filas) {
    const qraw = fila.match(/video-quality[^>]*>\s*([^<]+)/);
    const href = fila.match(/href="([^"]+)"/);
    if (!href) continue;
    const url = href[1];
    if (!/^https?:\/\//.test(url)) continue;
    const etiqueta = qraw ? qraw[1].trim() : 'video';
    const esHd = /hd/i.test(etiqueta) || /2k|4k|1080|2160/i.test(etiqueta);
    salida.push({ calidad: etiqueta, esHd, url });
  }
  return salida;
}

// Devuelve {ok,tipo,titulo,descarga_directa,calidad,candidatos,fuente} o lanza.
async function fetchSnapsaveVideo(inputUrl, parentSignal, timeoutMs = 20000) {
  const crudo = String(inputUrl || '').trim();
  const senal = parentSignal
    ? AbortSignal.any([parentSignal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  const fd = new FormData();
  fd.append('url', crudo);
  const r = await fetch(HOST + '/action.php?lang=en&nocache=' + entropia(), {
    method: 'POST',
    headers: { 'User-Agent': UA, Referer: HOST + '/', Origin: HOST.replace(/\/$/, ''), Accept: 'text/javascript, application/javascript, */*; q=0.01' },
    body: fd,
    signal: senal,
  });
  if (!r.ok) throw new Error('snapsave action.php HTTP ' + r.status);
  const cuerpo = await r.text();
  if (!/eval\s*\(/.test(cuerpo)) throw new Error('snapsave sin payload (HTTP ' + r.status + ')');
  const decodificado = decodificarPayload(cuerpo);
  if (/Url error|Download error/i.test(decodificado)) throw new Error('snapsave: video no disponible o privilegiado');
  const opciones = extraerOpciones(decodificado);
  if (!opciones.length) throw new Error('snapsave: sin enlaces de descarga en el payload');
  const ordenadas = [...opciones].sort((a, b) => (b.esHd - a.esHd));
  const mTitulo = desembarcar(decodificado).match(/<strong>([^<]*)<\/strong>/);
  const titulo = mTitulo && mTitulo[1] && mTitulo[1] !== 'Video Facebook' ? mTitulo[1].trim() : '';
  return {
    ok: true,
    tipo: 'video',
    titulo: titulo || 'video de Facebook',
    descarga_directa: ordenadas[0].url,
    calidad: /hd|4k/i.test(ordenadas[0].calidad) ? 'hd' : 'sd',
    candidatos: ordenadas.map((o) => o.url),
    fuente: 'snapsave',
  };
}

module.exports = { fetchSnapsaveVideo, decodificarPayload, extraerOpciones };
