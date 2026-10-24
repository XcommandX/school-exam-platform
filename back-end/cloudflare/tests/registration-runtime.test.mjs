// Real local workerd/SQLite DO; outbound requests are denied and counted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
const root = fileURLToPath(new URL('../', import.meta.url));
const origin = 'https://registration-runtime.invalid';
const password = 'anonymous-runtime-password';
const setupToken = 'anonymous_setup_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ';

test('real SQLite DO shares two-admin queue, rejects students/revoked sessions, serializes decisions and never calls mail', { timeout: 180_000 }, async t => {
  const outbound = [];
  const bundle = await build({ entryPoints: [resolve(root, 'src/worker.mjs')], bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*'], target: 'es2022' });
  assert(!bundle.outputFiles[0].text.includes('api.resend.com'));
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-10-20', compatibilityFlags: ['nodejs_compat'], bindings: { SETUP_TOKEN: setupToken },
    durableObjects: { AUTH: { className: 'PlatformAuthStore', useSQLite: true }, ACCOUNTS: { className: 'PlatformAccountStore', useSQLite: true }, BANK: { className: 'PlatformBankStore', useSQLite: true } },
    outboundService: request => { outbound.push(request.url); return new Response('outbound forbidden', { status: 503 }); },
    serviceBindings: { ASSETS: () => new Response('not found', { status: 404 }) },
  })); t.after(() => mf.dispose());
  async function call(path, body, actor, extra = {}, method = body === undefined ? 'GET' : 'POST') {
    const response = await mf.dispatchFetch(origin + path, { method, headers: {
      ...(body === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json' }),
      ...(actor ? { Cookie: actor.cookie, 'X-Account-ID': actor.id } : {}), ...extra,
    }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, value: await response.json(), headers: response.headers };
  }
  const actor = response => ({ cookie: response.headers.get('Set-Cookie').split(';')[0], id: response.value.user.id });
  const apply = username => call('/api/auth/register', { username, displayName: '匿名申请人', password });
  const decide = (id, action, admin) => call(`/api/admin/registrations/${id}/${action}`, {}, admin);
  assert.deepEqual((await call('/api/auth/registration-config')).value, { enabled: false, mode: 'admin' });
  assert.equal((await apply('before-setup')).status, 503);
  const first = await call('/api/auth/bootstrap', { setupToken, username: 'admin-one', displayName: '管理员甲', password }); assert.equal(first.status, 201);
  const a = actor(first);
  assert.equal((await call('/api/admin/users', { username: 'admin-two', displayName: '管理员乙', password, role: 'admin' }, a)).status, 201);
  const b = actor(await call('/api/auth/login', { username: 'admin-two', password }));
  assert.deepEqual((await call('/api/auth/registration-config')).value, { enabled: true, mode: 'admin' });
  const application = await apply('new-student'); assert.equal(application.status, 202); assert.equal(application.headers.get('Set-Cookie'), null);
  assert.equal((await apply('NEW-STUDENT')).status, 409);
  assert.equal((await call('/api/auth/login', { username: 'new-student', password })).status, 401);
  const list = await call('/api/admin/registrations', undefined, a);
  assert.equal(list.value.pendingCount, 1);
  assert.deepEqual(list.value, (await call('/api/admin/registrations', undefined, b)).value);
  const id = list.value.requests[0].id;
  assert.equal((await call('/api/admin/registrations')).status, 401);
  assert.equal((await call('/api/admin/registrations', undefined, a, { 'X-Account-ID': b.id })).status, 409);
  assert.equal((await call(`/api/admin/registrations/${id}/approve`, {}, a, { Origin: 'https://evil.invalid' })).status, 403);
  assert.equal((await call(`/api/admin/registrations/${id}/approve`, { role: 'admin' }, a)).status, 400);
  const approved = await Promise.all([decide(id, 'approve', a), decide(id, 'approve', b)]);
  assert.deepEqual(approved.map(r => r.status).sort(), [200,409]);
  for (const result of approved) assert.equal(result.headers.get('Set-Cookie'), null);
  const studentLogin = await call('/api/auth/login', { username: 'new-student', password }); assert.equal(studentLogin.value.user.role, 'student');
  const student = actor(studentLogin);
  assert.equal((await call('/api/admin/registrations', undefined, student)).status, 403);
  assert.equal((await decide(id, 'reject', student)).status, 403);
  assert.equal((await apply('race-student')).status, 202);
  const raceId = (await call('/api/admin/registrations', undefined, a)).value.requests.find(r => r.status === 'pending').id;
  const raced = await Promise.all([decide(raceId, 'approve', a), decide(raceId, 'reject', b)]);
  assert.deepEqual(raced.map(r => r.status).sort(), [200,409]);
  assert.equal((await apply('reject-student')).status, 202);
  const rejectId = (await call('/api/admin/registrations', undefined, b)).value.requests.find(r => r.status === 'pending').id;
  assert.deepEqual((await decide(rejectId, 'reject', b)).value, { rejected: true });
  assert.equal((await apply('reject-student')).status, 202);
  assert.equal((await call('/api/auth/logout', {}, b)).status, 200);
  assert.equal((await call('/api/admin/registrations', undefined, b)).status, 401);
  assert.equal((await decide(rejectId, 'approve', b)).status, 401);
  for (const path of ['/api/auth/registration-review','/api/auth/registration-approve']) {
    assert.equal((await call(path, { token: 'a'.repeat(43) })).status, 410);
    assert.equal((await call(path)).status, 410);
  }
  assert.equal((await call('/registration-review')).status, 410);
  const history = (await call('/api/admin/registrations', undefined, a)).value;
  assert(history.requests.some(r => r.status === 'rejected' && r.reviewedBy === '管理员乙'));
  assert(!JSON.stringify(history).match(/password|hash|token/i));
  assert.deepEqual(outbound, []);
});
