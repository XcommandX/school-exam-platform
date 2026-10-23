import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const local = new URL('./cloud-client.js', import.meta.url);
const source = fs.readFileSync(fs.existsSync(local) ? local : new URL('../../../../front-end/toefl/clients/cloud-client.js', import.meta.url), 'utf8')
  .replace('export async function initializeCloud', 'async function initializeCloud');
const namespace = 'school-exam-platform:account:original-user:toefl:';
const otherKey = 'school-exam-platform:account:other-user:toefl:four.history.v1';
const store = new Map([['four.history.v1', '[{"id":"unowned"}]'], [otherKey, '[{"id":"other"}]']]);
const requests = [], deleted = [];
let locked = 0, loggedOut = 0, expired = false, switched = false;
const server = {revision: 1, value: [{id: 'server-history'}]};
const context = {
  structuredClone, AbortController, AbortSignal, Date, console,
  setTimeout: () => 1, clearTimeout() {}, setInterval() {},
  BroadcastChannel: class {postMessage() {}},
  indexedDB: {deleteDatabase: name => deleted.push(name)},
  localStorage: {getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key)},
  window: {addEventListener() {}, TOEFLCloudConfig: {
    apiPath: path => path === '/api/me' ? '/api/me' : path.replace('/api/', '/api/toefl/'),
    headers: () => ({'X-Account-ID': 'original-user'}),
    storageKey: (id, key) => {assert.equal(id, 'original-user'); return namespace + key;},
    validateUser: me => assert.equal(me.id, 'original-user'),
    preserveLegacyStorage: true,
    recordingsReady: false,
    recordingDatabase: 'SchoolExamPlatform:account:original-user:toefl:recordings:v1',
    accountsUrl: '/account', lock: () => locked++, logout: async () => loggedOut++,
  }},
  document: {querySelector: () => null},
  fetch: async (path, init = {}) => {
    requests.push({path, ...init});
    assert.equal(init.headers['X-Account-ID'], 'original-user', 'bootstrap and every subsequent request identify the captured page owner');
    assert.equal(init.credentials, 'same-origin');
    if (switched) return {status: 409, ok: false, json: async () => ({code: 'account_changed'})};
    if (expired) return {status: 401, ok: false, json: async () => ({code: 'session_changed'})};
    if (path === '/api/toefl/bootstrap') return {ok: true, json: async () => ({me: {id: 'original-user', username: 'Original User', role: 'user', aiReady: false}, state: {items: [{key: 'four.history.v1', ...server}]}})};
    if (path === '/api/toefl/state' && init.method === 'PUT') {
      const data = JSON.parse(init.body);
      assert.equal(data.revision, server.revision);
      server.value = structuredClone(data.value);
      server.revision++;
      return {ok: true, json: async () => ({revision: server.revision, value: server.value})};
    }
    if (path === '/api/me') return {ok: true, json: async () => ({id: 'original-user'})};
    throw new Error('Unexpected endpoint: ' + path);
  },
};
vm.createContext(context);
vm.runInContext(source, context);
await vm.runInContext('initializeCloud()', context);
const cloud = context.window.PracticeCloud;
assert.equal(cloud.username, 'Original User');
assert.equal(cloud.storageKey('four.history.v1'), namespace + 'four.history.v1');
assert.equal(cloud.recordingsReady, false);
assert.equal(cloud.accountsUrl, '/account');
assert.match(cloud.recordingDatabase, /account:original-user:toefl:/);
assert.equal(JSON.parse(store.get(namespace + 'four.history.v1'))[0].id, 'server-history');
assert.equal(store.get(otherKey), '[{"id":"other"}]');
assert.equal(store.get('four.history.v1'), '[{"id":"unowned"}]');
assert.deepEqual(deleted, [], 'platform login preserves unowned and legacy recording databases');
cloud.queue('four.history.v1', [...server.value, {id: 'new-attempt'}]);
await vm.runInContext('flush()', context);
assert.equal(server.value.at(-1).id, 'new-attempt');
assert.equal(store.has(namespace + 'cloud.pending.four.history.v1'), false);
await vm.runInContext("api('/api/me')", context);
await cloud.logout();
assert.equal(loggedOut, 1, 'TOEFL logout uses the unified platform logout hook');
assert.equal(locked, 0);
assert(!requests.some(row => row.path === '/api/logout' || row.path === '/api/toefl/logout'));
expired = true;
await assert.rejects(vm.runInContext("api('/api/me')", context), /请重新登录/);
assert.equal(locked, 1);
expired = false; switched = true;
await assert.rejects(vm.runInContext("api('/api/me')", context), /请重新登录/);
assert.equal(locked, 2, 'account switches must lock immediately rather than being treated as a state version conflict');
assert.equal(store.get(otherKey), '[{"id":"other"}]');
assert.equal(store.get('four.history.v1'), '[{"id":"unowned"}]');
assert.deepEqual(deleted, [], 'session expiry never erases private local audio');
console.log('PASS: unified TOEFL session routes, captured account headers, private namespaces, shared logout and local-only recording capability preserve other accounts and unowned legacy data.');
