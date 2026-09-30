// Utilidades compartidas por los módulos de `documentos/`.
// Aquí vive únicamente la lógica de "entregar el archivo descargado
// directamente al navegador" (streaming + cabeceras), para que cada módulo
// de ruta (ytmp3, ytmp4, etc.) se mantenga enfocado en su propio scraping.
const secureApi = require('../secure-api');

// Límite defensivo: ningún archivo de audio/video servido debería superar
// esto. Protege contra respuestas anómalas del proveedor de streaming.
const MAX_DOWNLOAD_BYTES = 300 * 1024 * 1024;

function sanitizeFilename(name) {
  const cleaned = String(name || 'descarga')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9-_ ]/g, '')
    .trim()
    .slice(0, 80);
  return cleaned || 'descarga';
}

function isGoogleVideoUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      (url.hostname === 'googlevideo.com' || url.hostname.endsWith('.googlevideo.com'))
    );
  } catch {
    return false;
  }
}

// Descarga el archivo real desde el enlace directo de googlevideo.com y lo
// transmite (streaming) como respuesta con Content-Disposition: attachment,
// para que el resultado sea el propio archivo mp3/mp4 y no un JSON con un link.
async function streamMediaToResponse({ url, res, filename, contentType, parentSignal, timeoutMs = 25000 }) {
  if (!isGoogleVideoUrl(url)) {
    throw secureApi.apiError(502, 'El proveedor intentó entregar la descarga desde un destino no permitido.');
  }

  const controller = new AbortController();
  const timeoutError = secureApi.apiError(504, 'La descarga excedió el tiempo límite.');
  const onTimeout = () => controller.abort(timeoutError);
  const onParentAbort = () => controller.abort(parentSignal?.reason || timeoutError);
  const timer = setTimeout(onTimeout, timeoutMs);
  if (parentSignal) {
    if (parentSignal.aborted) onParentAbort();
    else parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }

  try {
    let upstream;
    try {
      upstream = await fetch(url, { signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) throw timeoutError;
      throw secureApi.apiError(502, 'No fue posible conectar con el servidor de streaming.');
    }
    if (!upstream.ok) {
      throw secureApi.apiError(502, 'El proveedor no pudo entregar el archivo solicitado.');
    }

    const declaredLength = upstream.headers.get('content-length');
    if (declaredLength !== null) {
      if (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_DOWNLOAD_BYTES) {
        throw secureApi.apiError(502, 'El archivo de descarga excede el tamaño permitido.');
      }
    }
    if (!upstream.body || typeof upstream.body.getReader !== 'function') {
      throw secureApi.apiError(502, 'No se pudo transmitir el archivo de descarga.');
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${sanitizeFilename(filename)}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (declaredLength) res.setHeader('Content-Length', declaredLength);

    const reader = upstream.body.getReader();
    let received = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > MAX_DOWNLOAD_BYTES) {
          await reader.cancel().catch(() => {});
          throw secureApi.apiError(502, 'El archivo de descarga excede el tamaño permitido.');
        }
        res.write(Buffer.from(value));
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {}
    }
    res.end();
  } catch (error) {
    if (error.statusCode) throw error;
    if (controller.signal.aborted) throw timeoutError;
    throw secureApi.apiError(502, 'No fue posible completar la descarga del archivo.');
  } finally {
    clearTimeout(timer);
    if (parentSignal) parentSignal.removeEventListener('abort', onParentAbort);
  }
}

module.exports = { sanitizeFilename, isGoogleVideoUrl, streamMediaToResponse, MAX_DOWNLOAD_BYTES };
