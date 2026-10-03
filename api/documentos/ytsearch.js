const yts = require('yt-search');
async function searchYoutube(query, limit = 5, signal) {
  const res = await yts(query);
  const videos = res.videos.slice(0, limit).map(v => ({
    videoId: v.videoId,
    id: v.videoId,
    title: v.title,
    url: v.url,
    thumbnail: v.thumbnail,
    timestamp: v.timestamp,
    duration: v.duration,
    views: v.views,
    author: v.author.name
  }));
  return videos;
}
module.exports = { searchYoutube };