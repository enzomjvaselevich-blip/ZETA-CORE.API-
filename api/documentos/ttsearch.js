// /ttsearch — Buscador de TikTok por scraping puro.
//
// Cómo funciona: se pide https://www.tiktok.com/search?q=... y se extrae la
// lista de videos directamente del HTML devuelto (pares "id"/"desc" que
// TikTok embebe en la página). No hay API externa involucrada.
const secureApi = require('../secure-api');

async function searchTikTok(query, limit, parentSignal) {
  return secureApi.fetchRealSearchResults(query, limit, 'tiktok', parentSignal);
}

module.exports = { searchTikTok };
