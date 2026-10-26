// Isolated contest Chrome smoke: node back-end/cloudflare/tests/contest-browser-smoke.mjs
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
try {
  const bundle = await build({entryPoints:[resolve(root,'src/worker.mjs')],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*'],target:'es2022'});
  mf = new Miniflare(convertV4MiniflareOptions({host:'127.0.0.1',port:0,https:true,modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-20',compatibilityFlags:['nodejs_compat'],bindings:{SETUP_TOKEN:setupToken},durableObjects:{AUTH:{className:'PlatformAuthStore',useSQLite:true},ACCOUNTS:{className:'PlatformAccountStore',useSQLite:true},BANK:{className:'PlatformBankStore',useSQLite:true}},serviceBindings:{ASSETS:async request=>{
    const path=resolve(assets,'.'+decodeURIComponent(new URL(request.url).pathname));
    if(!path.startsWith(assets+sep))return new Response('not found',{status:404});
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
  log('setup form and administrator account page',await evaluate('({role:document.querySelector("#identity-role").textContent,users:document.querySelectorAll("#user-list tr").length})'));
  const cookies = await command('Network.getCookies',{urls:[origin]});
  const sessionCookie = cookies.cookies.find(c=>c.name==='study_session'); assert.ok(sessionCookie?.secure&&sessionCookie?.httpOnly); assert.equal(sessionCookie.sameSite,'Strict');
  log('browser accepts Secure HttpOnly SameSite=Strict cookie');
  await evaluate('document.querySelector("#logout").click()');
  await waitExpression('location.pathname === "/login" && document.querySelector("#login-form")','logout');
  await evaluate(`document.querySelector('#username').value=${JSON.stringify(username)};document.querySelector('#password').value=${JSON.stringify(password)};document.querySelector('#login-submit').click();`);
  await waitExpression('location.pathname === "/" && !!window.PlatformHome','login and home',45000);
  await waitExpression('performance.getEntriesByType("resource").some(row=>row.name.endsWith("/api/me/home") && row.responseEnd>0)','home state loaded');
  log('real login form returns home');
  const artifactDir = resolve(root,'../../local-data/test-artifacts/contest-cloudflare');
  await mkdir(artifactDir,{recursive:true});
  const screenshot = async name => {const image=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(resolve(artifactDir,name+'.png'),Buffer.from(image.data,'base64'));};
  for(const width of [390,1440]) {
    await command('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
    assert.equal(await evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'),true);
    assert.equal(await evaluate('document.querySelectorAll(".contest-entry .subject-links a").length'),4);
    assert.equal(await evaluate('document.querySelector("#home-ap-title").textContent'),'AP');
    await evaluate('document.querySelector(".contest-entry").scrollIntoView({block:"center"})');await screenshot('card-'+width);
  }
  const catalog = await evaluate(`PlatformAuth.api('/api/contests/catalog')`);
  assert.equal(catalog.totalProblems,4011);assert.equal(catalog.exams.length,232);assert.deepEqual(catalog.errors,[]);
  log('Authenticated complete shared catalogue',{exams:catalog.exams.length,questions:catalog.totalProblems,mathjax:catalog.mathjaxAvailable});
  await navigate('/contests/');await waitExpression('document.querySelectorAll(".exam-tile").length>0','contest library');
  const amc=catalog.exams.find(e=>e.contest==='AMC10');assert.ok(amc);
  await navigate('/contests/?exam='+encodeURIComponent(amc.id));
  await waitExpression('document.querySelector("#statement").textContent.trim().length>0','real AMC question');
  assert.equal(await evaluate('window.PlatformAuth.active'),true);
  const audited=await evaluate(`(async()=>{const c=await PlatformAuth.api('/api/contests/catalog');let n=0;for(const e of c.exams){const d=await PlatformAuth.api('/api/contests/exams/'+e.id);n+=d.problems.length;}return n;})()`);
  assert.equal(audited,4011);log('All 232 authenticated exam routes load',audited);
  if(catalog.mathjaxAvailable) await waitExpression('document.querySelector("mjx-container")','self-hosted MathJax');
  await screenshot('real-amc');
  await navigate('/contests/?mode=example');await waitExpression('document.querySelectorAll(".exam-tile").length>0','examples remain separate');
  const examples=await evaluate(`PlatformAuth.api('/api/contests/catalog?mode=example')`);assert.equal(examples.exams.length,4);
  const sample=examples.exams.find(e=>e.contest==='AMC10');
  const sampleData=await evaluate(`PlatformAuth.api('/api/contests/exams/'+${JSON.stringify(sample.id)}+'?mode=example')`);
  const first=sampleData.problems[0];
  await navigate('/contests/?mode=example&exam='+sample.id);
  await waitExpression('document.querySelectorAll("#choices input").length>0','example choices');
  await evaluate(`document.querySelector('#choices input[value="'+${JSON.stringify(first.answer.accepted[0])}+'"]').click();document.querySelector('#check-answer').click()`);
  await waitExpression('!document.querySelector("#score-report").hidden','score visible');
  assert.match(await evaluate('document.querySelector("#score-total").textContent'),/6\s*\/\s*6/);
  log('Real Worker ordinary submit gives visible score',await evaluate('document.querySelector("#score-total").textContent'));
  assert.deepEqual(errors,[]);assert.deepEqual(failedRequests,[]);assert.deepEqual(externalRequests,[]);
  await writeFile(resolve(artifactDir,'report.json'),JSON.stringify({results,errors,failedRequests,externalRequests},null,2));
  console.log('Contest Cloudflare browser integration complete',artifactDir);
} catch(error) {
  if(socket?.readyState===WebSocket.OPEN){try{console.error('Failure page',await evaluate('({url:location.href,text:document.body?.innerText.slice(0,2500)})'));}catch{}}
  console.error('Browser exceptions',JSON.stringify(errors));console.error('HTTP failures',JSON.stringify(failedRequests));console.error('External requests',JSON.stringify(externalRequests));
  console.error(error.stack);process.exitCode=1;
} finally {
  if(socket?.readyState===WebSocket.OPEN){try{await command('Browser.close');}catch{}socket.close();}
  if(chrome&&chrome.exitCode===null){await Promise.race([once(chrome,'exit'),delay(4000)]);if(chrome.exitCode===null)chrome.kill();}
  if(mf)await mf.dispose();
  // Delete only the exact unique temporary profile created by this invocation.
  assert.equal(dirname(resolve(profile)),tempRoot);assert.ok(basename(profile).startsWith('school-platform-browser-'));
  try{await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200});}catch(error){console.warn('Temporary profile cleanup:',error.message);}
}
