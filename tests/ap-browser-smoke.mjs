/* Dependency-free Chrome CDP smoke test; requires an isolated debugging browser.
 * Start the unified server and Chrome --headless=new --remote-debugging-port=9227
 * with a disposable --user-data-dir, then: node tests/ap-browser-smoke.mjs
 * Uses a fresh off-the-record context; never clears an existing user's storage.
 * Screenshots contain only original fixtures and are saved under private-data/.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const base = process.env.AP_TEST_URL || 'http://127.0.0.1:8888';
const debug = process.env.AP_CHROME_URL || 'http://127.0.0.1:9227';
for (const value of [base, debug]) assert(['127.0.0.1', 'localhost'].includes(new URL(value).hostname), 'Tests require a loopback endpoint.');
const output = new URL('../private-data/ap-browser-checks/', import.meta.url);
await mkdir(output, { recursive: true });
const version = await fetch(debug + '/json/version').then(r => r.json());
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let serial = 0;
const pending = new Map(), exceptions = [];
ws.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.id) {
    const request = pending.get(message.id);
    if (request) { pending.delete(message.id); clearTimeout(request.timeout); message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result); }
  } else if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails);
};
function call(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++serial;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 15000);
    pending.set(id, { resolve, reject, timeout });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
const context = (await call('Target.createBrowserContext')).browserContextId;
let session;
try {
  const target = await call('Target.createTarget', { url: 'about:blank', browserContextId: context });
  session = (await call('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
  const cmd = (method, params) => call(method, params, session);
  await cmd('Page.enable'); await cmd('Runtime.enable'); await cmd('Network.enable');
  const evaluate = async expression => {
    const result = await cmd('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  async function wait(expression) {
    const end = Date.now() + 12000;
    while (Date.now() < end) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 100)); }
    throw new Error('Timed out waiting for ' + expression);
  }
  const has = text => 'document.body.innerText.includes(' + JSON.stringify(text) + ')';
  const click = text => evaluate(`(() => { const node = [...document.querySelectorAll('button')].find(node => node.textContent.trim() === ${JSON.stringify(text)} && !node.disabled); if (!node) throw new Error('Button missing: ' + ${JSON.stringify(text)}); node.click(); })()`);
  async function navigate(path) { await cmd('Page.navigate', { url: base + path }); await wait('document.readyState === "complete"'); }
  async function screenshot(name) {
    const result = await cmd('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(new URL(name, output), Buffer.from(result.data, 'base64'));
  }
  await cmd('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  // Make the empty-catalog path deterministic even if a local real import runs concurrently.
  const stub = await cmd('Page.addScriptToEvaluateOnNewDocument', { source: `const originalFetch = window.fetch.bind(window); window.fetch = (input, options) => String(input) === '/api/exams/ap/sources' ? Promise.resolve(new Response(JSON.stringify({exam:'ap',schemaVersion:2,sources:[],errors:[]}))) : originalFetch(input, options);` });
  await navigate('/ap/'); await wait(has('本机题库为空'));
  assert.equal(await evaluate('document.querySelectorAll(".ap-source").length'), 0);
  await screenshot('ap-empty-desktop.png');
  await click('打开原创示例'); await wait(has('开始练习'));
  await click('开始练习'); await wait('document.querySelectorAll("input[type=radio]").length > 0');
  assert.equal(await evaluate('document.body.classList.contains("ap-exam-active")'), true);
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".ap-header")).display'), 'none');
  await evaluate('document.activeElement.blur()');
  await screenshot('ap-mcq-desktop.png');
  const fixture = await fetch(base + '/api/ap/example').then(r => r.json());
  const firstWrong = (fixture.questions[0].correctOption + 1) % fixture.questions[0].options.length;
  await evaluate(`document.querySelector('input[value="${firstWrong}"]').click()`);
  await click('下一题');
  await evaluate(`document.querySelector('input[value="${fixture.questions[1].correctOption}"]').click()`);
  await click('下一题'); await wait('Boolean(document.querySelector("#ap-essay"))');
  const essay = 'A local library makes information accessible. Evidence supports this original test argument.';
  await evaluate(`(() => { const field=document.querySelector('#ap-essay'); field.value=${JSON.stringify(essay)}; field.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await wait('document.querySelector("#ap-save-state").textContent === "草稿已保存"');
  assert.equal(await evaluate('document.querySelector("#ap-word-count").textContent'), '12 words');
  await evaluate('document.activeElement.blur()');
  await screenshot('ap-writing-desktop.png');
  await cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await cmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  assert.equal(await evaluate('matchMedia("(prefers-reduced-motion: reduce)").matches'), true);
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Mobile practice must not overflow horizontally');
  await screenshot('ap-writing-mobile.png');
  await navigate('/ap/?view=drafts'); await wait(has('继续练习')); await click('继续练习');
  await wait('Boolean(document.querySelector("#ap-essay"))');
  assert.equal(await evaluate('document.querySelector("#ap-essay").value'), essay, 'Draft survives full navigation');
  await evaluate('document.querySelector("#ap-qnav-0").click()');
  assert.equal(await evaluate('Number(document.querySelector("input[type=radio]:checked").value)'), firstWrong);
  await evaluate('document.querySelector("#ap-qnav-4").click()');
  await click('提交复盘'); await wait('document.querySelector("dialog").open');
  await evaluate('[...document.querySelectorAll("dialog button")].find(b=>b.textContent==="提交复盘").click()');
  await wait(has('练习复盘'));
  const history = await evaluate('JSON.parse(localStorage.getItem(APModel.KEYS.history))');
  assert.equal(history.length, 1); assert.equal(history[0].answeredCount, 3); assert.equal(history[0].gradedCount, 2); assert.equal(history[0].correctCount, 1);
  assert.equal(await evaluate('JSON.parse(localStorage.getItem(APModel.KEYS.drafts)).length'), 0);
  await navigate('/ap/?view=wrong'); await wait(has('查看错题'));
  assert.equal(await evaluate('JSON.parse(localStorage.getItem(APModel.KEYS.wrong)).length'), 1);
  await click('查看错题'); await wait(has('你的选择'));
  await navigate('/'); await wait('Boolean(window.PlatformHome)');
  assert.equal(await evaluate(`document.querySelector('a[href="/ap/"]') !== null`), true);
  assert.equal(await evaluate('PlatformHome.examRoutes.ap'), '/ap/');
  assert.equal(await evaluate('window.HomeModel ? HomeModel.summarize([],[],[],Date.now(),JSON.parse(localStorage.getItem("school-exam-platform:ap:history:v1"))).all.answers : -1'), 0, 'Synthetic practice excluded from home totals');
  // Prominent entry is responsive and routes to the requested catalog filter.
  for (const width of [1440, 390, 320]) {
    await cmd('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 720 });
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Homepage overflow at ' + width);
    await evaluate('document.querySelector(".home-ap-entry").scrollIntoView({block:"center"})');
    await screenshot('home-ap-' + width + '.png');
  }
  await evaluate('document.querySelector(\'.home-ap-entry a[href="/ap/?kind=mcq"]\').click()');
  await wait('Boolean(document.querySelector(\'select[aria-label="类型"]\'))');
  assert.equal(await evaluate('document.querySelector(\'select[aria-label="类型"]\').value'), 'mcq');
  await navigate('/ap/?kind=frq'); await wait('Boolean(document.querySelector(\'select[aria-label="类型"]\'))');
  assert.equal(await evaluate('document.querySelector(\'select[aria-label="类型"]\').value'), 'frq');
  await click('打开原创示例'); await wait(has('开始练习'));
  assert.equal(await evaluate('document.querySelector("#ap-practice-mode").value'), 'timed');
  await click('开始练习'); await wait(has('剩余'));
  await wait('document.querySelector("#ap-timer").textContent !== "剩余 1:00:00"');
  await click('暂停'); await wait(has('练习已暂停'));
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".ap-workspace")).display'), 'none');
  assert.equal(await evaluate('document.activeElement.id'), 'ap-timer-pause');
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".ap-pagination")).display'), 'none');
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".ap-exam-navigator")).display'), 'none');
  const pausedTime = await evaluate('document.querySelector("#ap-timer").textContent');
  await navigate('/ap/?view=drafts'); await wait(has('继续练习')); await click('继续练习'); await wait(has('练习已暂停'));
  assert.equal(await evaluate('document.querySelector("#ap-timer").textContent'), pausedTime);
  await click('继续计时'); await wait('getComputedStyle(document.querySelector(".ap-workspace")).display !== "none"');
  await click('保存并退出'); await wait(has('继续练习'));
  assert.equal(await evaluate('JSON.parse(localStorage.getItem(APModel.KEYS.drafts))[0].timing.paused'), true);
  // Persist an elapsed clock in the isolated synthetic attempt to verify reload reconciliation and expiry.
  await evaluate(`(() => { const list=JSON.parse(localStorage.getItem(APModel.KEYS.drafts)); const d=list[0]; d.elapsedSeconds=0; d.started=Date.now()-3700000; d.timing.anchorAt=Date.now()-3700000; d.timing.paused=false; localStorage.setItem(APModel.KEYS.drafts,JSON.stringify(list)); })()`);
  await navigate('/ap/?view=drafts'); await wait(has('继续练习')); await click('继续练习'); await wait(has('计时结束'));
  assert.equal(await evaluate('document.querySelector("#ap-timer").textContent'), '剩余 00:00');
  assert.equal(await evaluate('JSON.parse(localStorage.getItem(APModel.KEYS.history)).length'), 1, 'Expiry must not auto-submit');
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Timer controls fit 320px');
  await evaluate('document.querySelector(".ap-exam-navigator summary").click()');
  assert.equal(await evaluate('document.querySelector(".ap-exam-navigator").open'), true);
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Expanded navigator fits 320px');
  await screenshot('ap-timer-expired-mobile.png');
  await evaluate('document.querySelector("#ap-qnav-1").click()');
  assert.equal(await evaluate('document.querySelector(".ap-exam-navigator summary").textContent'), '第 2 / 5 题');
  await click('保存并退出');
  await navigate('/ap/'); await wait(has('打开原创示例')); await click('打开原创示例'); await wait(has('开始练习'));
  await evaluate('document.querySelector("#ap-practice-mode").value="free"');
  await click('开始练习'); await wait(has('自由练习'));
  assert.match(await evaluate('document.querySelector("#ap-timer").textContent'), /^已用 /);
  await click('保存并退出');
  await cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  // Failures must be visible; real questions are never silently replaced by sample content.
  await cmd('Page.removeScriptToEvaluateOnNewDocument', { identifier: stub.identifier });
  const failure = await cmd('Page.addScriptToEvaluateOnNewDocument', { source: `const originalFetch = window.fetch.bind(window); window.fetch = (input, options) => String(input) === '/api/exams/ap/sources' ? Promise.resolve(new Response('Unavailable',{status:503})) : originalFetch(input, options);` });
  await navigate('/ap/'); await wait(has('重试')); assert.equal(await evaluate('document.querySelectorAll(".ap-source").length'), 0);
  await cmd('Page.removeScriptToEvaluateOnNewDocument', { identifier: failure.identifier });
  const denied = await cmd('Page.addScriptToEvaluateOnNewDocument', { source: `Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Blocked','SecurityError')}});` });
  await navigate('/ap/?view=drafts'); await wait('!document.getElementById("ap-storage-notice").hidden');
  await cmd('Page.removeScriptToEvaluateOnNewDocument', { identifier: denied.identifier });
  // Real catalog read-only sanity: valid imported sources must also pass the browser schema.
  await navigate('/ap/'); await wait('document.querySelector("#ap-content").getAttribute("aria-busy") !== "true"');
  const realCheck = await evaluate(`(async()=>{const list=await fetch('/api/exams/ap/sources').then(r=>r.json());for(const item of list.sources){const raw=await fetch('/api/exams/ap/sources/'+encodeURIComponent(item.id)).then(r=>r.json());APModel.validateSource(raw);}return {sources:list.sources.length,errors:list.errors};})()`);
  assert.equal(realCheck.errors.length, 0);
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Mobile catalog must not overflow horizontally');
  // Open one available source of each kind without answering real exam questions.
  // Screenshots remain fixture-only; no source text is logged or committed.
  const realSources = (await fetch(base + '/api/exams/ap/sources').then(r => r.json())).sources;
  const realTypes = [];
  for (const kind of ['mcq', 'frq', 'document-only']) {
    const matches = source => kind === 'document-only' ? source.questionCount === 0 && source.kind !== 'reference' : source.kind === kind && source.questionCount > 0;
    const item = realSources.find(source => matches(source) && source.year === (kind === 'mcq' ? 2013 : 2024)) || realSources.find(matches);
    if (!item) continue;
    await navigate('/ap/'); await wait('document.querySelectorAll(".ap-source").length > 0');
    await evaluate(`(() => { const card = [...document.querySelectorAll('.ap-source')].find(node => node.querySelector('h3').textContent === ${JSON.stringify(item.title)}); if (!card) throw new Error('Real source card missing'); card.querySelector('button').click(); })()`);
    await wait(has(item.title));
    await wait('document.querySelector("#ap-content").getAttribute("aria-busy") !== "true"');
    const source = await fetch(base + '/api/exams/ap/sources/' + encodeURIComponent(item.id)).then(r => r.json());
    const asset = '/' + source.documents[0].asset;
    const head = await fetch(base + asset, { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(head.headers.get('content-type'), 'application/pdf');
    const range = await fetch(base + asset, { headers: { Range: 'bytes=0-4' } });
    assert.equal(range.status, 206); assert.equal(await range.text(), '%PDF-');
    if (kind === 'document-only') {
      assert.equal(await evaluate(has('开始练习')), false, 'Document-only resources must not pretend to have answerable questions');
      if (await evaluate(has('进入资料复盘'))) await click('进入资料复盘');
      assert.equal(await evaluate(`[...document.querySelectorAll('a')].some(node => (node.getAttribute('href') || '').startsWith('/question-assets/ap/'))`), true);
    } else {
      await wait(has('开始练习')); await click('开始练习');
      await wait(kind === 'mcq' ? 'document.querySelectorAll("input[type=radio]").length > 0' : 'Boolean(document.querySelector("#ap-essay"))');
      if (kind === 'mcq') assert.equal(await evaluate('document.querySelectorAll("input[type=radio]").length'), source.questions[0].options.length);
      else assert.equal(await evaluate('document.querySelector("#ap-essay").value'), '');
      const storedClock = await evaluate('JSON.parse(localStorage.getItem(APModel.KEYS.drafts))[0].timing');
      assert.equal(storedClock.durationSeconds, kind === 'mcq' ? 3600 : 8100);
      assert.equal(storedClock.readingSeconds, kind === 'mcq' ? 0 : 900);
      if (kind === 'frq') assert.equal(await evaluate('document.querySelector("#ap-timer-phase").textContent'), '阅读阶段');
      const question = source.questions[0], document = source.documents.find(doc => doc.id === question.sourceDocument);
      const expectedLinks = question.pages.map(page => '/' + document.asset + '#page=' + page);
      const actualLinks = await evaluate(`[...document.querySelectorAll('a')].map(node => node.getAttribute('href'))`);
      assert(expectedLinks.every(href => actualLinks.includes(href)), 'Every original question page must have a bounded PDF link');
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Real practice must not overflow on mobile');
      await click('保存并退出');
    }
    realTypes.push(kind);
  }
  await navigate('/ap/'); await wait('document.querySelector("#ap-content").getAttribute("aria-busy") !== "true"');
  // Keyboard tab can reach an actual link/button from a fresh page.
  await cmd('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  assert.equal(await evaluate('["A","BUTTON","INPUT","SELECT"].includes(document.activeElement.tagName)'), true);
  assert.deepEqual(exceptions, []);
  console.log(JSON.stringify({ ok: true, browser: version.Browser, checks: ['empty catalog','synthetic MCQ scoring','FRQ no auto-grade','word count','draft navigation restore','wrong book','home synthetic exclusion','home AP links and filters','SAT-style exam layout','320/390/1440px layout','timer pause and restore','free mode','clock reload and expiry without submission','official MCQ/FRQ timing','503 state','storage denied','390px overflow','reduced motion','keyboard focus','real catalog schema'], realCatalog: realCheck, realTypes, screenshots: fileURLToPath(output) }, null, 2));
} finally {
  await call('Target.disposeBrowserContext', { browserContextId: context }).catch(() => {});
  ws.close();
}
