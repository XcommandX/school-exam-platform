'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Only original, in-memory metadata and a synthetic payload are used here.
const fullModule = {section: 'reading-writing', moduleNumber: 1, questionCount: 2, durationSeconds: 120};
const metadata = (collectionId, title, category, extra = {}) => ({collectionId, title, category, questionCount: 2, fullSAT: false, modules: [fullModule], sectionCounts: {'reading-writing': 2}, ...extra});
const catalog = {
  schemaVersion: 1, available: true, errors: [], categories: [
    {id: 'full-length', collections: [
      metadata('test-old', '24年3月测试卷（去重精校版）', 'full-length'),
      metadata('test-new', '2026年5月测试卷', 'full-length', {items: [{privateQuestion: 'MUST_NOT_BE_RETAINED'}], sourceCategory: '测试'}),
      metadata('test-day', '2026-05-02 测试卷', 'full-length'),
      metadata('test-undated', '无日期测试卷', 'full-length'),
      metadata('test-practice', '原创 2027年1月样例', 'full-length'),
      metadata('test-invalid-day', '2026-02-31 测试卷', 'full-length'),
      metadata('unsafe"<button>', 'Rejected metadata', 'full-length')
    ]},
    {id: 'reading-writing', collections: [metadata('test-rw', '<img src=x onerror=alert(1)>', 'reading-writing', {modules: [{...fullModule, answers: ['secret']}], sectionCounts: {'reading-writing': 2, answers: 'secret'}})]},
    {id: 'math', collections: [metadata('test-math', 'Math Sample', 'math', {sectionCounts: {math: 2}, modules: [{section: 'math', moduleNumber: 3, questionCount: 2}]})]}
  ]
};

function harness(response = catalog) {
  const requests = [];
  const context = vm.createContext({window: {}, AbortController, setTimeout, clearTimeout,
    fetch: async (url, options) => {
      requests.push({url, options});
      return {ok: true, json: async () => url === '/api/sat-library' ? structuredClone(response) : {collectionId: 'test-new', packs: [{id: 'synthetic', files: []}], assessment: null}};
    }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../front-end/sat/js/library.js'), 'utf8'), context);
  return {library: context.window.SATLibrary, requests, context};
}

(async () => {
  const {library, requests, context} = harness();
  assert.equal(library.state.status, 'idle');
  assert.equal(library.state.category, '测试');
  assert.equal(requests.length, 0, 'module loading does not request metadata or questions');
  assert.match(library.render(), /Loading tests/);
  await Promise.all([library.refresh(), library.refresh()]);
  assert.equal(requests.length, 1, 'concurrent refresh calls share the metadata request');
  assert.equal(requests[0].url, '/api/sat-library');
  assert.equal(library.state.status, 'ready');
  assert.equal(library.state.catalog.length, 8);
  assert.equal(library.find('test-new').items, undefined);
  assert.equal(JSON.stringify(library.state.catalog).includes('MUST_NOT_BE_RETAINED'), false);
  assert.equal(JSON.stringify(library.state.catalog).includes('secret'), false);
  assert.equal(library.find('test-rw').modules[0].answers, undefined);
  assert.equal(library.find('unsafe"<button>'), null);
  assert.equal(library.state.selectedId, 'test-day');

  const html = library.render([{status: 'completed', libraryCollectionId: 'test-new'}, {status: 'incomplete', libraryCollectionId: 'test-old'}, {status: 'completed', sourceIds: ['test-old']}]);
  assert.match(html, /Full-Length Tests/);
  assert.match(html, /Reading and Writing/);
  assert.match(html, />Math<\/button>/);
  assert.doesNotMatch(html, /datetime="2026-05"/);
  assert.match(html, /datetime="2026-05-02"/);
  assert.match(html, /May\. 2, 2026/);
  assert.match(html, /Practice Tests/);
  assert.match(html, /Undated Tests/);
  assert.doesNotMatch(html, /datetime="2027-01"|datetime="2026-02-31"|去重|精校/);
  assert.match(html, /data-action="library-review" data-id="test-new"/);
  assert.match(html, /data-action="library-restart" data-id="test-new"/);
  assert.match(html, /data-action="library-start" data-id="test-old"/);
  assert.doesNotMatch(html, /data-action="library-review" data-id="test-old"/);
  assert.match(html, /Partial Test/);
  const paused = library.render([{status: 'incomplete', libraryCollectionId: 'test-new', resumable: true, runtimeSnapshot: {synthetic: true}}, {status: 'completed', libraryCollectionId: 'test-new'}]);
  assert.match(paused, /data-action="library-resume" data-id="test-new"/);
  assert.match(paused, /data-action="library-review" data-id="test-new"/);
  assert.match(paused, /In Progress/);
  assert.doesNotMatch(library.render([{status: 'incomplete', libraryCollectionId: 'test-new', resumable: false}]), /library-resume/);
  assert.equal(requests.length, 1, 'rendering every card never loads a question package');
  assert.equal(library.find('test-new').examDate.source, 'official-schedule');
  assert.equal(library.find('test-new').examDate.precision, 'day');
  assert.equal(library.find('test-new').examDate.key, '2026-05-02');
  assert.match(library.find('test-new').examDate.sourceUrl, /^https:\/\/satsuite\.collegeboard\.org\//);

  const schedule = [...library.officialSchedule];
  assert.equal(schedule.length, 17);
  assert.ok(schedule.every(entry => entry.precision === 'day' && entry.source === 'official-schedule' && entry.sourceUrl.startsWith('https://')));
  const dates = harness({schemaVersion: 1, available: true, errors: [], categories: [{id: 'full-length', collections: [
    ...schedule.map((entry, index) => metadata(`date-${index}`, `${entry.month.slice(0, 4)}年${Number(entry.month.slice(5))}月A卷`, 'full-length')),
    metadata('school-day', '2024年4月School Day', 'full-length'),
    metadata('school-unknown', '2025年3月School Day', 'full-length'),
    metadata('bluebook-dated', '2026年3月Bluebook', 'full-length'),
    metadata('mixed-dated', '2026年3月难题拼卷', 'full-length'),
    metadata('aggregate-dated', '2026年3月零散汇总', 'full-length'),
    metadata('unverified-month', '2027年2月A卷', 'full-length')
  ]}]});
  await dates.library.refresh();
  schedule.forEach((entry, index) => {
    const actual = dates.library.find(`date-${index}`).examDate;
    assert.equal(actual.key, entry.date);
    assert.equal(actual.source, 'official-schedule');
    assert.equal(actual.sourceUrl, entry.sourceUrl);
  });
  assert.equal(dates.library.find('school-day').examDate.key, '2024-04');
  assert.equal(dates.library.find('school-day').examDate.precision, 'month');
  assert.equal(dates.library.find('school-day').examDate.sourceUrls.length, 2);
  for (const id of ['school-unknown', 'bluebook-dated', 'mixed-dated', 'aggregate-dated']) assert.equal(dates.library.find(id).examDate.key, 'undated');
  assert.equal(dates.library.find('unverified-month').examDate.precision, 'month');
  assert.equal(dates.library.find('unverified-month').examDate.source, 'source-title');
  assert.match(dates.library.render(), /datetime="2024-04"/);
  assert.doesNotMatch(dates.library.render(), /datetime="2024-04-01"/);

  library.select('test-new');
  assert.equal(library.state.selectedId, 'test-new');
  library.setCategory('英语');
  assert.equal(library.state.selectedId, 'test-rw');
  const reading = library.render();
  assert.match(reading, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(reading, /<img|sat-library-time-group/);
  library.select('test-new');
  assert.equal(library.state.selectedId, 'test-rw', 'selecting a different category cannot hide the current selection');
  library.setCategory('math');
  assert.equal(library.state.category, '数学');
  assert.match(library.render(), /Math Sample/);
  library.setCategory('unknown');
  assert.equal(library.state.category, '数学');
  await assert.rejects(library.collection('../private'), /unavailable/);
  assert.equal(requests.length, 1);
  const payload = await library.collection('test-new');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, '/api/sat-library/collections/test-new');
  assert.equal(payload.packs[0].id, 'synthetic');

  const disconnected = harness({schemaVersion: 1, available: false, categories: [], errors: []});
  await disconnected.library.refresh();
  assert.match(disconnected.library.render(), /No test library is connected/);
  const partial = harness({...catalog, errors: [{collectionId: 'unavailable', error: 'Damaged synthetic set'}]});
  await partial.library.refresh();
  assert.match(partial.library.render(), /1 test collection is unavailable/);
  context.fetch = async () => ({ok: false, status: 503});
  await library.refresh();
  assert.equal(library.state.status, 'error');
  assert.match(library.render(), /role="alert"/);
  assert.match(library.render(), /data-action="library-refresh">Retry<\/button>/);
  context.fetch = async () => {const error = new Error('aborted'); error.name = 'AbortError'; throw error;};
  await library.refresh();
  assert.match(library.state.message, /too long/);
  const invalid = harness({schemaVersion: 2, categories: []});
  await invalid.library.refresh();
  assert.equal(invalid.library.state.status, 'error');

  const css = fs.readFileSync(path.join(__dirname, '../../front-end/sat/css/library.css'), 'utf8');
  assert.ok(css.split('\n').filter(line => line.includes('{') && !line.startsWith('@media')).every(line => line.trim().startsWith('.app-shell[data-sat-management]')), 'all UI rules stay in the management scope');
  console.log('SAT library: metadata-only requests, lazy explicit package load, date precision, category/selection, attempt actions, escaping, failure states and management CSS scope passed.');
})().catch(error => {console.error(error); process.exitCode = 1;});
