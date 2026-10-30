import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HTML = fs.readFileSync(path.join(HERE, 'index.html'));
const PUZZLE_HTML = fs.readFileSync(path.join(HERE, 'puzzle.html'));

export function startServer({ port = 9360 } = {}) {
  const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url.startsWith('/?') || req.url === '/puzzle.html') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(PUZZLE_HTML);
      return;
    }
    if (req.url === '/index.html') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(HTML);
      return;
    }
    if (req.url === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        port: address.port,
        url: `http://127.0.0.1:${address.port}/`,
      });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] || process.env.SLIDER_PORT || 9360);
  const { url } = await startServer({ port });
  console.log(`本地滑块页面: ${url}`);
  console.log('按 Ctrl+C 停止。');
}
