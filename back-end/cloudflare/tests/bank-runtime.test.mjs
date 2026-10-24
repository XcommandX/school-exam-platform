// Actual local workerd + SQLite DO tests. Only anonymous generated fixtures;
// Miniflare uses disposable local state, not private banks or deployed services.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { MAX_BANK_REQUEST_BYTES } from '../src/bank.mjs';
const SETUP_TOKEN = 'bank_fixture_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const root = fileURLToPath(new URL('../', import.meta.url));
const script = `
import { PlatformAuthStore } from './src/auth.mjs';
import { PlatformBankStore } from './src/bank.mjs';
export { PlatformAuthStore, PlatformBankStore };
export default {
  async fetch(request, env) {
    // Test-only trusted forwarding. Production must reject forged internal
    // headers and perform its own Origin, X-Account-ID and CSRF checks.
    const url = new URL(request.url);
    if (url.pathname.startsWith('/auth/')) {
      url.pathname = url.pathname.slice(5);
      return env.AUTH.getByName('platform-auth-v1').fetch(new Request(url, request));
    }
    return env.BANK.getByName('platform-bank-v1').fetch(request);
  }
};`;
async function runtime() {
  const bundle = await build({ stdin: { contents: script, resolveDir: root, sourcefile: 'bank-runtime-fixture.mjs' },
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*'], target: 'es2022' });
  const modules = [{ type: 'ESModule', path: resolve(root, 'bank-runtime-fixture.mjs'), contents: bundle.outputFiles[0].text }];
  return new Miniflare(convertV4MiniflareOptions({
    modulesRoot: root, modules, compatibilityDate: '2026-10-19', compatibilityFlags: ['nodejs_compat'],
    bindings: { SETUP_TOKEN }, durableObjects: {
      AUTH: { className: 'PlatformAuthStore', useSQLite: true }, BANK: { className: 'PlatformBankStore', useSQLite: true },
    },
  }));
}
async function auth(mf, path, body) {
  const response = await mf.dispatchFetch('https://bank-test.invalid/auth' + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, value: await response.json() };
}
const synthetic = passage => ({ title: 'Workerd anonymous fixture', questions: [{ prompt: 'Select A.',
  options: ['A', 'B', 'C', 'D'], answer: 'A', passage, userSelectedAnswer: 'B', customMetadata: {
    sourceExamId: 'synthetic-exam', studentName: 'PRIVATE SYNTHETIC', repairAudit: { score: 99 },
  } }], attempts: [{ studentName: 'PRIVATE SYNTHETIC' }] });
function bank(mf, path, session, raw) {
  return mf.dispatchFetch('https://bank-test.invalid' + path, {
    method: raw === undefined ? 'GET' : 'POST', headers: {
      'Content-Type': 'application/json', 'X-Platform-Token': session?.token || '', 'X-Platform-User': session?.user?.id || '',
    }, ...(raw === undefined ? {} : { body: JSON.stringify({ name: 'anonymous.json', text: typeof raw === 'string' ? raw : JSON.stringify(raw) }) }),
  });
}

test('workerd real AUTH/Bank SQL DO accepts admin, denies student/revoked users, and streams canonical sources', { timeout: 60_000 }, async t => {
  const mf = await runtime(); t.after(() => mf.dispose());
  assert.equal((await bank(mf, '/question-bank', null)).status, 401);
  const setup = await auth(mf, '/bootstrap', { setupToken: SETUP_TOKEN, username: 'bank-admin', password: 'bank-fixture-password' });
  assert.equal(setup.status, 201, JSON.stringify(setup.value)); const admin = setup.value;
  const posted = await bank(mf, '/question-bank', admin, synthetic('😀 **literal passage**'));
  assert.equal(posted.status, 201, await posted.clone().text());
  const saved = await posted.json(); assert.doesNotMatch(saved.text, /PRIVATE|studentName|userSelectedAnswer|repairAudit/);
  assert.deepEqual(await (await bank(mf, '/question-bank', admin)).json(), { files: [saved], errors: [] });
  assert.deepEqual(await (await bank(mf, '/question-bank', admin, saved.text)).json(), saved);
  const sources = await (await bank(mf, '/sources', admin)).json(); assert.equal(sources.sources.length, 1);
  const canonical = await (await bank(mf, '/sources/' + encodeURIComponent(sources.sources[0].id), admin)).json();
  assert.equal(canonical.schemaVersion, 1); assert.equal(canonical.questions[0].correctOption, 0);
  const created = await auth(mf, '/create-user', { token: admin.token, username: 'bank-student', password: 'student-fixture-password' });
  assert.equal(created.status, 201);
  const student = await auth(mf, '/login', { username: 'bank-student', password: 'student-fixture-password', address: '192.0.2.20' });
  assert.equal(student.status, 200);
  assert.equal((await bank(mf, '/question-bank', student.value, synthetic('Student denied'))).status, 403);
  assert.equal((await bank(mf, '/question-bank', student.value)).status, 200);
  assert.equal((await bank(mf, '/question-bank', { ...admin, user: student.value.user }, synthetic('wrong user'))).status, 409);
  assert.equal((await auth(mf, '/logout', { token: admin.token })).status, 200);
  assert.equal((await bank(mf, '/sources', admin)).status, 401);
  assert.equal((await bank(mf, '/question-bank', admin, synthetic('Revoked admin'))).status, 401);
});

test('workerd accepts the original near-20MiB request and streams the compatibility response', { timeout: 120_000 }, async t => {
  const mf = await runtime(); t.after(() => mf.dispose());
  const setup = await auth(mf, '/bootstrap', { setupToken: SETUP_TOKEN, username: 'large-bank-admin', password: 'large-fixture-password' });
  assert.equal(setup.status, 201);
  let raw = synthetic('x'.repeat(MAX_BANK_REQUEST_BYTES - 8192));
  const response = await bank(mf, '/question-bank', setup.value, raw); raw = null;
  assert.equal(response.status, 201, response.status !== 201 ? await response.text() : '');
  let bytes = 0; for await (const chunk of response.body) bytes += chunk.length;
  assert.ok(bytes > 19 * 1024 * 1024);
  const list = await bank(mf, '/question-bank', setup.value); assert.equal(list.status, 200);
  bytes = 0; for await (const chunk of list.body) bytes += chunk.length;
  assert.ok(bytes > 19 * 1024 * 1024);
  const sources = await (await bank(mf, '/sources', setup.value)).json(); assert.equal(sources.sources.length, 1);
});
