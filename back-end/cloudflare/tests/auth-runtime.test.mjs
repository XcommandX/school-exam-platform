// Real local workerd/SQLite Durable Object integration. Anonymous ephemeral
// state only; no network deployment, private database, paid API or new packages.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { pbkdf2Sync } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const SETUP_TOKEN = 'runtime_fixture_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const root = fileURLToPath(new URL('../', import.meta.url));
const script = `
import { PlatformAuthStore, hashPassword, verifyPassword } from './src/auth.mjs';
export { PlatformAuthStore };
export default {
  async fetch(request, env) {
    // Algorithm-only test: local workerd is unlimited; this synthetic outer
    // route is NOT a Free Worker CPU test. Real setup/login below go through DO.
    if (new URL(request.url).pathname === '/crypto-probe') {
      const first = hashPassword('runtime-fixture-password');
      const good = verifyPassword('runtime-fixture-password', first);
      const bad = verifyPassword('different-password', first);
      return Response.json({first, good, bad});
    }
    // This is a test-only internal RPC forwarder, NEVER the production wrapper.
    return env.AUTH.get(env.AUTH.idFromName('anonymous-auth-fixture')).fetch(request);
  }
};
`;

async function createRuntime() {
  const bundle = await build({ stdin: { contents: script, resolveDir: root, sourcefile: 'auth-runtime-fixture.mjs' },
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*'], target: 'es2022' });
  const modules = [{ type: 'ESModule', path: resolve(root, 'auth-runtime-fixture.mjs'), contents: bundle.outputFiles[0].text }];
  return new Miniflare(convertV4MiniflareOptions({
    modulesRoot: root, modules, compatibilityDate: '2026-10-19', compatibilityFlags: ['nodejs_compat'],
    bindings: { SETUP_TOKEN },
    durableObjects: { AUTH: { className: 'PlatformAuthStore', useSQLite: true } },
    // Miniflare's default persistence is temporary, removed by dispose().
  }));
}

async function rpc(runtime, path, body) {
  const response = await runtime.dispatchFetch(`http://auth-test.invalid${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, headers: response.headers, value: await response.json() };
}

test('workerd hashes/verifies standard 600000 PBKDF2 iterations without native KDF or weak fallback', { timeout: 30_000 }, async t => {
  const runtime = await createRuntime();
  t.after(() => runtime.dispose());
  const start = performance.now();
  const response = await runtime.dispatchFetch('http://auth-test.invalid/crypto-probe');
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.match(value.first, /^pbkdf2_sha256\$600000\$[a-f0-9]{48}\$[a-f0-9]{64}$/);
  assert.equal(value.good, true);
  assert.equal(value.bad, false);
  const parts = value.first.split('$');
  assert.equal(pbkdf2Sync('runtime-fixture-password', Buffer.from(parts[2], 'hex'), 600000, 32, 'sha256').toString('hex'), parts[3]);
  t.diagnostic(`Local workerd startup + 3 JS 600000-iteration operations: ${Math.round(performance.now() - start)} ms (not cloud CPU billing measurement).`);
});

test('workerd SQLite DO enforces setup, single-session login, admin authorization and revocation', { timeout: 60_000 }, async t => {
  const runtime = await createRuntime();
  t.after(() => runtime.dispose());
  const setup = await rpc(runtime, '/bootstrap', { setupToken: SETUP_TOKEN, username: 'runtime-admin', password: 'runtime-admin-password' });
  assert.equal(setup.status, 201, JSON.stringify(setup.value));
  assert.equal(setup.value.user.role, 'admin');
  assert.equal(setup.value.authenticated, true);
  assert.equal(setup.headers.get('Cache-Control'), 'no-store');
  const again = await rpc(runtime, '/bootstrap', { setupToken: SETUP_TOKEN, username: 'other-admin', password: 'another-password' });
  assert.equal(again.status, 409);
  const admin = await rpc(runtime, '/login', { username: 'RUNTIME-ADMIN', password: 'runtime-admin-password', address: '192.0.2.10' });
  assert.equal(admin.status, 200, JSON.stringify(admin.value));
  assert.notEqual(admin.value.token, setup.value.token);
  assert.equal((await rpc(runtime, '/session', { token: setup.value.token })).value.authenticated, false);
  const token = admin.value.token;
  const created = await rpc(runtime, '/create-user', { token, username: 'runtime-student', password: 'runtime-student-password', displayName: '匿名运行时学生' });
  assert.equal(created.status, 201, JSON.stringify(created.value));
  const student = await rpc(runtime, '/login', { username: 'runtime-student', password: 'runtime-student-password', address: '192.0.2.11' });
  assert.equal(student.status, 200);
  assert.equal((await rpc(runtime, '/users', { token: student.value.token })).status, 403);
  assert.equal((await rpc(runtime, '/users', { token })).value.users.length, 2);
  const session = await rpc(runtime, '/session', { token: student.value.token });
  assert.equal(session.value.authenticated, true);
  assert.equal('token' in session.value, false);
  assert.equal(session.value.user.displayName, '匿名运行时学生');
  const reset = await rpc(runtime, '/password', { token, targetId: created.value.user.id, newPassword: 'reset-student-password' });
  assert.equal(reset.status, 200);
  assert.deepEqual(reset.value, { ok: true });
  assert.equal((await rpc(runtime, '/session', { token: student.value.token })).value.authenticated, false);
  assert.equal((await rpc(runtime, '/login', { username: 'runtime-student', password: 'runtime-student-password', address: '192.0.2.11' })).status, 401);
  const newStudent = await rpc(runtime, '/login', { username: 'runtime-student', password: 'reset-student-password', address: '192.0.2.11' });
  assert.equal(newStudent.status, 200);
  const disabled = await rpc(runtime, '/update-user', { token, targetId: created.value.user.id, changes: { active: false } });
  assert.equal(disabled.status, 200);
  assert.equal((await rpc(runtime, '/session', { token: newStudent.value.token })).value.authenticated, false);
  assert.equal((await rpc(runtime, '/update-user', { token, targetId: admin.value.user.id, changes: { role: 'student' } })).status, 409);
  assert.equal((await rpc(runtime, '/logout', { token })).status, 200);
  assert.equal((await rpc(runtime, '/session', { token })).value.authenticated, false);
});

test('workerd concurrent first-setup requests create exactly one administrator', { timeout: 30_000 }, async t => {
  const runtime = await createRuntime();
  t.after(() => runtime.dispose());
  const results = await Promise.all(['setup-admin-one', 'setup-admin-two'].map(username => rpc(runtime, '/bootstrap', {
    setupToken: SETUP_TOKEN, username, password: 'concurrent-fixture-password',
  })));
  assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
  const success = results.find(result => result.status === 201);
  const users = await rpc(runtime, '/users', { token: success.value.token });
  assert.equal(users.value.users.length, 1);
});
