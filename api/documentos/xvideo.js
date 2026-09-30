// /xvideo — Extractor de video de X/Twitter por scraping puro.
//
// A diferencia de la versión anterior, este módulo YA NO llama a proxies de
// terceros (como fxtwitter.com). Solo consulta el endpoint público de
// sindicación que X/Twitter usa para sus propios widgets de "embed"
// (cdn.syndication.twimg.com), que es el mismo dominio oficial de X, y de
// ahí extrae los enlaces de video directamente del contenido devuelto.
const secureApi = require('../secure-api');

const SYNDICATION_HOST = 'cdn.syndication.twimg.com';

async function fetchXVideo(inputUrl, parentSignal) {
  const tweetId = secureApi.extractTweetId(inputUrl);
  const syndicationUrl = `https://${SYNDICATION_HOST}/tweet-result?id=${tweetId}&lang=en`;

  let response;
  let body;
  try {
    const result = await secureApi.fetchTextSafe(syndicationUrl, {
      allowedHosts: [SYNDICATION_HOST],
      parentSignal,
      timeoutMs: 3500,
      maxBytes: 2 * 1024 * 1024,
      acceptedStatuses: [404],
    });
    response = result.response;
    body = result.text;
  } catch (error) {
    if (error.statusCode === 504) throw error;
    throw secureApi.apiError(502, 'No fue posible consultar el contenido público de X/Twitter.');
  }

  if (response.status === 404) {
    throw secureApi.apiError(404, 'La publicación no existe o no es pública.');
  }

  const data = secureApi.parseJson(body, 'X/Twitter devolvió datos inválidos.');
  const tweet = data.tweet || data;
  if (!tweet || typeof tweet !== 'object') {
    throw secureApi.apiError(502, 'X/Twitter devolvió datos inesperados.');
  }

  const videos = secureApi.getVideoVariants(tweet);
  if (!videos.length) {
    throw secureApi.apiError(404, 'No se encontraron videos disponibles en la publicación indicada.');
  }

  return {
    ok: true,
    endpoint: 'xvideo',
    input: inputUrl,
    tweet_id: tweetId,
    videos,
    total_videos: videos.length,
    best: videos[0].url,
    thumbnail: tweet.media?.photos?.[0]?.url || tweet.media?.videos?.[0]?.thumbnail_url || null,
    text: tweet.text || null,
  };
}

module.exports = { fetchXVideo };
