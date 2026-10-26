'use strict';
// Static entry contract only; responsive rendering/navigation use browser checks.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'apps/web/index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'apps/web/styles.css'), 'utf8');
const entry = html.match(/<section class="home-ap-entry"[^>]*>[\s\S]*?<\/section>/)?.[0];

test('AP is a separate labelled entry after the two existing primary exam cards', () => {
  assert.ok(entry);
  assert.match(entry, /aria-labelledby="home-ap-title"/);
  assert.match(entry, /<h2 id="home-ap-title">AP English Language and Composition<\/h2>/);
  assert.equal((html.match(/class="exam-card /g) || []).length, 2);
  assert.ok(html.indexOf(entry) > html.indexOf('class="exam-card sat"'));
  assert.ok(html.indexOf(entry) < html.indexOf('<footer'));
  assert.doesNotMatch(entry, /<(?:p|small)\b/);
});

test('AP uses three native destinations with meaningful accessible labels', () => {
  const links = [...entry.matchAll(/<a\s+([^>]+)>/g)].map(match => match[1]);
  assert.equal(links.length, 3);
  assert.deepEqual(links.map(attrs => attrs.match(/href="([^"]+)"/)[1]), ['/ap/?kind=mcq', '/ap/?kind=frq', '/ap/']);
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
  assert.match(css, /\.home-ap-entry\{[^}]*grid-template-columns:minmax\(0,1fr\) auto/);
  assert.match(css, /\.home-ap-entry \.home-ap-actions a\{[^}]*min-height:48px/);
  assert.match(css, /@media\(max-width:1050px\)\{\.home-ap-entry\{grid-template-columns:1fr/);
  assert.match(css, /@media\(max-width:720px\)\{\.home-ap-entry/);
  assert.match(css, /a:focus-visible/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)/);
  assert.match(css, /\.reduced-motion \*/);
});
