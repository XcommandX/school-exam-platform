import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { BankStore, PlatformBankStore, BANK_CHUNK_BYTES, MAX_BANK_BYTES, MAX_BANK_REQUEST_BYTES } from '../src/bank.mjs';
import { normalizeQuestionSet, toSATLegacy } from '../src/bank-schema.mjs';

function storage() {
  const db = new DatabaseSync(':memory:');
  return { db, sql: { exec(query, ...args) { return db.prepare(query).all(...args); } },
    transactionSync(fn) { db.exec('BEGIN'); try { const value = fn(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } } };
}
const sample = (title = 'Anonymous synthetic set', extra = {}) => ({ title, questions: [{
  prompt: 'Select A.', options: ['A', 'B', 'C', 'D'], answer: 'A',
  customMetadata: { sourceExamId: 'synthetic-exam', studentName: 'PRIVATE PERSON', repairAudit: { userAnswer: 'B' } },
  userSelectedAnswer: 'B', ...extra,
}], studentName: 'PRIVATE PERSON', attempts: [{ score: 4 }] });
const envelope = (raw, name = 'private-original-name.json') => ({ name, text: typeof raw === 'string' ? raw : JSON.stringify(raw) });
const req = (raw, { name, path = '/question-bank', headers = {}, method = 'POST' } = {}) => new Request('https://bank.invalid' + path, {
  method, headers: { 'Content-Type': 'application/json', 'X-Platform-Token': 'valid-token', 'X-Platform-User': 'anonymous-admin', ...headers },
  ...(method === 'GET' ? {} : { body: JSON.stringify(envelope(raw, name)) }),
});
const noop = async () => {};
const failsCode = code => error => error.code === code;
function authEnvironment(decide = () => ({ authenticated: true, user: { id: 'anonymous-admin', role: 'admin', active: true } })) {
  const calls = [];
  return { calls, AUTH: { getByName(name) {
    assert.equal(name, 'platform-auth-v1');
    return { async fetch(url, init) {
      assert.equal(url, 'https://internal/session'); assert.equal(init.method, 'POST');
      assert.equal(init.headers['Content-Type'], 'application/json');
      assert.deepEqual(JSON.parse(init.body), { token: 'valid-token' }); calls.push(init);
      return Response.json(await decide(calls.length));
    } };
  } } };
}

test('POST persists only canonical/legacy allowlists and GET preserves original contracts', async t => {
  const state = storage(); t.after(() => state.db.close()); const store = new BankStore(state, { clock: () => 123456 });
  const raw = sample(), document = normalizeQuestionSet(raw), response = await store.import(req(raw), noop);
  assert.equal(response.status, 201); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const saved = await response.json(); assert.match(saved.name, /^sat-[a-f0-9]{64}\.json$/);
  assert.equal(saved.lastModified, 123456); assert.deepEqual(JSON.parse(saved.text), toSATLegacy(document));
  assert.deepEqual(await store.list().json(), { files: [saved], errors: [] });
  assert.deepEqual(await store.sources().json(), { schemaVersion: 1, exam: 'sat', sources: [{ id: document.id,
    title: document.title, questionCount: 1, section: 'Reading and Writing', defaultDurationSeconds: 1920, moduleCount: 1 }], errors: [] });
  assert.deepEqual(await store.source(document.id).json(), document);
  const rows = store.rows('SELECT body FROM bank_chunks');
  for (const row of rows) assert.doesNotMatch(Buffer.from(row.body).toString(), /PRIVATE PERSON|studentName|userSelectedAnswer|repairAudit|private-original-name|attempts/);
  assert.equal(store.bytes(), rows.reduce((sum, row) => sum + row.body.length, 0));
  assert.throws(() => store.source('sat:not-found'), failsCode('not_found'));
});

test('normalized hashes deduplicate reordered objects, renamed files, private metadata and legacy reimports', async t => {
  const state = storage(); t.after(() => state.db.close()); const store = new BankStore(state); let checks = 0;
  const first = await (await store.import(req(sample()), async () => { checks++; })).json();
  const raw = sample(); raw.studentName = 'OTHER PRIVATE'; raw.questions[0].customMetadata.repairAudit = { score: 999 };
  raw.questions[0] = Object.fromEntries(Object.entries(raw.questions[0]).reverse());
  const again = await (await store.import(req(raw, { name: 'renamed.json' }), async () => { checks++; })).json();
  const roundtrip = await (await store.import(req(first.text), async () => { checks++; })).json();
  assert.deepEqual(again, first); assert.deepEqual(roundtrip, first); assert.equal(checks, 3);
  assert.equal(store.one('SELECT COUNT(*) AS n FROM bank_documents').n, 1);
  assert.equal(store.one('SELECT COUNT(*) AS n FROM bank_uploads').n, 1);
  assert.equal((await store.list().json()).files.length, 1);
});

test('canonical document revisions remain separate without replacing static/new-pack content', async t => {
  const state = storage(); t.after(() => state.db.close()); const store = new BankStore(state);
  const raw = sample(); const first = await (await store.import(req(raw), noop)).json();
  raw.questions[0].explanation = 'Updated synthetic explanation.';
  const second = await (await store.import(req(raw), noop)).json();
  assert.notEqual(first.name, second.name);
  assert.equal(JSON.parse(first.text).sourceId, JSON.parse(second.text).sourceId);
  const listed = await store.list().json(); assert.equal(listed.files.length, 2);
  const expected = listed.files.sort((a, b) => a.name.localeCompare(b.name))[0];
  assert.equal((await store.source(JSON.parse(first.text).sourceId).json()).questions[0].explanation, JSON.parse(expected.text).questions[0].explanation);
});

test('revocation at fresh precommit check rolls back all staged content including duplicate requests', async t => {
  const state = storage(); t.after(() => state.db.close()); const store = new BankStore(state);
  await assert.rejects(() => store.import(req(sample()), async () => { throw new Error('revoked'); }), /revoked/);
  for (const table of ['bank_chunks', 'bank_uploads', 'bank_documents']) assert.equal(store.one(`SELECT COUNT(*) AS n FROM ${table}`).n, 0);
  const first = await (await store.import(req(sample()), noop)).json();
  await assert.rejects(() => store.import(req(sample()), async () => { throw new Error('demoted'); }), /demoted/);
  assert.deepEqual((await store.list().json()).files, [first]);
});

test('capacity counts canonical+legacy+summary, returns clear errors and still permits dedup at full quota', async t => {
  const state = storage(); t.after(() => state.db.close()); const store = new BankStore(state);
  const first = await (await store.import(req(sample()), noop)).json();
  const upload = store.one('SELECT id FROM bank_uploads').id;
  // Synthetic quota counter; never allocate a half-gigabyte test database.
  state.sql.exec('UPDATE bank_uploads SET size=? WHERE id=?', MAX_BANK_BYTES, upload);
  await assert.rejects(() => store.import(req(sample('Different synthetic title')), noop), error => error.code === 'bank_storage_limit' && error.status === 413 && error.message.includes('512 MiB'));
  assert.deepEqual(await (await store.import(req(sample()), noop)).json(), first);
  assert.equal(store.one('SELECT COUNT(*) AS n FROM bank_uploads').n, 1);
  assert.equal(store.one('SELECT COUNT(*) AS n FROM bank_documents').n, 1);
});

test('physical SQLite overhead has independent headroom guard with clean rollback', async t => {
  const state = storage(); t.after(() => state.db.close()); const store = new BankStore(state);
  const first = await (await store.import(req(sample()), noop)).json();
  state.sql.databaseSize = 894 * 1024 * 1024;
  await assert.rejects(() => store.import(req(sample('physical-quota')), noop), error => error.status === 413 && error.code === 'bank_database_limit');
  assert.equal(store.one('SELECT COUNT(*) AS n FROM bank_uploads').n, 1);
  assert.deepEqual(await (await store.import(req(sample()), noop)).json(), first);
  state.sql.databaseSize = 0;
  await assert.rejects(() => store.import(req(sample('growing-overhead')), async () => { state.sql.databaseSize = 895 * 1024 * 1024; }), failsCode('bank_database_limit'));
  assert.equal(store.one('SELECT COUNT(*) AS n FROM bank_uploads').n, 1);
});

test('UTF-8 chunk boundaries and escaped streamed files round-trip with every SQL BLOB <=256KiB', async t => {
  const state = storage(); t.after(() => state.db.close()); const store = new BankStore(state);
  const passage = 'a'.repeat(262100) + '😀中文\\"\n\t'.repeat(120000), raw = sample('Escaped multi-chunk', { passage });
  const saved = await (await store.import(req(raw), noop)).json();
  assert.equal(JSON.parse(saved.text).questions[0].passage, passage);
  assert.ok(store.one('SELECT MAX(length(body)) AS n FROM bank_chunks').n <= BANK_CHUNK_BYTES);
  const source = await store.source(JSON.parse(saved.text).sourceId).json(); assert.equal(source.questions[0].passage, passage);
  assert.equal((await store.list().json()).files[0].text, saved.text);
});

test('list is lazy, paged and snapshot-consistent without materializing complete files', async t => {
  const state = storage(); t.after(() => state.db.close()); const store = new BankStore(state);
  await (await store.import(req(sample('First')), noop)).body.cancel();
  const rows = store.rows.bind(store), sizes = []; let reads = 0;
  store.rows = (query, ...args) => {
    if (query.includes('SELECT body')) reads++;
    const result = rows(query, ...args); if (query.includes('LIMIT 32')) sizes.push(result.length); return result;
  };
  const response = store.list(); assert.equal(reads, 0);
  await (await store.import(req(sample('Later')), noop)).body.cancel();
  const content = await response.json(); assert.equal(content.files.length, 1); assert.equal(JSON.parse(content.files[0].text).title, 'First');
  assert.ok(sizes.every(size => size <= 32)); assert.ok(reads > 0);
  assert.equal((await store.list().json()).files.length, 2);
});

test('restart removes unreachable sanitized staging bytes but preserves committed documents', async t => {
  const state = storage(); t.after(() => state.db.close()); let store = new BankStore(state);
  const first = await (await store.import(req(sample()), noop)).json();
  const staged = store.stage(normalizeQuestionSet(sample('Interrupted')));
  assert.ok(store.one('SELECT id FROM bank_uploads WHERE id=?', staged.id));
  store = new BankStore(state); assert.equal(store.one('SELECT id FROM bank_uploads WHERE id=?', staged.id), undefined);
  assert.deepEqual((await store.list().json()).files, [first]);
});

test('DO rejects anonymous, student import, stale user binding and missing auth service', async t => {
  for (const variant of ['anonymous', 'student', 'mismatch', 'unavailable']) {
    const state = storage(); t.after(() => state.db.close());
    const env = authEnvironment(() => ({ authenticated: variant !== 'anonymous', user: { id: variant === 'mismatch' ? 'other' : 'anonymous-admin', role: 'student' } }));
    if (variant === 'unavailable') env.AUTH.getByName = () => { throw new Error('offline'); };
    const object = new PlatformBankStore({ storage: state }, env);
    const response = await object.fetch(req(sample())); assert.equal(response.status, { anonymous: 401, student: 403, mismatch: 409, unavailable: 503 }[variant]);
    assert.equal(object.store.one('SELECT COUNT(*) AS n FROM bank_uploads').n, 0);
  }
  const state = storage(); t.after(() => state.db.close()); const env = authEnvironment();
  const object = new PlatformBankStore({ storage: state }, env);
  assert.equal((await object.fetch(new Request('https://bank.invalid/question-bank'))).status, 401); assert.equal(env.calls.length, 0);
});

test('DO checks fresh role before commit and authenticated students may read only', async t => {
  const state = storage(); t.after(() => state.db.close());
  let demote = true;
  const env = authEnvironment(n => ({ authenticated: true, user: { id: 'anonymous-admin', role: demote && n > 1 ? 'student' : 'admin' } }));
  const object = new PlatformBankStore({ storage: state }, env);
  assert.equal((await object.fetch(req(sample()))).status, 403); assert.equal(env.calls.length, 2); assert.equal(object.store.bytes(), 0);
  demote = false;
  const posted = await object.fetch(req(sample())); assert.equal(posted.status, 201); const saved = await posted.json();
  demote = true;
  assert.equal((await object.fetch(req(null, { method: 'GET' }))).status, 200);
  assert.equal((await object.fetch(req(null, { method: 'GET', path: '/sources' }))).status, 200);
  assert.deepEqual(await (await object.fetch(req(null, { method: 'GET', path: '/sources/' + encodeURIComponent(JSON.parse(saved.text).sourceId) }))).json(), normalizeQuestionSet(sample()));
  assert.equal((await object.fetch(req(sample()))).status, 403);
});

test('DO returns malformed/duplicate JSON, content-type, filename and request-size errors without storing', async t => {
  const state = storage(); t.after(() => state.db.close()); const object = new PlatformBankStore({ storage: state }, authEnvironment());
  const invalidRequests = [
    req('{"questions":[],"questions":[]}'), req('{"questions":[{"answer":NaN}]}'),
    req(sample(), { name: '../private.json' }), req(sample(), { name: 'not-json.txt' }),
    req(sample(), { headers: { 'Content-Type': 'text/plain' } }),
    req(sample(), { headers: { 'Content-Length': String(MAX_BANK_REQUEST_BYTES + 1) } }),
    req(sample(), { path: '/question-bank?debug=1' }),
  ];
  const expected = [400, 400, 400, 400, 415, 413, 400];
  for (let i = 0; i < invalidRequests.length; i++) assert.equal((await object.fetch(invalidRequests[i])).status, expected[i]);
  const headers = { 'Content-Type': 'application/json', 'X-Platform-Token': 'valid-token', 'X-Platform-User': 'anonymous-admin' };
  const outerDuplicate = new Request('https://bank.invalid/question-bank', { method: 'POST', headers,
    body: '{"name":"a.json","text":"{}","te\\u0078t":"{}"}' });
  assert.equal((await object.fetch(outerDuplicate)).status, 400);
  let part = 0;
  const oversized = new ReadableStream({ pull(controller) {
    if (part++ < 81) controller.enqueue(new Uint8Array(BANK_CHUNK_BYTES).fill(32)); else controller.close();
  } });
  const tooLarge = await object.fetch(new Request('https://bank.invalid/question-bank', { method: 'POST', headers, body: oversized, duplex: 'half' }));
  assert.equal(tooLarge.status, 413); assert.equal((await tooLarge.json()).code, 'bank_request_limit');
  assert.equal(object.store.bytes(), 0);
  assert.equal((await object.fetch(req(sample(), { method: 'PUT' }))).status, 405);
  assert.equal((await object.fetch(req(null, { method: 'GET', path: '/sources/%ZZ' }))).status, 404);
});

test('single in-flight import cannot interleave another writer and retry returns explicit 429', async t => {
  const state = storage(); t.after(() => state.db.close()); let release;
  const gate = new Promise(resolve => { release = resolve; });
  let atCommit; const committed = new Promise(resolve => { atCommit = resolve; });
  const env = authEnvironment(async n => { if (n === 2) { atCommit(); await gate; } return { authenticated: true, user: { id: 'anonymous-admin', role: 'admin' } }; });
  const object = new PlatformBankStore({ storage: state }, env);
  const first = object.fetch(req(sample())); await committed;
  const busy = await object.fetch(req(sample('other'))); assert.equal(busy.status, 429); assert.equal(busy.headers.get('Retry-After'), '2');
  release(); assert.equal((await first).status, 201);
});

test('nearly 20MiB legacy text imports and streams in bounded chunks', { timeout: 120_000 }, async t => {
  const state = storage(); t.after(() => state.db.close()); const store = new BankStore(state);
  const raw = sample('Large synthetic file', { passage: 'a'.repeat(MAX_BANK_REQUEST_BYTES - 8192) });
  const body = JSON.stringify(envelope(raw)); assert.ok(Buffer.byteLength(body) < MAX_BANK_REQUEST_BYTES);
  const response = await store.import(new Request('https://bank.invalid/question-bank', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }), noop);
  assert.equal(response.status, 201); await response.body.cancel();
  assert.ok(store.one('SELECT MAX(length(body)) AS n FROM bank_chunks').n <= BANK_CHUNK_BYTES);
  assert.ok(store.bytes() > 39 * 1024 * 1024);
  // Count output, do not response.text()/json() the entire compatibility list.
  let bytes = 0; for await (const chunk of store.list().body) bytes += chunk.length;
  assert.ok(bytes > 19 * 1024 * 1024);
});
