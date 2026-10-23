'use strict';
// Explicit local-only smoke test: read catalog metadata and exactly three PDF
// collections. Never connect to the shared service or the user's browser.
// SAT_PDF_SMOKE_COLLECTION_IDS selects three comma-separated published IDs.
// SAT_PDF_SMOKE_STAGE separates reports for original and assembled catalogs.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {chromium} = require('playwright');
const repo = path.resolve(__dirname, '../..');
const stage = process.env.SAT_PDF_SMOKE_STAGE || 'assembled';
assert.match(stage, /^[a-z0-9-]+$/);
const output = path.join(repo, 'local-data/pdf-sat-conversion/browser', stage);
const fixturePath = path.join(repo, 'local-data/pdf-sat-conversion/browser-fixtures.json');
const snapshot = String.raw`
import json, os, sys
from pathlib import Path
root = Path.cwd()
sys.path.insert(0, str(root / 'back-end'))
from server.serve_platform import read_sat_library, _sat_library_index
base = root / 'back-end/sat/questions/sat-packs'
pdf = base / 'pdf-official'
libraries = (base / 'gengdu-offline', pdf)
rows = json.loads((pdf / 'catalog.json').read_text())['collections']
titles = [
    '2026年10月第3套SAT',
    '2023年6月第1&2&3套数学',
    '2023年3月考题阅读语法',
]
samples = []
selected = os.environ.get('SAT_PDF_SMOKE_COLLECTION_IDS', '')
if selected:
    identities = selected.split(',')
    assert len(identities) == len(set(identities)) == 3, 'Select exactly three distinct collections'
    available, indexed, errors = _sat_library_index(libraries)
    assert available and not errors
    for identity in identities:
        folder, report, metadata = indexed[identity]
        samples.append({'sourceFile': report.get('sourceFile', metadata['title']), 'collectionId': identity,
                        'sourceOrder': report['sourceOrder'], 'payload': read_sat_library(libraries, identity)})
else:
    for title in titles:
        matching = [row for row in rows if row.get('title') == title]
        assert len(matching) == 1, 'Expected exactly one catalog match for each selected title'
        row = matching[0]
        report = json.loads((pdf / row['directory'] / 'conversion-report.json').read_text())
        samples.append({'sourceFile': row.get('sourceFile', title), 'collectionId': row['collectionId'],
                        'sourceOrder': report['sourceOrder'],
                        'payload': read_sat_library(pdf, row['collectionId'])})
data = {'catalog': read_sat_library(libraries), 'samples': samples,
        'pdfCatalogCount': len(rows), 'pdfPureTitleCount': sum('纯题目' in row['title'] for row in rows)}
target = root / 'local-data/pdf-sat-conversion/browser-fixtures.json'
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
`;
const mime = {'.js':'application/javascript', '.css':'text/css', '.html':'text/html',
  '.woff2':'font/woff2', '.woff':'font/woff', '.ttf':'font/ttf', '.svg':'image/svg+xml'};
const problems = {pageErrors: [], unexpectedRequests: [], httpErrors: [], failedRequests: []};
const report = {ok: false, stage, localOnly: true, sourceCollectionsLoaded: 3, samples: [], ...problems};
let browser;
const server = http.createServer(async (req, res) => {
  try {
    assert.equal(req.method, 'GET');
    const route = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    let file;
    if (route.startsWith('/sat/')) file = path.resolve(repo, 'front-end/sat', route.slice(5));
    else if (route === '/web/sat-bridge.js') file = path.join(repo, 'front-end/web/sat-bridge.js');
    else throw Error('Unknown frontend resource');
    assert.ok(file.startsWith(path.join(repo, 'front-end/sat') + path.sep)
      || file === path.join(repo, 'front-end/web/sat-bridge.js'));
    let data = await fs.readFile(file);
    if (route === '/sat/html/index.html') data = Buffer.from(data.toString().replace(
      '<head>', '<head><script src="/web/sat-bridge.js"></script>'));
    res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
    res.end(data);
  } catch { res.statusCode = 404; res.end('missing'); }
});

async function runSample(fixture, sample, index, origin) {
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}});
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const requests = [];
  page.on('pageerror', error => problems.pageErrors.push({sample: index, message: error.message.slice(0, 200)}));
  page.on('response', response => {
    if (response.status() >= 400) problems.httpErrors.push({sample: index, path: new URL(response.url()).pathname, status: response.status()});
  });
  page.on('requestfailed', request => problems.failedRequests.push({sample: index, path: new URL(request.url()).pathname}));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) {
      problems.unexpectedRequests.push({sample: index, external: true});
      return route.abort();
    }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    requests.push(url.pathname);
    let value;
    if (request.method() !== 'GET') {
      problems.unexpectedRequests.push({sample: index, method: request.method(), path: url.pathname});
      value = {error: 'Read-only browser smoke test'};
    } else if (url.pathname === '/api/sat-library') value = fixture.catalog;
    else if (url.pathname === '/api/sat-library/collections/' + sample.collectionId) value = sample.payload;
    else if (url.pathname === '/api/question-bank/status') value = {service: 'sat-question-bank-v1', token: 'local-pdf-smoke'};
    else if (url.pathname === '/api/question-bank') value = {files: [], errors: []};
    else if (['/api/sat-packs', '/api/sat-test-collection'].includes(url.pathname)) value = {collectionId: null, packs: [], assessment: null};
    else if (url.pathname === '/api/sat-library/question-index') value = {schemaVersion: 1, available: true, sources: [], questions: [], errors: []};
    else {
      problems.unexpectedRequests.push({sample: index, path: url.pathname});
      value = {error: 'Unconfigured local smoke API'};
    }
    await route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(value)});
  });
  const result = {collectionId: sample.collectionId, questionCount: sample.payload.questionCount,
    fullSAT: sample.payload.fullSAT,
    questionsVisited: 0, imagesDecoded: 0, formulaNodes: 0, formulaWarnings: 0,
    formulaErrors: 0, formulaErrorPositions: [], moduleNumbers: [], moduleTransitions: 0, sectionBreaks: 0, screenshots: []};
  report.samples.push(result);
  try {
    await page.goto(origin + '/sat/html/index.html');
    await page.evaluate(() => SATApp.ready);
    await page.locator('[data-action=startPractice]').first().click();
    await page.waitForFunction(() => SATLibrary.state.status === 'ready');
    assert.equal(requests.filter(value => value.includes('/collections/')).length, 0);
    const card = page.locator('article.sat-library-card[data-id="' + sample.collectionId + '"]');
    await card.waitFor();
    if (sample.payload.fullSAT) assert.doesNotMatch(await card.innerText(), /Partial Test/);
    else assert.match(await card.innerText(), /Partial Test/);
    const timeline = await card.evaluate(node => ({
      date: node.closest('.sat-library-time-group').querySelector('time')?.dateTime,
      dates: [...document.querySelectorAll('.sat-library-date time')].map(time => time.dateTime)
    }));
    assert.ok(timeline.date, 'A dated PDF source must appear in a dated timeline group');
    assert.deepEqual(timeline.dates, [...timeline.dates].sort().reverse(), 'Timeline dates must descend');
    result.timelineDate = timeline.date;
    await card.locator('[data-action=library-start]').click();
    await page.locator('.practice-ready').waitFor();
    const plan = await page.evaluate(() => ({fullSAT: SATApp.appState.activePractice.fullSAT,
      standardTiming: SATApp.appState.activePractice.standardTiming,
      modules: SATApp.appState.activePractice.modules.map(module => ({start: module.start, end: module.end,
        section: module.section, moduleNumber: module.moduleNumber, durationSeconds: module.durationSeconds}))}));
    assert.equal(plan.fullSAT, sample.payload.fullSAT);
    assert.equal(plan.standardTiming, true);
    assert.deepEqual(plan.modules.map(module => module.moduleNumber), sample.payload.modules.map(module => module.moduleNumber));
    assert.deepEqual(plan.modules.map(module => module.durationSeconds), sample.payload.modules.map(module => module.section === 'math' ? 2100 : 1920));
    const ids = await page.evaluate(async () => Promise.all(SATApp.appState.activePractice.questionIds.map(async id =>
      (await SATStorage.get('questions', id)).itemId)));
    const expected = sample.payload.modules.flatMap(module => module.items.map(item => item.itemId));
    assert.deepEqual(ids, expected, 'The plan must retain the source module and item order');
    assert.deepEqual(ids, sample.sourceOrder.map(item => item.itemId), 'Source order must agree with collection modules');
    result.moduleNumbers = plan.modules.map(module => module.moduleNumber);
    await page.locator('[data-action=begin]').click();
    await page.waitForFunction(() => SATApp.appState.view === 'preparing');
    result.preparingObserved = true;
    await page.locator('#modal[open]').waitFor();
    await page.locator('#modalActions button').first().click();
    const photographed = new Set();
    for (let position = 0; position < ids.length; position++) {
      await page.locator('#questionView').waitFor();
      const state = await page.evaluate(async () => {
        const runtime = JSON.parse(localStorage.getItem('sat-reading-practice-v1'));
        const images = [...document.querySelectorAll('#questionView img')];
        await Promise.all(images.map(image => image.decode()));
        return {position: runtime.currentQuestion, moduleIndex: runtime.moduleIndex || 0,
          images: images.length, imagesValid: images.every(image => image.naturalWidth > 0 && image.naturalHeight > 0),
          formulaErrors: document.querySelectorAll('#questionView .sat-formula-error, #questionView .katex-error').length,
          formulas: document.querySelectorAll('#questionView .sat-formula').length,
          warnings: document.querySelectorAll('#questionView [data-latex-warnings]').length};
      });
      assert.equal(state.position, position, 'Runtime question order must match source order');
      assert.equal(state.imagesValid, true, 'Every rendered source image must decode');
      result.questionsVisited++;
      result.imagesDecoded += state.images;
      result.formulaNodes += state.formulas;
      result.formulaWarnings += state.warnings;
      result.formulaErrors += state.formulaErrors;
      if (state.formulaErrors) result.formulaErrorPositions.push({position: position + 1, itemId: ids[position], count: state.formulaErrors});
      const section = sample.payload.modules[state.moduleIndex].section;
      if (!photographed.has(section) && (state.images > 0 || position === ids.length - 1)) {
        const name = 'sample-' + (index + 1) + '-' + section + '-exam.png';
        await page.screenshot({path: path.join(output, name), fullPage: false});
        result.screenshots.push(name); photographed.add(section);
      }
      if (position === ids.length - 1) break;
      const module = plan.modules[state.moduleIndex];
      await page.locator('#nextButton').click();
      if (position + 1 === module.end) {
        await page.locator('#reviewView').waitFor();
        await page.locator('#nextButton').click();
        await page.locator('.module-over').waitFor();
        if (sample.payload.fullSAT && section !== sample.payload.modules[state.moduleIndex + 1].section) {
          await page.locator('#resumeTesting').waitFor();
          assert.match(await page.locator('#breakTime').innerText(), /^(?:10:00|9:5\d)$/);
          await page.locator('#resumeTesting').click();
          await page.locator('#startMathSection').waitFor();
          assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('sat-reading-practice-v1')).phase), 'section_ready');
          await page.locator('#startMathSection').click();
          result.sectionBreaks++;
        }
        await page.locator('#modal[open]').waitFor();
        await page.locator('#modalActions button').first().click();
        result.moduleTransitions++;
      }
    }
    assert.equal(requests.filter(value => value.includes('/collections/')).length, 1,
      'Exactly one selected package may be loaded in each isolated context');
    assert.equal(result.moduleTransitions, Math.max(0, plan.modules.length - 1),
      'Every available original module boundary must be exercised');
    result.readyObserved = true;
    result.examObserved = true;
  } finally { await context.close(); }
}

(async () => {
  await fs.mkdir(output, {recursive: true});
  const generated = spawnSync(process.env.PYTHON || 'python3', ['-B', '-c', snapshot], {cwd: repo, encoding: 'utf8'});
  assert.equal(generated.status, 0, 'Read-only fixture snapshot failed: ' + generated.stderr.slice(0, 500));
  const fixture = JSON.parse(await fs.readFile(fixturePath, 'utf8'));
  assert.equal(fixture.samples.length, 3);
  assert.deepEqual(fixture.catalog.errors, []);
  if (stage === 'assembled') assert.equal(fixture.pdfPureTitleCount, 0, 'Paired question-only PDFs must not be separately listed');
  report.pdfCatalogCollectionCount = fixture.pdfCatalogCount;
  report.pdfPureTitleCount = fixture.pdfPureTitleCount;
  report.catalogCollectionCount = fixture.catalog.categories.reduce((sum, category) => sum + category.collections.length, 0);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? {executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE} : {channel: 'chrome'})});
  const origin = 'http://127.0.0.1:' + server.address().port;
  for (let index = 0; index < fixture.samples.length; index++) await runSample(fixture, fixture.samples[index], index, origin);
  for (const values of Object.values(problems)) assert.deepEqual(values, []);
  assert.ok(report.samples.reduce((sum, sample) => sum + sample.imagesDecoded, 0) > 0);
  assert.ok(report.samples.some(sample => sample.moduleTransitions > 0), 'At least one sampled source must cross modules');
  assert.equal(report.samples.reduce((sum, sample) => sum + sample.formulaErrors, 0), 0,
    'Sample formulas must render without error nodes; positions are recorded in the local report');
  report.ok = true;
})().catch(error => {
  report.failure = {name: error.name, message: error.message.slice(0, 600)};
  process.exitCode = 1;
}).finally(async () => {
  if (browser) await browser.close();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await fs.mkdir(output, {recursive: true});
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
});
