'use strict';
// Static entry contract only; responsive rendering/navigation use browser checks.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'apps/web/index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'apps/web/styles.css'), 'utf8');
const entry = html.match(/<section class="exam-card home-ap-entry"[^>]*>[\s\S]*?<\/section>/)?.[0];

test('AP is a separate labelled entry after the two existing primary exam cards', () => {
  assert.ok(entry);
  assert.match(entry, /aria-labelledby="home-ap-title"/);
  assert.match(entry, /<h2 id="home-ap-title">AP<\/h2>/);
  assert.equal((html.match(/class="exam-card /g) || []).length, 3);
  assert.ok(html.indexOf(entry) > html.indexOf('class="exam-card sat"'));
  assert.ok(html.indexOf(entry) < html.indexOf('<footer'));
  assert.doesNotMatch(entry, /<(?:p|small)\b/);
});

test('AP groups existing courses rather than question types', () => {
  const links = [...entry.matchAll(/<a\s+([^>]+)>/g)].map(match => match[1]);
  assert.equal(links.length, 2);
  assert.deepEqual(links.map(attrs => attrs.match(/href="([^"]+)"/)[1]), ['/ap/', '/ap/']);
  links.forEach(attrs => assert.match(attrs, /aria-label="[^"]+"/));
  assert.doesNotMatch(entry, /onclick=|data-dialog=|target="_blank"/);
});

test('primary exam destinations remain and footer keeps only Personal Vocab', () => {
  for (const section of ['reading', 'listening', 'speaking', 'writing']) {
    assert.ok(html.includes(`href="/toefl/?section=${section}"`));
  }
  assert.ok(html.includes('href="/sat/?view=dashboard"'));
  assert.ok(html.includes('href="/sat/?view=practiceBuilder&amp;mode=custom"'));
  const footer = html.match(/<footer\b[\s\S]*?<\/footer>/)[0];
  assert.match(footer, /data-dialog="vocab">Personal Vocab/);
  assert.doesNotMatch(footer, /href="\/ap\//);
});

test('AP styles stay scoped and retain responsive, focus and reduced-motion support', () => {
  assert.match(entry, /class="start-button"/);
  assert.match(entry, /aria-label="AP 课程"/);
  assert.match(entry, /英语语言与写作/);
  assert.doesNotMatch(entry, /MCQ|FRQ|home-ap-kind/);
  assert.match(css, /\.home-ap-entry\{--accent:var\(--blue\)/);
  assert.match(css, /\.home-ap-entry \.subject-links>a\{[^}]*min-height:78px/);
  assert.match(css, /a:focus-visible/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)/);
  assert.match(css, /\.reduced-motion \*/);
});
