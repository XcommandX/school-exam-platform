// Anonymous production acceptance: never reads cookies or creates user records.
// Usage: node scripts/check-live.mjs https://<worker>.<subdomain>.workers.dev
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash, randomBytes} from 'node:crypto';
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
for (const path of ['/', '/account', '/sat/', '/toefl/', '/ap', '/ap/', '/ap/index.html', '/contests', '/contests/', '/contests/index.html']) {
  const result = await probe(path, 302); assert.ok(result.response.headers.get('Location').startsWith('/login?next='));
}
const login = await probe('/login', 200);
assert.match(login.text, /login-form/); assert.doesNotMatch(login.text, /window\.PlatformSession=/);
assert.ok(login.response.headers.get('Content-Security-Policy').includes("frame-ancestors 'none'"));
assert.match((await probe('/setup', 200)).text, /setup-form/);
assert.match((await probe('/setup.js', 200)).text, /replaceState/);
const sha = value => createHash('sha256').update(value).digest('hex');
for (const name of ['sat-bridge.js', 'platform-auth.js', 'styles.css', 'toefl-bridge.js']) {
  const live = await probe('/web/' + name, 200);
  const source = await readFile(new URL('../../../front-end/web/' + name, import.meta.url));
  assert.equal(sha(Buffer.from(live.text)), sha(source), 'Deployed public source hash: ' + name);
}
for (const path of ['/api/me', '/api/me/home', '/api/admin/users', '/api/sat/bootstrap', '/api/sat-library/catalog', '/api/sat-question-catalog', '/api/question-bank', '/api/toefl/bootstrap', '/api/toefl/ai-config', '/api/toefl/assess', '/api/ap/example', '/api/exams/ap/sources']) await probe(path, 401);
for (const path of ['/_catalog/routes.json', '/_catalog/toefl-ai-questions.json', '/.git/config', '/toefl/four-data.js', '/sat/js/question-bank.js', '/ap/app.js', '/ap/examples/synthetic-practice.json']) await probe(path, 404);
// Contest APIs, actual shared images, vendor code and internal copies remain guarded.
for (const path of ['/api/contests/catalog','/api/contests/catalog?mode=example']) await probe(path,401);
const contestManifest = JSON.parse(await readFile(new URL('../../question-banks/contests/RESOURCE_MANIFEST.json', import.meta.url),'utf8'));
const contestExam = contestManifest.files.find(file=>file.path.startsWith('exams/'));
await probe('/api/contests/exams/'+contestExam.path.slice(6,-5),401);
const contestImage = contestManifest.files.find(file=>file.path.startsWith('assets/'));
for (const path of ['/contests/app.js','/contests/timer.js','/_catalog/contests/catalog.json','/contest-assets/'+contestImage.path,'/contest-vendor/mathjax/es5/tex-svg.js']) await probe(path,404);
// Published AP material URLs must remain protected even when exact ids/hashes are known.
const apManifest = JSON.parse(await readFile(new URL('../../question-banks/ap/RESOURCE_MANIFEST.json', import.meta.url), 'utf8'));
const apSetFile = apManifest.files.find(file => file.path.startsWith('sets/'));
const apSet = JSON.parse(await readFile(new URL('../../question-banks/ap/' + apSetFile.path, import.meta.url), 'utf8'));
await probe('/api/exams/ap/sources/' + encodeURIComponent(apSet.id), 401);
const apPdf = apManifest.files.filter(file => file.path.endsWith('.pdf')).sort((a,b)=>b.bytes-a.bytes)[0];
const apPdfRoute = '/question-assets/ap/' + apPdf.path.slice('assets/'.length);
await probe(apPdfRoute, 404);
await probe(apPdfRoute, 404, {method:'HEAD'});
await probe(apPdfRoute, 404, {headers:{Range:'bytes=0-4'}});
const invalidOrigin = await probe('/api/auth/bootstrap', 403, {method: 'POST', headers: {'Content-Type': 'application/json', Origin: 'https://untrusted.invalid'}, body: '{}'});
assert.equal(JSON.parse(invalidOrigin.text).code, 'invalid_origin');
// This known-invalid setup token can never create an account. It exercises the
// real AUTH SQLite DO without a login, a default password, or a production user.
const auth = await fetch(origin + '/api/auth/bootstrap', {method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(30000), headers: {'Content-Type': 'application/json', Origin: origin}, body: JSON.stringify({setupToken: 'invalid-anonymous-probe-token-not-a-secret', username: '', password: ''})});
const body = await auth.json();
assert.ok((auth.status === 503 && body.code === 'setup_unavailable') || (auth.status === 403 && body.code === 'invalid_setup_token'), `AUTH must fail closed before any user creation: HTTP ${auth.status}, code ${body.code}`);
checks++; console.log('PASS', auth.status, 'AUTH SQLite DO refuses invalid initialization');
// A random, non-existent account exercises the SAME 600k dummy verification
// inside the real AUTH DO, without creating a user or inspecting credentials.
// Once per release: this consumes KDF resources and writes normal failed-login
// audit/rate-limit state (including one of the source IP's 30/15-minute quota).
const crypto = await probe('/api/auth/login', 401, {method: 'POST', headers: {'Content-Type': 'application/json', Origin: origin},
  body: JSON.stringify({username: 'probe-' + randomBytes(16).toString('hex'), password: 'public-non-account-release-check'})});
assert.equal(JSON.parse(crypto.text).code, 'invalid_credentials', 'Production must perform a full-strength hash rather than return crypto_unavailable');
console.log('LIVE ANONYMOUS CHECKS PASSED', checks, origin);
