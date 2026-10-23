'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const M = require('../apps/ap/ap-model.js');
const example = require('../apps/ap/examples/synthetic-practice.json');
const copy = value => JSON.parse(JSON.stringify(value));
const now = Date.UTC(2026, 9, 23, 12, 0, 0);
const source = M.validateSource(example);
function attempt(id = 'ap-attempt:test') { return M.createDraft(source, now, id); }
function completed(answers = {}, id = 'ap-attempt:test') {
  const draft = attempt(id);
  draft.answers = answers;
  return M.finish(source, draft, now + 60000);
}
function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  const reads = [], writes = [];
  return { data, reads, writes, getItem(key) { reads.push(key); return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { writes.push(key); data.set(key, value); } };
}
function summary(overrides = {}) {
  return Object.assign({ id: source.id, title: source.title, section: source.section, questionCount: source.questions.length,
    defaultDurationSeconds: 3600, year: 2025, form: 'Set 1', kind: 'frq', contentMode: 'synthetic', documentCount: 0, reviewCount: 0 }, overrides);
}

test('AP model exposes CJS and browser APIs without accessing a DOM or storage', () => {
  const sandbox = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../apps/ap/ap-model.js'), 'utf8'), sandbox);
  assert.equal(typeof sandbox.APModel.validateSource, 'function');
  assert.equal(sandbox.APModel.KEYS.history, 'school-exam-platform:ap:history:v1');
  assert.equal(Object.isFrozen(M), true);
  assert.equal(M.KEYS.history, 'school-exam-platform:ap:history:v1');
});

test('committed example is original synthetic material and covers MCQ and all three FRQ tasks', () => {
  assert.equal(source.contentMode, 'synthetic');
  assert.equal(source.documents.length, 0);
  assert.equal(source.questions.length, 5);
  assert.equal(source.questions.filter(q => q.type === 'mcq').length, 2);
  assert.deepEqual(source.questions.filter(q => q.type === 'free-response').map(q => q.responseType), ['synthesis', 'rhetorical-analysis', 'argument']);
  assert.equal(source.questions.every(q => q.pages.length === 0 && q.answerProvenance.length), true);
  assert.notEqual(source, example);
});

test('source validation rejects cross-exam, invalid revisions, duplicate questions and invalid answer indices', () => {
  for (const mutate of [
    value => { value.exam = 'sat'; },
    value => { value.schemaVersion = 1; },
    value => { value.subject = 'literature'; },
    value => { value.revision = 'v1'; },
    value => { value.questions[0].id = 'sat:other:q001'; },
    value => { value.questions[1].id = value.questions[0].id; },
    value => { value.questions[0].correctOption = 20; },
    value => { value.questions[2].correctOption = 0; },
    value => { value.questions[2].responseType = 'automatic-score'; },
    value => { value.questions[0].pages = [-1]; },
    value => { value.questions[0].sourceDocument = 'missing'; }
  ]) {
    const value = copy(example); mutate(value);
    assert.throws(() => M.validateSource(value), TypeError);
  }
});

test('PDF links are same-origin, content-addressed, page-bounded and never executable', () => {
  const doc = { id: 'paper', role: 'questions', label: 'Original test document', asset: 'question-assets/ap/' + 'b'.repeat(64) + '.pdf', pageCount: 5 };
  assert.equal(M.pdfHref(doc, 2), '/' + doc.asset + '#page=2');
  for (const asset of ['javascript:alert(1)', 'https://elsewhere.test/a.pdf', '//elsewhere.test/a.pdf', 'question-assets/sat/' + 'b'.repeat(64) + '.pdf', 'question-assets/ap/../a.pdf', 'question-assets/ap/%2e%2e/a.pdf', 'question-assets/ap/a.pdf', doc.asset + '?x=1', doc.asset + '#page=2']) {
    assert.equal(M.pdfHref({ ...doc, asset }), null);
  }
  for (const page of [0, -1, 6, '1', 1.5, NaN]) assert.equal(M.pdfHref(doc, page), null);
  const privateDoc = { ...copy(example), contentMode: 'private', kind: 'reference', questions: [], documents: [doc] };
  assert.equal(M.validateSource(privateDoc).questions.length, 0);
  const privateQuestion = copy(example);
  privateQuestion.contentMode = 'private';
  assert.throws(() => M.validateSource(privateQuestion));
});

test('catalog validates independently and keeps document-only counts at zero', () => {
  const catalog = M.validateCatalog({ exam: 'ap', schemaVersion: 2, sources: [summary(), summary({ id: 'ap:scan', questionCount: 0, kind: 'mcq', contentMode: 'private', documentCount: 1 }), { id: 'sat:bad' }, summary()], errors: ['invalid file'] });
  assert.equal(catalog.sources.length, 2);
  assert.equal(catalog.errorCount, 3);
  assert.equal(catalog.sources[1].questionCount, 0);
  assert.throws(() => M.validateCatalog({ exam: 'sat', schemaVersion: 2, sources: [], errors: [] }));
  const empty = M.validateCatalog({ exam: 'ap', schemaVersion: 2, sources: [], errors: [] });
  assert.deepEqual(empty.sources, []);
});

test('catalog filters combine year, kind, search, and private/synthetic provenance', () => {
  const sources = [summary({ title: 'Practice Alpha', contentMode: 'private' }), summary({ id: 'ap:beta', title: 'Practice Beta', kind: 'mcq', year: 2024 }), summary({ id: 'ap:reference', kind: 'reference', year: null })];
  assert.equal(M.filterSources(sources, { year: '2025', kind: 'frq', search: ' ALPHA ', contentMode: 'private' }).length, 1);
  assert.equal(M.filterSources(sources, { year: '2025', kind: 'mcq' }).length, 0);
  assert.equal(M.filterSources(sources, { search: 'set 1' }).length, 3);
  assert.equal(M.filterSources(sources, { contentMode: 'synthetic' }).length, 2);
});

test('word count handles whitespace, apostrophes, hyphens and unicode; timer never shows negative time', () => {
  assert.equal(M.countWords(''), 0);
  assert.equal(M.countWords(' \n \t '), 0);
  assert.equal(M.countWords("Don't assume a well-planned café is empty.\nSecond line."), 9);
  assert.equal(M.countWords('one—two 2026'), 3);
  assert.equal(M.countWords(null), 0);
  assert.equal(M.formatTime(0), '00:00');
  assert.equal(M.formatTime(65), '01:05');
  assert.equal(M.formatTime(3601), '1:00:01');
  assert.equal(M.formatTime(-3), '00:00');
});

test('only answered verified MCQs are graded; blanks, unverified answers and FRQs never inflate scores', () => {
  const answers = { [source.questions[0].id]: 0, [source.questions[1].id]: 0, [source.questions[2].id]: 'A reasoned original essay.' };
  assert.deepEqual(M.totals(source, answers), { questionCount: 5, answeredCount: 3, gradedCount: 2, correctCount: 1 });
  assert.deepEqual(M.results(source, answers).map(item => item.status), ['correct', 'incorrect', 'ungraded', 'unanswered', 'unanswered']);
  const unverified = copy(source);
  unverified.questions[0].reviewStatus = 'needs-review';
  unverified.questions[1].correctOption = null;
  assert.deepEqual(M.totals(unverified, answers), { questionCount: 5, answeredCount: 3, gradedCount: 0, correctCount: 0 });
  assert.equal(M.totals(source, { [source.questions[0].id]: '0', [source.questions[2].id]: '  \n' }).answeredCount, 0);
  assert.equal(M.results(source, answers)[2].correct, null);
});

test('drafts resume only for an exact source, revision and content mode with valid answers', () => {
  const draft = attempt();
  draft.answers = { [source.questions[0].id]: 2, [source.questions[2].id]: 'An unfinished draft.' };
  draft.cursor = 2;
  draft.elapsedSeconds = 89;
  draft.timerEnabled = true;
  assert.deepEqual(M.restoreDraft(source, draft), draft);
  for (const changed of [{ ...source, revision: 'd'.repeat(64) }, { ...source, id: 'ap:other' }, { ...source, contentMode: 'private' }]) {
    assert.equal(M.restoreDraft(changed, draft), null);
    assert.throws(() => M.finish(changed, draft, now + 1000));
  }
  for (const changed of [
    { ...draft, cursor: 999 }, { ...draft, elapsedSeconds: -1 }, { ...draft, timerEnabled: 'yes' },
    { ...draft, answers: { 'ap:other:q001': 0 } }, { ...draft, answers: { [source.questions[0].id]: 99 } },
    { ...draft, answers: { [source.questions[2].id]: 1 } }, { ...draft, updated: now - 1 }
  ]) assert.equal(M.restoreDraft(source, changed), null);
  assert.equal(M.restoreDraft(source, Object.assign({}, draft, { answers: JSON.parse('{"__proto__":{"polluted":true}}') })), null);
  assert.equal({}.polluted, undefined);
});

test('completed records retain identity, provenance, milliseconds and submitted answers', () => {
  const answers = { [source.questions[0].id]: 1, [source.questions[2].id]: 'My essay.' };
  const draft = attempt();
  draft.answers = answers;
  const original = copy(draft);
  const result = M.finish(source, draft, now + 1500);
  assert.equal(result.status, 'completed');
  assert.equal(result.finished, now + 1500);
  assert.equal(result.sourceId, source.id);
  assert.equal(result.revision, source.revision);
  assert.equal(result.contentMode, 'synthetic');
  assert.equal(result.answeredCount, 2);
  assert.equal(result.correctCount, 0);
  assert.equal(result.gradedCount, 1);
  assert.deepEqual(result.answers, answers);
  assert.deepEqual(draft, original);
  assert.deepEqual(M.normalizeRecord(result), result);
  assert.equal(M.normalizeRecord({ ...result, correctCount: 5 }), null);
  assert.equal(M.normalizeRecord({ ...result, status: 'in-progress' }), null);
  assert.equal(M.normalizeRecord({ ...result, finished: '2026-10-23' }), null);
});

test('wrong book contains verified wrong MCQs only and never conflates revisions or sources', () => {
  const incorrect = completed({ [source.questions[0].id]: 1, [source.questions[1].id]: 1, [source.questions[2].id]: 'Essay.' });
  let wrong = M.updateWrongBook([], source, incorrect);
  assert.equal(wrong.length, 1);
  assert.equal(wrong[0].questionId, source.questions[0].id);
  wrong = M.updateWrongBook(wrong, source, incorrect);
  assert.equal(wrong.length, 1);
  assert.equal(M.updateWrongBook(wrong, source, completed({})).length, 1);
  const anotherRevision = { ...wrong[0], revision: 'f'.repeat(64) };
  wrong = M.updateWrongBook([wrong[0], anotherRevision], source, completed({ [source.questions[0].id]: 0 }));
  assert.equal(wrong.length, 1);
  assert.equal(wrong[0].revision, 'f'.repeat(64));
  assert.throws(() => M.updateWrongBook([], { ...source, revision: 'f'.repeat(64) }, incorrect));
  const unverified = copy(source);
  unverified.questions[0].reviewStatus = 'needs-review';
  assert.equal(M.updateWrongBook([], unverified, incorrect).length, 0);
});

test('storage reads and writes only exact AP keys, rejecting arbitrary namespace access', () => {
  const fake = memoryStorage({ 'old-app:history': '[{"id":"legacy"}]', 'school-exam-platform:sat:history:v1': '[{"id":"sat"}]' });
  const store = M.createStorage(fake);
  assert.deepEqual(store.read('history'), []);
  assert.equal(store.write('history', [completed()]), true);
  assert.equal(store.read('history').length, 1);
  assert.deepEqual(fake.reads, [M.KEYS.history, M.KEYS.history]);
  assert.deepEqual(fake.writes, [M.KEYS.history]);
  for (const name of ['sat', 'constructor', '__proto__', 'history:v1']) {
    assert.throws(() => store.read(name));
    assert.throws(() => store.write(name, []));
  }
  assert.equal(fake.data.get('old-app:history'), '[{"id":"legacy"}]');
  assert.equal(fake.data.get('school-exam-platform:sat:history:v1'), '[{"id":"sat"}]');
});

test('storage corruption is reported, invalid records skipped, and invalid writes do not replace valid data', () => {
  const issues = [];
  const fake = memoryStorage({ [M.KEYS.history]: 'not json', [M.KEYS.drafts]: JSON.stringify([attempt(), null, { id: 'legacy' }]) });
  const store = M.createStorage(fake, issue => issues.push(issue));
  assert.deepEqual(store.read('history'), []);
  assert.equal(store.read('drafts').length, 1);
  assert.equal(issues.filter(issue => issue.reason === 'corrupt').length, 2);
  assert.equal(store.write('history', [completed()]), true);
  assert.equal(store.write('history', [{ id: 'bad' }]), false);
  assert.equal(store.read('history').length, 1);
});

test('quota and denied storage retain work in session memory and report failure rather than fake success', () => {
  const issues = [];
  const denied = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceededError'); } };
  const store = M.createStorage(denied, issue => issues.push(issue));
  assert.deepEqual(store.read('drafts'), []);
  assert.equal(store.write('drafts', [attempt()]), false);
  assert.equal(store.read('drafts').length, 1);
  assert.equal(store.write('history', [completed()]), false);
  assert.equal(store.read('history').length, 1);
  assert.equal(issues.every(issue => issue.reason === 'unavailable'), true);
  const unavailable = M.createStorage(null);
  assert.equal(unavailable.write('history', [completed()]), false);
  assert.equal(unavailable.read('history').length, 1);
});

test('record normalization deduplicates IDs, preserves stable identity and bounds retained lists', () => {
  const record = completed();
  const result = M.normalizeList('history', [record, record, { ...record, sourceId: 'sat:bad' }, { ...record, revision: 'old' }]);
  assert.equal(result.items.length, 1);
  assert.equal(result.invalidCount, 3);
  const many = Array.from({ length: M.LIMITS.history + 5 }, (_, index) => completed({}, 'ap-attempt:' + index));
  assert.equal(M.normalizeList('history', many).items.length, M.LIMITS.history);
  assert.deepEqual(M.normalizeList('history', {}).items, []);
});

test('content remains plain text and unknown personal fields are not retained', () => {
  const raw = copy(example);
  raw.student = 'private-name';
  raw.questions[0].selectedOption = 1;
  raw.questions[0].prompt = '<img src=x onerror=alert(1)> & text';
  const normalized = M.validateSource(raw);
  assert.equal(normalized.student, undefined);
  assert.equal(normalized.questions[0].selectedOption, undefined);
  assert.equal(normalized.questions[0].prompt, raw.questions[0].prompt);
  const ui = fs.readFileSync(path.join(__dirname, '../apps/ap/app.js'), 'utf8');
  assert.doesNotMatch(ui, /\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML|document\.write\(/);
  const html = fs.readFileSync(path.join(__dirname, '../apps/ap/index.html'), 'utf8');
  assert.match(html, /href="\/web\/styles\.css"/);
  assert.match(html, /href="\/ap\/styles\.css"/);
  assert.doesNotMatch(ui, /localStorage\.(getItem|setItem|clear|removeItem)/);
});
