// /ttsearch — Buscador de TikTok multi-fuente (scraping directo, tikwm,
// DDG HTML, DDG Lite y Bing en paralelo + enriquecido via oEmbed/tikwm).
const secureApi = require('../secure-api');

async function searchTikTok(query, limit, parentSignal) {
  return secureApi.fetchRealSearchResults(query, limit, 'tiktok', parentSignal);
}

module.exports = { searchTikTok, obtenerDiagnosticoTikTok: secureApi.obtenerDiagnosticoTikTok };
