// /ytmp3 — Descargador de audio de YouTube por scraping puro.
//
// Cómo funciona:
//  1. Si `query` es un enlace de YouTube, se valida y se extrae el videoId.
//     Si es texto libre, se usa `ytsearch` para encontrar el primer resultado.
//  2. Se abre el video con `youtubei.js` (una librería que habla el mismo
//     protocolo interno que usa la app/web de YouTube) para leer los
//     formatos de audio/video que el propio reproductor de YouTube expone.
//  3. Se elige el mejor formato de audio y, si viene firmado/cifrado, se
//     descifra con el reproductor — igual que hace el YouTube real.
//  4. `downloadYoutubeAudio` transmite ese archivo de audio directamente al
//     cliente como descarga (Content-Disposition: attachment), en vez de
//     devolver solo un enlace en JSON.
const secureApi = require('../secure-api');
const { streamMediaToResponse, sanitizeFilename } = require('./shared');
const { searchYoutube } = require('./ytsearch');

async function resolveYoutubeTarget(query, parentSignal) {
  if (/^https?:\/\//i.test(query)) {
    const videoId = secureApi.extractYoutubeVideoId(query);
    if (!videoId) {
      throw secureApi.apiError(400, 'La URL de YouTube no es válida; se requiere HTTPS y una ruta reconocida.');
    }
    return { videoId, title: query };
  }
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(query)) {
    throw secureApi.apiError(400, 'Solo se aceptan enlaces HTTPS de YouTube.');
  }
  const results = await searchYoutube(query, 1, parentSignal);
  if (!results[0]) throw secureApi.apiError(404, 'No se encontró un video para la búsqueda.');
  return { videoId: results[0].videoId, title: results[0].title || query };
}

async function getYoutubeAudio(query, parentSignal) {
  const { videoId, title } = await resolveYoutubeTarget(query, parentSignal);
  const media = await secureApi.fetchYoutubeMedia(videoId, 'audio', '720p', parentSignal);
  return { videoId, title, media };
}

async function downloadYoutubeAudio(query, res, parentSignal) {
  const { videoId, title, media } = await getYoutubeAudio(query, parentSignal);
  await streamMediaToResponse({
    url: media.url,
    res,
    filename: `${sanitizeFilename(title)}.mp3`,
    contentType: 'audio/mpeg',
    parentSignal,
  });
  return { videoId, title, media };
}

module.exports = { resolveYoutubeTarget, getYoutubeAudio, downloadYoutubeAudio };
