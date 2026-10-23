'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const bridge = fs.readFileSync(path.join(root, 'apps/web/toefl-bridge.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'apps/toefl/src/frontend/four-app.js'), 'utf8');
const entryParser = app.match(/function entryFromUrl\(search\)\{[\s\S]*?\n\}/)?.[0];
const startupStart = app.indexOf('const initialRoute=window.history.state;');
const startupEnd = app.indexOf('\n})();', startupStart);
assert.ok(entryParser && startupStart >= 0 && startupEnd > startupStart,
  'The TOEFL module must expose its published entry parser and native startup choice.');
const startup = app.slice(startupStart, startupEnd);
const plain = value => JSON.parse(JSON.stringify(value));

function setup(search = '', state = null, pathname = '/toefl/') {
  const context = vm.createContext({URLSearchParams});
  vm.runInContext(`
    class Storage {
      constructor() { this.data = new Map(); }
      getItem(key) { return this.data.get(String(key)) ?? null; }
      setItem(key, value) { this.data.set(String(key), String(value)); }
      removeItem(key) { this.data.delete(String(key)); }
    }
    const localStorage = new Storage(), sessionStorage = new Storage();
    const recordingCalls = [], historyWrites = [];
    const window = {localStorage, sessionStorage,
      indexedDB: {open(name, version) { recordingCalls.push({name, version, owner: this === window.indexedDB}); return name; }}};
    const location = window.location = ${JSON.stringify({pathname, search})};
    const history = window.history = {state: ${JSON.stringify(state)},
      replaceState(...args) { historyWrites.push(args); this.state = args[0]; }};
    localStorage.setItem('four.history.v1', 'old-private-history');
    localStorage.setItem('four.drafts.v2', 'old-private-drafts');
    let selected, routeDepth = 0;
    const routeOwner = 'local';
    function makeEntry(view, state) { return {view, state, y: 0}; }
    function restoreRoute(route) { selected = {kind: 'restore', route}; }
    function returnToEntry(entry) { selected = {kind: 'entry', entry}; }
    function renderHome() { selected = {kind: 'home'}; }
  `, context);
  vm.runInContext(bridge, context);
  return {context, run: code => vm.runInContext(code, context)};
}

function navigate(search, state = null) {
  const fixture = setup(search, state);
  fixture.run(entryParser);
  fixture.run(startup);
  assert.equal(fixture.run('historyWrites.length'), 0, 'The platform bridge must not claim native navigation.');
  return plain(fixture.run('selected'));
}

// Exercise the actual module entry parser after the platform bootstrap.
const sections = ['reading', 'listening', 'speaking', 'writing'];
for (const section of sections) {
  const practice = {view: 'bank', state: {subject: section, module: section + '-t1', page: 0, query: ''}, y: 0};
  assert.deepEqual(navigate('?section=' + section), {kind: 'entry', entry: practice});
  assert.deepEqual(navigate('?view=practice&section=' + section), {kind: 'entry', entry: practice});
  assert.deepEqual(navigate('?view=mock&section=' + section),
    {kind: 'entry', entry: {view: 'sets', state: {setSubject: section}, y: 0}});
  assert.deepEqual(navigate('?view=plan&section=' + section),
    {kind: 'entry', entry: {view: 'learning', state: {lsubject: section, ltab: 'today'}, y: 0}});
  assert.deepEqual(navigate('?view=wrongBook&section=' + section),
    {kind: 'entry', entry: {view: 'mistakes', state: {lsubject: section, ltab: 'review'}, y: 0}});
  for (const view of ['report', 'history']) assert.deepEqual(navigate('?view=' + view + '&section=' + section),
    {kind: 'entry', entry: {view: 'history', state: {hsubject: section}, y: 0}});
  for (const view of ['home', 'progress', 'vocab']) assert.deepEqual(navigate('?view=' + view + '&section=' + section),
    {kind: 'entry', entry: {view, state: {}, y: 0}}, 'This entry ignores section filters.');
  for (const view of ['invalid', '__proto__', 'constructor']) assert.deepEqual(navigate('?view=' + view + '&section=' + section),
    {kind: 'home'}, 'An invalid view must not become an automatic section entry.');
}
assert.deepEqual(navigate('?view=mock'),
  {kind: 'entry', entry: {view: 'sets', state: {setSubject: 'full'}, y: 0}});
assert.deepEqual(navigate('?view=plan'),
  {kind: 'entry', entry: {view: 'learning', state: {ltab: 'today'}, y: 0}});
assert.deepEqual(navigate('?view=wrongBook'),
  {kind: 'entry', entry: {view: 'mistakes', state: {ltab: 'review'}, y: 0}});
for (const view of ['home', 'progress', 'vocab', 'practice', 'report', 'history']) assert.deepEqual(navigate('?view=' + view),
  {kind: 'entry', entry: {view: {practice: 'bank', report: 'history'}[view] || view, state: {}, y: 0}});
for (const search of ['', '?section=math', '?token=ignored&returnUrl=https://other.test']) {
  assert.deepEqual(navigate(search), {kind: 'home'});
}

// A deep-link URL remains unchanged while the learner navigates. Refresh must
// restore the module's page, including its new home and wrong-book views.
for (const view of ['home', 'mistakes', 'exam', 'review']) {
  const route = {state: {view, ltab: 'review'}, entry: {view: 'home', state: {}, y: 0},
    study: null, attempt: view === 'review' ? 'saved-attempt' : null,
    draft: view === 'exam' ? 'saved-draft' : null, y: 120};
  const state = {owner: 'local', depth: 1, navigationVersion: 2, toeflRoute: route};
  assert.deepEqual(navigate('?view=wrongBook&section=reading', state), {kind: 'restore', route});
}
assert.deepEqual(navigate('?view=practice&section=listening&username=ignored&token=ignored&returnUrl=https://other.test',
  {owner: 'different-account', toeflRoute: {state: {view: 'history'}}}),
  {kind: 'entry', entry: {view: 'bank', state: {subject: 'listening', module: 'listening-t1', page: 0, query: ''}, y: 0}});

const storage = setup();
assert.equal(storage.run("localStorage.getItem('four.history.v1')"), null, 'Old personal history is not read.');
assert.equal(storage.run("localStorage.getItem('four.drafts.v2')"), null, 'Old personal drafts are not read.');
for (const [oldKey, newKey] of Object.entries(plain(storage.run('window.TOEFLPlatformBridge.storageKeys')))) {
  storage.run(`localStorage.setItem(${JSON.stringify(oldKey)}, 'new-platform-value')`);
  assert.equal(storage.run(`localStorage.data.get(${JSON.stringify(newKey)})`), 'new-platform-value');
  storage.run(`sessionStorage.setItem(${JSON.stringify(oldKey)}, 'session-value')`);
  assert.equal(storage.run(`sessionStorage.data.get(${JSON.stringify(oldKey)})`), 'session-value');
  storage.run(`localStorage.removeItem(${JSON.stringify(oldKey)})`);
  assert.equal(storage.run(`localStorage.data.has(${JSON.stringify(newKey)})`), false);
}
assert.equal(storage.run("localStorage.data.get('four.history.v1')"), 'old-private-history');
assert.equal(storage.run("localStorage.data.get('four.drafts.v2')"), 'old-private-drafts');
storage.run("window.indexedDB.open('toefl-recordings-v1', 3); window.indexedDB.open('other-db', 1)");
assert.deepEqual(plain(storage.run('recordingCalls')), [
  {name: 'SchoolExamPlatform:toefl:recordings:v1', version: 3, owner: true},
  {name: 'other-db', version: 1, owner: true},
]);
assert.equal(storage.run('window.TOEFLPlatformBridge.recordingDatabase'), 'SchoolExamPlatform:toefl:recordings:v1');
assert.equal(setup('', null, '/').run('window.TOEFLPlatformBridge'), undefined);
console.log('PASS: platform TOEFL bootstrap preserves native entry mapping and page restoration, account boundaries, isolated storage and recording database.');
