let ytInstance = null;
async function getYT() {
  if (ytInstance) return ytInstance;
  const mod = await import('youtubei.js');
  ytInstance = await mod.Innertube.create({ generate_session: false });
  return ytInstance;
}
async function searchYoutube(query, limit = 5) {
  const yt = await getYT();
  const res = await yt.search(query, { type: 'video' });
  const list = res.results || res.videos || [];
  return list.filter(v => v.id).slice(0, limit).map(v => ({
    videoId: v.id,
    id: v.id,
    title: v.title?.text || v.title || "",
    url: `https://www.youtube.com/watch?v=${v.id}`,
    thumbnail: v.thumbnails?.[0]?.url || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
    timestamp: v.duration?.text || "",
    author: v.author?.name || ""
  }));
}
module.exports = { searchYoutube };