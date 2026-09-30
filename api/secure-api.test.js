const test = require('node:test');
const assert = require('node:assert/strict');
const secureApi = require('./secure-api');
const handler = require('./index');

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
  global.fetch = async () => {
    throw new TypeError('provider unavailable');
  };
  await assert.rejects(
    secureApi.fetchXVideo('https://x.com/example/status/123456789012345'),
    { statusCode: 502 },
  );
});

test('reserva 404 de X para respuestas válidas sin video', async () => {
  global.fetch = async (url) => new Response(
    String(url).includes('fxtwitter') ? JSON.stringify({ tweet: { text: 'hello' } }) : JSON.stringify({ text: 'hello' }),
    { headers: { 'content-type': 'application/json' } },
  );
  await assert.rejects(
    secureApi.fetchXVideo('https://x.com/example/status/123456789012345'),
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

