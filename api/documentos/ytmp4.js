let ytInstance = null;
async function getYT() {
  if (ytInstance) return ytInstance;
  const { Innertube } = require('youtubei.js');
  ytInstance = await Innertube.create({ generate_session: false });
  return ytInstance;
}
const { searchYoutube } = require('./ytsearch');

async function getYoutubeVideo(query, quality = '720p') {
  const yt = await getYT();
  let videoId = query;
  let titleSearch = "";
  const m = query.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  if (m) videoId = m[1];
  else if (!/^[a-zA-Z0-9_-]{11}$/.test(query)) {
    const s = await searchYoutube(query, 1);
    if (!s.length) throw Object.assign(new Error('No se encontró'), { statusCode: 404 });
    videoId = s[0].videoId;
    titleSearch = s[0].title;
  }
  const info = await yt.getInfo(videoId);
  const format = info.chooseFormat({ quality: 'best', type: 'video+audio' });
  if (!format) throw Object.assign(new Error('No video'), { statusCode: 502, code: 'YOUTUBE_FORMAT_UNAVAILABLE' });
  const url = format.decipher? format.decipher(yt.session.player) : format.url;
  return {
    videoId,
    title: info.basic_info.title || titleSearch,
    media: { url, quality: format.quality_label || quality, mimeType: format.mime_type }
  };
}
module.exports = { getYoutubeVideo };