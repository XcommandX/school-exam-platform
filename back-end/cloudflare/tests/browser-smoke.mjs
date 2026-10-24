// Optional real-Chrome smoke: node back-end/cloudflare/tests/browser-smoke.mjs
// Requires the complete locally built assets. No production services or data.
// Set CHROME_PATH to Chrome/Chromium on macOS/Linux or a non-default Windows install.
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve, sep, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
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
const tempRoot = resolve(tmpdir()), profile = await mkdtemp(resolve(tempRoot, 'school-platform-browser-'));
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
    if(value.method==='Network.responseReceived'&&value.params.response.status>=400)failedRequests.push({url:value.params.response.url,status:value.params.response.status});
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
  await evaluate('document.querySelector("[data-dialog=plan]").click()');
  await waitExpression('document.querySelector("#plan-form")','plan form');
  await evaluate('document.querySelector("#plan-form [name=dailyGoal]").value="37";document.querySelector("#plan-form [name=note]").value="Anonymous browser smoke";document.querySelector("#plan-form button[type=submit]").click()');
  await waitExpression('!document.querySelector("#home-dialog").open && document.querySelector("#today-progress").textContent.includes("37")','plan saved');
  await command('Page.reload');
  await waitExpression('document.readyState === "complete" && performance.getEntriesByType("navigation")[0]?.type === "reload" && !!window.PlatformHome && document.querySelector("#today-progress").textContent.includes("37")','plan persisted');
  const home = await evaluate('(async()=>{const response=await fetch("/api/me/home");return {status:response.status,value:await response.json()};})()');
  assert.equal(home.status,200);assert.equal(home.value.value.plan.dailyGoal,37);assert.equal(home.value.value.plan.note,'Anonymous browser smoke');
  log('home plan DOM save survives reload and matches account DO');
  await navigate('/sat/?view=startPractice');
  await waitExpression('window.SATApp && window.SATLibrary?.state.status === "ready"','SAT catalogue',60000);
  log('SAT Start Practice catalogue',await evaluate('({status:SATLibrary.state.status,collections:SATLibrary.state.catalog?.length,bank:window.SATBank?.state,origin:location.origin})'));
  assert.equal(await evaluate('SATBank.state.connected'),true,'HTTPS SAT bank bridge must connect');
  await navigate('/sat/?view=practiceBuilder&mode=custom&section=math');
  await waitExpression('window.SATBuilderLibrary?.state.status === "ready" && !!document.querySelector("#questionResults")','SAT question index',60000);
  assert.equal(await evaluate('SATApp.appState.filters.section'),'math');
  log('SAT question catalogue and math filter',await evaluate('({status:SATBuilderLibrary.state.status,questions:SATBuilderLibrary.state.questions.length,section:SATApp.appState.filters.section})'));
  await navigate('/sat/?view=timingSettings');
  await evaluate('SATPlatformBridge.ready');
  await waitExpression('!!document.querySelector("#examTimerWarning")','SAT timing settings');
  await evaluate('const select=document.querySelector("#examTimerWarning");select.value="fixed";select.dispatchEvent(new Event("change",{bubbles:true}));');
  await waitExpression('window.SATSettings?.config.examTimerWarning === "fixed"','SAT preference write');
  await evaluate('SATAccountSync.sync()');
  const stored = await evaluate('(async()=>{const response=await fetch("/api/sat/settings/appConfig",{headers:{"X-Account-ID":PlatformAuth.user.id}});return {status:response.status,value:await response.json()};})()');
  assert.equal(stored.status,200);assert.equal(stored.value.value.examTimerWarning,'fixed');
  log('SAT timing deep link and preference reaches account DO');
  for(const view of ['history','wrongBook','syncConflicts']){
    await navigate('/sat/?view='+view);
    await evaluate('SATPlatformBridge.ready');
    assert.equal(await evaluate('SATApp.appState.view'),view);
    log('SAT '+view+' deep link');
  }
  for(const section of ['reading','listening','speaking','writing']){
    await navigate('/toefl/?section='+section);
    await waitExpression('!!window.PracticeCloud && !!window.FOUR_DATA && !!document.querySelector("#app .site-header")','TOEFL '+section,60000);
    const info = await evaluate('({user:PracticeCloud.userId,heading:document.querySelector("#app main")?.innerText.slice(0,180),status:PracticeCloud.getStatus(),records:FOUR_DATA.records?.length,buttons:document.querySelectorAll("#app button").length})');
    assert.ok(info.buttons>5); assert.ok(!info.heading.includes('暂时无法加载'));
    assert.equal(await evaluate('document.querySelector(".subject.active")?.dataset.value'),section);
    assert.equal(await evaluate('PracticeCloud.recordingsReady'),false,'cloud recording must remain explicitly disabled');
    assert.equal(await evaluate('PracticeCloud.aiReady'),false,'external AI must remain explicitly disabled');
    log('TOEFL '+section+' module',info);
  }
  console.log('Browser exceptions',JSON.stringify(errors));
  console.log('Failed HTTP requests',JSON.stringify(failedRequests));
  console.log('Blocked external requests',JSON.stringify(externalRequests));
  assert.deepEqual(errors,[],'no browser JavaScript exceptions or console errors');
  assert.deepEqual(integrationWarnings,[],'no swallowed SAT route integration errors');
  assert.deepEqual(failedRequests.filter(item=>!item.url.endsWith('/favicon.ico')),[],'no app HTTP failures');
  assert.deepEqual(externalRequests,[],'no external services required by smoke routes');
  console.log('BROWSER SMOKE PASSED',results.length,'checks');
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
