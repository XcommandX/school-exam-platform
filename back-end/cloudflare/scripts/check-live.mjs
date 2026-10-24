// Anonymous production acceptance: never reads cookies or creates user records.
// Usage: node scripts/check-live.mjs https://<worker>.<subdomain>.workers.dev
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const supplied = process.argv[2];
let origin;
try {
  const url = new URL(supplied);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !url.hostname.endsWith('.workers.dev')) throw new Error();
  origin = url.origin;
} catch { console.error('Usage: node scripts/check-live.mjs https://<worker>.<subdomain>.workers.dev'); process.exit(1); }
let checks = 0;
async function probe(path, expected, init = {}) {
  const response = await fetch(origin + path, {redirect: 'manual', signal: AbortSignal.timeout(30000), ...init});
  const text = await response.text();
  assert.equal(response.status, expected, path + ': unexpected HTTP status');
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store', path);
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff', path);
  assert.equal(response.headers.get('X-Frame-Options'), 'DENY', path);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null, path);
  checks++; console.log('PASS', expected, path);
  return {response, text};
}
const status = await probe('/api/platform/status', 200);
assert.equal(JSON.parse(status.text).deployment, 'cloudflare');
assert.equal(JSON.parse(status.text).auth.loginEnabled, true);
const session = await probe('/api/auth/session', 200);
assert.equal(JSON.parse(session.text).authenticated, false);
assert.equal(JSON.parse(session.text).user, null);
for (const path of ['/', '/account', '/sat/', '/toefl/']) {
  const result = await probe(path, 302); assert.ok(result.response.headers.get('Location').startsWith('/login?next='));
}
const login = await probe('/login', 200);
assert.match(login.text, /login-form/); assert.doesNotMatch(login.text, /window\.PlatformSession=/);
assert.ok(login.response.headers.get('Content-Security-Policy').includes("frame-ancestors 'none'"));
assert.match((await probe('/setup', 200)).text, /setup-form/);
assert.match((await probe('/setup.js', 200)).text, /replaceState/);
const sha = value => createHash('sha256').update(value).digest('hex');
for (const name of ['sat-bridge.js', 'platform-auth.js', 'styles.css']) {
  const live = await probe('/web/' + name, 200);
  const source = await readFile(new URL('../../../front-end/web/' + name, import.meta.url));
  assert.equal(sha(Buffer.from(live.text)), sha(source), 'Deployed public source hash: ' + name);
}
for (const path of ['/api/me', '/api/me/home', '/api/admin/users', '/api/sat/bootstrap', '/api/sat-library/catalog', '/api/sat-question-catalog', '/api/question-bank', '/api/toefl/bootstrap']) await probe(path, 401);
for (const path of ['/_catalog/routes.json', '/.git/config', '/toefl/four-data.js', '/sat/js/question-bank.js']) await probe(path, 404);
const invalidOrigin = await probe('/api/auth/bootstrap', 403, {method: 'POST', headers: {'Content-Type': 'application/json', Origin: 'https://untrusted.invalid'}, body: '{}'});
assert.equal(JSON.parse(invalidOrigin.text).code, 'invalid_origin');
// This known-invalid setup token can never create an account. It exercises the
// real AUTH SQLite DO without a login, a default password, or a production user.
const auth = await fetch(origin + '/api/auth/bootstrap', {method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(30000), headers: {'Content-Type': 'application/json', Origin: origin}, body: JSON.stringify({setupToken: 'invalid-anonymous-probe-token-not-a-secret'})});
const body = await auth.json();
assert.ok((auth.status === 503 && body.code === 'setup_unavailable') || (auth.status === 403 && body.code === 'invalid_setup_token'), 'AUTH must fail closed before any user creation');
checks++; console.log('PASS', auth.status, 'AUTH SQLite DO refuses invalid initialization');
console.log('LIVE ANONYMOUS CHECKS PASSED', checks, origin);
