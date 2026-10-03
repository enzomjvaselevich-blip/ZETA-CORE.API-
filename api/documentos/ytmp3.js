const { searchYoutube } = require('./ytsearch');

async function getYoutubeAudio(query, signal) {
  let videoId = query;
  let titleSearch = "";
  const ytIdRegex = /(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
  const match = query.match(ytIdRegex);
  if (match) videoId = match[1];
  else if (!/^[a-zA-Z0-9_-]{11}$/.test(query)) {
    const s = await searchYoutube(query, 1, signal);
    if (!s.length) throw Object.assign(new Error('No se encontró nada'), { statusCode: 404 });
    videoId = s[0].videoId;
    titleSearch = s[0].title;
  }

  const res = await fetch("https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      context: { client: { clientName: "ANDROID", clientVersion: "19.29.37", androidSdkVersion: 30 } },
      videoId
    }),
    signal
  });
  const data = await res.json();
  const title = data?.videoDetails?.title || titleSearch || "YouTube Audio";
  const formats = [...(data?.streamingData?.adaptiveFormats || []),...(data?.streamingData?.formats || [])];
  let audio = formats.filter(f => f.mimeType && f.mimeType.includes('audio')).sort((a,b) => (b.bitrate||0)-(a.bitrate||0))[0];
  if (!audio) throw Object.assign(new Error('YouTube no ofreció audio'), { statusCode: 502, code: 'YOUTUBE_FORMAT_UNAVAILABLE' });

  return {
    videoId,
    title,
    media: { url: audio.url, quality: '128kbps', mimeType: audio.mimeType }
  };
}
module.exports = { getYoutubeAudio };