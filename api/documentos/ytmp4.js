// /ytmp4 — Descargador de video de YouTube por scraping puro.
//
// Mismo mecanismo que `ytmp3.js` (ver ese archivo para el detalle del
// scraping con `youtubei.js`), pero eligiendo el mejor formato de video
// para la calidad pedida y entregando el archivo .mp4 como descarga directa.
const secureApi = require('../secure-api');
const { streamMediaToResponse, sanitizeFilename } = require('./shared');
const { resolveYoutubeTarget } = require('./ytmp3');

async function getYoutubeVideo(query, quality, parentSignal) {
  const { videoId, title } = await resolveYoutubeTarget(query, parentSignal);
  const media = await secureApi.fetchYoutubeMedia(videoId, 'video', quality, parentSignal);
  return { videoId, title, media };
}

async function downloadYoutubeVideo(query, quality, res, parentSignal) {
  const { videoId, title, media } = await getYoutubeVideo(query, quality, parentSignal);
  await streamMediaToResponse({
    url: media.url,
    res,
    filename: `${sanitizeFilename(title)}.mp4`,
    contentType: 'video/mp4',
    parentSignal,
  });
  return { videoId, title, media };
}

module.exports = { getYoutubeVideo, downloadYoutubeVideo };
