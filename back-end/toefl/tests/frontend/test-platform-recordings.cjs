const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const source = fs.readFileSync(path.resolve(__dirname, '../../../../front-end/toefl/four-app.js'), 'utf8');
const start = source.indexOf('async function saveRecording(');
const end = source.indexOf('function hydrateRecordings(', start);
let uploads = 0, writes = 0, timers = 0;
const context = {
  Date, navigator: {onLine: true},
  window: {PracticeCloud: {userId: 'original-user', recordingsReady: false, saveRecording() {uploads++;}}, addEventListener() {}},
  audioDB: async () => ({}), putRecording: async () => writes++,
  recordingCloudState: new Map(), purgeCancelledRecordings: async () => {},
  setTimeout: () => timers++, clearTimeout() {},
};
vm.createContext(context);
vm.runInContext(source.slice(start, end), context);
(async () => {
  await context.saveRecording('attempt:record:question', 'attempt', new Blob(['synthetic test audio']));
  await context.retryRecordingCloud();
  context.scheduleRecordingRetry();
  assert.equal(writes, 1, 'local audio must be durably stored even when remote recording storage is unavailable');
  assert.equal(uploads, 0, 'platform recordings must not call unsupported server upload endpoints');
  assert.equal(timers, 0, 'local-only audio must not create endless remote retries');
  assert.equal(context.recordingCloudState.get('attempt:record:question'), 'local');
  const controlsAt = source.indexOf('function recordControls(');
  const controlsEnd = source.indexOf('\n', controlsAt);
  Object.assign(context, {recordingKey: () => 'key', recordingUrls: new Map([['key', 'blob:local']]), recorder: null, recordStarting: false, micState: 'idle', session: null, esc: String});
  vm.runInContext(source.slice(controlsAt, controlsEnd), context);
  const html = context.recordControls({}, {});
  assert(html.includes('录音已保存在此浏览器'));
  assert(!html.includes('待同步'));
  const audioAt = source.indexOf('function audioDB('), audioEnd = source.indexOf('\n', audioAt);
  const dbContext = {window: {indexedDB: true, PracticeCloud: {userId: 'original-user', recordingDatabase: 'SchoolExamPlatform:account:original-user:toefl:recordings:v1'}}, audioDBPromise: null, indexedDB: {open(name) {assert.equal(name, 'SchoolExamPlatform:account:original-user:toefl:recordings:v1'); return {};}}};
  vm.createContext(dbContext);
  vm.runInContext(source.slice(audioAt, audioEnd), dbContext);
  dbContext.audioDB();
  console.log('PASS: platform recording capability keeps durable per-account audio local, labels it accurately and never starts unsupported uploads or retries.');
})().catch(error => {console.error(error); process.exitCode = 1;});
