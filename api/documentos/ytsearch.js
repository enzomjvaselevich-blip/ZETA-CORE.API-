let ytInstance = null;
async function getYT() {
  if (ytInstance) return ytInstance;
  const { Innertube } = require('youtubei.js');
  ytInstance = await Innertube.create({ generate_session: false });
  return ytInstance;
}

async function searchYoutube(query, limit = 5) {
  const yt = await getYT();
  const res = await yt.search(query, { type: 'video' });
  const videos = (res.results || res.videos || []).filter(v => v.id || v.video_id).slice(0, limit);
  return videos.map(v => ({
    videoId: v.id || v.video_id,
    id: v.id || v.video_id,
    title: v.title?.text || v.title || "",
    url: `https://www.youtube.com/watch?v=${v.id || v.video_id}`,
    thumbnail: v.thumbnails?.[0]?.url || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
    timestamp: v.duration?.text || "",
    duration: v.duration?.text || "",
    views: v.view_count?.text || "",
    author: v.author?.name || ""
  }));
}
module.exports = { searchYoutube };