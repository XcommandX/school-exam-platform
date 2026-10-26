// Real Chromium smoke tests; no npm packages or personal browser profiles.
// PYTHON=/path/to/python CHROME_PATH=/path/to/chrome node tests/contest-browser.mjs
// Add --private to additionally inspect an already-imported local bank (never uploaded).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const usePrivate = process.argv.includes('--private');
const out = path.join(root, 'local-data', 'test-results', `${Date.now()}${usePrivate ? '-private' : '-example'}`);
fs.mkdirSync(out, {recursive: true});
const profile = path.join(out, 'chrome-profile');
const portFile = path.join(out, 'server-port.txt');
const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const chrome = process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome');
const tempPrivate = path.join(out, 'empty-private');
fs.mkdirSync(tempPrivate, {recursive:true});
for (const folder of ['contest-vendor', ...(usePrivate ? ['contests'] : [])]) {
  const source = path.join(root, 'local-data', folder);
  if (fs.existsSync(source)) fs.cpSync(source, path.join(tempPrivate, folder), {recursive:true});
}
const serverCode = "from pathlib import Path; import sys; sys.path.insert(0,str(Path(sys.argv[1])/'back-end')); from server.serve_platform import create_server; s=create_server(Path(sys.argv[1]),0,Path(sys.argv[2])); s.auth.store.create_user('browser-contest-fixture','fixture-password'); s.auth.store.create_user('browser-contest-second','fixture-password'); Path(sys.argv[3]).write_text(str(s.server_port)); s.serve_forever()";
const server = spawn(python, ['-u','-c',serverCode, root, tempPrivate, portFile], {cwd:root,stdio:'ignore'});
let launchError;
server.on('error', e => { launchError = e; });
const browser = spawn(chrome, ['--headless=new','--disable-gpu','--no-first-run','--disable-background-networking','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'], {stdio:'ignore'});
browser.on('error', e => { launchError = e; });
let ws;
const results = [], errors = [], external = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFile(file) { for(let n=0;n<150;n++) { if (launchError) throw launchError; if(fs.existsSync(file)) return fs.readFileSync(file,'utf8'); await delay(100); } throw Error(`Startup timeout: ${path.basename(file)}`); }
try {
  const port = Number(await waitFile(portFile));
  const debugPort = Number((await waitFile(path.join(profile,'DevToolsActivePort'))).split('\n')[0]);
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve,reject) => {ws.onopen=resolve;ws.onerror=reject;});
  let nextId=0;const pending = new Map();
  function call(method,params={}) { return new Promise((resolve,reject) => {const id=++nextId;const timer=setTimeout(()=>{pending.delete(id);reject(Error(`CDP timeout: ${method}`));},30000);pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});ws.send(JSON.stringify({id,method,params}));}); }
  ws.onmessage = event => {const m=JSON.parse(event.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);if(p)m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails);else if(m.method==='Fetch.requestPaused'){const url=m.params.request.url;if(/^https?:/.test(url)&&!url.startsWith(`http://127.0.0.1:${port}/`)){external.push(url);call('Fetch.failRequest',{requestId:m.params.requestId,errorReason:'BlockedByClient'}).catch(()=>{});}else call('Fetch.continueRequest',{requestId:m.params.requestId}).catch(()=>{});}};
  async function run(expression){const response=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(response.exceptionDetails)throw Error(JSON.stringify(response.exceptionDetails));return response.result.value;}
  async function until(expression) {
    for(let n=0;n<300;n++) {if(await run(`Boolean(${expression})`))return;await delay(50);}
    const diagnostics=await run(`({url:location.href,active:document.activeElement?.outerHTML,notice:document.querySelector('#notice')?.textContent,error:document.querySelector('#error')?.textContent,math:document.querySelector('#math-notice')?.textContent,busy:document.querySelector('#question-panel')?.getAttribute('aria-busy'),practiceHidden:document.querySelector('#practice-view')?.hidden})`);
    throw Error('Timed out: '+expression+'; '+JSON.stringify(diagnostics));
  }
  async function click(selector){await run(`document.querySelector(${JSON.stringify(selector)}).click()`);}
  async function input(selector,value){await run(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));})()`);}
  async function navigate(suffix){await call('Page.navigate',{url:`http://127.0.0.1:${port}${suffix}`});await until(`document.readyState==='complete'&&document.querySelector('#exam-count')?.textContent&&!document.querySelector('#notice').textContent.includes('正在读取')`);}
  async function questionReady(number){await until(`!document.querySelector('#practice-view').hidden&&document.querySelector('#question-panel').getAttribute('aria-busy')==='false'${number ? `&&document.querySelector('#question-title').textContent==='第 ${number} 题'` : ''}`);}
  async function screenshot(name){const result=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(result.data,'base64'));}
  async function assertLayout(){const value=await run(`({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,mathErrors:document.querySelectorAll('[data-mml-node="merror"],[data-mjx-error]').length})`);assert.ok(value.scroll<=value.width,JSON.stringify(value));assert.equal(value.mathErrors,0);return value;}
  await call('Runtime.enable');await call('Page.enable');await call('Emulation.setFocusEmulationEnabled',{enabled:true});await call('Page.bringToFront');await call('Fetch.enable',{patterns:[{urlPattern:'*'}]});
  await call('Emulation.setDeviceMetricsOverride',{width:1360,height:1000,deviceScaleFactor:1,mobile:false});
  const origin = `http://127.0.0.1:${port}`;
  const login = await fetch(origin + '/api/auth/login', {method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({username:'browser-contest-fixture',password:'fixture-password'})});
  assert.equal(login.status,200); const cookie=login.headers.get('set-cookie').split(';')[0];
  await call('Network.setCookie',{name:cookie.split('=')[0],value:cookie.slice(cookie.indexOf('=')+1),url:origin,httpOnly:true,sameSite:'Strict'});
  const apiFetch = route => fetch(origin + route, {headers:{Cookie:cookie}});
  await navigate('/contests/');
  if(!usePrivate){assert.match(await run(`document.querySelector('#exam-list').textContent`),/尚未导入/);assert.equal(await run(`document.querySelectorAll('.exam-tile').length`),0);results.push('Private empty state does not auto-select examples');await screenshot('empty-desktop');}
  await click('#example-mode');await until(`document.querySelectorAll('.exam-tile').length>0&&document.querySelector('#example-mode').getAttribute('aria-pressed')==='true'`);
  await assertLayout();await screenshot('library-desktop');
  const exampleCatalog=await (await apiFetch('/api/contests/catalog?mode=example')).json();
  const exams={};for(const item of exampleCatalog.exams)exams[item.contest]=await(await apiFetch(`/api/contests/exams/${item.id}?mode=example`)).json();
  assert.equal(exampleCatalog.exams.length,4);
  const amc=exams.AMC10;
  await run(`document.querySelector('.exam-tile[data-exam="${amc.id}"]').focus()`);
  await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r',unmodifiedText:'\r'});await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await questionReady();assert.equal(await run(`document.activeElement.id`),'question-title');results.push('Keyboard Enter opens exam and moves focus to new question');
  const first=amc.problems[0], wrong=first.choices.find(c=>!first.answer.accepted.includes(c.label)).label;
  await click(`#choices input[value="${wrong}"]`);await click('#check-answer');assert.match(await run(`document.querySelector('#feedback').textContent`),/不匹配/);
  assert.equal(await run(`document.querySelector('#score-report').hidden`),false);assert.equal(await run(`document.querySelector('#score-total').textContent`),'0 / 6 分');
  await click('#bookmark');assert.equal(await run(`document.querySelector('#bookmark').getAttribute('aria-pressed')`),'true');
  await click('[data-view="wrong"]');assert.equal(await run(`document.querySelectorAll('#saved-list .saved-row').length`),1);
  await click('#saved-list button');await questionReady();assert.equal(await run(`document.querySelector('#check-answer').disabled`),true);
  await call('Page.reload');await questionReady();assert.match(await run(`document.querySelector('#feedback').textContent`),/不匹配/);
  results.push('Choice grading, first-attempt lock, wrong book, bookmark and reload persistence');
  await click('[data-view="bookmarks"]');assert.equal(await run(`document.querySelectorAll('#saved-list .saved-row').length`),1);
  await click('[data-view="library"]');
  await click('.contest-card[data-contest="AIME"]');await click('.exam-tile');await questionReady();
  const aime=exams.AIME;
  for(const p of aime.problems.filter(p=>p.quality.auto_gradable)){
    await click(`#question-nav button[aria-label^="第 ${p.number} 题"]`);await questionReady(p.number);
    await input('#integer-answer','x');await click('#check-answer');assert.match(await run(`document.querySelector('#feedback').textContent`),/0–999/);
    await input('#integer-answer',String(p.answer.value).padStart(3,'0'));await click('#check-answer');assert.match(await run(`document.querySelector('#feedback').textContent`),/回答正确/);
  }
  results.push('AIME integer validation and padded answers');
  const disputed=Object.values(exams).flatMap(e=>e.problems.map(p=>({e,p}))).find(({p})=>p.question_type!=='proof'&&!p.quality.auto_gradable);
  if(disputed){await navigate(`/contests/?mode=example&exam=${disputed.e.id}&q=${disputed.p.number}`);await questionReady(disputed.p.number);assert.equal(await run(`document.querySelector('#check-answer').disabled`),true);results.push('Disputed problem grading gate');}
  await navigate(`/contests/?mode=example&exam=${amc.id}&q=${amc.problems[1].number}`);await questionReady(amc.problems[1].number);
  assert.equal(amc.problems[1].solutions.length,0);
  await click('#solution-details summary');await until(`document.querySelector('#solution-body').childElementCount>0`);
  assert.equal(await run(`document.querySelector('#check-answer').disabled`),false);results.push('Opening missing solution does not reveal or disable grading');
  await click('#reveal-answer');assert.equal(await run(`document.querySelector('#check-answer').disabled`),true);results.push('Answer reveal excludes subsequent grading');
  await navigate(`/contests/?mode=example&exam=${exams.USAMO.id}`);await questionReady();
  const proof='Original browser-test proof draft: expand both squares and compare.';
  await input('#proof-draft',proof);await call('Page.reload');await questionReady();assert.equal(await run(`document.querySelector('#proof-draft').value`),proof);assert.equal(await run(`document.querySelector('#check-answer').hidden`),true);
  await click('#solution-details summary');await until(`document.querySelector('#solution-body').childElementCount>0`);await assertLayout();
  results.push('Proof draft persistence and manual-only review');await screenshot('proof-desktop');
  const beforeSecond = await run(`localStorage.getItem(ContestTimer.storageKey(PlatformAuth.user.id))`);
  const second = await call('Target.createTarget',{url:`http://127.0.0.1:${port}/contests/?mode=example&exam=${exams.USAMO.id}`});
  let secondSocket;
  try {
    const pages=await(await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    secondSocket=new WebSocket(pages.find(p=>p.id===second.targetId).webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{secondSocket.onopen=resolve;secondSocket.onerror=reject;});
    let secondId=0;
    const secondRun=expression=>new Promise((resolve,reject)=>{
      const id=++secondId,timer=setTimeout(()=>reject(Error('Second tab CDP timeout')),10000);
      secondSocket.onmessage=e=>{const m=JSON.parse(e.data);if(m.id===id){clearTimeout(timer);m.error?reject(Error(m.error.message)):resolve(m.result);}};
      secondSocket.send(JSON.stringify({id,method:'Runtime.evaluate',params:{returnByValue:true,expression}}));
    });
    // Poll from Node: a promise created in about:blank can be destroyed by navigation.
    let secondReady=false;
    for(let n=0;n<300;n++){
      const check=await secondRun(`document.readyState==='complete'&&!document.querySelector('#practice-view')?.hidden&&document.querySelector('#question-panel')?.getAttribute('aria-busy')==='false'`);
      if(check.result?.value){secondReady=true;break;}await delay(50);
    }
    assert.equal(secondReady,true,'Second tab did not finish loading');
    const secondResult=await secondRun(`(()=>{const d=document.querySelector('#proof-draft');d.value='Second tab must not overwrite';d.dispatchEvent(new Event('input',{bubbles:true}));return {notice:document.querySelector('#storage-notice').textContent,draft:document.querySelector('#draft-status').textContent,saved:localStorage.getItem(ContestTimer.storageKey(PlatformAuth.user.id))};})()`);
    assert.ok(!secondResult.exceptionDetails,JSON.stringify(secondResult));
    assert.match(secondResult.result.value.notice,/另一个标签页/);assert.match(secondResult.result.value.draft,/尚未保存/);
    assert.equal(secondResult.result.value.saved,beforeSecond);results.push('Second tab cannot overwrite saved drafts or first-attempt locks');
  } finally {secondSocket?.close();await call('Target.closeTarget',{targetId:second.targetId});}
  if(usePrivate){
    await navigate('/contests/');assert.equal(await run(`document.querySelector('#count-total').textContent`),'4,011');
    await screenshot('private-library-desktop');
    for(const [id,num] of [['amc10-2015-regular-b',8],['usamo-2022-regular-single',2],['amc12-2002-regular-p',12],['aime-2026-regular-ii',1]]){
      await navigate(`/contests/?exam=${id}&q=${num}`);await questionReady(num);
      await run(`Promise.all([...document.querySelectorAll('#statement img')].map(i=>i.decode()))`);
      assert.ok(await run(`document.querySelectorAll('#statement mjx-container').length>0`));await assertLayout();
      if(id==='aime-2026-regular-ii')assert.equal(await run(`document.querySelector('#check-answer').disabled`),true);
      if(id==='usamo-2022-regular-single'){assert.ok(await run(`document.querySelectorAll('#statement img').length>0`));await screenshot('private-proof-diagram');}
      if(id==='amc10-2015-regular-b')await screenshot('private-math-desktop');
    }
    await navigate('/contests/?exam=amc10-2000-regular-single&q=2');await questionReady(2);await click('#solution-details summary');
    await until(`document.querySelector('#solution-body').textContent.includes('独立推导参考解答')`);
    assert.equal(await run(`document.querySelectorAll('.external-solutions a').length`),1);
    assert.match(await run(`document.querySelector('.external-solutions a').href`),/^https:\/\/live\.poshenloh\.com\//);
    await screenshot('private-supplemented-solution');
    results.push('4011 private questions, local diagrams/MathJax, new independent solution/reference link, supplemental and real dispute gates');
  }
  // Defense in depth: bypass backend normalization with synthetic hostile API HTML.
  // Only original examples are altered; nothing is written into the question bank.
  const hostile=String.raw`<p>Original sanitizer test $x^2+1$.</p><script>window.contestUnsafe=1</script><iframe src="https://example.invalid/frame"></iframe><svg onload="window.contestUnsafe=2"><script>window.contestUnsafe=3</script></svg><img src="https://example.invalid/image.png" onerror="window.contestUnsafe=4"><img src="/contest-assets/assets/../escape.svg"><a href="javascript:window.contestUnsafe=5" onclick="window.contestUnsafe=6">unsafe link</a><span style="background:url(https://example.invalid/pixel)" onmouseover="window.contestUnsafe=7">safe text</span><p>$\href{javascript:window.contestUnsafe=8}{unsafe}$ $\href{https://example.invalid/math}{external}$ $\url{https://example.invalid/url}$ $\require{https://example.invalid/extension.js}$</p>`;
  const hostileScript=await call('Page.addScriptToEvaluateOnNewDocument',{source:`const nativeFetch=window.fetch;window.fetch=async(...args)=>{const r=await nativeFetch(...args);if(String(args[0]).includes('/api/contests/exams/${exams.AMC12.id}')){const d=await r.json();d.problems[0].statement.html=${JSON.stringify(hostile)};return new Response(JSON.stringify(d),{status:200,headers:{'Content-Type':'application/json'}});}return r;};`});
  await navigate(`/contests/?mode=example&exam=${exams.AMC12.id}&q=1`);await questionReady(1);
  assert.equal(await run(`window.contestUnsafe||0`),0);
  assert.equal(await run(`document.querySelectorAll('#statement script,#statement iframe,#statement img,#statement object,#statement [onclick],#statement [onerror],#statement [onload],#statement [onmouseover]').length`),0);
  assert.equal(await run(`[...document.querySelectorAll('#statement a')].some(a=>/^(?:javascript:|https?:)/i.test(a.getAttribute('href')||a.getAttribute('xlink:href')||''))`),false);
  if(usePrivate)assert.ok(await run(`document.querySelectorAll('#statement mjx-container').length>0`));
  await call('Page.removeScriptToEvaluateOnNewDocument',{identifier:hostileScript.identifier});results.push('Synthetic hostile HTML/TeX stays inert with no unsafe links or external requests');
  // Hold a real (or unavailable-formula fallback) typeset to force rapid navigation.
  await navigate(`/contests/?mode=example&exam=${exams.USAMO.id}&q=1`);await questionReady(1);
  await run(`(()=>{const mj=window.MathJax||(window.MathJax={}),original=mj.typesetPromise?.bind(mj)||(()=>Promise.resolve());window.contestMathReady=Promise.resolve(true);let once=true;mj.typesetPromise=async(...args)=>{if(once){once=false;await new Promise(resolve=>{window.releaseTypeset=resolve;});}return original(...args);};})()`);
  await click('#question-nav button[aria-label^="第 2 题"]');await until(`typeof window.releaseTypeset==='function'`);
  await click('#question-nav button[aria-label^="第 3 题"]');await run(`window.releaseTypeset()`);await questionReady(3);
  await input('#proof-draft','Draft belongs only to question three');
  const identity=await run(`(()=>{const s=ContestModel.load(JSON.stringify(JSON.parse(localStorage.getItem(ContestTimer.storageKey(PlatformAuth.user.id))).regular));const e={id:'${exams.USAMO.id}',revision:'${exams.USAMO.revision}'};return ContestModel.getSession(s,'example',e).responses;})()`);
  assert.equal(identity[exams.USAMO.problems[2].id].value,'Draft belongs only to question three');assert.notEqual(identity[exams.USAMO.problems[1].id]?.value,'Draft belongs only to question three');
  await run(`(()=>{const original=MathJax.typesetPromise.bind(MathJax);let once=true;window.releaseModeTypeset=null;MathJax.typesetPromise=async(...args)=>{if(once){once=false;await new Promise(resolve=>{window.releaseModeTypeset=resolve;});}return original(...args);};})()`);
  await click('#question-nav button[aria-label^="第 2 题"]');await until(`typeof window.releaseModeTypeset==='function'`);
  await click('#private-mode');await run(`window.releaseModeTypeset()`);await until(`document.querySelector('#private-mode').getAttribute('aria-pressed')==='true'`);
  assert.equal(await run(`document.querySelector('#practice-view').hidden`),true);assert.equal(await run(`document.querySelector('#library-view').hidden`),false);
  results.push('Delayed math rendering preserves final question, response identity and mode');
  await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});
  await navigate(`/contests/?mode=example&exam=${amc.id}`);await questionReady();await assertLayout();await screenshot('practice-mobile');
  await navigate('/contests/?mode=example');await assertLayout();await screenshot('library-mobile');
  await call('Emulation.setDeviceMetricsOverride',{width:320,height:720,deviceScaleFactor:1,mobile:false});await assertLayout();
  await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  assert.equal(await run(`getComputedStyle(document.querySelector('.contest-card')).transitionDuration`),'0s');
  // Test keyboard focus and a forbidden localStorage gracefully in a fresh page load.
  await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  assert.notEqual(await run(`document.activeElement.tagName`),'BODY');
  const injected=await call('Page.addScriptToEvaluateOnNewDocument',{source:`Object.defineProperty(window,'localStorage',{get(){throw Error('storage disabled for smoke test')}});`});
  await navigate(`/contests/?mode=example&exam=${exams.USAMO.id}`);await questionReady();assert.equal(await run(`document.querySelector('#storage-notice').hidden`),false);
  await input('#proof-draft','Unsaved proof');assert.match(await run(`document.querySelector('#draft-status').textContent`),/尚未保存/);
  await call('Page.removeScriptToEvaluateOnNewDocument',{identifier:injected.identifier});
  results.push('390px / 320px layouts, reduced motion, keyboard focus and storage-denied fallback');
  const delayed=await call('Page.addScriptToEvaluateOnNewDocument',{source:`const originalFetch=window.fetch;window.fetch=async(...args)=>{if(String(args[0]).includes('/api/contests/catalog')){await new Promise(resolve=>{window.releaseCatalog=resolve});}return originalFetch(...args);};`});
  await call('Page.navigate',{url:`http://127.0.0.1:${port}/contests/?mode=example&exam=${amc.id}`});
  await until(`typeof window.releaseCatalog==='function'`);await click('[data-view="history"]');await run(`window.releaseCatalog()`);
  await until(`document.querySelectorAll('.exam-tile').length>0&&!document.querySelector('#notice').textContent.includes('正在读取')`);
  assert.equal(await run(`document.querySelector('#saved-view').hidden`),false);assert.equal(await run(`document.querySelector('#practice-view').hidden`),true);
  await call('Page.removeScriptToEvaluateOnNewDocument',{identifier:delayed.identifier});
  await navigate('/contests/?mode=example&view=history');assert.equal(await run(`document.querySelector('#saved-view').hidden`),false);
  await click('[data-view="library"]');await click('#private-mode');await until(`document.querySelector('#private-mode').getAttribute('aria-pressed')==='true'`);
  assert.equal(await run(`document.querySelector('#library-view').hidden`),false);results.push('Delayed catalogs respect newer navigation; initial URL view is not replayed on mode change');
  await call('Page.navigate',{url:`http://127.0.0.1:${port}/`});await until(`document.querySelector('.contest-entry a[href="/contests/"]')`);assert.ok(await run(`document.querySelector('.subject-links a[href^="/sat/"]')!==null`));
  await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});await assertLayout(); await screenshot('home-mobile');
  await call('Emulation.setDeviceMetricsOverride',{width:1360,height:1000,deviceScaleFactor:1,mobile:false});await assertLayout();await screenshot('home-desktop');
  await run(`document.querySelector('.contest-entry').scrollIntoView({block:'center'})`);await screenshot('contest-card-desktop');
  assert.equal(await run(`document.querySelectorAll('.contest-entry .subject-links a').length`),4);
  assert.ok(await run(`document.querySelector('.home-ap-entry a[href="/ap/"]')!==null`));
  await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});await assertLayout();await run(`document.querySelector('.contest-entry').scrollIntoView({block:'center'})`);await screenshot('contest-card-mobile');
  await call('Emulation.setDeviceMetricsOverride',{width:1360,height:1000,deviceScaleFactor:1,mobile:false});
  results.push('Home link and existing SAT entry remain present');
  // Native dialogs are accepted only for explicit test start/finish actions.
  async function confirmClick(selector){await until(`!document.querySelector(${JSON.stringify(selector)}).disabled&&!document.querySelector(${JSON.stringify(selector)}).hidden`);const opened=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{ws.removeEventListener('message',listener);reject(Error('Expected confirmation: '+selector));},10000);function listener(event){const m=JSON.parse(event.data);if(m.method==='Page.javascriptDialogOpening'){clearTimeout(timer);ws.removeEventListener('message',listener);resolve();}}ws.addEventListener('message',listener);});const promise=click(selector);await opened;await call('Page.handleJavaScriptDialog',{accept:true});await promise;}
  await navigate(`/contests/?mode=example&exam=${amc.id}`);await questionReady();
  const regularBefore=await run(`JSON.stringify(JSON.parse(localStorage.getItem(ContestTimer.storageKey(PlatformAuth.user.id))).regular)`);
  await click('#timed-mode');await confirmClick('#timer-start');
  await until(`document.querySelector('#timer-status').dataset.status==='running'`);
  assert.equal(await run(`document.querySelector('#reveal-answer').hidden&&document.querySelector('#solution-details').hidden&&document.querySelector('#check-answer').hidden`),true);
  assert.equal(await run(`document.querySelector('#score-report').hidden`),true);
  await click(`#choices input[value="${first.answer.accepted[0]}"]`);
  const started=await run(`JSON.parse(localStorage.getItem(ContestTimer.storageKey(PlatformAuth.user.id))).timed.attempts.at(-1)`);
  assert.equal(started.sessions[0].deadline-started.sessions[0].startedAt,75*60*1000);
  await call('Page.reload');await questionReady();
  const resumed=await run(`JSON.parse(localStorage.getItem(ContestTimer.storageKey(PlatformAuth.user.id))).timed.attempts.at(-1)`);
  assert.equal(resumed.sessions[0].deadline,started.sessions[0].deadline);assert.equal(resumed.responses[first.id].value,started.responses[first.id].value);
  assert.equal(await run(`document.querySelectorAll('#timer-source[href],#source-body a,#statement a[href]').length`),0);
  await screenshot('timed-desktop');await call('Emulation.setDeviceMetricsOverride',{width:320,height:720,deviceScaleFactor:1,mobile:false});await assertLayout();await screenshot('timed-mobile');await call('Emulation.setDeviceMetricsOverride',{width:1360,height:1000,deviceScaleFactor:1,mobile:false});await confirmClick('#timer-finish');await until(`document.querySelector('#timer-status').dataset.status==='finished'`);
  assert.equal(await run(`[...document.querySelectorAll('#choices input')].every(e=>e.disabled)`),true);
  assert.equal(await run(`JSON.stringify(JSON.parse(localStorage.getItem(ContestTimer.storageKey(PlatformAuth.user.id))).regular)`),regularBefore);
  const expectedTimed=6+(amc.problems.filter(p=>p.quality.auto_gradable).length-1)*1.5;
  assert.equal(await run(`document.querySelector('#score-report').hidden`),false);assert.match(await run(`document.querySelector('#score-title').textContent`),/部分题/);
  assert.equal(await run(`document.querySelector('#score-total').textContent`),`${expectedTimed} / ${amc.problems.filter(p=>p.quality.auto_gradable).length*6} 分`);
  const finishedScore=await run(`document.querySelector('#score-report').textContent`);await call('Page.reload');await questionReady();assert.equal(await run(`document.querySelector('#score-report').textContent`),finishedScore);await screenshot('submitted-score');
  // Resume a synthetically expired attempt to avoid a 75-minute smoke wait.
  await click('#new-attempt');await confirmClick('#timer-start');
  const clockShift=await call('Page.addScriptToEvaluateOnNewDocument',{source:`const realNow=Date.now;Date.now=()=>realNow()+76*60000;`});
  await call('Page.reload');await questionReady();await until(`document.querySelector('#timer-status').dataset.status==='expired'`);
  await call('Page.removeScriptToEvaluateOnNewDocument',{identifier:clockShift.identifier});
  assert.equal(await run(`[...document.querySelectorAll('#choices input')].every(e=>e.disabled)`),true);
  assert.equal(await run(`document.querySelector('#score-report').hidden`),false);assert.equal(await run(`document.querySelector('#score-total').textContent`),`${amc.problems.filter(p=>p.quality.auto_gradable).length*1.5} / ${amc.problems.filter(p=>p.quality.auto_gradable).length*6} 分`);
  results.push('Timed scores hidden live; finish/reload/expiry show correct and blank scores, readonly records and separate untimed totals');
  const fullUsamo=await call('Page.addScriptToEvaluateOnNewDocument',{source:`const nativeFetch=window.fetch;window.fetch=async(...args)=>{const r=await nativeFetch(...args);if(String(args[0]).includes('/api/contests/exams/${exams.USAMO.id}')){const d=await r.json();d.problems.push(...d.problems.map((p,i)=>({...p,id:d.id+'-0'+(i+4),number:i+4})));return new Response(JSON.stringify(d),{status:200,headers:{'Content-Type':'application/json'}});}return r;};`});
  await navigate(`/contests/?mode=example&exam=${exams.USAMO.id}`);await questionReady();await click('#timed-mode');await confirmClick('#timer-start');
  assert.match(await run(`document.querySelector('#timer-remaining').textContent`),/^04:29:|^04:30:/);
  await confirmClick('#timer-finish');await click('#timer-days [data-day="1"]');
  assert.equal(await run(`document.querySelector('#timer-status').dataset.status`),'ready');
  await confirmClick('#timer-start');await until(`document.querySelector('#timer-status').dataset.status==='running'`);
  const usamoAttempt=await run(`JSON.parse(localStorage.getItem(ContestTimer.storageKey(PlatformAuth.user.id))).timed.attempts.at(-1)`);
  assert.equal(usamoAttempt.sessions[0].status,'finished');assert.equal(usamoAttempt.sessions[1].deadline-usamoAttempt.sessions[1].startedAt,270*60000);
  await confirmClick('#timer-finish');results.push('USAMO days start separately, each 270 minutes');
  const ownerKey=await run(`ContestTimer.storageKey(PlatformAuth.user.id)`);const ownerData=await run(`localStorage.getItem(${JSON.stringify(ownerKey)})`);
  const secondLogin=await fetch(origin+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({username:'browser-contest-second',password:'fixture-password'})});assert.equal(secondLogin.status,200);
  const secondCookie=secondLogin.headers.get('set-cookie').split(';')[0];await call('Network.setCookie',{name:secondCookie.split('=')[0],value:secondCookie.slice(secondCookie.indexOf('=')+1),url:origin,httpOnly:true,sameSite:'Strict'});
  await navigate('/contests/?mode=example&view=history');await until(`PlatformAuth.user.username==='browser-contest-second'`);
  assert.notEqual(await run(`ContestTimer.storageKey(PlatformAuth.user.id)`),ownerKey);
  assert.equal(await run(`document.querySelectorAll('#saved-list .saved-row').length`),0);
  assert.equal(await run(`localStorage.getItem(${JSON.stringify(ownerKey)})`),ownerData);
  results.push('Second authenticated account sees no previous account records and leaves originals intact');
  assert.equal(errors.length,0,JSON.stringify(errors));assert.equal(external.length,0,JSON.stringify(external));
  const report={passed:true,platform:os.platform(),usePrivate,results,errors,external};fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({...report,output:out},null,2));await call('Browser.close').catch(()=>{});
} catch(error){fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({passed:false,error:String(error),results,errors,external},null,2));console.error(error);console.error('Artifacts:',out);process.exitCode=1;}
finally{ws?.close();browser.kill();server.kill();}
