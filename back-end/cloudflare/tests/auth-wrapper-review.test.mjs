// Independent auth-boundary/data-integrity review regressions. All fixtures
// are anonymous and SQLite state is strictly in memory. No Worker/bank import.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ProjectedJSON, InputError } from '../src/json-stream.mjs';
import { AccountStore, PlatformAccountStore } from '../src/data.mjs';
import { satProjection, validateSAT, validateHome } from '../src/validation.mjs';

function storage(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  return { db, sql: { exec(query, ...args) {
    if (query.includes(';\n')) { db.exec(query); return []; }
    return db.prepare(query).all(...args);
  } }, transactionSync(fn) {
    db.exec('SAVEPOINT review');
    try { const result = fn(); db.exec('RELEASE SAVEPOINT review'); return result; }
    catch (error) { db.exec('ROLLBACK TO SAVEPOINT review'); db.exec('RELEASE SAVEPOINT review'); throw error; }
  }, async setAlarm() {} };
}
function parse(text, select = satProjection, split = 0) {
  const parser = new ProjectedJSON({ select }), bytes = Buffer.from(text);
  if (split) { for (let i = 0; i < bytes.length; i += split) parser.write(bytes.subarray(i, i + split)); }
  else parser.write(bytes);
  const value = parser.end(); return { parser, value, bytes };
}
const req = body => new Request('https://anonymous-review.invalid', { method: 'PUT', body: typeof body === 'string' ? body : JSON.stringify(body) });
const change = (value, revision = 0, mutationId = 'anonymous-review') => ({ value, revision, mutationId });
const wrong = (extra = {}) => ({ questionId: 'q1', addedAt: 1, reason: 'manual', questionSnapshot: { id: 'q1', ...extra } });
const attempt = (extra = {}) => ({
  id: 'a1', practiceName: '匿名审查练习', status: 'completed', completedAt: 1,
  questionIds: ['q1'], totalQuestions: 1, questionSnapshots: [{ id: 'q1', text: 'opaque', section: 'math' }],
  answers: { q1: { answered: true, correctness: true } },
  correctCount: 1, incorrectCount: 0, unansweredCount: 0, ungradedCount: 0, ...extra,
});
const code = expected => error => error instanceof InputError && error.code === expected;

test('review: leading UTF-8 BOM cannot silently shift persisted JSON byte ranges', () => {
  const input = '\ufeff{"value":{"x":1},"revision":0}';
  for (const split of [0, 1, 2, 3, 5]) assert.throws(() => parse(input, satProjection, split), InputError);
});

test('review: Unicode and escapes retain exact raw value byte boundaries at every chunk size', () => {
  const input = ' {"revision":0,"value":{"questionId":"q1","questionSnapshot":{"id":"q1","text":"中文😀\\n\\uD834\\uDD1E"}},"mutationId":"review"} ';
  const expected = input.slice(input.indexOf('{"questionId"'), input.indexOf(',"mutationId"'));
  for (const split of [0, 1, 2, 3, 7, 19]) {
    const { parser, bytes } = parse(input, satProjection, split);
    assert.equal(bytes.subarray(parser.captureStart, parser.captureEnd).toString(), expected);
  }
});

test('review: exact number hashes distinguish unsafe integers and underflow while normalizing decimal spellings', () => {
  const hash = number => parse(`{"value":{"questionSnapshot":{"n":${number}}}}`).parser.hash;
  assert.notEqual(hash('9007199254740992'), hash('9007199254740993'));
  assert.notEqual(hash('1e-500'), hash('2e-500'));
  assert.notEqual(hash('1.00000000000000001'), hash('1'));
  for (const [left, right] of [['1', '1.0'], ['100', '1e2'], ['0.01', '10e-3'], ['0', '-0'], ['-10.00', '-1e1']]) assert.equal(hash(left), hash(right));
});

test('review: unsafe-integer differences cannot reuse a mutation ID', async t => {
  const store = new AccountStore(storage(t));
  const text = JSON.stringify(change(wrong({ precise: 'NUM' })));
  await store.putSAT('wrong-book', 'q1', req(text.replace('"NUM"', '9007199254740992')));
  await assert.rejects(() => store.putSAT('wrong-book', 'q1', req(text.replace('"NUM"', '9007199254740993'))), code('mutation_reused'));
});

test('review: unsafe-integer differences cannot pass completed-attempt immutability', async t => {
  const store = new AccountStore(storage(t));
  const value = attempt({ questionSnapshots: [{ id: 'q1', precise: 'NUM' }] });
  await store.putSAT('attempts', 'a1', req(JSON.stringify(change(value)).replace('"NUM"', '9007199254740992')));
  await assert.rejects(() => store.putSAT('attempts', 'a1', req(JSON.stringify(change(value, 1, 'review-new')).replace('"NUM"', '9007199254740993'))), code('attempt_completed'));
});

test('review: projection omits opaque/unknown descendants but never hides unknown top-level fields', () => {
  const body = change(attempt({ unexpected: [{ private: 'ignored' }], modules: [{ huge: 'ignored' }] }));
  const { value } = parse(JSON.stringify(body));
  assert.deepEqual(value.value.unexpected, []);
  assert.deepEqual(value.value.modules, []);
  assert.equal(value.value.questionSnapshots[0].text, undefined);
  assert.throws(() => validateSAT('attempts', 'a1', value, 1000), code('invalid_sat_data'));
  const root = parse(JSON.stringify({ ...change(attempt()), unexpected: { nested: { huge: 'ignored' } } })).value;
  assert(Object.hasOwn(root, 'unexpected'));
  assert.throws(() => validateSAT('attempts', 'a1', root, 1000), code('invalid_sat_data'));
});

test('review: malformed projected snapshot/recovery containers cannot become valid by omission', () => {
  for (const broken of [
    { questionSnapshots: { q1: { id: 'q1' } } },
    { questionSnapshots: [{ id: ['q1'] }] },
    { answers: [{ q1: { answered: true, correctness: true } }] },
    { answers: { q1: { answered: [], correctness: true } } },
    { status: 'incomplete', resumable: true, runtimeSnapshot: { activePractice: { id: 'a1', questionIds: ['q1'] }, questionStates: [null] } },
    { status: 'incomplete', resumable: true, runtimeSnapshot: { activePractice: { id: 'a1', questionIds: { 0: 'q1' } }, questionStates: [{}] } },
  ]) assert.throws(() => validateSAT('attempts', 'a1', parse(JSON.stringify(change(attempt(broken)))).value, 1000), code('invalid_sat_data'));
});

test('review: actual save/resume shape preserves full runtime, question annotations, module timing and SPR responses', async t => {
  const store = new AccountStore(storage(t)), now = 1_700_000_000_000;
  const ids = ['pack-rw:q1@1', 'pack-rw:%E6%9D%90%E6%96%99@1', 'pack-math:q1@2', 'pack-math:formula%2Fitem@1'];
  const modules = [
    { start: 0, end: 1, section: 'Reading and Writing', sectionNumber: 1, moduleNumber: 1, durationSeconds: 1920 },
    { start: 1, end: 2, section: 'Reading and Writing', sectionNumber: 1, moduleNumber: 2, durationSeconds: 1920 },
    { start: 2, end: 3, section: 'Math', sectionNumber: 2, moduleNumber: 1, durationSeconds: 2100 },
    { start: 3, end: 4, section: 'Math', sectionNumber: 2, moduleNumber: 2, durationSeconds: 2100 },
  ];
  const questions = ids.map((id, i) => ({
    id, itemId: `item-${i}`, itemRevision: 1, packId: 'anonymous-review', packRevision: 1,
    section: i < 2 ? 'Reading and Writing' : 'Math', responseType: i === 3 ? 'student-produced-response' : 'single-choice',
    passage: '匿名材料 😀', prompt: 'Synthetic question', options: ['A', 'B', 'C', 'D'], correctOption: 1,
    metadata: { sourceId: i < 2 ? 'pack-rw' : 'pack-math', sourceQuestionIndex: i, sourceFileName: 'synthetic.json' },
    packContent: { prompt: [{ type: 'text', text: 'Synthetic content' }], image: { data: 'data:image/png;base64,anonymous-fixture' } },
  }));
  const highlights = [{ id: 'h-review', block: 'passage-0', start: 0, end: 3, color: 'pink', underline: 'dashed' }];
  const states = ids.map((id, i) => ({ selectedOption: i < 2 ? 1 : null, numericResponse: i === 3 ? '1/2' : '', markedForReview: i === 2,
    eliminatedOptions: [3], highlights: structuredClone(highlights), timeSpentMs: 1000 * i, materialScrollTop: i * 20, note: 'Anonymous note' }));
  const runtime = {
    currentQuestion: 3, view: 'question', questionStates: states, endTimestamp: now + 120000, remainingSeconds: 120,
    highlightMode: true, highlightColor: 'pink', highlightUnderline: 'dashed', timerHidden: false, eliminationVisible: true,
    split: 50, completed: true, phase: 'paused', elapsedMs: 482000, remainingTimeMs: 120000, segmentStartedAt: null,
    questionEnterTimestamp: null, moduleIndex: 3, moduleResults: [{ moduleIndex: 0, reason: 'submitted', finishedAt: now - 300000 }],
    lineReaderState: { enabled: true, y: 112 }, questionTimerPanelState: { visible: true, x: 75, y: 40 }, directionsShown: true,
    activePractice: { id: 'a1', name: '匿名全真暂停', questionIds: ids, sourceIds: ['pack-rw', 'pack-math'], createdAt: now - 482000,
      libraryCollectionId: 'review-collection', fullSAT: true, standardTiming: true, untimed: false, allowOvertime: false, modules },
    finishedAt: now, finishPending: { status: 'incomplete', reason: 'saved-exit' },
  };
  const answers = Object.fromEntries(ids.map((id, i) => [id, { ...states[i], answered: i !== 2, correctness: i === 2 || i === 3 ? null : true,
    responseType: questions[i].responseType, itemId: questions[i].itemId, itemRevision: 1, correctOption: 1 }]));
  const saved = attempt({ questionIds: ids, questionSnapshots: questions, totalQuestions: ids.length, answers,
    status: 'incomplete', finishReason: 'saved-exit', startedAt: now - 482000, completedAt: now, savedAt: now,
    practiceName: '匿名全真暂停', correctCount: 2, incorrectCount: 0, unansweredCount: 1, ungradedCount: 1,
    libraryCollectionId: 'review-collection', fullSAT: true, standardTiming: true, untimed: false, allowOvertime: false,
    modules, moduleResults: runtime.moduleResults, elapsedMs: runtime.elapsedMs, remainingTimeMs: runtime.remainingTimeMs,
    durationSeconds: 8040, sourceIds: ['pack-rw', 'pack-math'], resumable: true, runtimeSnapshot: runtime });
  await store.putSAT('attempts', 'a1', req(change(saved)));
  const restored = (await store.get('attempts', 'a1').json()).value;
  assert.deepEqual(restored, saved);
  assert.deepEqual(restored.runtimeSnapshot.activePractice.questionIds.map(id => restored.questionSnapshots.find(q => q.id === id)), questions);
  assert.equal(restored.runtimeSnapshot.questionStates[3].numericResponse, '1/2');
  assert.equal(restored.runtimeSnapshot.questionStates[0].highlights[0].underline, 'dashed');
  assert.equal(restored.runtimeSnapshot.activePractice.modules[3].durationSeconds, 2100);
  const completed = { ...restored, status: 'completed', resumable: false, runtimeSnapshot: null, finishReason: 'submitted', completedAt: now + 120000 };
  await store.putSAT('attempts', 'a1', req(change(completed, 1, 'complete-resumed')));
  assert.deepEqual((await store.get('attempts', 'a1').json()).value, completed);
  await assert.rejects(() => store.putSAT('attempts', 'a1', req(change(saved, 2, 'stale-resume'))), code('attempt_completed'));
});

test('review: aggregate retained values have a bounded budget even when every string is small', () => {
  const parser = new ProjectedJSON(), element = Buffer.from('"' + 'x'.repeat(4096) + '",');
  parser.write(Buffer.from('{"value":['));
  assert.throws(() => { for (let i = 0; i < 4000; i++) parser.write(element); }, InputError);
  assert(parser.retainedWeight <= 25 * 1024 * 1024);
});

test('review: omitted object key/hash bookkeeping also has a bounded budget', () => {
  const parser = new ProjectedJSON({ select: satProjection });
  parser.write(Buffer.from('{"value":{"modules":[{'));
  let rejected = false;
  for (let i = 0; i < 120000; i++) {
    try { parser.write(Buffer.from(`${i ? ',' : ''}"key${i}":1`)); }
    catch (error) { assert(error instanceof InputError); rejected = true; break; }
  }
  assert.equal(rejected, true);
});

test('review: null is not an omitted boolean or optional home note', () => {
  for (const field of ['deleted', 'restore']) assert.throws(() => validateSAT('wrong-book', 'q1', { ...change(wrong()), [field]: null }, 100), InputError);
  assert.throws(() => validateHome({ plan: { dailyGoal: 10, note: null } }), InputError);
  assert.deepEqual(validateHome({ plan: { dailyGoal: 10 } }), { plan: { dailyGoal: 10 } });
});

test('review: superseded chunks survive pending readers and are freed on completed/cancelled streams', async t => {
  const store = new AccountStore(storage(t));
  await store.putSAT('wrong-book', 'q1', req(change(wrong({ text: 'old' }))));
  const old = store.get('wrong-book', 'q1');
  await store.putSAT('wrong-book', 'q1', req(change(wrong({ text: 'new' }), 1, 'review-update')));
  store.cleanup();
  assert.equal((await old.json()).value.questionSnapshot.text, 'old');
  store.cleanup();
  assert.equal(store.one('SELECT COUNT(*) AS n FROM uploads').n, 1);
  const reader = store.get('wrong-book', 'q1');
  await reader.body.cancel(); store.cleanup();
  assert.equal(store.readers.size, 0);
});

test('review: bootstrap pins every settings row before awaiting any value read', async t => {
  const store = new AccountStore(storage(t));
  await store.putSAT('settings', 'appConfig', req(change({ moduleQuestionLimit: 10, examTimerWarning: 'fixed' })));
  await store.putSAT('settings', 'questionTimer', req(change({ enabled: true, mode: 'up' })));
  const load = store.load.bind(store); let interleaved = false;
  store.load = async row => {
    if (!interleaved) {
      interleaved = true;
      await store.putSAT('settings', 'questionTimer', req(change({ enabled: false, mode: 'down' }, 1, 'settings-replacement')));
    }
    return load(row);
  };
  const value = await (await store.bootstrap()).json();
  assert.deepEqual(value.settings.find(item => item.key === 'questionTimer'), { key: 'questionTimer', revision: 1, value: { enabled: true, mode: 'up' } });
  assert.equal(store.readers.size, 0);
  store.cleanup();
  assert.equal(store.one('SELECT COUNT(*) AS n FROM uploads').n, 2);
});

test('review: SQLite physical-size headroom rejects writes before new payloads or revisions commit', async t => {
  const backing = storage(t), store = new AccountStore(backing), MiB = 1024 * 1024;
  await store.putSAT('wrong-book', 'q1', req(change(wrong({ text: 'retained' }))));
  await (await store.putState('home', req({ revision: 0, value: { plan: { dailyGoal: 10 } } }))).body.cancel();
  const before = store.one('SELECT COUNT(*) AS n FROM uploads').n;
  backing.sql.databaseSize = 896 * MiB;
  await assert.rejects(() => store.putSAT('wrong-book', 'q1', req(change(wrong({ text: 'not-committed' }), 1, 'capacity'))), code('sat_storage_limit'));
  await assert.rejects(() => store.putState('home', req({ revision: 1, value: { plan: { dailyGoal: 20 } } })), code('sat_storage_limit'));
  assert.equal(store.row('wrong-book', 'q1').revision, 1);
  assert.equal(store.row('home', 'settings').revision, 1);
  assert.equal(store.one('SELECT COUNT(*) AS n FROM uploads').n, before);
  assert.equal(store.staging.size, 0);
  assert.equal((await store.get('wrong-book', 'q1').json()).value.questionSnapshot.text, 'retained');
  backing.sql.databaseSize = 892 * MiB;
  assert.doesNotThrow(() => store.capacity(4 * MiB));
  assert.throws(() => store.capacity(4 * MiB + 1), code('sat_storage_limit'));
  backing.sql.databaseSize = 850 * MiB;
  await store.putSAT('wrong-book', 'q1', req({ revision: 1, mutationId: 'capacity-delete', deleted: true }));
  assert.equal(store.row('wrong-book', 'q1').deleted, 1, 'small tombstones must not reserve the entire 64 MiB upload maximum');
});

test('review: staged chunk storage failure rolls back uncommitted bytes without losing the previous value', async t => {
  const backing = storage(t), store = new AccountStore(backing);
  await store.putSAT('wrong-book', 'q1', req(change(wrong({ text: 'retained' }))));
  const exec = backing.sql.exec; let failOnce = true;
  backing.sql.exec = (query, ...args) => {
    if (failOnce && query.startsWith('INSERT INTO chunks')) { failOnce = false; throw new Error('synthetic SQLite capacity failure'); }
    return exec(query, ...args);
  };
  await assert.rejects(() => store.putSAT('wrong-book', 'q1', req(change(wrong({ text: 'uncommitted' }), 1, 'storage-error'))), /synthetic SQLite capacity failure/);
  assert.equal(store.row('wrong-book', 'q1').revision, 1);
  assert.equal(store.one('SELECT COUNT(*) AS n FROM uploads').n, 1);
  assert.equal(store.staging.size, 0);
  assert.equal((await store.get('wrong-book', 'q1').json()).value.questionSnapshot.text, 'retained');
});

test('review: account DO independently checks token, supplied owner, bound owner and post-upload revocation', async t => {
  const backing = storage(t); let valid = true, activeId = 'owner-a', checks = 0;
  const env = { AUTH: { getByName(name) { assert.equal(name, 'platform-auth-v1'); return { async fetch(_url, options) {
    checks++; const { token } = JSON.parse(options.body);
    return Response.json({ authenticated: valid && token === 'session-token', user: valid ? { id: activeId, role: 'student' } : null });
  } }; } } };
  const object = new PlatformAccountStore({ storage: backing }, env);
  const call = (owner, token = 'session-token', method = 'GET', body) => object.fetch(new Request('https://internal/api/me/home', {
    method, headers: { 'X-Platform-User': owner, 'X-Platform-Token': token }, body,
  }));
  assert.equal((await call('owner-a', 'invalid')).status, 401);
  assert.equal((await call('owner-b')).status, 409);
  assert.equal((await call('owner-a')).status, 200);
  activeId = 'owner-b';
  assert.equal((await call('owner-b')).status, 403);
  activeId = 'owner-a';
  const original = object.verify.bind(object);
  object.verify = async request => { const user = await original(request); valid = false; return user; };
  const response = await call('owner-a', 'session-token', 'PUT', JSON.stringify({ revision: 0, value: { plan: { dailyGoal: 1 } } }));
  assert.equal(response.status, 401);
  assert.equal(object.store.row('home', 'settings'), undefined);
  assert(checks >= 6);
});

test('review: TOEFL state shapes and home conflicts preserve original client contract', async t => {
  const store = new AccountStore(storage(t));
  await (await store.putState('toefl', req({ key: 'four.words.v1', value: { anonymous: true }, revision: 0 }))).body.cancel();
  await (await store.putState('toefl', req({ key: 'four.learning.v1', value: [], revision: 0 }))).body.cancel();
  assert.deepEqual((await store.state('toefl').json()).items.map(item => item.key), ['four.learning.v1', 'four.words.v1']);
  const me = { id: 'anonymous-owner', role: 'student' };
  const bootstrap = await store.state('toefl', me).json();
  assert.deepEqual(bootstrap.me, { ...me, aiReady: false });
  assert.equal(bootstrap.state.items.length, 2);
  await assert.rejects(() => store.putState('toefl', req({ key: 'four.learning.v1', value: {}, revision: 1 })), InputError);
  await assert.rejects(() => store.putState('toefl', req({ key: 'four.words.v1', value: [], revision: 1 })), InputError);
});
