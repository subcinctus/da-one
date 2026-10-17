// Plain static server like GitHub Pages: no CSP, no page wrapping, gzip with Content-Length of
// the compressed body for text, JSON and .wasm (the worst case for download-length checks).
import http from 'http';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

const root = path.resolve(process.argv[2]);
const port = Number(process.argv[3] || 8790);
const base = process.argv[4] || '/answer-desk/';
const types = { '.html': 'text/html; charset=utf-8', '.mjs': 'application/javascript; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.wasm': 'application/wasm' };
const gz = new Set(['.html', '.mjs', '.js', '.json', '.txt', '.md', '.wasm']);
const cache = new Map();
http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (!p.startsWith(base)) { console.log('404', p); res.writeHead(404); res.end('not found'); return; }
  p = '/' + p.slice(base.length);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(root, p);
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { console.log('404', p); res.writeHead(404); res.end('not found'); return; }
  const ext = path.extname(f);
  let body = fs.readFileSync(f);
  const headers = { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'max-age=600' };
  if (gz.has(ext) && /gzip/.test(req.headers['accept-encoding'] || '')) {
    if (!cache.has(f)) cache.set(f, zlib.gzipSync(body, { level: 6 }));
    body = cache.get(f);
    headers['Content-Encoding'] = 'gzip';
  }
  headers['Content-Length'] = body.length;
  res.writeHead(200, headers);
  res.end(body);
}).listen(port, () => console.log(`serving ${root} at http://127.0.0.1:${port}${base}`));
