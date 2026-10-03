const ytdl = require('@distube/ytdl-core');
const { searchYoutube } = require('./ytsearch');

async function getYoutubeVideo(query, quality = '720p', signal) {
  let videoId = query;
  let titleFromSearch = '';
  if (!ytdl.validateURL(query)) {
    const s = await searchYoutube(query, 1, signal);
    if (!s.length) throw Object.assign(new Error('No se encontró nada para: ' + query), { statusCode: 404 });
    videoId = s[0].videoId;
    titleFromSearch = s[0].title;
  } else {
    videoId = ytdl.getVideoID(query);
  }
  const info = await ytdl.getInfo(`https://www.youtube.com/watch?v=${videoId}`, { requestOptions: { signal } });
  let format = ytdl.chooseFormat(info.formats, { filter: f => f.hasVideo && f.hasAudio, quality: 'highest' });
  if (!format) format = ytdl.chooseFormat(info.formats, { quality: 'highest' });
  if (!format ||!format.url) {
    throw Object.assign(new Error('YouTube no ofreció video'), { statusCode: 502, code: 'YOUTUBE_FORMAT_UNAVAILABLE' });
  }
  return {
    videoId,
    title: info.videoDetails.title || titleFromSearch,
    media: {
      url: format.url,
      quality: format.qualityLabel || quality,
      mimeType: format.mimeType
    }
  };
}
module.exports = { getYoutubeVideo };