import http from 'http';
import { URL } from 'url';
import axios from 'axios';

const PORT = process.env.PORT || 3033;
const API_KEY = 'dvyer578604746817';
const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36';

const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const query = parsedUrl.searchParams.get('query');
    const limitParam = parseInt(parsedUrl.searchParams.get('limit')) || 5;
    const limit = Math.min(Math.max(limitParam, 1), 10);

    if (parsedUrl.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(`
            <!DOCTYPE html>
            <html lang="es">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>ZETA-CORE | API Dashboard</title>
                <style>
                    :root {
                        --bg-main: #07060a;
                        --bg-sidebar: #0d0b11;
                        --card-bg: #121017;
                        --border-color: #1f1b2c;
                        --neon-blue: #00f0ff;
                        --neon-orange: #ff9900;
                        --neon-pink: #ff007f;
                        --text-main: #ffffff;
                        --text-muted: #8b88a5;
                    }
                    body {
                        background-color: var(--bg-main);
                        color: var(--text-main);
                        font-family: 'Segoe UI', system-ui, sans-serif;
                        margin: 0;
                        display: flex;
                        min-height: 100vh;
                    }
                    .sidebar {
                        width: 260px;
                        background-color: var(--bg-sidebar);
                        border-right: 1px solid var(--border-color);
                        display: flex;
                        flex-direction: column;
                        position: fixed;
                        height: 100vh;
                        overflow-y: auto;
                    }
                    .sidebar-header {
                        padding: 20px;
                        display: flex;
                        align-items: center;
                        gap: 12px;
                        border-bottom: 1px solid var(--border-color);
                    }
                    .sidebar-header img {
                        width: 40px;
                        height: 40px;
                        border-radius: 50%;
                        object-fit: cover;
                    }
                    .sidebar-header h1 {
                        font-size: 16px;
                        color: var(--neon-blue);
                        margin: 0;
                    }
                    .sidebar-menu {
                        padding: 15px;
                        display: flex;
                        flex-direction: column;
                        gap: 5px;
                    }
                    .menu-category {
                        font-size: 11px;
                        text-transform: uppercase;
                        letter-spacing: 1px;
                        color: var(--text-muted);
                        margin: 15px 0 5px 5px;
                    }
                    .menu-item {
                        display: flex;
                        align-items: center;
                        gap: 12px;
                        padding: 10px 12px;
                        color: var(--text-muted);
                        text-decoration: none;
                        border-radius: 8px;
                        font-size: 14px;
                        transition: 0.2s;
                    }
                    .menu-item:hover, .menu-item.active {
                        background-color: #1c1729;
                        color: var(--text-main);
                    }
                    .main-content {
                        margin-left: 260px;
                        flex: 1;
                        padding: 30px;
                        box-sizing: border-box;
                    }
                    .card {
                        background: var(--card-bg);
                        border: 1px solid var(--border-color);
                        border-radius: 16px;
                        padding: 25px;
                        max-width: 600px;
                        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
                    }
                    h2 {
                        color: var(--neon-blue);
                        margin-top: 0;
                        font-size: 20px;
                    }
                    label {
                        font-size: 13px;
                        color: var(--text-muted);
                        display: block;
                        margin-bottom: 6px;
                    }
                    input, select {
                        width: 100%;
                        padding: 12px;
                        background: #171420;
                        border: 1px solid var(--border-color);
                        color: var(--text-main);
                        border-radius: 8px;
                        margin-bottom: 15px;
                        font-size: 14px;
                        box-sizing: border-box;
                    }
                    input:focus, select:focus {
                        outline: none;
                        border-color: var(--neon-blue);
                    }
                    .btn-group {
                        display: grid;
                        grid-template-columns: 1fr 1fr;
                        gap: 10px;
                    }
                    .btn {
                        padding: 12px;
                        border: none;
                        border-radius: 8px;
                        font-weight: bold;
                        font-size: 14px;
                        cursor: pointer;
                        transition: opacity 0.2s, transform 0.1s;
                    }
                    .btn:hover { opacity: 0.9; transform: scale(1.01); }
                    .btn-ttsearch { background-color: var(--neon-pink); color: #fff; grid-column: span 2; }
                    .btn-ytmp3 { background-color: var(--neon-blue); color: #000; }
                    .btn-ytmp4 { background-color: var(--neon-orange); color: #000; }
                </style>
            </head>
            <body>
                <div class="sidebar">
                    <div class="sidebar-header">
                        <img src="https://i.imgur.com/74aX2Q0.png" alt="Avatar">
                        <h1>ZETA-CORE API</h1>
                    </div>
                    <div class="sidebar-menu">
                        <a href="#" class="menu-item">📄 Términos y Condiciones</a>
                        <a href="#" class="menu-item">🛒 Tienda</a>
                        <a href="#" class="menu-item">🎫 Abrir Ticket</a>

                        <div class="menu-category">Categorías</div>
                        <a href="#" class="menu-item active">📥 Descargadores</a>
                        <a href="#" class="menu-item">🖼️ StickerLy</a>
                        <a href="#" class="menu-item">🔍 Búsquedas</a>
                        <a href="#" class="menu-item">🛠️ Utilidades</a>
                        <a href="#" class="menu-item">🕵️ Stalking</a>
                        <a href="#" class="menu-item">✨ Generadores</a>
                        <a href="#" class="menu-item">⛩️ Anime</a>
                        <a href="#" class="menu-item">🔥 NSFW +18</a>
                        <a href="#" class="menu-item">💻 IA</a>
                        <a href="#" class="menu-item">💬 WhatsApp</a>

                        <div class="menu-category">Cuenta</div>
                        <a href="#" class="menu-item">🚪 Cerrar sesión</a>
                    </div>
                </div>

                <div class="main-content">
                    <div class="card">
                        <h2>⚡ Panel de Pruebas</h2>
                        
                        <label>Enlace o Término de Búsqueda:</label>
                        <input type="text" id="userInput" placeholder="Ej: Messi edits o link de TikTok...">

                        <label>Límite (Para búsquedas):</label>
                        <select id="limitSelect">
                            <option value="1">1</option>
                            <option value="3">3</option>
                            <option value="5" selected>5</option>
                            <option value="10">10</option>
                        </select>

                        <div class="btn-group">
                            <button class="btn btn-ttsearch" onclick="ejecutar('ttsearch')">TikTok Search (API)</button>
                            <button class="btn btn-ytmp3" onclick="ejecutar('ytmp3')">YouTube MP3</button>
                            <button class="btn btn-ytmp4" onclick="ejecutar('ytmp4')">YouTube MP4</button>
                        </div>
                    </div>
                </div>

                <script>
                    function ejecutar(endpoint) {
                        const val = document.getElementById('userInput').value.trim();
                        const limit = document.getElementById('limitSelect').value;
                        if(!val) {
                            alert('Por favor, ingresa un texto o enlace.');
                            return;
                        }
                        window.location.href = '/' + endpoint + '?query=' + encodeURIComponent(val) + '&limit=' + limit;
                    }
                </script>
            </body>
            </html>
        `);
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    if (parsedUrl.pathname === '/ttsearch') {
        if (!query) return res.end(JSON.stringify({ ok: false, message: "Falta el parámetro query" }));

        try {
            const apiUrl = `https://dv-yer-api.online/tiktok/search?q=${encodeURIComponent(query)}&limit=${limit}&apikey=${API_KEY}`;
            const apiRes = await axios.get(apiUrl, {
                headers: { 'User-Agent': UA },
                timeout: 15000
            });

            if (apiRes.data && apiRes.data.ok && Array.isArray(apiRes.data.results)) {
                const results = apiRes.data.results.slice(0, limit).map((item, index) => ({
                    id: index + 1,
                    title: item.title || `Resultado #${index + 1} para "${query}" en TikTok`,
                    url: item.stream_url || item.download_url || item.links?.stream || item.links?.download || `https://tiktok.com/video/result-${index + 1}`
                }));

                return res.end(JSON.stringify({
                    ok: true,
                    action: "tiktok_search",
                    keyword: query,
                    total_results: results.length,
                    results: results
                }, null, 2));
            } else {
                throw new Error("La API externa no devolvió resultados válidos.");
            }
        } catch (error) {
            return res.end(JSON.stringify({
                ok: false,
                action: "tiktok_search",
                keyword: query,
                message: `Error: ${error.message}`
            }, null, 2));
        }
    }

    if (parsedUrl.pathname === '/ytmp3' || parsedUrl.pathname === '/ytmp4') {
        if (!query) return res.end(JSON.stringify({ ok: false, message: "Falta el parámetro query" }));
        return res.end(JSON.stringify({ ok: true, action: parsedUrl.pathname.replace('/', ''), input: query, download_url: "https://example.com/media.mp4" }));
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, message: "Endpoint no encontrado" }));
});

server.listen(PORT, () => {
    console.log(`[ZETA-CORE] Servidor con interfaz moderna iniciado en el puerto ${PORT}`);
});
