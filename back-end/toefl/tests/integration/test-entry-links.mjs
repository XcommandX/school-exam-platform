import assert from 'node:assert/strict';
import { buildToeflEntryUrl } from '../../../../front-end/toefl/integration/entry-links.mjs';

const views = ['home', 'practice', 'mock', 'plan', 'wrongBook', 'report', 'history', 'progress', 'vocab'];
const sections = ['reading', 'listening', 'speaking', 'writing'];
assert.equal(buildToeflEntryUrl('/toefl/'), '/toefl/?view=home');
assert.equal(buildToeflEntryUrl('https://practice.example.test/exams/toefl/'), 'https://practice.example.test/exams/toefl/?view=home');
assert.equal(buildToeflEntryUrl('http://localhost:8788/toefl/index.html', { view: 'mock' }), 'http://localhost:8788/toefl/index.html?view=mock');
for (const view of views) for (const section of sections) {
  const result = new URL(buildToeflEntryUrl('/school/toefl/', { view, section }), 'https://school.example.test');
  assert.equal(result.origin, 'https://school.example.test');
  assert.equal(result.pathname, '/school/toefl/');
  assert.deepEqual([...result.searchParams], [['view', view], ['section', section]]);
}
assert.equal(buildToeflEntryUrl('/toefl/?token=private&returnUrl=https://other.test#old', { view: 'history' }), '/toefl/?view=history');
assert.equal(buildToeflEntryUrl('https://practice.example.test/toefl/?username=test&view=old#fragment', { view: 'practice', section: 'reading' }), 'https://practice.example.test/toefl/?view=practice&section=reading');
for (const base of ['', null, {}, 'javascript:alert(1)', 'data:text/html,test', '//other.test/toefl/', 'toefl/', '../toefl/', 'https:/other.test/', 'https:\\other.test', '/\\other.test', '/toefl/\n', 'https://name:password@practice.example.test/toefl/', 'ftp://practice.example.test/toefl/']) {
  assert.throws(() => buildToeflEntryUrl(base), TypeError, `Reject unsafe or ambiguous base: ${String(base)}`);
}
for (const view of ['', 'exam', 'review', 'wrongbook', null, 1, '__proto__']) assert.throws(() => buildToeflEntryUrl('/toefl/', { view }), /view/);
for (const section of ['', 'full', 'math', null, [], 1]) assert.throws(() => buildToeflEntryUrl('/toefl/', { section }), /section/);
for (const options of [null, [], 'mock']) assert.throws(() => buildToeflEntryUrl('/toefl/', options), TypeError);
for (const key of ['userId', 'username', 'password', 'token', 'returnUrl', 'redirect']) {
  assert.throws(() => buildToeflEntryUrl('/toefl/', { [key]: 'unused' }), /Only view and section/);
}
assert.throws(() => buildToeflEntryUrl('/toefl/', { [Symbol('token')]: 'unused' }), /Only view and section/);
console.log('PASS: all TOEFL entry views and sections, preserved trusted base paths, same-origin root links, query allowlisting and rejection of credentials, redirects and unsafe URL schemes.');
