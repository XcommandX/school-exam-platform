import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createPreviewServer } from '../../scripts/preview.mjs';

const server = createPreviewServer();
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = 'http://127.0.0.1:' + server.address().port;
try {
  const html = await fetch(base).then(r => r.text());
  assert(html.includes('本地匿名样例'));
  const data = await fetch(base + '/four-data.js').then(r => r.text());
  assert(data.includes('ANONYMOUS_FIXTURE'));
  assert.equal((await fetch(base + '/audio/fixture-tone.wav')).headers.get('Content-Type'), 'audio/wav');
  for (const route of ['/src/cloud/worker.mjs', '/.env', '/%2e%2e%2fsource-snapshot.json', '/%5c..%5c.env', '/audio/']) {
    assert.equal((await fetch(base + route)).status, 404, route);
  }
  assert.equal((await fetch(base + '/api/me')).status, 503);
  assert.equal((await fetch(base + '/', { method: 'POST', body: 'data' })).status, 405);
  assert.equal((await fetch(base + '/four-app.js', { method: 'HEAD' })).headers.get('Cache-Control'), 'no-store');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
console.log('PASS: loopback preview exposes anonymous frontend only; no cloud routes, directories or source traversal.');
