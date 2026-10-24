import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

// Run the actual browser bank + platform bridge, without a server, persistent
// storage, private records, or generated assets. The original localhost-only
// gate is invisible to workerd tests whose browser URL is 127.0.0.1.
const bankSource = await readFile(new URL('../../../front-end/sat/js/question-bank.js', import.meta.url), 'utf8');
const bridgeSource = await readFile(new URL('../../../front-end/web/sat-bridge.js', import.meta.url), 'utf8');
const owner = 'a'.repeat(32);
const session = (role = 'admin') => ({ authenticated: true, user: { id: owner, role } });
const rawText = JSON.stringify({ title: 'Original synthetic SAT fixture', questions: [{ question: 'What is 1 + 1?', answer: '2' }] });
const savedFile = { name: 'sat-anonymous-fixture.json', text: rawText, lastModified: 1700000000000 };

async function browser({
  url = 'https://school.example/sat/html/index.html', injectedSession,
  status = { service: 'sat-question-bank-v1', token: 'synthetic-csrf-token', writable: true },
  statusCode = 200, postCode = 201, postValue = savedFile, files = [],
} = {}) {
  const calls = [], previews = [], commits = [], storageReads = [];
  class Storage {
    constructor() { this.values = new Map(); }
    getItem(key) { return this.values.get(String(key)) ?? null; }
    setItem(key, value) { this.values.set(String(key), String(value)); }
    removeItem(key) { this.values.delete(String(key)); }
  }
  const context = {
    URL, URLSearchParams, Headers, File, AbortController, setTimeout, clearTimeout,
    location: new URL(url), Storage, localStorage: new Storage(), console,
    indexedDB: { open() { throw new Error('No database should be opened by these tests.'); } },
    document: { readyState: 'complete' },
    SATStorage: {
      async get(store, key) { storageReads.push({ store, key }); return null; },
      async all(store) { storageReads.push({ store }); return []; },
    },
    SATImporter: {
      async preview(file) {
        const text = await file.text();
        previews.push({ name: file.name, text, lastModified: file.lastModified });
        return { fileName: file.name, rawText: text, contentHash: 'synthetic:' + file.name, errors: [], warnings: [], count: 1 };
      },
      async commit(preview) { commits.push(preview); return preview.count; },
    },
    async fetch(input, init = {}) {
      const target = new URL(typeof input === 'string' ? input : input.url, url);
      const method = String(init.method || 'GET').toUpperCase();
      const call = { url: target.href, path: target.pathname, method, headers: new Headers(init.headers), body: init.body, cache: init.cache, signal: init.signal };
      calls.push(call);
      assert.equal(target.origin, new URL(url).origin, 'bank access must remain same-origin');
      let value, code = 200;
      if (call.path === '/api/question-bank/status' && method === 'GET') { value = status; code = statusCode; }
      else if (call.path === '/api/sat-packs' && method === 'GET') value = { collectionId: null, packs: [], assessment: null };
      else if (call.path === '/api/question-bank' && method === 'GET') value = { files, errors: [] };
      else if (call.path === '/api/question-bank' && method === 'POST') { value = postValue; code = postCode; }
      else throw new Error('Unexpected request: ' + method + ' ' + call.path);
      return { ok: code >= 200 && code < 300, status: code, async json() { return structuredClone(value); } };
    },
  };
  if (injectedSession !== undefined) context.PlatformSession = injectedSession;
  context.window = context;
  vm.createContext(context);
  vm.runInContext(bridgeSource, context, { filename: 'sat-bridge.js' });
  vm.runInContext(bankSource, context, { filename: 'question-bank.js' });
  await context.SATPlatformBridge.ready;
  return { context, bank: context.SATBank, calls, previews, commits, storageReads };
}

function preview() { return { fileName: 'synthetic.json', rawText }; }

test('HTTPS authenticated platform connects the shared bank and saves through the owner-bound backend', async () => {
  const { bank, calls, previews } = await browser({ injectedSession: session() });
  await bank.init();
  assert.equal(bank.state.mode, 'local');
  assert.equal(bank.state.connected, true);
  assert.equal(bank.state.writable, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/question-bank/status');
  assert.equal(calls[0].cache, 'no-store');
  assert.ok(calls[0].signal instanceof AbortSignal);
  await bank.prepareWrite();
  const imported = preview();
  assert.equal(await bank.saveFile(imported), true);
  const write = calls[1];
  assert.equal(write.path, '/api/question-bank');
  assert.equal(write.method, 'POST');
  assert.equal(write.headers.get('Content-Type'), 'application/json');
  assert.equal(write.headers.get('X-SAT-Bank-Token'), 'synthetic-csrf-token');
  assert.equal(write.headers.get('X-Account-ID'), owner);
  assert.deepEqual(JSON.parse(write.body), { name: 'synthetic.json', text: rawText });
  assert.equal(imported.savedToBank, true);
  assert.equal(imported.fileName, savedFile.name);
  assert.equal(imported.bankFile.lastModified, savedFile.lastModified);
  assert.equal(previews.length, 1, 'the bridge validates the server-normalized text before import');
  assert.equal(previews[0].text, savedFile.text);
});

test('HTTPS without a verified injected account stays browser-only and sends no bank request', async () => {
  for (const injectedSession of [undefined, {}, { authenticated: false, user: { id: owner } }, { authenticated: true }, { authenticated: true, user: {} }, { authenticated: true, user: { id: '' } }]) {
    const { bank, calls } = await browser({ injectedSession });
    await bank.init();
    assert.equal(bank.state.mode, 'browser');
    assert.equal(bank.state.connected, false);
    assert.equal(bank.state.writable, false);
    assert.equal(await bank.saveFile(preview()), false);
    assert.equal(calls.length, 0);
  }
});

test('standalone HTTP loopback retains automatic bank connection without a platform session', async () => {
  const { bank, calls } = await browser({ url: 'http://127.0.0.1:8876/sat/html/index.html' });
  await bank.init();
  assert.equal(bank.state.mode, 'local');
  assert.equal(bank.state.connected, true);
  assert.equal(bank.state.writable, true);
  assert.equal(await bank.saveFile(preview()), true);
  assert.equal(calls[1].method, 'POST');
  assert.equal(calls[1].headers.get('X-Account-ID'), null);
  assert.equal(calls[1].headers.get('X-SAT-Bank-Token'), 'synthetic-csrf-token');
});

test('HTTP on a non-loopback host is not treated as a verified platform', async () => {
  const { bank, calls } = await browser({ url: 'http://school.example/sat/html/index.html' });
  await bank.init();
  assert.equal(bank.state.mode, 'browser');
  assert.equal(calls.length, 0);
});

test('HTTPS students receive read-only bank state and empty active collection falls back to shared legacy files', async () => {
  const { bank, calls, previews, commits } = await browser({
    injectedSession: session('student'), status: { service: 'sat-question-bank-v1', token: 'synthetic-student-csrf', writable: false }, files: [savedFile],
    postCode: 403, postValue: { error: 'Only administrators can modify shared questions.' },
  });
  await bank.init();
  assert.equal(bank.state.mode, 'local');
  assert.equal(bank.state.connected, true);
  assert.equal(bank.state.writable, false);
  await assert.rejects(bank.prepareWrite(), /Only administrators/);
  assert.equal(calls.length, 1, 'prepareWrite blocks the import before any write request');
  await bank.sync();
  assert.deepEqual(calls.map(call => call.path), ['/api/question-bank/status', '/api/sat-packs', '/api/question-bank']);
  assert.equal(previews.length, 1);
  assert.equal(commits.length, 1);
  assert.equal(bank.state.collectionId, null);
  assert.equal(bank.state.assessment, null);
  assert.equal(bank.state.busy, false);
  assert.equal(bank.state.errors.length, 0);
  assert.equal(bank.state.writable, false);
  const imported = preview();
  await assert.rejects(bank.saveFile(imported), error => error.status === 403);
  assert.equal(calls.at(-1).headers.get('X-Account-ID'), owner);
  assert.equal(imported.savedToBank, undefined, 'a direct unauthorized write cannot be recorded as saved');
});

test('failed or wrong-service status does not grant cloud-bank connectivity', async () => {
  for (const options of [
    { statusCode: 401, status: { error: 'Please log in.' } },
    { status: { service: 'unrelated-service', token: 'not-a-bank', writable: true } },
  ]) {
    const { bank, calls } = await browser({ injectedSession: session(), ...options });
    await bank.init();
    assert.equal(bank.state.mode, 'browser');
    assert.equal(bank.state.connected, false);
    assert.equal(bank.state.writable, false);
    assert.equal(await bank.saveFile(preview()), false);
    assert.equal(calls.length, 1);
  }
});

test('SAT deep links reach account-menu settings/conflicts and original management actions', async () => {
  for (const [view, attribute] of [['timingSettings', 'data-account-action'], ['syncConflicts', 'data-account-action'], ['startPractice', 'data-action']]) {
    const clicked = [], warnings = [], history = [];
    class Storage { getItem() { return null; } setItem() {} removeItem() {} }
    const context = { URL, URLSearchParams, Storage, location: new URL('https://school.example/sat/html/index.html?view=' + view),
      localStorage: new Storage(), indexedDB: { open() {} }, SATApp: { ready: Promise.resolve() },
      console: { warn(...args) { warnings.push(args); } }, history: { replaceState(...args) { history.push(args); } },
      document: { readyState: 'complete', querySelector(selector) {
        return selector.split(',').map(value => value.trim()).includes(`[${attribute}="${view}"]`) ? { click() { clicked.push(view); } } : null;
      } },
    };
    context.window = context; vm.createContext(context);
    vm.runInContext(bridgeSource, context, { filename: 'sat-bridge.js' });
    await context.SATPlatformBridge.ready;
    assert.deepEqual(clicked, [view]); assert.deepEqual(warnings, []);
    assert.equal(history[0][2], '/sat/html/index.html');
  }
});

test('new SAT packs remain outside the legacy writable bank', async () => {
  const { bank, calls } = await browser({ injectedSession: session() });
  await bank.init();
  assert.equal(await bank.saveFile({ ...preview(), isSATPack: true }), false);
  assert.equal(calls.length, 1);
});
