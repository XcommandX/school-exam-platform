// Isolated AP Chrome smoke: node back-end/cloudflare/tests/ap-browser-smoke.mjs
// Requires the complete locally built assets. No production services or data.
// Set CHROME_PATH to Chrome/Chromium on macOS/Linux or a non-default Windows install.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, sep, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const root = fileURLToPath(new URL('../', import.meta.url));
const assets = resolve(root, '../../local-data/builds/cloudflare/assets');
const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const setupToken = 'browser-fixture_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const username = 'browser-review', password = 'anonymous-browser-password';
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.mjs':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.gif':'image/gif', '.ico':'image/x-icon', '.mp3':'audio/mpeg', '.wav':'audio/wav', '.woff2':'font/woff2', '.woff':'font/woff' };
let mf, chrome, socket, origin, sequence = 0;
const pending = new Map(), errors = [], integrationWarnings = [], failedRequests = [], externalRequests = [], results = [];
const tempRoot = resolve(root, '../../local-data/test-artifacts');
await mkdir(tempRoot,{recursive:true});
const profile = await mkdtemp(resolve(tempRoot, 'school-platform-browser-'));
const log = (name, detail) => { results.push({name, detail}); console.log('PASS', name, JSON.stringify(detail ?? '')); };
async function until(check, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await delay(150); }
  throw new Error('Timed out: ' + label);
}
function command(method, params = {}) {
  return new Promise((resolveCall, rejectCall) => {
    const id = ++sequence, timeout = setTimeout(() => { pending.delete(id); rejectCall(new Error('CDP timeout: '+method)); }, 60000);
    pending.set(id, { resolve: value => { clearTimeout(timeout); resolveCall(value); }, reject: error => { clearTimeout(timeout); rejectCall(error); } });
    socket.send(JSON.stringify({id, method, params}));
  });
}
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function waitExpression(expression, label, timeout) {
  return until(async () => { try { return await evaluate(expression); } catch (error) { if (/context|navigat/i.test(error.message)) return false; throw error; } }, label, timeout);
}
async function navigate(path) {
  await evaluate('window.__browserSmokePreviousDocument = true');
  const response = await command('Page.navigate', {url:origin + path});
  if(response.errorText) throw new Error(response.errorText);
  const pathname = path.startsWith('/sat/?') ? '/sat/html/index.html' : path.split('?')[0];
  await waitExpression('!window.__browserSmokePreviousDocument && document.readyState === "complete" && location.pathname === '+JSON.stringify(pathname), 'navigate '+path);
}
let mode='scored', postCount=0; const held=[];
async function mockAI(requestId,request) {
  const config={enabled:true,version:'ap-lang-rubric-2019-v1',scoreMin:0,scoreMax:6,scoreStep:1,limits:{responseCharacters:18000}};
  let result=config;
  if(request.method==='POST') { postCount++; const body=JSON.parse(request.postData); assert.equal(body.consent,true); const {createHash}=await import('node:crypto');
    result={version:config.version,sourceId:body.sourceId,revision:body.revision,questionId:body.questionId,responseHash:createHash('sha256').update(body.response).digest('hex'),questionType:'argument',status:mode==='limited'?'limited':'scored',rows:mode==='limited'?null:{thesis:{score:1,reason:'<img src=x onerror=alert(1)>',evidence:['Essay quotation']},evidenceCommentary:{score:3,reason:'Evidence reason',evidence:[]},sophistication:{score:0,reason:'Complexity reason',evidence:[]}},total:mode==='limited'?null:4,feedback:'Mock AI browser fixture only',strengths:['Clear thesis'],improvements:['Explain evidence'],limitations:['Not real AI'],createdAt:new Date().toISOString()};
  }
  const deliver=()=>command('Fetch.fulfillRequest',{requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'application/json'}],body:Buffer.from(JSON.stringify(result)).toString('base64')});
  if(mode==='held'&&request.method==='POST')held.push(deliver);else await deliver();
}
try {
  const bundle = await build({entryPoints:[resolve(root,'src/worker.mjs')],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*'],target:'es2022'});
  mf = new Miniflare(convertV4MiniflareOptions({host:'127.0.0.1',port:0,https:true,modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-20',compatibilityFlags:['nodejs_compat'],bindings:{SETUP_TOKEN:setupToken},durableObjects:{AUTH:{className:'PlatformAuthStore',useSQLite:true},ACCOUNTS:{className:'PlatformAccountStore',useSQLite:true},BANK:{className:'PlatformBankStore',useSQLite:true}},serviceBindings:{ASSETS:async request=>{
    const pathname=decodeURIComponent(new URL(request.url).pathname);
    const sourceOverride=pathname.startsWith('/ap/') && /\.(js|css|html)$/.test(pathname);
    const path=sourceOverride?resolve(root,'../../front-end','.'+pathname):resolve(assets,'.'+pathname);
    if(!sourceOverride&&!path.startsWith(assets+sep))return new Response('not found',{status:404});
    try { const bytes=await readFile(path); return new Response(request.method==='HEAD'?null:bytes,{headers:{'Content-Type':mime[extname(path)]||'application/octet-stream'}}); }
    catch {return new Response('not found',{status:404});}
  }}}));
  const ready = await mf.ready;
  origin = 'https://study-smoke.invalid:' + ready.port;
  console.log('Isolated HTTPS runtime', origin);
  chrome = spawn(chromePath, ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--no-proxy-server','--ignore-certificate-errors','--host-resolver-rules=MAP study-smoke.invalid 127.0.0.1','--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--user-data-dir='+profile,'about:blank'], {stdio:'ignore',windowsHide:true});
  const processError = new Promise((_, reject) => chrome.once('error', reject));
  const portFile = await Promise.race([until(async()=>{try{return await readFile(resolve(profile,'DevToolsActivePort'),'utf8');}catch{return false;}},'Chrome debugging port'),processError]);
  const port = portFile.split(/\r?\n/)[0];
  const targets = await (await fetch('http://127.0.0.1:'+port+'/json/list')).json();
  const page = targets.find(item=>item.type==='page'); assert.ok(page);
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await once(socket,'open');
  socket.addEventListener('message', event=>{
    const value=JSON.parse(event.data);
    if(value.id){const call=pending.get(value.id);if(!call)return;pending.delete(value.id);value.error?call.reject(new Error(value.error.message)):call.resolve(value.result);return;}
    if(value.method==='Runtime.exceptionThrown')errors.push(value.params.exceptionDetails.exception?.description||value.params.exceptionDetails.text);
    if(value.method==='Runtime.consoleAPICalled'){
      const text=value.params.args.map(arg=>arg.value||arg.description).join(' ');
      if(value.params.type==='error')errors.push(text);
      if(value.params.type==='warning'&&text.includes('SAT homepage integration:'))integrationWarnings.push(text);
    }
    if(value.method==='Network.responseReceived'&&value.params.response.status>=400&&!value.params.response.url.endsWith('/favicon.ico'))failedRequests.push({url:value.params.response.url,status:value.params.response.status});
    if(value.method==='Fetch.requestPaused'){
      const {requestId,request}=value.params;
      if(/^https?:/.test(request.url)&&!request.url.startsWith(origin+'/')){externalRequests.push(request.url);void command('Fetch.failRequest',{requestId,errorReason:'BlockedByClient'}).catch(()=>{});}
      else if(new URL(request.url).pathname.startsWith('/api/ap/ai-config') || new URL(request.url).pathname==='/api/ap/assess') void mockAI(requestId,request);
      else void command('Fetch.continueRequest',{requestId}).catch(()=>{});
    }
  });
  await command('Page.enable'); await command('Runtime.enable'); await command('Network.enable');
  await command('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]});
  await navigate('/login');
  assert.equal(await evaluate('!!document.querySelector("#login-form")'),true);
  log('HTTPS non-loopback login page');
  await command('Page.navigate',{url:origin+'/setup#token='+setupToken});
  await waitExpression('document.querySelector("#setup-form") && document.readyState === "complete"','setup form');
  assert.equal(await evaluate('location.hash'), '');
  assert.equal(await evaluate('document.querySelector("#setup-token").value'), setupToken);
  await evaluate(`document.querySelector('#username').value=${JSON.stringify(username)};document.querySelector('#display-name').value='匿名浏览器审查';document.querySelector('#password').value=${JSON.stringify(password)};document.querySelector('#confirm-password').value=${JSON.stringify(password)};document.querySelector('#setup-submit').click();`);
  await waitExpression('location.pathname === "/account" && document.querySelector("#identity-username")?.textContent.includes('+JSON.stringify(username)+')','setup and account',45000);
  await waitExpression('document.querySelectorAll("#user-list tr").length > 0','admin user list');
  await navigate('/ap/');
  await waitExpression('!!window.APModel && document.querySelector("#ap-content h2")','AP ready');
  // Seed a completed synthetic argument record, never touch production records.
  const originalHistory=await evaluate(`(async()=>{const source=APModel.validateSource(await PlatformAuth.api('/api/ap/example'));const q=source.questions.find(q=>q.responseType==='argument');const draft=APModel.createDraft(source,Date.now()-10000,'ap-attempt:ai-browser',true);draft.answers[q.id]='My argument supports a clear thesis with relevant evidence and commentary.';const record=APModel.finish(source,draft,Date.now());localStorage.setItem(APModel.storageKeys(PlatformAuth.user.id).history,JSON.stringify([record]));return JSON.stringify([record]);})()`);
  const clickText=async text=>evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(text)});if(!b)throw Error('Missing button');b.click();})()`);
  async function review() {
    await navigate('/ap/?view=history'); await clickText('查看复盘');
    await waitExpression('[...document.querySelectorAll(".ap-ai-review button")].some(b=>b.textContent==="AI评分"&&!b.disabled)','AI enabled');
    await evaluate(`(()=>{const b=[...document.querySelectorAll('.ap-ai-review button')].find(b=>b.textContent==='AI评分'&&!b.disabled);b.closest('details').open=true;})()`);
  }
  async function assess(accept) {
    await evaluate(`window.confirm=message=>{window.__consentText=message;return ${accept};}`);
    await evaluate(`[...document.querySelectorAll('.ap-ai-review button')].find(b=>b.textContent==='AI评分'&&!b.disabled).click()`);
  }
  await review(); await assess(false); assert.equal(postCount,0);
  assert.match(await evaluate('window.__consentText'),/Cloudflare AI/);log('consent cancellation never sends essay');
  await assess(true);await waitExpression('document.body.innerText.includes("AI估分 4 / 6")','scored output');
  assert.equal(await evaluate('document.querySelectorAll(".ap-ai-review img").length'),0);
  assert.equal(await evaluate('document.body.innerText.includes("<img src=x onerror=alert(1)>")'),true);
  assert.equal(await evaluate('document.body.innerText.includes("下载反馈")'),true);
  const artifactDir=resolve(tempRoot,'ap-ai-browser');await mkdir(artifactDir,{recursive:true});
  await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});
  await evaluate(`[...document.querySelectorAll('.ap-ai-review')].find(box=>box.textContent.includes('AI估分 4 / 6')).scrollIntoView({behavior:'instant',block:'start'})`);
  await waitExpression('window.scrollY > 0','scored panel scrolled');
  const screenshot=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(resolve(artifactDir,'scored-mobile.png'),Buffer.from(screenshot.data,'base64'));
  log('scored 1+4+1 rows, safe plain text and feedback download visible');
  mode='limited';await review();await assess(true);await waitExpression('document.body.innerText.includes("仅提供反馈，未评分")','limited');
  assert.equal(await evaluate('document.body.innerText.includes("AI估分 4 / 6")'),false);log('limited response has no score');
  mode='held';await review();await assess(true);await until(()=>held.length,'held navigation request');
  await clickText('练习记录');await held.shift()().catch(()=>{});
  assert.equal(await evaluate('document.querySelectorAll(".ap-ai-review").length'),0);log('navigation aborts and suppresses stale output');
  await review();await assess(true);await until(()=>held.length,'held account request');
  await evaluate(`document.dispatchEvent(new CustomEvent('platform:session-ended'));`);await held.shift()().catch(()=>{});
  assert.equal(await evaluate('document.querySelector("#ap-main").hidden'),true);
  assert.equal(await evaluate('document.querySelector("#ap-content").textContent'),'');
  assert.equal(await evaluate('localStorage.getItem(APModel.storageKeys(PlatformAuth.user.id).history)'),originalHistory);
  log('session-ended clears personal output and preserves essay bytes');
  assert.deepEqual(errors,[]);assert.deepEqual(externalRequests,[]);
  await writeFile(resolve(artifactDir,'report.json'),JSON.stringify({mockAI:true,results,errors,failedRequests,externalRequests},null,2));
  console.log('AP AI Chrome smoke passed',artifactDir);
} catch(error) {
  if(socket?.readyState===WebSocket.OPEN){try{console.error('Failure page',await evaluate('({url:location.href,text:document.body?.innerText.slice(0,3000)})'));}catch{}}
  console.error(error.stack);process.exitCode=1;
} finally {
  if(socket?.readyState===WebSocket.OPEN){try{await command('Browser.close');}catch{}socket.close();}
  if(chrome&&chrome.exitCode===null){await Promise.race([once(chrome,'exit'),delay(4000)]);if(chrome.exitCode===null)chrome.kill();}
  if(mf)await mf.dispose();
  assert.equal(dirname(resolve(profile)),tempRoot);assert.ok(basename(profile).startsWith('school-platform-browser-'));
  try{await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200});}catch(error){console.warn('Temporary profile cleanup:',error.message);}
}
