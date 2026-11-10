// Minimal static server for previewing out/ (localhost only).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve('out'); const port = Number(process.env.PORT || 8765);
http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '') || 'index.html');
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': p.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' }); fs.createReadStream(p).pipe(res);
}).listen(port, '127.0.0.1', () => console.log('serving ' + root + ' on http://localhost:' + port));
