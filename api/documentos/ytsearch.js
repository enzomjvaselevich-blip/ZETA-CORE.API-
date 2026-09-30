// /ytsearch — Buscador de YouTube por scraping puro.
//
// Cómo funciona: se pide la página pública de resultados
// https://www.youtube.com/results?search_query=... y se extrae el bloque
// JSON `ytInitialData` que YouTube incrusta en un <script> del propio HTML.
// No se llama a ninguna API externa ni de pago: es la misma página que ve
// un navegador normal, solo que la leemos como texto.
const secureApi = require('../secure-api');

async function searchYoutube(query, limit, parentSignal) {
  return secureApi.fetchRealSearchResults(query, limit, 'youtube', parentSignal);
}

module.exports = { searchYoutube };
