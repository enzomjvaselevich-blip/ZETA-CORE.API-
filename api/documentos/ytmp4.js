const secureApi = require('../secure-api');
const { searchYoutube } = require('./ytsearch');
async function getYoutubeVideo(query, quality = '720p') {
  let videoId = query;
  let titleSearch = "";
  const m = query.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  if (m) videoId = m[1];
  else if (!/^[a-zA-Z0-9_-]{11}$/.test(query)) {
    const s = await searchYoutube(query, 1);
    if (!s.length) throw Object.assign(new Error('No se encontró'), { statusCode: 404 });
    videoId = s[0].videoId; titleSearch = s[0].title;
  }
  const media = await secureApi.fetchYoutubeMedia(videoId, 'video', quality);
  return { videoId, title: media.basic_info?.title || titleSearch, media: { url: media.url, quality: media.quality, bitrate: media.bitrate } };
}
module.exports = { getYoutubeVideo };
