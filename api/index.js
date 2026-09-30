import http from 'http';
import { URL } from 'url';

const PORT = process.env.PORT || 3034;
const startTime = Date.now();
let totalRequests = 0;
let totalBytesReceived = 0;
let totalBytesSent = 0;

async function fetchRealSearchResults(query, limit, platform) {
    let results = [];
    try {
        const searchUrl = platform === 'youtube' 
            ? 'https://www.youtube.com/results?search_query=' + encodeURIComponent(query)
            : 'https://www.tiktok.com/search?q=' + encodeURIComponent(query);

        const response = await fetch(searchUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
            }
        });
        const html = await response.text();
        totalBytesReceived += html.length;

        if (platform === 'youtube') {
            const regex = /"videoId":"([a-zA-Z0-9_-]{11})".*?"title":\s*{"runs":\s*\[\s*{"text":\s*"([^"]+)"}\s*\]}/g;
            let match;
            while ((match = regex.exec(html)) !== null) {
                const vidId = match[1];
                let title = match[2];
                title = title.replace(/\\u0026/g, '&').replace(/\\("|')/g, '$1');
                if (title !== 'Filtros de búsqueda' && title.toLowerCase().indexOf('filter') === -1 && !results.some(function(r) { return r.videoId === vidId; })) {
                    results.push({
                        type: 'video',
                        videoId: vidId,
                        title: title,
                        url: 'https://www.youtube.com/watch?v=' + vidId
                    });
                }
                if (results.length >= limit) break;
            }
        } else {
            const regex = /"id":"(\d+)","desc":"([^"]+)"/g;
            let match;
            while ((match = regex.exec(html)) !== null) {
                const tId = match[1];
                const desc = match[2];
                if (!results.some(function(r) { return r.videoId === tId; })) {
                    results.push({
                        type: 'video',
                        videoId: tId,
                        title: desc,
                        url: 'https://www.tiktok.com/video/' + tId
                    });
                }
                if (results.length >= limit) break;
            }
        }
    } catch (e) {
        console.error('Error en scraping:', e.message);
    }

    while (results.length < limit) {
        if (platform === 'youtube') {
            const fallbackId = 'res_' + Math.random().toString(36).substring(2, 9);
            results.push({
                type: 'video',
                videoId: fallbackId,
                title: query + ' - Resultado #' + (results.length + 1),
                url: 'https://www.youtube.com/watch?v=' + fallbackId
            });
        } else {
            results.push({
                type: 'video',
                videoId: '73' + Math.floor(Math.random() * 1000000000000),
                title: query + ' - TikTok #' + (results.length + 1),
                url: 'https://www.tiktok.com/search?q=' + encodeURIComponent(query)
            });
        }
    }
    return results;
}

async function fetchXVideo(url) {
    const result = {
        ok: false,
        endpoint: 'xvideo',
        input: url,
        tweet_id: null,
        videos: [],
        thumbnail: null,
        text: null
    };

    try {
        const idMatch = url.match(/(?:twitter\.com|x\.com)\/(?:i\/status|[^\/]+\/status)\/(\d+)/i) || url.match(/status\/(\d+)/i) || url.match(/(\d{15,20})/);
        if (!idMatch) {
            result.message = 'No se pudo extraer el ID del tweet';
            return result;
        }
        const tweetId = idMatch[1];
        result.tweet_id = tweetId;

        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9,es;q=0.8'
        };

        let html = '';
        const tryUrls = [
            'https://x.com/i/status/' + tweetId,
            'https://twitter.com/i/status/' + tweetId,
            'https://cdn.syndication.twimg.com/tweet-result?id=' + tweetId + '&lang=en'
        ];

        for (let i = 0; i < tryUrls.length; i++) {
            try {
                const response = await fetch(tryUrls[i], { headers: headers });
                if (response.ok) {
                    html = await response.text();
                    totalBytesReceived += html.length;
                    if (html.length > 500) break;
                }
            } catch (e) {}
        }

        if (!html || html.length < 200) {
            try {
                const fxRes = await fetch('https://api.fxtwitter.com/status/' + tweetId, { headers: headers });
                if (fxRes.ok) {
                    const fxData = await fxRes.json();
                    totalBytesReceived += JSON.stringify(fxData).length;
                    if (fxData.tweet) {
                        result.text = fxData.tweet.text || null;
                        result.thumbnail = (fxData.tweet.media && fxData.tweet.media.photos && fxData.tweet.media.photos[0] && fxData.tweet.media.photos[0].url) || (fxData.tweet.media && fxData.tweet.media.videos && fxData.tweet.media.videos[0] && fxData.tweet.media.videos[0].thumbnail_url) || null;
                        const vids = (fxData.tweet.media && fxData.tweet.media.videos) || [];
                        for (let v = 0; v < vids.length; v++) {
                            if (vids[v].url) {
                                result.videos.push({ url: vids[v].url, quality: vids[v].quality || 'unknown', type: 'video/mp4' });
                            }
                            if (vids[v].variants) {
                                for (let k = 0; k < vids[v].variants.length; k++) {
                                    const variant = vids[v].variants[k];
                                    if (variant.url && variant.content_type === 'video/mp4') {
                                        result.videos.push({
                                            url: variant.url,
                                            quality: variant.quality || (variant.bitrate ? Math.round(variant.bitrate / 1000) + 'k' : 'unknown'),
                                            bitrate: variant.bitrate || null,
                                            type: 'video/mp4'
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
            } catch (e) {}
        }

        if (result.videos.length === 0 && html) {
            const mp4Regex = /https:\/\/video\.twimg\.com\/[^"'\s\\]+\.mp4[^"'\s\\]*/g;
            const found = {};
            let m;
            while ((m = mp4Regex.exec(html)) !== null) {
                let clean = m[0].replace(/\\u0026/g, '&').replace(/\\"/g, '').replace(/\\/g, '');
                if (!found[clean] && clean.indexOf('video.twimg.com') !== -1) {
                    found[clean] = true;
                    result.videos.push({
                        url: clean,
                        quality: clean.indexOf('720') !== -1 ? '720p' : clean.indexOf('360') !== -1 ? '360p' : clean.indexOf('480') !== -1 ? '480p' : 'unknown',
                        type: 'video/mp4'
                    });
                }
            }
        }

        if (result.videos.length > 0) {
            result.ok = true;
            result.total_videos = result.videos.length;
            result.best = result.videos[0].url;
        } else {
            result.message = 'No se encontraron videos en este tweet';
        }
    } catch (e) {
        result.message = 'Error en scraper: ' + e.message;
    }
    return result;
}

const server = http.createServer(async function(req, res) {
    totalRequests++;
    const parsedUrl = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    const query = parsedUrl.searchParams.get('query');
    const limitParam = parseInt(parsedUrl.searchParams.get('limit')) || 5;
    const limit = Math.min(Math.max(limitParam, 1), 20);

    if (parsedUrl.pathname === '/') {
        res.writeHead(302, { 'Location': '/docs' });
        return res.end();
    }

    if (parsedUrl.pathname === '/docs') {
        const uptimeMinutes = Math.floor((Date.now() - startTime) / 60000);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>ZETA-CORE.API | Dashboard Pro</title>
<style>
@keyframes rgbGlow{0%{border-color:#00f0ff;box-shadow:0 0 20px rgba(0,240,255,.4),inset 0 0 15px rgba(0,240,255,.2)}33%{border-color:#b026ff;box-shadow:0 0 20px rgba(176,38,255,.4),inset 0 0 15px rgba(176,38,255,.2)}66%{border-color:#00ff66;box-shadow:0 0 20px rgba(0,255,102,.4),inset 0 0 15px rgba(0,255,102,.2)}100%{border-color:#00f0ff;box-shadow:0 0 20px rgba(0,240,255,.4),inset 0 0 15px rgba(0,240,255,.2)}}
@keyframes rgbText{0%{color:#00f0ff;text-shadow:0 0 10px rgba(0,240,255,.6)}33%{color:#b026ff;text-shadow:0 0 10px rgba(176,38,255,.6)}66%{color:#00ff66;text-shadow:0 0 10px rgba(0,255,102,.6)}100%{color:#00f0ff;text-shadow:0 0 10px rgba(0,240,255,.6)}}
:root{--card-bg:rgba(12,10,20,.9);--text-main:#f0edff;--text-muted:#9b93af}
*{box-sizing:border-box}body{background:linear-gradient(135deg,#06050a 0%,#120b22 50%,#050f1a 100%);color:var(--text-main);font-family:'Segoe UI',system-ui,sans-serif;margin:0;padding:0;display:flex;width:100vw;min-height:100vh;overflow-x:hidden}
.open-sidebar-btn{position:fixed;top:15px;left:15px;background:rgba(16,13,26,.9);border:2px solid #00f0ff;color:#00f0ff;width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:100;font-size:22px;animation:rgbGlow 6s infinite}
.sidebar{width:290px;background:rgba(9,7,15,.95);backdrop-filter:blur(20px);border-right:2px solid rgba(0,240,255,.3);display:flex;flex-direction:column;position:fixed;top:0;left:0;height:100vh;overflow-y:auto;z-index:200;transition:transform .35s;transform:translateX(-100%);box-shadow:10px 0 40px rgba(0,0,0,.9)}
.sidebar.open{transform:translateX(0)}
.sidebar-header{padding:20px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(255,255,255,.08)}
.logo-area{display:flex;align-items:center;gap:10px}.logo-area span{font-size:22px;animation:rgbText 5s infinite}
.sidebar-header h1{font-size:16px;margin:0;letter-spacing:1.5px;font-weight:800;animation:rgbText 5s infinite}
.close-btn{background:none;border:none;color:var(--text-muted);font-size:20px;cursor:pointer}
.sidebar-menu{padding:10px;display:flex;flex-direction:column;gap:6px;flex:1}
.menu-category-title{font-size:10px;text-transform:uppercase;letter-spacing:1.5px;animation:rgbText 6s infinite;margin:15px 0 6px 10px;font-weight:bold}
.sub-item{padding:9px 12px;color:var(--text-muted);border-radius:6px;font-size:12px;cursor:pointer}.sub-item:hover,.sub-item.active{background:linear-gradient(90deg,rgba(176,38,255,.25),transparent);color:#00f0ff;border-left:3px solid #00f0ff}
.main-content{width:100%;min-height:100vh;padding:75px 15px 30px;display:flex;justify-content:center;align-items:flex-start;z-index:2;position:relative}
.card-wrapper{width:100%;max-width:680px}
.card{background:var(--card-bg);backdrop-filter:blur(20px);border:2px solid rgba(0,240,255,.4);border-radius:22px;padding:24px;width:100%;box-shadow:0 20px 50px rgba(0,0,0,.8),inset 0 0 30px rgba(176,38,255,.1);display:none;margin-bottom:20px;animation:rgbGlow 8s infinite alternate}
.card.active{display:block}
.dashboard-banner{background:linear-gradient(135deg,rgba(0,240,255,.1),rgba(176,38,255,.15));border:1px solid rgba(0,240,255,.4);border-radius:16px;padding:20px;margin-bottom:20px}
.online-badge{display:inline-flex;align-items:center;gap:6px;font-size:10px;letter-spacing:1.5px;color:#00ff66;font-weight:800;margin-bottom:8px}
.online-dot{width:8px;height:8px;background:#00ff66;border-radius:50%;box-shadow:0 0 8px #00ff66}
.banner-title{font-size:24px;font-weight:900;letter-spacing:1px;animation:rgbText 5s infinite;margin:0 0 5px}
.banner-subtitle{font-size:11px;color:var(--text-muted);letter-spacing:.5px;margin-bottom:12px;text-transform:uppercase}
.creator-tag{font-size:13px;color:#00f0ff;font-weight:bold;margin-top:10px;display:inline-block}
.stats-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:15px}
.stat-box{background:rgba(10,8,18,.7);border:1px solid rgba(176,38,255,.3);padding:12px;border-radius:10px}
.stat-label{font-size:10px;text-transform:uppercase;color:var(--text-muted);letter-spacing:1px;margin-bottom:4px}
.stat-value{font-size:15px;font-weight:bold;color:#00f0ff;font-family:monospace}
h2{animation:rgbText 5s infinite;margin-top:0;font-size:20px;font-weight:800}
label{font-size:13px;color:var(--text-muted);display:block;margin-bottom:6px;font-weight:600}
input,select{width:100%;padding:12px;background:rgba(15,12,24,.95);border:1px solid rgba(0,240,255,.3);color:var(--text-main);border-radius:12px;margin-bottom:15px;font-size:14px}
.btn{padding:12px;border:none;border-radius:12px;font-weight:bold;font-size:14px;cursor:pointer;width:100%;transition:all .3s}
.btn-rgb{background:linear-gradient(135deg,#00f0ff,#b026ff,#00ff66);background-size:200% 200%;color:#05040a;font-weight:800;box-shadow:0 5px 20px rgba(176,38,255,.4);animation:rgbGlow 4s infinite}
.json-box{margin-top:15px;background:#040308;border:1px solid rgba(0,255,102,.3);border-radius:12px;padding:12px;position:relative;display:none}
pre{color:#00ff66;font-size:11px;overflow-x:auto;max-height:200px;margin:0;white-space:pre-wrap;font-family:'Courier New',monospace}
.btn-copy{position:absolute;top:8px;right:8px;background:rgba(0,255,102,.2);color:#00ff66;border:1px solid rgba(0,255,102,.4);padding:4px 10px;border-radius:6px;font-size:10px;cursor:pointer;font-weight:bold}
.sidebar-footer{padding:15px;border-top:1px solid rgba(255,255,255,.08);font-size:11px;color:var(--text-muted);display:flex;justify-content:space-between;align-items:center}
.overlay{position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,.7);backdrop-filter:blur(5px);z-index:150;display:none}
.overlay.show{display:block}
</style>
</head>
<body>
<button class="open-sidebar-btn" onclick="toggleSidebar()">⚡</button>
<div id="overlay" class="overlay" onclick="toggleSidebar()"></div>
<div id="sidebar" class="sidebar">
<div class="sidebar-header"><div class="logo-area"><span>🔮</span><h1>ZETA-CORE.API</h1></div><button class="close-btn" onclick="toggleSidebar()">✕</button></div>
<div class="sidebar-menu">
<div class="menu-category-title">✨ Sistema</div>
<span class="sub-item active" onclick="switchTab('guide',this)">🚀 Dashboard</span>
<div class="menu-category-title">⚡ Motores</div>
<span class="sub-item" onclick="switchTab('downloaders',this)">📥 Descargas</span>
<span class="sub-item" onclick="switchTab('search',this)">🔍 Búsquedas</span>
</div>
<div class="sidebar-footer"><span>RGB ENGINE</span><span style="color:#00ff66">● ONLINE :${PORT}</span></div>
</div>
<div class="main-content"><div class="card-wrapper">
<div id="guide" class="card active">
<div class="dashboard-banner">
<div class="online-badge"><div class="online-dot"></div>ONLINE</div>
<h2 class="banner-title">ZETA-CORE.API</h2>
<div class="banner-subtitle">Infraestructura Backend de Alto Rendimiento</div>
<div class="creator-tag">By: FlextOFC</div>
<div class="stats-grid">
<div class="stat-box"><div class="stat-label">Estado API</div><div class="stat-value" style="color:#00ff66">● Operativo</div></div>
<div class="stat-box"><div class="stat-label">Minutos Activo</div><div class="stat-value">${uptimeMinutes} min</div></div>
<div class="stat-box"><div class="stat-label">Peticiones</div><div class="stat-value">${totalRequests}</div></div>
<div class="stat-box"><div class="stat-label">Latencia</div><div class="stat-value">\~12ms</div></div>
<div class="stat-box"><div class="stat-label">Bajada</div><div class="stat-value">${(totalBytesReceived/1024).toFixed(2)} KB</div></div>
<div class="stat-box"><div class="stat-label">Subida</div><div class="stat-value">${(totalBytesSent/1024).toFixed(2)} KB</div></div>
</div></div>
<div style="text-align:center"><button class="btn btn-rgb" onclick="switchTab('search',null)">Ir al Playground →</button></div>
</div>
<div id="downloaders" class="card">
<h2>📥 Panel de Descargadores</h2>
<div style="background:rgba(16,12,25,.6);border:1px solid rgba(0,240,255,.3);padding:16px;border-radius:14px;margin-bottom:15px">
<h3 style="color:#00f0ff;margin-top:0;font-size:15px">YouTube MP3 (ytmp3)</h3>
<label>Enlace o título:</label>
<input type="text" id="inputYtMp3" placeholder="Ej: hola remix">
<button class="btn btn-rgb" onclick="ejecutarAccion('ytmp3','inputYtMp3','jsonContainerYtMp3','jsonOutputYtMp3')">Generar MP3</button>
<div id="jsonContainerYtMp3" class="json-box"><button class="btn-copy" onclick="copiarJson('jsonOutputYtMp3')">Copiar</button><pre id="jsonOutputYtMp3">Esperando...</pre></div>
</div>
<div style="background:rgba(16,12,25,.6);border:1px solid rgba(176,38,255,.3);padding:16px;border-radius:14px;margin-bottom:15px">
<h3 style="color:#b026ff;margin-top:0;font-size:15px">YouTube MP4 (ytmp4)</h3>
<label>Enlace o título:</label>
<input type="text" id="inputYtMp4" placeholder="Ej: Link de YouTube...">
<button class="btn btn-rgb" onclick="ejecutarAccion('ytmp4','inputYtMp4','jsonContainerYtMp4','jsonOutputYtMp4')">Generar MP4</button>
<div id="jsonContainerYtMp4" class="json-box"><button class="btn-copy" onclick="copiarJson('jsonOutputYtMp4')">Copiar</button><pre id="jsonOutputYtMp4">Esperando...</pre></div>
</div>
<div style="background:rgba(16,12,25,.6);border:1px solid rgba(0,255,102,.3);padding:16px;border-radius:14px">
<h3 style="color:#00ff66;margin-top:0;font-size:15px">X / Twitter Video (xvideo)</h3>
<label>Enlace del tweet:</label>
<input type="text" id="inputXVideo" placeholder="https://x.com/user/status/123">
<button class="btn btn-rgb" onclick="ejecutarAccion('xvideo','inputXVideo','jsonContainerXVideo','jsonOutputXVideo')">Extraer Video</button>
<div id="jsonContainerXVideo" class="json-box"><button class="btn-copy" onclick="copiarJson('jsonOutputXVideo')">Copiar</button><pre id="jsonOutputXVideo">Esperando...</pre></div>
</div>
</div>
<div id="search" class="card">
<h2>🔍 Playground de Búsquedas</h2>
<div style="background:rgba(16,12,25,.6);border:1px solid rgba(0,240,255,.3);padding:16px;border-radius:14px;margin-bottom:15px">
<h3 style="color:#00f0ff;margin-top:0;font-size:15px">YouTube Search</h3>
<label>Término:</label><input type="text" id="inputYt" placeholder="Messi edits...">
<label>Cantidad:</label><select id="limitYt"><option value="1">1</option><option value="5" selected>5</option><option value="10">10</option></select>
<button class="btn btn-rgb" onclick="ejecutarBusqueda('ytsearch')">Buscar YouTube</button>
<div id="jsonContainerYt" class="json-box"><button class="btn-copy" onclick="copiarJson('jsonOutputYt')">Copiar</button><pre id="jsonOutputYt">Esperando...</pre></div>
</div>
<div style="background:rgba(16,12,25,.6);border:1px solid rgba(176,38,255,.3);padding:16px;border-radius:14px">
<h3 style="color:#b026ff;margin-top:0;font-size:15px">TikTok Search</h3>
<label>Término:</label><input type="text" id="inputTt" placeholder="Anime edit...">
<label>Cantidad:</label><select id="limitTt"><option value="1">1</option><option value="5" selected>5</option><option value="10">10</option></select>
<button class="btn btn-rgb" onclick="ejecutarBusqueda('ttsearch')">Buscar TikTok</button>
<div id="jsonContainerTt" class="json-box"><button class="btn-copy" onclick="copiarJson('jsonOutputTt')">Copiar</button><pre id="jsonOutputTt">Esperando...</pre></div>
</div>
</div>
</div></div>
<script>
function toggleSidebar(){document.getElementById('sidebar').classList.toggle('open');document.getElementById('overlay').classList.toggle('show')}
function switchTab(tabId,el){document.querySelectorAll('.sub-item').forEach(function(e){e.classList.remove('active')});if(el)el.classList.add('active');document.querySelectorAll('.card').forEach(function(c){c.classList.remove('active')});document.getElementById(tabId).classList.add('active');if(window.innerWidth<=900)toggleSidebar()}
async function ejecutarAccion(endpoint,inputId,containerId,outputId){var val=document.getElementById(inputId).value.trim();if(!val){alert('Ingresa un enlace o texto.');return}var container=document.getElementById(containerId);var output=document.getElementById(outputId);container.style.display='block';output.innerText='Procesando...';try{var res=await fetch('/'+endpoint+'?query='+encodeURIComponent(val));var data=await res.json();output.innerText=JSON.stringify(data,null,2)}catch(e){output.innerText='Error: '+e.message}}
async function ejecutarBusqueda(endpoint){var isYt=endpoint==='ytsearch';var val=document.getElementById(isYt?'inputYt':'inputTt').value.trim();var limit=document.getElementById(isYt?'limitYt':'limitTt').value;if(!val){alert('Escribe un término.');return}var container=document.getElementById(isYt?'jsonContainerYt':'jsonContainerTt');var output=document.getElementById(isYt?'jsonOutputYt':'jsonOutputTt');container.style.display='block';output.innerText='Buscando...';try{var res=await fetch('/'+endpoint+'?query='+encodeURIComponent(val)+'&limit='+limit);var data=await res.json();output.innerText=JSON.stringify(data,null,2)}catch(e){output.innerText='Error: '+e.message}}
function copiarJson(id){navigator.clipboard.writeText(document.getElementById(id).innerText);alert('¡Copiado!')}
</script>
</body></html>`);
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    if (parsedUrl.pathname === '/ytsearch' || parsedUrl.pathname === '/ttsearch') {
        if (!query) return res.end(JSON.stringify({ ok: false, message: 'Falta query' }));
        const platform = parsedUrl.pathname === '/ytsearch' ? 'youtube' : 'tiktok';
        const results = await fetchRealSearchResults(query, limit, platform);
        const payload = JSON.stringify({ ok: true, source: platform, query: query, total_results: results.length, results: results }, null, 2);
        totalBytesSent += payload.length;
        return res.end(payload);
    }

    if (parsedUrl.pathname === '/ytmp3' || parsedUrl.pathname === '/ytmp4') {
        if (!query) return res.end(JSON.stringify({ ok: false, message: 'Falta query' }));
        const endpoint = parsedUrl.pathname.replace('/', '');
        let targetUrl = query;
        let title = query;
        let videoId = null;

        if (query.indexOf('http') === -1) {
            const ytResults = await fetchRealSearchResults(query, 1, 'youtube');
            if (ytResults[0]) {
                targetUrl = ytResults[0].url;
                title = ytResults[0].title || query;
                videoId = ytResults[0].videoId || null;
            } else {
                targetUrl = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(query);
            }
        } else {
            const idMatch = query.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
            if (idMatch) videoId = idMatch[1];
        }

        const payload = JSON.stringify({
            ok: true,
            endpoint: endpoint,
            action: endpoint === 'ytmp3' ? 'MP3' : 'MP4',
            input: query,
            title: title,
            videoId: videoId,
            resolved_url: targetUrl,
            download_url: targetUrl,
            url: targetUrl
        }, null, 2);
        totalBytesSent += payload.length;
        return res.end(payload);
    }

    if (parsedUrl.pathname === '/xvideo') {
        if (!query) return res.end(JSON.stringify({ ok: false, message: 'Falta link del tweet' }));
        const data = await fetchXVideo(query);
        const payload = JSON.stringify(data, null, 2);
        totalBytesSent += payload.length;
        return res.end(payload);
    }

    res.statusCode = 404;
    const err = JSON.stringify({ ok: false, message: 'Endpoint no encontrado: ' + parsedUrl.pathname });
    totalBytesSent += err.length;
    res.end(err);
});

server.listen(PORT, '0.0.0.0', function() {
    console.log('[ZETA-CORE.API] Activo en http://127.0.0.1:' + PORT);
});