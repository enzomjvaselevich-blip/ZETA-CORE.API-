#!/usr/bin/env node
// ZETA-CORE Relay: corre en tu PC/celu y deja que la API descargue YouTube
// desde tu IP de casa (residencial), que no esta bloqueada por googlevideo.
//
// Uso:
//   RELAY_KEY=una-clave-secreta node relay.js
//   (si no pones RELAY_KEY, se genera una sola vez y se muestra al arrancar)
//
// Endpoints (todos exigen el header x-relay-key o ?key=):
//   GET /ping                                  -> salud para la API
//   GET /descarga?video=<videoId>&kind=audio|video -> streamea el archivo
//
// El tunel (cloudflared/ngrok) se abre aparte y reconecta solo; la API lo
// detecta con su health check de 60s sin tocar codigo.

'use strict';
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');

const PUERTO = Number(process.env.RELAY_PORT) || 8080;
let CLAVE = (process.env.RELAY_KEY || '').trim();
const CLAVE_GENERADA = !CLAVE;
if (!CLAVE) CLAVE = 'zeta-relay-' + crypto.randomBytes(9).toString('base64url');

const UA_ANDROID = 'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip';
const UA_WEB = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const API_KEY_INNERTUBE = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

// Cache de formatos resueltos: los enlaces de googlevideo duran ~6h.
const formatosCache = new Map();
const TTL_FORMATO = 30 * 60 * 1000;

function claveValida(recibida) {
  const a = crypto.createHash('sha256').update(String(recibida || '')).digest();
  const b = crypto.createHash('sha256').update(CLAVE).digest();
  return crypto.timingSafeEqual(a, b);
}

function responderJson(res, status, obj) {
  const cuerpo = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(cuerpo);
}

// POST JSON a youtubei/v1/player y devolver el JSON parseado.
function pedirJson(destino, cuerpo, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(destino);
    const data = Buffer.from(JSON.stringify(cuerpo));
    const pedido = https.request(u, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': data.length },
      timeout: timeoutMs,
    }, (rta) => {
      const trozos = [];
      rta.on('data', (t) => trozos.push(t));
      rta.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(trozos).toString('utf8'))); }
        catch (e) { reject(new Error('JSON invalido del player')); }
      });
      rta.on('error', reject);
    });
    pedido.on('timeout', () => { pedido.destroy(new Error('timeout del player')); });
    pedido.on('error', reject);
    pedido.end(data);
  });
}

// Elige el formato segun kind: audio -> itag 140 (m4a); video -> itag 22 (720p
// con audio), luego 18 (360p con audio), luego el mejor mp4 adaptativo.
function elegirFormato(conUrl, kind) {
  if (kind === 'audio') {
    return conUrl.find((f) => f.itag === 140)
      || conUrl.filter((f) => String(f.mimeType || '').startsWith('audio/'))
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0]
      || null;
  }
  const mp4 = conUrl.filter((f) => String(f.mimeType || '').startsWith('video/mp4'));
  return conUrl.find((f) => f.itag === 22)
    || conUrl.find((f) => f.itag === 18)
    || mp4.sort((a, b) => (b.height || 0) - (a.height || 0))[0]
    || null;
}

// Resuelve el video: ANDROID (sin cookie, ideal desde IP residencial), luego
// ANDROID_VR, luego WEB con la cookie de la API (si vino en x-yt-cookie).
// Devuelve el formato elegido o null.
async function resolver(videoId, kind, cookie) {
  const claveCache = videoId + '|' + kind + '|' + (cookie ? 'ck' : 'nock');
  const cacheado = formatosCache.get(claveCache);
  if (cacheado && cacheado.expiresAt > Date.now()) return cacheado.formato;
  const clientes = [
    { clientName: 'ANDROID', clientVersion: '21.03.36', androidSdkVersion: 36, hl: 'es', ua: 'com.google.android.youtube/21.03.36(Linux; U; Android 16; en_US; SM-S908E Build/TP1A.220624.014) gzip', xcn: '3', cookie: false },
    { clientName: 'ANDROID_VR', clientVersion: '1.65.10', androidSdkVersion: 32, deviceMake: 'Oculus', deviceModel: 'Quest 3', hl: 'es', ua: 'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip', xcn: '28', cookie: false },
    { clientName: 'WEB', clientVersion: '2.20260623.01.00', hl: 'es', ua: UA_WEB, xcn: '1', cookie: true },
  ];
  const razones = [];
  for (const cliente of clientes) {
    if (cliente.cookie && !cookie) continue;
    try {
      const headers = { 'User-Agent': cliente.ua, 'X-YouTube-Client-Name': cliente.xcn, 'X-YouTube-Client-Version': cliente.clientVersion, 'Accept-Language': 'es-ES,es;q=0.9' };
      if (cliente.cookie) headers.Cookie = cookie;
      const datos = await pedirJson(
        'https://www.youtube.com/youtubei/v1/player?key=' + API_KEY_INNERTUBE + '&prettyPrint=false',
        { context: { client: { clientName: cliente.clientName, clientVersion: cliente.clientVersion, androidSdkVersion: cliente.androidSdkVersion, deviceMake: cliente.deviceMake, deviceModel: cliente.deviceModel, hl: cliente.hl } }, videoId, contentCheckOk: true, racyCheckOk: true },
        headers,
        10000,
      );
      if (!datos || (datos.playabilityStatus && datos.playabilityStatus.status !== 'OK')) {
        razones.push(cliente.clientName + '=' + ((datos && datos.playabilityStatus && datos.playabilityStatus.status) || 'sin respuesta'));
        continue;
      }
      const sd = datos.streamingData || {};
      const formatos = [].concat(sd.adaptiveFormats || [], sd.formats || []);
      const conUrl = formatos.filter((f) => f && f.url);
      if (!conUrl.length) continue;
      const elegido = elegirFormato(conUrl, kind);
      if (elegido) {
        formatosCache.set(claveCache, { formato: elegido, expiresAt: Date.now() + TTL_FORMATO });
        if (formatosCache.size > 100) formatosCache.delete(formatosCache.keys().next().value);
        return elegido;
      }
    } catch (e) {
      razones.push(cliente.clientName + '=EXC:' + String(e && e.message || e).slice(0, 60));
    }
  }
  console.log('[relay] no pude resolver ' + videoId + ' (' + kind + '): ' + razones.join(' | '));
  return null;
}

const servidor = http.createServer((req, res) => {
  let u;
  try { u = new URL(req.url, 'http://localhost'); } catch { return responderJson(res, 400, { ok: false, message: 'URL invalida.' }); }
  const clave = req.headers['x-relay-key'] || u.searchParams.get('key') || '';
  if (!claveValida(clave)) return responderJson(res, 401, { ok: false, message: 'Clave de relay invalida.' });

  if (u.pathname === '/ping') {
    return responderJson(res, 200, { ok: true, relay: 'ZETA-CORE relay', uptime_s: Math.round(process.uptime()) });
  }

  if (u.pathname === '/descarga') {
    const videoId = u.searchParams.get('video') || '';
    const kind = u.searchParams.get('kind') === 'audio' ? 'audio' : 'video';
    const cookie = String(req.headers['x-yt-cookie'] || '');
    if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) return responderJson(res, 400, { ok: false, message: 'videoId invalido.' });

    resolver(videoId, kind, cookie).then((formato) => {
      if (!formato) return responderJson(res, 502, { ok: false, message: 'El relay no pudo resolver el video desde esta IP.' });
      const cabeceras = { 'User-Agent': UA_ANDROID, 'Accept': '*/*' };
      if (req.headers.range) cabeceras.Range = req.headers.range;
      const pedido = https.request(formato.url, { method: 'GET', headers: cabeceras }, (rta) => {
        if (rta.statusCode !== 200 && rta.statusCode !== 206) {
          rta.resume();
          formatosCache.delete(videoId + '|' + kind + '|' + (cookie ? 'ck' : 'nock'));
          return responderJson(res, 502, { ok: false, message: 'googlevideo rechazo la descarga desde tu IP (HTTP ' + rta.statusCode + ').' });
        }
        const sal = {
          'Content-Type': kind === 'audio' ? 'audio/mp4' : 'video/mp4',
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
          'Content-Disposition': 'inline; filename="' + videoId + '.' + (kind === 'audio' ? 'm4a' : 'mp4') + '"',
        };
        if (rta.headers['content-length']) sal['Content-Length'] = rta.headers['content-length'];
        if (rta.headers['content-range']) sal['Content-Range'] = rta.headers['content-range'];
        res.writeHead(rta.statusCode, sal);
        rta.pipe(res);
      });
      req.on('close', () => { if (!res.writableEnded) pedido.destroy(); });
      pedido.on('timeout', () => { pedido.destroy(new Error('timeout de googlevideo')); });
      pedido.on('error', (e) => {
        if (!res.headersSent) responderJson(res, 502, { ok: false, message: 'Error bajando desde googlevideo: ' + String(e && e.message || e).slice(0, 100) });
      });
      pedido.end();
    }).catch((e) => responderJson(res, 500, { ok: false, message: 'Error interno del relay: ' + String(e && e.message || e).slice(0, 150) }));
    return;
  }

  responderJson(res, 404, { ok: false, message: 'Ruta no encontrada en el relay.' });
});

servidor.listen(PUERTO, () => {
  console.log('');
  console.log('==============================================');
  console.log('  ZETA-CORE RELAY corriendo en el puerto ' + PUERTO);
  console.log('----------------------------------------------');
  if (CLAVE_GENERADA) {
    console.log('  CLAVE generada (ponela en Vercel como RELAY_KEY):');
    console.log('  ' + CLAVE);
  } else {
    console.log('  CLAVE: la que pusiste en RELAY_KEY');
  }
  console.log('  Probalo en local:  http://localhost:' + PUERTO + '/ping');
  console.log('==============================================');
  console.log('');
  console.log('Siguiente paso: abrir el tunel hacia este puerto');
  console.log('  cloudflared tunnel --url http://localhost:' + PUERTO);
  console.log('y pegar la URL https://...trycloudflare.com en Vercel como RELAY_URL');
  console.log('');
});
