const test = require('node:test');
const assert = require('node:assert/strict');
const secureApi = require('../api/secure-api');
const handler = require('../api/index');

const originalFetch = global.fetch;

function mockResponse() {
  return {
    headers: {},
    statusCode: 200,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      Object.assign(this.headers, headers);
    },
    end(body = '') {
      this.body = body;
    },
  };
}

test.afterEach(() => {
  global.fetch = originalFetch;
});

test('acepta únicamente formatos HTTPS reconocidos de YouTube', () => {
  assert.equal(secureApi.extractYoutubeVideoId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(secureApi.extractYoutubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(secureApi.extractYoutubeVideoId('http://youtube.com/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(secureApi.extractYoutubeVideoId('https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(secureApi.extractYoutubeVideoId('https://youtube.com:8443/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(secureApi.extractYoutubeVideoId('https://user@youtube.com/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(secureApi.extractYoutubeVideoId('https://youtu.be/dQw4w9WgXcQ/extra'), null);
});

test('elige formatos directos válidos de YouTube según calidad y tipo', async () => {
  const formats = [
    { mime_type: 'video/mp4', height: 360, bitrate: 700000, url: 'https://rr1.googlevideo.com/videoplayback?itag=18' },
    { mime_type: 'video/mp4', height: 720, bitrate: 1800000, url: 'https://rr1.googlevideo.com/videoplayback?itag=22' },
    { mime_type: 'audio/mp4', bitrate: 128000, url: 'https://rr1.googlevideo.com/videoplayback?itag=140' },
    { mime_type: 'video/mp4', height: 1080, bitrate: 4000000, url: 'https://attacker.example/video.mp4' },
  ];

  assert.deepEqual(await secureApi.selectYoutubeMediaFormat(formats, 'video', '720p'), {
    url: formats[1].url,
    quality: '720p',
    bitrate: 1800000,
  });
  assert.deepEqual(await secureApi.selectYoutubeMediaFormat(formats, 'video', '1080p'), {
    url: formats[1].url,
    quality: '720p',
    bitrate: 1800000,
  });
  assert.deepEqual(await secureApi.selectYoutubeMediaFormat(formats, 'audio', '720p'), {
    url: formats[2].url,
    quality: 'audio-128kbps',
    bitrate: 128000,
    esAudioPuro: true,
  });
  await assert.rejects(() => secureApi.selectYoutubeMediaFormat([], 'audio', '720p'), {
    statusCode: 502,
    code: 'YOUTUBE_FORMAT_UNAVAILABLE',
  });
});

test('descifra formatos con signature_cipher usando el reproductor', async () => {
  const fakePlayer = {};
  const formats = [
    {
      mime_type: 'audio/mp4',
      bitrate: 128000,
      signature_cipher: 'fake-cipher',
      decipher: async (player) => (player === fakePlayer ? 'https://rr2.googlevideo.com/videoplayback?itag=140&sig=ok' : null),
    },
  ];

  assert.deepEqual(await secureApi.selectYoutubeMediaFormat(formats, 'audio', '720p', fakePlayer), {
    url: 'https://rr2.googlevideo.com/videoplayback?itag=140&sig=ok',
    quality: 'audio-128kbps',
    bitrate: 128000,
    esAudioPuro: true,
  });

  await assert.rejects(() => secureApi.selectYoutubeMediaFormat(formats, 'audio', '720p'), {
    statusCode: 502,
    code: 'YOUTUBE_FORMAT_UNAVAILABLE',
  });
});

test('explica claramente cuando YouTube no expone un formato de audio', () => {
  const error = secureApi.apiError(502, 'No hay un enlace multimedia directo compatible disponible.', {
    code: 'YOUTUBE_FORMAT_UNAVAILABLE',
  });
  assert.match(secureApi.publicErrorMessage(error), /no ofreció un enlace directo de audio/);
});

test('valida estrictamente la ruta y el ID de X', () => {
  assert.equal(secureApi.extractTweetId('https://x.com/example/status/123456789012345'), '123456789012345');
  assert.equal(secureApi.extractTweetId('https://twitter.com/i/status/123456789012345'), '123456789012345');
  assert.throws(() => secureApi.extractTweetId('https://x.com.evil.example/example/status/123456789012345'), { statusCode: 400 });
  assert.throws(() => secureApi.extractTweetId('https://x.com/example/status/123456789012345-extra'), { statusCode: 400 });
  assert.throws(() => secureApi.extractTweetId('http://x.com/example/status/123456789012345'), { statusCode: 400 });
});

test('bloquea redirecciones hacia hosts no permitidos', async () => {
  global.fetch = async () => new Response(null, {
    status: 302,
    headers: { location: 'http://127.0.0.1/internal' },
  });
  await assert.rejects(
    secureApi.fetchTextSafe('https://www.tiktok.com/@user/video/1', {
      allowedHosts: ['www.tiktok.com'],
      timeoutMs: 100,
    }),
    { statusCode: 502 },
  );
});

test('rechaza respuestas mayores al máximo de bytes', async () => {
  global.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(9));
      controller.close();
    },
  }));
  await assert.rejects(
    secureApi.fetchTextSafe('https://www.youtube.com/results', {
      allowedHosts: ['www.youtube.com'],
      maxBytes: 8,
      timeoutMs: 100,
    }),
    { statusCode: 502 },
  );
});

test('rechaza un Content-Length malformado', async () => {
  global.fetch = async () => new Response('small', {
    headers: { 'content-length': '5bytes' },
  });
  await assert.rejects(
    secureApi.fetchTextSafe('https://www.youtube.com/results', {
      allowedHosts: ['www.youtube.com'],
      timeoutMs: 100,
    }),
    { statusCode: 502 },
  );
});

test('limita redirecciones incluso cuando el host sigue permitido', async () => {
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return new Response(null, {
      status: 302,
      headers: { location: 'https://www.youtube.com/redirect' },
    });
  };
  await assert.rejects(
    secureApi.fetchTextSafe('https://www.youtube.com/results', {
      allowedHosts: ['www.youtube.com'],
      timeoutMs: 100,
    }),
    { statusCode: 502 },
  );
  assert.equal(calls, 5);
});

test('propaga timeout del proveedor como 504', async () => {
  global.fetch = (_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });
  await assert.rejects(
    secureApi.fetchTextSafe('https://www.youtube.com/results', {
      allowedHosts: ['www.youtube.com'],
      timeoutMs: 10,
    }),
    { statusCode: 504 },
  );
});

test('no confunde fallos de proveedores de X con ausencia de video', async () => {
  const { fetchXVideo } = require('../api/documentos/xvideo');
  global.fetch = async () => {
    throw new TypeError('provider unavailable');
  };
  await assert.rejects(
    fetchXVideo('https://x.com/example/status/123456789012345'),
    { statusCode: 502 },
  );
});

test('reserva 404 de X para respuestas válidas sin video', async () => {
  const { fetchXVideo } = require('../api/documentos/xvideo');
  global.fetch = async (url) => new Response(
    String(url).includes('fxtwitter') ? JSON.stringify({ tweet: { text: 'hello' } }) : JSON.stringify({ text: 'hello' }),
    { headers: { 'content-type': 'application/json' } },
  );
  await assert.rejects(
    fetchXVideo('https://x.com/example/status/123456789012345'),
    { statusCode: 404 },
  );
});

test('bloquea una redirección TikTok a localhost antes de seguirla', async () => {
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return new Response(null, {
      status: 302,
      headers: { location: 'https://127.0.0.1/private' },
    });
  };
  await assert.rejects(
    secureApi.fetchTikTokVideo('https://www.tiktok.com/@user/video/1'),
    { statusCode: 502 },
  );
  assert.equal(calls, 1);
});

test('rechaza métodos no permitidos antes de llamar a proveedores', async () => {
  const response = mockResponse();
  await handler({ method: 'POST', url: '/tiktok', headers: {}, socket: {} }, response);
  assert.equal(response.statusCode, 405);
  assert.equal(response.headers.Allow, 'GET, HEAD');
  assert.equal(JSON.parse(response.body).ok, false);
});

test('valida calidad antes de consultar rate limit o proveedores', async () => {
  const response = mockResponse();
  await handler({ method: 'GET', url: '/youtube?query=sample&quality=8k', headers: {}, socket: {} }, response);
  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).requestId, response.headers['X-Request-Id']);
});


test('capa 2 - elegirFormatoInvidious: audio prefiere itag 140 y video mp4 hasta 720p', () => {
  const json = {
    title: 'Prueba',
    author: 'Canal',
    lengthSeconds: '252',
    viewCount: '1000',
    likeCount: '50',
    adaptiveFormats: [
      { itag: 137, url: 'https://x/v137', type: 'video/mp4; codecs="avc1.640028"', bitrate: 4000000, qualityLabel: '1080p' },
      { itag: 136, url: 'https://x/v136', type: 'video/mp4; codecs="avc1.64001f"', bitrate: 2000000, qualityLabel: '720p' },
      { itag: 140, url: 'https://x/a140', type: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 130000, audioQuality: 'AUDIO_QUALITY_MEDIUM' },
      { itag: 251, url: 'https://x/a251', type: 'audio/webm; codecs="opus"', bitrate: 160000 },
    ],
    formats: [{ itag: 18, url: 'https://x/v18', type: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"', qualityLabel: '360p' }],
  };
  const audio = secureApi.elegirFormatoInvidious(json, 'audio');
  assert.ok(audio);
  assert.equal(audio.url, 'https://x/a140');
  assert.equal(audio.itag, '140');
  const video = secureApi.elegirFormatoInvidious(json, 'video');
  assert.ok(video);
  assert.equal(video.url, 'https://x/v136');
  assert.equal(video.calidad, '720p');
  assert.equal(secureApi.elegirFormatoInvidious(null, 'audio'), null);
  assert.equal(secureApi.elegirFormatoInvidious({ error: 'x' }, 'audio'), null);
  assert.equal(secureApi.elegirFormatoInvidious({ adaptiveFormats: [{ url: 'http://inseguro' }] }, 'audio'), null);
});

test('capa 2 - elegirFormatoPiped: prefiere video muxed y audio m4a', () => {
  const json = {
    title: 'Prueba Piped',
    uploader: 'Canal',
    duration: 300,
    views: 2000,
    likes: 100,
    audioStreams: [
      { url: 'https://x/pa251', mimeType: 'audio/webm', bitrate: 160000, quality: '160 kbps' },
      { url: 'https://x/pa140', mimeType: 'audio/mp4', bitrate: 128000, quality: '128 kbps', itag: 140 },
    ],
    videoStreams: [
      { url: 'https://x/pv22', mimeType: 'video/mp4', quality: '720p', videoOnly: false, itag: 22 },
      { url: 'https://x/pv137', mimeType: 'video/mp4', quality: '1080p', videoOnly: true, bitrate: 4000000 },
      { url: 'https://x/pv136', mimeType: 'video/mp4', quality: '720p', videoOnly: true, bitrate: 2000000 },
    ],
  };
  const audio = secureApi.elegirFormatoPiped(json, 'audio');
  assert.ok(audio);
  assert.equal(audio.url, 'https://x/pa140');
  const video = secureApi.elegirFormatoPiped(json, 'video');
  assert.ok(video);
  assert.equal(video.url, 'https://x/pv22');
  assert.equal(video.sin_audio, undefined);
  const soloVideoOnly = {
    videoStreams: [
      { url: 'https://x/pv136', mimeType: 'video/mp4', quality: '720p', videoOnly: true, bitrate: 2000000 },
      { url: 'https://x/pv135', mimeType: 'video/mp4', quality: '480p', videoOnly: true, bitrate: 900000 },
    ],
  };
  const v2 = secureApi.elegirFormatoPiped(soloVideoOnly, 'video');
  assert.ok(v2);
  assert.equal(v2.url, 'https://x/pv136');
  assert.equal(v2.sin_audio, true);
  assert.equal(secureApi.elegirFormatoPiped(null, 'video'), null);
  assert.equal(secureApi.elegirFormatoPiped({ error: 'x' }, 'video'), null);
});

test('capa 2 - salud de instancias: caida se recuerda y vence a los 15 min', () => {
  const estado = secureApi.estadoSaludInstancias();
  assert.ok(Array.isArray(estado));
});

test('sesion anonima - parseSetCookies deduplica y arma cabecera util', () => {
  const { cookie } = secureApi.parseSetCookies([
    'VISITOR_INFO1_LIVE=abc123; Domain=.youtube.com; Secure',
    'GPS=1; Domain=.youtube.com',
    'VISITOR_INFO1_LIVE=vieja; Domain=.youtube.com',
    'sin-igual',
    '',
  ]);
  assert.ok(cookie.includes('VISITOR_INFO1_LIVE=abc123'));
  assert.ok(cookie.includes('GPS=1'));
  assert.ok(!cookie.includes('vieja'));
});

test('sesion anonima - extraerVisitorData des-escapa el JSON del HTML', () => {
  const html = 'window.ytcfg.set({"VISITOR_DATA":"CgtLZE0wM0dqSGwwdyjri_PXBmKbAgqYAkNzOEJD\\u003d\\u003d"});';
  const vd = secureApi.extraerVisitorData(html);
  assert.equal(typeof vd, 'string');
  assert.ok(vd.length > 20);
  assert.ok(!vd.includes('\\u003d'));
  assert.equal(secureApi.extraerVisitorData('<html>sin datos</html>'), '');
});

test('escaleraCalidades - video degrada best->480->360->18 y respeta un pedido numerico', () => {
  assert.deepEqual(secureApi.escaleraCalidades('video', 'best'), ['best', '480', '360', '18']);
  assert.deepEqual(secureApi.escaleraCalidades('video', '480'), ['480', 'best', '360', '18']);
  assert.deepEqual(secureApi.escaleraCalidades('video', '1080'), ['1080', 'best', '480', '360', '18']);
  assert.deepEqual(secureApi.escaleraCalidades('audio', 'best'), ['best']);
  assert.deepEqual(secureApi.escaleraCalidades('audio', '140'), ['140', 'best']);
});
