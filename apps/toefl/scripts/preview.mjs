import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, distRoot } from './build.mjs';

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.wav': 'audio/wav' };
export function createPreviewServer() {
  const root = path.join(distRoot, 'preview');
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (pathname.startsWith('/api/')) {
        res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(req.method === 'HEAD' ? '' : JSON.stringify({ error: '本地样例未连接云端账号或 AI。' }));
        return;
      }
      if (pathname.includes('\\') || pathname.split('/').some(x => x.startsWith('.'))) throw Error('Not found');
      const target = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
      const actual = await realpath(target);
      if (!actual.startsWith(root + path.sep) || !types[path.extname(actual)] || !(await stat(actual)).isFile()) throw Error('Not found');
      const body = await readFile(actual);
      res.writeHead(200, { 'Content-Type': types[path.extname(actual)], 'Content-Length': body.length });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch { res.writeHead(404); res.end(); }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8788);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('PORT must be 1024–65535.');
  await build();
  const server = createPreviewServer();
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Anonymous intake preview: http://127.0.0.1:${port}/`));
}
