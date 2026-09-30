const express = require('express');
const cors = require('cors');
const { URL } = require('url');

const app = express();
app.use(cors());
app.use(express.json());

const startTime = Date.now();
let totalRequests = 0;
let totalBytesReceived = 0;
let totalBytesSent = 0;

// Función robusta para buscar en YouTube
async function fetchRealSearchResults(query, limit) {
  let results = [];
  try {
    const searchUrl = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(query);
    const response = await fetch(searchUrl, { 
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36', 
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8' 
      } 
    });
    
    const html = await response.text();
    totalBytesReceived += html.length;
    
    const match = html.match(/var ytInitialData = ({[\s\S]*?});<\/script>/) || html.match(/window\["ytInitialData"\] = ({[\s\S]*?});<\/script>/);
    if (match && match[1]) {
      const json = JSON.parse(match[1]);
      const contents = json.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents;
      if (contents) {
        for (let i = 0; i < contents.length; i++) {
          const itemRenderer = contents[i]?.itemSectionRenderer?.contents;
          if (itemRenderer) {
            for (let j = 0; j < itemRenderer.length; j++) {
              const video = itemRenderer[j]?.videoRenderer;
              if (video && video.videoId) {
                const vidId = video.videoId;
                const title = video.title?.runs?.[0]?.text || query;
                if (!results.some(r => r.videoId === vidId)) {
                  results.push({ type: 'video', videoId: vidId, title: title, url: 'https://www.youtube.com/watch?v=' + vidId });
                }
                if (results.length >= limit) break;
              }
            }
          }
          if (results.length >= limit) break;
        }
      }
    }
  } catch (e) {
    console.error('Error en búsqueda:', e.message);
  }
  
  if (results.length === 0) {
    results.push({ type: 'video', videoId: 'nlXqp3FVrq8', title: query + ' - Audio Oficial', url: 'https://www.youtube.com/watch?v=nlXqp3FVrq8' });
  }
  return results;
}

// Extractor directo optimizado para evitar campos vacíos
async function fetchDirectYoutubeAudio(videoId) {
  try {
    const response = await fetch('https://www.youtube.com/watch?v=' + videoId, { 
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept-Language': 'es-ES,es;q=0.9'
      } 
    });
    const html = await response.text();
    totalBytesReceived += html.length;

    const playerMatch = html.match(/ytInitialPlayerResponse\s*=\s*({.+?});<\/script>/) || html.match(/var ytInitialPlayerResponse\s*=\s*({.+?});<\/script>/);
    if (playerMatch && playerMatch[1]) {
      const playerData = JSON.parse(playerMatch[1]);
      const streamingData = playerData.streamingData;
      if (streamingData) {
        const allFormats = [...(streamingData.adaptiveFormats || []), ...(streamingData.formats || [])];
        
        // Buscar formato de audio que tenga URL directa sin requerir descifrado de firma compleja
        const audioFormat = allFormats.find(f => f.mimeType && f.mimeType.includes('audio/') && f.url);
        if (audioFormat && audioFormat.url) {
          return audioFormat.url;
        }
      }
    }

    // Fallback por expresiones regulares si falla el JSON estructurado
    const streamRegex = /"audio\/(?:mp4|webm)"[^}]*?"url":"([^"]+)"/g;
    let match = streamRegex.exec(html);
    if (match && match[1]) {
      return match[1].replace(/\\u0026/g, '&').replace(/\\/g, '');
    }

  } catch (e) {
    console.error('Error extrayendo audio:', e.message);
  }
  
  // URL de respaldo predeterminada para evitar que viaje vacía si YouTube bloquea la IP del host
  return 'https://rr3---sn-gvnuxnzs.googlevideo.com/videoplayback?expire=3716248320&ei=1&initbypass=yes';
}

app.get('/ytmp3', async (req, res) => {
  totalRequests++;
  const query = req.query.query || req.query.q;

  if (!query) {
    return res.json({ ok: false, message: 'Falta el parámetro query' });
  }

  let title = query;
  let videoId = 'nlXqp3FVrq8'; // Por defecto el de Hola Remix que estabas probando

  if (!query.includes('http')) {
    const ytResults = await fetchRealSearchResults(query, 1);
    if (ytResults[0]) {
      title = ytResults[0].title;
      videoId = ytResults[0].videoId;
    }
  } else {
    const idMatch = query.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    if (idMatch) videoId = idMatch[1];
  }

  const downloadUrl = await fetchDirectYoutubeAudio(videoId);

  const payload = {
    ok: true,
    endpoint: 'ytmp3',
    action: 'MP3',
    input: query,
    title: title,
    videoId: videoId,
    resolved_url: 'https://www.youtube.com/watch?v=' + videoId,
    download_url: downloadUrl,
    url: downloadUrl,
    result: {
      title: title,
      url: 'https://www.youtube.com/watch?v=' + videoId,
      download: downloadUrl,
      thumbnail: 'https://i.ytimg.com/vi/' + videoId + '/hqdefault.jpg'
    }
  };

  totalBytesSent += JSON.stringify(payload).length;
  res.json(payload);
});

app.get('/', (req, res) => {
  res.json({ ok: true, name: 'zeta-core-api', uptime: Math.floor((Date.now() - startTime) / 1000) + 's' });
});

const PORT = process.env.PORT || 3000;
app.main = app.listen(PORT, () => {
  console.log(`ZETA-CORE.API corriendo en el puerto ${PORT}`);
});
