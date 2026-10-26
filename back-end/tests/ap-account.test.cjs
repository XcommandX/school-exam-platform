'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const M = require('../../front-end/ap/ap-model.js');
const Home = require('../../front-end/web/home-model.js');
const source = M.validateSource(require('../../front-end/ap/examples/synthetic-practice.json'));
const now = Date.now();
const draft = M.createDraft(source, now - 1000, 'ap-attempt:account-test', true);
const record = M.finish(source, draft, now);
const root = path.resolve(__dirname, '../..');
const ui = fs.readFileSync(path.join(root, 'front-end/ap/app.js'), 'utf8');
function storage() {
  const data = new Map(), reads = [], writes = [];
  return {data, reads, writes, getItem(key) {reads.push(key);return data.get(key) ?? null;}, setItem(key, value) {writes.push(key);data.set(key, value);}};
}
test('AP storage requires an explicit account and rejects namespace injection', () => {
  for (const id of [undefined, null, '', '../a', 'a:b', {}, 123]) {
    assert.throws(() => M.storageKeys(id));
    assert.throws(() => M.createStorage(storage(), undefined, id));
  }
  assert.equal(M.storageKeys('user-a').history, 'school-exam-platform:account:user-a:ap:history:v1');
});
test('accounts cannot read each other; anonymous records are neither read nor migrated', () => {
  const s = storage();
  const legacy = 'school-exam-platform:ap:history:v1';
  s.data.set(legacy, JSON.stringify([record]));
  const a = M.createStorage(s, undefined, 'user-a'), b = M.createStorage(s, undefined, 'user-b');
  assert.deepEqual(a.read('history'), []);
  a.write('history', [record]); a.write('drafts', [draft]);
  assert.equal(a.read('history').length, 1);
  assert.equal(a.read('drafts').length, 1);
  assert.deepEqual(b.read('history'), []); assert.deepEqual(b.read('drafts'), []);
  assert.ok(!s.reads.includes(legacy) && !s.writes.includes(legacy));
  assert.equal(s.data.get(legacy), JSON.stringify([record]));
});
test('expired document cannot read cached records or write under either identity', () => {
  const s = storage(); let active = true;
  const a = M.createStorage(s, undefined, 'user-a', () => active);
  a.write('drafts', [draft]); a.read('drafts');
  const snapshot = [...s.data], reads = s.reads.length, writes = s.writes.length;
  active = false;
  assert.deepEqual(a.read('drafts'), []); assert.equal(a.write('drafts', []), false);
  assert.deepEqual([...s.data], snapshot); assert.equal(s.reads.length, reads); assert.equal(s.writes.length, writes);
});
test('revocation also clears quota-failure memory fallback', () => {
  let active = true;
  const a = M.createStorage(null, undefined, 'user-a', () => active);
  a.write('drafts', [draft]); assert.equal(a.read('drafts').length, 1);
  active = false; assert.deepEqual(a.read('drafts'), []);
  active = true; assert.deepEqual(a.read('drafts'), []);
});
test('AP app never touches DOM, storage or network without an active authenticated owner', () => {
  for (const auth of [undefined, {active:false,user:{id:'user-a'}}, {active:true,user:null}]) {
    vm.runInNewContext(ui, {window:{PlatformAuth:auth}});
  }
});
test('AP uses shared session guard and clears personal UI when session ends', () => {
  const html = fs.readFileSync(path.join(root, 'front-end/ap/index.html'), 'utf8');
  assert.ok(html.indexOf('/web/platform-auth.js') < html.indexOf('/ap/app.js'));
  assert.match(ui, /return await auth\.api\(path/);
  assert.doesNotMatch(ui, /await fetch\(/);
  assert.match(ui, /accountId, active\)/);
  assert.match(ui, /platform:session-ended/);
  assert.match(ui, /clearInterval\(timerInterval\)/);
  assert.match(ui, /state\.draft = null/);
  assert.match(ui, /document\.getElementById\('ap-main'\)\.hidden = true/);
});
test('home AP statistics are opt-in account-scoped, validated, and exclude synthetic exercises', () => {
  const a = {...record, contentMode:'private', questionCount:5, answeredCount:3, gradedCount:2, correctCount:1};
  const summary = Home.summarize([], [], [], now, [a, a, record, {...a,id:'bad',correctCount:6}]);
  assert.deepEqual(summary.ap, {answers:3,correct:1,graded:2,attempts:1});
  assert.equal(Home.summarize([],[],[],now).ap.attempts, 0);
  const home = fs.readFileSync(path.join(root,'front-end/web/app.js'),'utf8');
  assert.match(home, /apHistory:prefix\+'ap:history:v1'/);
  assert.doesNotMatch(home, /school-exam-platform:ap:/);
  for (const feature of ['/api/me/home','/api/toefl/state','/api/sat/summary','manage-accounts','logout-button','homeConflict']) assert.ok(home.includes(feature));
});
