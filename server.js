const http = require('node:http');
const handler = require('./api/index.js');

const port = Number(process.env.PORT) || 3000;
const server = http.createServer((req, res) => {
  handler(req, res).catch((error) => {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ok: false, message: String(error && error.message || error).slice(0, 200) }, null, 2));
    } else {
      res.destroy();
    }
  });
});

server.listen(port, () => {
  console.log(`ZETA-CORE API local en http://localhost:${port}`);
});
