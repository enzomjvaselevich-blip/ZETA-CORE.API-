// /tiktok — Extractor de video de TikTok por scraping puro.
//
// Cómo funciona: se descarga el HTML público de la página del video de
// TikTok y se parsea el bloque `__UNIVERSAL_DATA_FOR_REHYDRATION__` (o el
// antiguo `SIGI_STATE`) que TikTok incrusta en su propio HTML. Esos bloques
// contienen los enlaces directos de video/audio sin marca de agua.
const secureApi = require('../secure-api');

async function extractTikTokVideo(url, parentSignal) {
  return secureApi.fetchTikTokVideo(url, parentSignal);
}

module.exports = { extractTikTokVideo };
