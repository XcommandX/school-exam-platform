'use strict';
// Synthetic-only regression: no real accounts, question banks, or browser records.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const {chromium} = require('playwright');
const repo = path.resolve(__dirname, '../..');
const root = path.join(repo, 'front-end/sat');
const fixturesRoot = path.join(repo, 'docs/drafts/sat-question-packs');
const mime = {'.js':'application/javascript', '.css':'text/css', '.html':'text/html', '.json':'application/json', '.svg':'image/svg+xml', '.woff2':'font/woff2'};
const server = http.createServer(async (req, res) => {
  try {
    assert.equal(req.method, 'GET', 'the fixture server must remain read-only');
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/question-bank')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(url.pathname.endsWith('/status') ? {service:'sat-question-bank-v1', token:'synthetic-username-fixture'} : {files:[], errors:[]}));
      return;
    }
    const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    assert.ok(file.startsWith(root + path.sep));
    res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
    res.end(await fs.readFile(file));
  } catch {
    res.statusCode = 404;
    res.end('missing');
  }
});

async function fixtureFiles() {
  const files = [];
  async function walk(folder, relative) {
    for (const entry of await fs.readdir(folder, {withFileTypes:true})) {
      const next = relative + '/' + entry.name;
      if (entry.isDirectory()) await walk(path.join(folder, entry.name), next);
      else files.push({name:next, bytes:[...await fs.readFile(path.join(folder, entry.name))]});
    }
  }
  for (const name of ['rw-single-choice', 'math-single-choice', 'math-spr']) await walk(path.join(fixturesRoot, name), name);
  return files;
}

(async () => {
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({headless:true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE} : {channel:'chrome'})});
    const context = await browser.newContext({viewport:{width:1440, height:1000}});
    await context.addInitScript(() => {
      const initial = {id:'synthetic-username-owner', username:'SyntheticLogin', displayName:'Different Display Name', name:'Different Legacy Name'};
      window.PlatformAuth = {user:JSON.parse(sessionStorage.getItem('synthetic-username-user') || 'null') || initial, active:true};
    });
    const page = await context.newPage(), errors = [];
    const screenshots = path.join(repo, 'local-data/test-artifacts/sat-username');
    await fs.mkdir(screenshots, {recursive:true});
    const screenshot = async name => {
      // Let resize/layout changes reach Chromium's compositor under the mocked clock.
      const painted = page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.clock.runFor(100);
      await painted;
      await page.screenshot({path:path.join(screenshots, name + '.png'), fullPage:name.startsWith('break-')});
    };
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(12000);
    const url = `http://127.0.0.1:${server.address().port}/html/index.html`;
    const runtime = () => page.evaluate(() => JSON.parse(localStorage.getItem('sat-reading-practice-v1')));
    const closeDirections = async () => {
      await page.locator('#modal[open]').waitFor();
      await page.locator('#modalActions button').click();
    };
    const assertName = async (selector, expected) => {
      await page.locator(selector).waitFor({state:'visible'});
      assert.equal(await page.locator(selector).textContent(), expected);
      assert.equal(await page.locator(selector).locator('img,script,b').count(), 0, 'identity is rendered as text, never markup');
    };
    const changeUser = async user => page.evaluate(user => {
      PlatformAuth.user = {id:'synthetic-username-owner', ...user};
      sessionStorage.setItem('synthetic-username-user', JSON.stringify(PlatformAuth.user));
      document.dispatchEvent(new CustomEvent('platform:user', {detail:PlatformAuth.user}));
    }, user);
    const checkWork = async name => {
      await page.locator('#navigatorToggle').click();
      await page.locator('#goReview').click();
      await page.locator('#reviewView').waitFor({state:'visible'});
      await assertName('#studentName', name);
    };
    const finishModule = async name => {
      if (await page.locator('#questionView').isVisible()) await checkWork(name);
      await page.locator('#nextButton').click();
      await page.locator('.module-over').waitFor();
      const stopped = await runtime();
      assert.equal(stopped.phase, 'module_break');
      assert.equal(stopped.segmentStartedAt, null);
      await page.clock.fastForward(1900);
    };
    const assertFooterBounds = async selector => {
      const bounds = await page.locator(selector).evaluate(el => {
        const r = el.getBoundingClientRect();
        return {left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:innerWidth, height:innerHeight};
      });
      assert.ok(bounds.left >= 0 && bounds.right <= bounds.width, `name must fit horizontally: ${JSON.stringify(bounds)}`);
      assert.ok(bounds.top >= 0 && bounds.bottom <= bounds.height, `name must remain visible: ${JSON.stringify(bounds)}`);
    };
    await page.goto(url);
    await page.evaluate(() => SATApp.ready);
    const ids = await page.evaluate(async files => {
      const selected = files.map(({name, bytes}) => {
        const file = new File([new Uint8Array(bytes)], name.split('/').pop());
        Object.defineProperty(file, 'webkitRelativePath', {value:name});
        return file;
      });
      for (const preview of await SATPack.previewFiles(selected)) {
        if (preview.errors.length) throw Error(preview.errors.join('; '));
        await SATImporter.commit(preview);
      }
      return (await SATStorage.all('questions')).map(q => q.id);
    }, await fixtureFiles());
    assert.equal(ids.length, 5);
    await page.reload();
    await page.evaluate(() => SATApp.ready);
    await page.clock.install({time:new Date('2026-10-24T00:00:00Z')});
    await page.evaluate(async ids => {
      SATApp.appState.practiceKind = 'full-sat';
      await SATApp.startPractice(ids, 'Synthetic username integration', 1920);
    }, ids);
    await page.locator('[data-action=begin]').click();
    await closeDirections();
    assert.equal((await runtime()).activePractice.modules.length, 4);
    assert.match(await page.locator('.section-info h1').innerText(), /Reading and Writing/);
    await assertName('#studentName', 'SyntheticLogin');
    const longName = 'SyntheticUsername'.padEnd(40, 'x');
    assert.equal(longName.length, 40);
    await changeUser({username:longName, displayName:'Ignored display name'});
    await assertName('#studentName', longName);
    await assertFooterBounds('#studentName');
    const nameBox = await page.locator('#studentName').boundingBox();
    const navBox = await page.locator('#navigatorToggle').boundingBox();
    assert.ok(nameBox.x + nameBox.width <= navBox.x, 'a long username must not overlap question navigation');
    await page.setViewportSize({width:390, height:844});
    await assertFooterBounds('#studentName');
    const narrowNameBox = await page.locator('#studentName').boundingBox();
    const narrowNavBox = await page.locator('#navigatorToggle').boundingBox();
    assert.ok(narrowNameBox.x + narrowNameBox.width <= narrowNavBox.x, 'a long username must not overlap question navigation on a narrow screen');
    await page.setViewportSize({width:1440, height:1000});
    await checkWork(longName);
    await finishModule(longName);
    await closeDirections();
    await assertName('#studentName', longName);
    await finishModule(longName);
    await page.locator('.sat-break').waitFor();
    await assertName('.sat-break footer', longName);
    await assertFooterBounds('.sat-break footer');
    await screenshot('break-desktop');
    assert.match(await page.locator('.break-information').innerText(), /Do not disturb students who are still testing/);
    const initialBreak = await runtime();
    assert.equal(initialBreak.phase, 'section_break');
    const specialName = '<img src=x onerror="window.identityInjected=true"> & 姓名';
    await changeUser({username:' ', displayName:specialName, name:'Unused fallback'});
    await assertName('.sat-break footer', specialName);
    assert.equal(await page.evaluate(() => !!window.identityInjected), false);
    assert.equal(await page.locator('#resumeTesting').evaluate(el => typeof el.onclick), 'function', 'profile updates preserve the break button handler');
    await page.setViewportSize({width:390, height:844});
    await page.locator('.sat-break footer').scrollIntoViewIfNeeded();
    await assertFooterBounds('.sat-break footer');
    await screenshot('break-narrow');
    const breakSpacing = await page.evaluate(() => {
      const container = document.querySelector('.sat-break'), css = getComputedStyle(container);
      return {name:container.querySelector('footer').getBoundingClientRect().top, rules:container.querySelector('.break-information').getBoundingClientRect().bottom, paddingBottom:css.paddingBottom, gap:css.gap, containerHeight:container.getBoundingClientRect().height, scrollHeight:container.scrollHeight};
    });
    assert.ok(breakSpacing.name >= breakSpacing.rules, `the footer must not cover break rules on a narrow screen: ${JSON.stringify(breakSpacing)}`);
    await page.setViewportSize({width:1440, height:1000});
    await page.clock.fastForward(30000);
    await page.reload();
    await page.evaluate(() => SATApp.ready);
    await assertName('.sat-break footer', specialName);
    const reloadedBreak = await runtime();
    assert.equal(reloadedBreak.breakEndTimestamp, initialBreak.breakEndTimestamp);
    assert.equal(reloadedBreak.elapsedMs, initialBreak.elapsedMs);
    await page.clock.fastForward(90000);
    assert.match(await page.locator('#breakTime').innerText(), /^[78]:\d\d$/);
    await page.locator('#resumeTesting').click();
    await assertName('.sat-math-ready footer', specialName);
    const ready = await runtime();
    assert.equal(ready.phase, 'section_ready');
    assert.equal(ready.moduleIndex, initialBreak.moduleIndex);
    assert.equal(ready.elapsedMs, initialBreak.elapsedMs);
    await changeUser({name:'Legacy Name Fallback'});
    await assertName('.sat-math-ready footer', 'Legacy Name Fallback');
    assert.equal(await page.locator('#startMathSection').evaluate(el => typeof el.onclick), 'function', 'profile updates preserve the ready button handler');
    await page.clock.fastForward(120000);
    await page.reload();
    await page.evaluate(() => SATApp.ready);
    await assertName('.sat-math-ready footer', 'Legacy Name Fallback');
    const stillReady = await runtime();
    assert.equal(stillReady.phase, 'section_ready');
    assert.equal(stillReady.moduleIndex, ready.moduleIndex);
    assert.equal(stillReady.endTimestamp, ready.endTimestamp);
    assert.equal(stillReady.elapsedMs, ready.elapsedMs);
    await changeUser({username:longName});
    await screenshot('ready-desktop');
    await page.setViewportSize({width:390, height:844});
    await assertName('.sat-math-ready footer', longName);
    await assertFooterBounds('.sat-math-ready footer');
    await screenshot('ready-narrow');
    await page.setViewportSize({width:1440, height:1000});
    await page.locator('#startMathSection').click();
    await closeDirections();
    await assertName('#studentName', longName);
    const active = await runtime();
    assert.equal(active.phase, 'active');
    assert.equal(active.moduleIndex, 2);
    assert.equal(active.elapsedMs, ready.elapsedMs);
    const remaining = await page.evaluate(end => end - Date.now(), active.endTimestamp);
    assert.ok(remaining > 2097000 && remaining <= 2100000, 'the complete Math timer starts only after the second Resume click');
    assert.match(await page.locator('.section-info h1').innerText(), /Math/);
    await checkWork(longName);
    await page.reload();
    await page.evaluate(() => SATApp.ready);
    await assertName('#studentName', longName);

    // A fresh standalone context has no injected PlatformAuth at all.
    const standaloneContext = await browser.newContext();
    const standalone = await standaloneContext.newPage();
    standalone.on('pageerror', error => errors.push(error.message));
    await standalone.goto(url);
    await standalone.evaluate(() => SATApp.ready);
    const standaloneIds = await standalone.evaluate(async () => {
      const q = {id:'synthetic-standalone:q', section:'Reading and Writing', passage:'Original synthetic passage.', prompt:'Original synthetic question?', options:['A','B','C','D'], correctOption:0, metadata:{sourceId:'synthetic-standalone', sourceFileName:'synthetic.json', sourceQuestionIndex:0, importedAt:Date.now()}};
      await SATStorage.importSet({id:'synthetic-standalone', fileName:'synthetic.json', displayName:'Synthetic standalone fixture', questionCount:1, contentHash:'synthetic-standalone', importedAt:Date.now()}, [q]);
      return [q.id];
    });
    await standalone.evaluate(ids => SATApp.startPractice(ids, 'Standalone username fallback', 120), standaloneIds);
    await standalone.locator('[data-action=begin]').click();
    await standalone.locator('#modal[open]').waitFor();
    await standalone.locator('#modalActions button').click();
    assert.equal(await standalone.locator('#studentName').innerText(), 'Student');
    assert.equal(await standalone.evaluate(() => SATSession.getStudentName()), 'Student');
    await standaloneContext.close();
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ok:true, syntheticOnly:true, screenshots, checks:['username precedence and display/legacy name fallbacks', 'Reading and Math exam and Check Your Work', 'break and waiting-page identity', 'reload preserves identity and timers', 'profile events preserve Resume handlers', 'early Resume waits for second click to start Math', 'escaped special characters and 40-character names', '390px exam identity and break footer spacing', 'standalone Student fallback']}));
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
