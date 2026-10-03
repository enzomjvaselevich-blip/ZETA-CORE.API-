async function searchYoutube(query, limit = 5, signal) {
  const body = {
    context: { client: { clientName: "WEB", clientVersion: "2.20240101.00.00" } },
    query
  };
  const res = await fetch("https://www.youtube.com/youtubei/v1/search?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal
  });
  const data = await res.json();
  const contents = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents || [];
  let videos = [];
  for (let c of contents) {
    const vr = c.videoRenderer;
    if (vr) {
      videos.push({
        videoId: vr.videoId,
        id: vr.videoId,
        title: vr.title?.runs?.[0]?.text || "",
        url: `https://www.youtube.com/watch?v=${vr.videoId}`,
        thumbnail: `https://i.ytimg.com/vi/${vr.videoId}/hqdefault.jpg`,
        timestamp: vr.lengthText?.simpleText || "",
        duration: vr.lengthText?.simpleText || "",
        views: vr.viewCountText?.simpleText || "",
        author: vr.ownerText?.runs?.[0]?.text || ""
      });
      if (videos.length >= limit) break;
    }
  }
  return videos;
}
module.exports = { searchYoutube };