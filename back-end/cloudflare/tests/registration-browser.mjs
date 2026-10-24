// Real installed Chrome + actual frontend files, MOCK HTTP API only (not backend integration).
// Run: node back-end/cloudflare/tests/registration-browser.mjs (Node 24+, Chrome installed).
// Optional CHROME_PATH; no npm dependencies, build, real mail, accounts, or production calls.
// A unique loopback server and disposable Chrome profile exist only for this process.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const artifactRoot = resolve(root, 'local-data/test-artifacts/registration');
await mkdir(artifactRoot, { recursive: true });
const runDir = await mkdtemp(resolve(artifactRoot, 'run-'));
const tempRoot = resolve(tmpdir());
const profile = await mkdtemp(resolve(tempRoot, 'registration-browser-'));
const chromePath = process.env.CHROME_PATH || (process.platform === 'win32'
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome');
const fixture = { username: 'anonymous-student', displayName: '匿名浏览器同学', password: 'synthetic-only-password' };
const administrator = { id:'fixture-admin', username:'admin-fixture', displayName:'匿名管理员', role:'admin', active:true };
const student = { id:'fixture-student', username:'student-fixture', displayName:'匿名学生', role:'student', active:true };
const endpoints = { config: '/api/auth/registration-config', session: '/api/auth/session', login: '/api/auth/login', register: '/api/auth/register', requests:'/api/admin/registrations', users:'/api/admin/users' };
const application = (id='request-one', status='pending') => ({id,username:fixture.username,displayName:fixture.displayName,status,createdAt:Date.UTC(2026,9,25),reviewedAt:status==='pending'?null:Date.UTC(2026,9,25,1),reviewedBy:status==='pending'?null:'另一位管理员'});
const listReply = requests => ({status:200,body:{requests,pendingCount:requests.filter(row=>row.status==='pending').length}});
let pageUser = null;
const assets = new Map([
  ['/login', 'login.html'], ['/account','account.html'],
  ...['login.html', 'login.js', 'login.css', 'account.html','account.js','account.css','platform-auth.js', 'styles.css'].map(name => ['/web/' + name, name]),
]);
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const requests = [], blocked = [], exceptions = [], results = [], screenshots = [], unexpected = [], pending = new Map();
let scenario = {}, chrome, socket, origin, browserVersion, sequence = 0;
function defaults() {
  return {
    [endpoints.config]: { status: 200, body: { enabled: true, mode:'admin' } },
    [endpoints.session]: { status: 200, body: pageUser ? {authenticated:true,user:pageUser} : { authenticated: false } },
    [endpoints.login]: { status: 200, body: { authenticated: true, user: { id: 'anonymous-fixture', username: fixture.username } } },
    [endpoints.register]: { status: 202, body: { pending: true } },
    [endpoints.requests]: listReply([application()]),
    [endpoints.users]: {status:200,body:{users:[administrator,student]}},
    [endpoints.requests+'/request-one/approve']: { status: 200, body: { approved: true } },
    [endpoints.requests+'/request-one/reject']: { status: 200, body: { rejected: true } },
  };
}
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, origin || 'http://127.0.0.1');
    let body = '';
    for await (const chunk of req) { body += chunk; assert.ok(body.length < 16384, 'fixture request size'); }
    const record = { method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null };
    requests.push(record);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // Also prevent accidental connections if a future page adds remote resources.
    res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'");
    if (url.pathname.startsWith('/api/')) {
      let reply = scenario[url.pathname];
      if (Array.isArray(reply)) reply = reply.length > 1 ? reply.shift() : reply[0];
      if (!reply) { unexpected.push(req.url); reply = { status: 404, body: { message: 'Unexpected fixture API' } }; }
      if (reply.gate) await reply.gate;
      if (reply.disconnect) { res.destroy(); return; }
      res.writeHead(reply.status, { 'Content-Type': reply.raw !== undefined ? 'text/html' : 'application/json' });
      res.end(reply.raw ?? JSON.stringify(reply.body)); return;
    }
    if (url.pathname === '/fixture-session.js') {
      res.writeHead(200, {'Content-Type':'text/javascript'});
      res.end('window.PlatformSession='+JSON.stringify(pageUser?{authenticated:true,user:pageUser}:{authenticated:false})+';'); return;
    }
    if (assets.has(url.pathname)) {
      const name = assets.get(url.pathname);
      res.writeHead(200, { 'Content-Type': mime[extname(name)] });
      let content = await readFile(resolve(root, 'front-end/web', name));
      if(name==='account.html')content=content.toString().replace('<head>','<head><script src="/fixture-session.js"></script>');
      res.end(content); return;
    }
    if (url.pathname === '/' || url.pathname === '/fixture-home') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><body><h1 id="fixture-home">Anonymous mock login destination</h1></body></html>'); return;
    }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    unexpected.push(req.url); res.writeHead(404); res.end('Fixture not found');
  } catch (error) { unexpected.push(error.message); if (!res.headersSent) res.writeHead(500); res.end('Fixture error'); }
});
async function until(check, label, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await delay(40); }
  throw new Error('Timed out: ' + label);
}
function command(method, params = {}) {
  return new Promise((resolveCall, rejectCall) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); rejectCall(new Error('CDP timeout: ' + method)); }, 15000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolveCall(value); }, reject: error => { clearTimeout(timer); rejectCall(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function waitExpression(expression, label = expression) {
  return until(async () => { try { return await evaluate(expression); } catch (error) { if (/context|navigat/i.test(error.message)) return false; throw error; } }, label);
}
const count = path => requests.filter(item => item.url === path).length;
async function navigate(path) {
  // Force a fresh document even when only the fragment differs from the previous case.
  // Page.navigate otherwise performs a same-document navigation and does not rerun scripts.
  await command('Page.navigate', { url: 'about:blank' });
  await waitExpression('location.href === "about:blank" && document.readyState === "complete"');
  await evaluate('window.__oldRegistrationDocument = true');
  const response = await command('Page.navigate', { url: origin + path });
  assert.ok(!response.errorText, response.errorText);
  await waitExpression('!window.__oldRegistrationDocument && document.readyState === "complete" && location.pathname === ' + JSON.stringify(path.split(/[?#]/)[0]), 'navigate ' + path.split('#')[0]);
}
async function reset(overrides = {}, path = '/login', user = null) {
  pageUser = user;
  scenario = { ...defaults(), ...overrides };
  requests.length = 0;
  await command('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
  await navigate(path);
  if (path.startsWith('/login')) {
    await until(() => count(endpoints.config) === 1 && count(endpoints.session) === 1, 'login startup API calls');
    await waitExpression('window.__fixtureFetches.every(row => row.done)', 'startup responses settled');
  }
}
async function click(selector) {
  const point = await evaluate(`(() => {const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw new Error('Missing click target');el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();if(!r.width||!r.height)throw new Error('Invisible click target');return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
}
async function fill(selector, value) {
  await evaluate(`(() => {const el=document.querySelector(${JSON.stringify(selector)});el.focus();el.select();})()`);
  // Actual trusted Chrome input, so native minlength/maxlength validation is exercised.
  await command('Input.insertText', { text: value });
}
async function registerMode() {
  await click('#show-register');
  await waitExpression('!document.querySelector("#register-form").hidden');
}
async function fillRegistration(values = {}) {
  const data = { username: fixture.username, displayName: fixture.displayName, password: fixture.password, confirm: fixture.password, ...values };
  for (const [selector, key] of [['#register-username', 'username'], ['#register-name', 'displayName'], ['#register-password', 'password'], ['#register-confirm', 'confirm']]) await fill(selector, data[key]);
}
async function noRegistrationRequest() {
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  assert.equal(count(endpoints.register), 0, 'invalid form must not call register API');
}
async function screenshot(name) {
  await evaluate('document.fonts.ready');
  await evaluate('window.scrollTo(0,0)');
  const metrics = await command('Page.getLayoutMetrics');
  const size = metrics.cssContentSize;
  const image = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 } });
  const path = resolve(runDir, name + '.png');
  await writeFile(path, Buffer.from(image.data, 'base64')); screenshots.push(path);
}
async function check(name, test) {
  try { await test(); results.push({ name, passed: true }); console.log('PASS', name); }
  catch (error) {
    results.push({ name, passed: false, error: error.message }); console.error('FAIL', name, error.message);
    try { await screenshot('failure-' + results.length); } catch { /* Preserve original assertion. */ }
  }
}
async function adminReady(overrides = {}, user = administrator) {
  await reset(overrides, '/account', user);
  if(user.role==='admin') await waitExpression('document.querySelector("#registration-list").children.length>0');
}
const approveSelector='[data-registration-action="approve"][data-id="request-one"]';
const rejectSelector='[data-registration-action="reject"][data-id="request-one"]';
async function chooseFilter(value){await evaluate(`(()=>{const el=document.querySelector('#registration-filter');el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('change',{bubbles:true}));})()`);}
async function confirmDecision(selector){await click(selector);await waitExpression('document.querySelector("#confirm-dialog").open');await click('#confirm-ok');}
try {
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
  origin = 'http://127.0.0.1:' + server.address().port;
  console.log('MOCK API real-Chrome regression; ephemeral origin', origin);
  chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  const processError = new Promise((_, reject) => chrome.once('error', reject));
  const portFile = await Promise.race([until(async () => { try { return await readFile(resolve(profile, 'DevToolsActivePort'), 'utf8'); } catch { return false; } }, 'Chrome startup', 30000), processError]);
  const targets = await (await fetch('http://127.0.0.1:' + portFile.split(/\r?\n/)[0] + '/json/list')).json();
  socket = new WebSocket(targets.find(item => item.type === 'page').webSocketDebuggerUrl);
  await once(socket, 'open');
  socket.addEventListener('message', event => {
    const value = JSON.parse(event.data);
    if (value.id) {
      const call = pending.get(value.id); if (!call) return; pending.delete(value.id);
      value.error ? call.reject(new Error(value.error.message)) : call.resolve(value.result); return;
    }
    if (value.method === 'Runtime.exceptionThrown') exceptions.push(value.params.exceptionDetails.exception?.description || value.params.exceptionDetails.text);
    if (value.method === 'Runtime.consoleAPICalled' && value.params.type === 'error') exceptions.push(value.params.args.map(arg => arg.value || arg.description).join(' '));
    if (value.method === 'Fetch.requestPaused') {
      const { requestId, request } = value.params;
      if (new URL(request.url).origin !== origin) { blocked.push(request.url); void command('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => {}); }
      else void command('Fetch.continueRequest', { requestId }).catch(() => {});
    }
  });
  browserVersion = await command('Browser.getVersion');
  for (const method of ['Page.enable', 'Runtime.enable', 'Network.enable']) await command(method);
  await command('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  // Observe request timing without changing responses or app behavior.
  await command('Page.addScriptToEvaluateOnNewDocument', { source: `window.__fixtureFetches=[];const originalFetch=window.fetch;window.fetch=function(...args){const row={url:String(args[0]),hash:location.hash,done:false};window.__fixtureFetches.push(row);return originalFetch.apply(this,args).finally(()=>{row.done=true;});};` });

  await check('login is default; accessible switching and password visibility', async () => {
    await reset();
    assert.deepEqual(await evaluate('({login:document.querySelector("#login-form").hidden,register:document.querySelector("#register-form").hidden,sent:document.querySelector("#registration-sent").hidden,title:document.title,pressed:document.querySelector("#show-login").getAttribute("aria-pressed")})'), { login: false, register: true, sent: true, title: '登录 · Study Space', pressed: 'true' });
    await fill('#password', fixture.password); await click('#password-toggle');
    assert.equal(await evaluate('document.querySelector("#password").type'), 'text');
    await registerMode();
    assert.equal(await evaluate('document.activeElement.id'), 'register-username');
    assert.equal(await evaluate('document.querySelector("#password").value'), '');
    assert.equal(await evaluate('document.querySelector("#show-register").getAttribute("aria-pressed")'), 'true');
    await fill('#register-password', fixture.password); await click('#show-login');
    assert.equal(await evaluate('document.querySelector("#register-password").value'), '');
    assert.equal(await evaluate('document.activeElement.id'), 'username');
  });
  await check('registration required fields prevent requests', async () => {
    await reset(); await registerMode(); await click('#register-submit'); await noRegistrationRequest();
    assert.equal(await evaluate('document.querySelector("#register-username").validity.valueMissing'), true);
    await fillRegistration(); await fill('#register-name', ''); await click('#register-submit'); await noRegistrationRequest();
    assert.equal(await evaluate('document.querySelector("#register-name").validity.valueMissing'), true);
  });
  await check('username pattern and length constraints use native Chrome validation', async () => {
    await reset(); await registerMode();
    for (const username of ['ab', '_invalid', 'space name', '中文账号']) {
      await fillRegistration({ username }); await click('#register-submit'); await noRegistrationRequest();
      assert.equal(await evaluate('document.querySelector("#register-username").validity.valid'), false, username);
    }
    await fill('#register-username', 'a'.repeat(45));
    assert.equal(await evaluate('document.querySelector("#register-username").value.length'), 40);
    await fill('#register-name', 'x'.repeat(65));
    assert.equal(await evaluate('document.querySelector("#register-name").value.length'), 60);
  });
  await check('short password and missing confirmation prevent requests', async () => {
    await reset(); await registerMode(); await fillRegistration({ password: 'short', confirm: 'short' });
    await click('#register-submit'); await noRegistrationRequest();
    assert.equal(await evaluate('document.querySelector("#register-password").validity.tooShort'), true);
    await fillRegistration(); await fill('#register-confirm', ''); await click('#register-submit'); await noRegistrationRequest();
    assert.equal(await evaluate('document.querySelector("#register-confirm").validity.valueMissing'), true);
  });
  await check('password mismatch focuses confirmation and input clears custom validity', async () => {
    await reset(); await registerMode(); await fillRegistration({ confirm: 'synthetic-mismatch' }); await click('#register-submit');
    await noRegistrationRequest();
    assert.equal(await evaluate('document.activeElement.id'), 'register-confirm');
    assert.equal(await evaluate('document.querySelector("#register-confirm").validationMessage'), '两次输入的密码不一致。');
    await fill('#register-confirm', fixture.password);
    assert.equal(await evaluate('document.querySelector("#register-confirm").validity.valid'), true);
  });
  await check('pending success never logs in; submission locks; resets secrets and returns to login', async () => {
    let release; const gate = new Promise(done => { release = done; });
    await reset({ [endpoints.register]: { status: 202, body: { pending: true }, gate } });
    try {
      await registerMode(); await fillRegistration(); await click('#register-submit');
      await until(() => count(endpoints.register) === 1, 'register request');
      assert.equal(await evaluate('document.querySelector("#register-submit").disabled && document.querySelector("#show-login").disabled && document.querySelector("#show-register").disabled && document.querySelector("#register-form").getAttribute("aria-busy")==="true"'), true);
      await click('#register-submit'); assert.equal(count(endpoints.register), 1);
    } finally { release(); }
    await waitExpression('!document.querySelector("#registration-sent").hidden');
    const request = requests.find(item => item.url === endpoints.register);
    assert.equal(request.method, 'POST'); assert.equal(request.headers['content-type'], 'application/json');
    assert.deepEqual(request.body, { username: fixture.username, displayName: fixture.displayName, password: fixture.password });
    assert.equal(count(endpoints.login), 0);
    assert.equal(await evaluate('location.pathname'), '/login');
    assert.equal(await evaluate('PlatformAuth.active'), false);
    assert.equal(await evaluate('localStorage.length + sessionStorage.length'), 0);
    assert.equal((await command('Network.getCookies', { urls: [origin] })).cookies.length, 0);
    assert.equal(await evaluate('document.querySelector("#register-password").value + document.querySelector("#register-confirm").value'), '');
    assert.equal(await evaluate('document.activeElement.id'), 'sent-title');
    await click('#back-to-login');
    assert.equal(await evaluate('document.querySelector("#login-form").hidden'), false);
    assert.equal(await evaluate('document.querySelector("#username").value'), fixture.username);
  });
  for (const [label, reply, message] of [
    ['duplicate account', { status: 409, body: { error: { code: 'username_taken', message: '该账号已被使用。' } } }, '该账号已被使用。'],
    ['registration unavailable', { status: 503, body: { message: '注册审批暂未启用，请联系维护者。' } }, '注册审批暂未启用，请联系维护者。'],
    ['rate limit', { status: 429, body: { error: '请求过于频繁，请稍后重试。' } }, '请求过于频繁，请稍后重试。'],
    ['malformed success', { status: 200, body: { pending: false } }, '申请未完成，请重试。'],
    ['non-JSON error', { status: 502, raw: '<h1>Mock gateway error</h1>' }, '操作未完成，请稍后重试。'],
    ['network disconnect', { disconnect: true }, '暂时无法连接服务器，请检查连接后重试。'],
  ]) await check('registration error: ' + label, async () => {
    await reset({ [endpoints.register]: reply }); await registerMode(); await fillRegistration(); await click('#register-submit');
    await waitExpression('document.querySelector("#register-status").classList.contains("error")');
    assert.equal(await evaluate('document.querySelector("#register-status").textContent'), message);
    assert.equal(await evaluate('document.querySelector("#register-submit").disabled'), false);
    assert.equal(await evaluate('document.querySelector("#registration-sent").hidden'), true);
    assert.equal(await evaluate('location.pathname'), '/login'); assert.equal(count(endpoints.login), 0);
    await fill('#register-name', '匿名修改名称');
    assert.equal(await evaluate('document.querySelector("#register-status").textContent'), '');
  });
  await check('unconfigured registration is visibly closed; existing login still works', async () => {
    await reset({ [endpoints.config]: { status: 200, body: { enabled: false, mode:'admin' } } }); await registerMode();
    assert.equal(await evaluate('document.querySelector("#register-submit").disabled'), true);
    assert.match(await evaluate('document.querySelector("#register-status").textContent'), /注册暂未开放/);
    await fillRegistration(); await click('#register-submit'); await noRegistrationRequest();
    assert.match(await evaluate('document.querySelector("#register-status").textContent'), /注册暂未开放/);
    await click('#show-login'); await fill('#username', fixture.username); await fill('#password', fixture.password); await click('#login-submit');
    await waitExpression('!!document.querySelector("#fixture-home")'); assert.equal(count(endpoints.login), 1);
  });
  await check('legacy registration-config 404 preserves successful login and safe next', async () => {
    await reset({ [endpoints.config]: { status: 404, raw: '<h1>Not Found</h1>' } }, '/login?next=%2Ffixture-home');
    assert.equal(await evaluate('document.querySelector("#auth-switch").hidden'), true);
    await fill('#username', fixture.username); await fill('#password', fixture.password); await click('#login-submit');
    await waitExpression('location.pathname==="/fixture-home" && !!document.querySelector("#fixture-home")');
    assert.equal(count(endpoints.login), 1);
  });
  await check('login error remains public, recovers on input, rejects incomplete success', async () => {
    await reset({ [endpoints.login]: [{ status: 401, body: { error: { code: 'invalid_credentials', message: '账号或密码错误。' } } }, { status: 200, body: { authenticated: false } }] });
    await fill('#username', fixture.username); await fill('#password', fixture.password); await click('#login-submit');
    await waitExpression('document.querySelector("#login-status").classList.contains("error")');
    assert.equal(await evaluate('document.querySelector("#login-status").textContent'), '账号或密码错误。');
    assert.equal(await evaluate('location.pathname'), '/login');
    await fill('#password', fixture.password); assert.equal(await evaluate('document.querySelector("#login-status").textContent'), '');
    await click('#login-submit'); await waitExpression('document.querySelector("#login-status").textContent==="登录未完成，请重试。"');
    assert.equal(await evaluate('document.querySelector("#login-submit").disabled'), false);
  });
  await check('safeNext rejects external, auth and API destinations', async () => {
    await reset();
    for (const value of ['https://example.invalid', '//example.invalid', '/\\example.invalid', '/login', '/registration-review#token=x', '/api/auth/session', '/web/login.html']) assert.equal(await evaluate('PlatformAuth.safeNext(' + JSON.stringify(value) + ')'), '/');
    assert.equal(await evaluate('PlatformAuth.safeNext("/fixture-home?tab=one#top")'), '/fixture-home?tab=one#top');
  });
  await check('all administrators see shared pending requests; no decision on GET', async () => {
    await adminReady();
    assert.equal(await evaluate('document.querySelector("#registrations-section").hidden'),false);
    assert.equal(await evaluate('document.querySelector("#registration-count").textContent'),'1');
    assert.match(await evaluate('document.querySelector("#registration-list").textContent'), /anonymous-student/);
    assert.equal(requests.filter(r=>r.method==='POST').length,0);
    assert.equal(requests.find(r=>r.url===endpoints.requests).headers['x-account-id'],administrator.id);
    const second={...administrator,id:'second-admin',username:'second-admin'};
    await adminReady({},second);
    assert.match(await evaluate('document.querySelector("#registration-list").textContent'), /anonymous-student/);
    assert.equal(requests.find(r=>r.url===endpoints.requests).headers['x-account-id'],second.id);
  });
  await check('approval requires explicit confirmation and refreshes both lists', async () => {
    await adminReady();
    await click(approveSelector); await waitExpression('document.querySelector("#confirm-dialog").open');
    await click('#confirm-cancel'); assert.equal(count(endpoints.requests+'/request-one/approve'),0);
    await waitExpression('!document.querySelector('+JSON.stringify(approveSelector)+').disabled');
    scenario[endpoints.requests]=listReply([application('request-one','approved')]);
    const previousUsers=count(endpoints.users);
    await confirmDecision(approveSelector);
    await until(()=>count(endpoints.requests+'/request-one/approve')===1,'approved POST');
    await until(()=>count(endpoints.users)>previousUsers,'accounts refreshed');
    await waitExpression('document.querySelector("#registration-count").textContent==="0"');
    await chooseFilter('approved');
    await waitExpression('document.querySelector("#registration-list").textContent.includes("已通过")');
    const request=requests.find(r=>r.url.endsWith('/approve'));
    assert.equal(request.method,'POST');assert.deepEqual(request.body,{});
    assert.equal(request.headers['x-account-id'],administrator.id);
    assert.equal(await evaluate('document.querySelectorAll("[data-registration-action]").length'),0);
  });
  await check('reject locks duplicate actions, preserves failed request for retry', async () => {
    let release;const gate=new Promise(done=>release=done);
    await adminReady({[endpoints.requests+'/request-one/reject']:{status:503,body:{message:'匿名临时故障'},gate}});
    try{
      await confirmDecision(rejectSelector);
      await until(()=>count(endpoints.requests+'/request-one/reject')===1,'reject request');
      assert.equal(await evaluate('[...document.querySelectorAll("[data-registration-action]")].every(el=>el.disabled)'),true);
    }finally{release();}
    await waitExpression('document.body.textContent.includes("匿名临时故障")');
    await waitExpression('!document.querySelector('+JSON.stringify(rejectSelector)+').disabled');
    scenario[endpoints.requests+'/request-one/reject']={status:200,body:{rejected:true}};
    scenario[endpoints.requests]=listReply([application('request-one','rejected')]);
    await confirmDecision(rejectSelector);
    await waitExpression('document.querySelector("#registration-count").textContent==="0"');
    await chooseFilter('rejected');await waitExpression('document.querySelector("#registration-list").textContent.includes("已拒绝")');
    assert.equal(count(endpoints.requests+'/request-one/reject'),2);
  });
  await check('another administrator decision conflict refreshes stale requests', async () => {
    await adminReady({[endpoints.requests+'/request-one/approve']:{status:409,body:{message:'该申请已由其他管理员处理。'}}});
    scenario[endpoints.requests]=listReply([application('request-one','rejected')]);
    await confirmDecision(approveSelector);
    await waitExpression('document.querySelector("#registration-count").textContent==="0"');
    await chooseFilter('');await waitExpression('document.querySelector("#registration-list").textContent.includes("已拒绝")');
    assert.equal(await evaluate('document.querySelectorAll("[data-registration-action]").length'),0);
  });
  await check('filter and hostile names render only text', async () => {
    const hostile='<img src=x onerror=alert(1)>';
    await adminReady({[endpoints.requests]:listReply([{...application(),displayName:hostile},application('two','approved'),application('three','rejected')])});
    assert.equal(await evaluate('document.querySelectorAll("#registration-list img").length'),0);
    assert.ok((await evaluate('document.querySelector("#registration-list").textContent')).includes(hostile));
    await chooseFilter('');assert.equal(await evaluate('document.querySelector("#registration-list").children.length'),3);
    await chooseFilter('rejected');assert.equal(await evaluate('document.querySelector("#registration-list").children.length'),1);
  });
  await check('students never fetch or display administrative registrations', async () => {
    await adminReady({},student);
    assert.equal(count(endpoints.requests),0);assert.equal(count(endpoints.users),0);
    assert.equal(await evaluate('document.querySelector("#registrations-section").hidden'),true);
    await evaluate('window.dispatchEvent(new Event("focus"))');
    await waitExpression('window.__fixtureFetches.every(row=>row.done)');
    assert.equal(count(endpoints.requests),0);
  });
  await check('empty queue and manual retry after list failure', async () => {
    await reset({[endpoints.requests]:{status:503,body:{message:'无法读取申请'}}},'/account',administrator);
    await waitExpression('document.querySelector("#registrations-status").textContent.includes("无法读取申请")');
    scenario[endpoints.requests]=listReply([]);await click('#reload-registrations');
    await waitExpression('document.querySelector("#registration-count").textContent==="0"');
    assert.equal(await evaluate('document.querySelectorAll("[data-registration-action]").length'),0);
  });
  await check('focus refresh reveals newly arrived requests', async () => {
    await adminReady();const before=count(endpoints.requests);
    scenario[endpoints.requests]=listReply([application(),application('new-request')]);
    await evaluate('window.dispatchEvent(new Event("focus"))');
    await until(()=>count(endpoints.requests)>before,'focus refresh');
    await waitExpression('document.querySelector("#registration-count").textContent==="2"');
  });
  await check('role loss clears sensitive list and hides admin controls', async () => {
    await adminReady();
    await evaluate('PlatformAuth.updateUser({id:"fixture-admin",role:"student"})');
    assert.equal(await evaluate('document.querySelector("#registrations-section").hidden'),true);
    assert.equal(await evaluate('document.querySelector("#registration-list").children.length'),0);
  });
  await check('late list response cannot restore data after role loss',async()=>{
    let release;const gate=new Promise(done=>release=done);
    await reset({[endpoints.requests]:{...listReply([application()]),gate}},'/account',administrator);
    try{
      await until(()=>count(endpoints.requests)===1,'held administrator list');
      await evaluate('PlatformAuth.updateUser({id:"fixture-admin",role:"student"})');
    }finally{release();}
    await waitExpression('window.__fixtureFetches.every(row=>row.done)');
    assert.equal(await evaluate('document.querySelector("#registration-list").children.length'),0);
    assert.equal(await evaluate('document.querySelector("#registrations-section").hidden'),true);
  });
  await check('legacy Python administrator UI hides unsupported registration section',async()=>{
    await reset({[endpoints.requests]:{status:404,body:{message:'Not Found'}}},'/account',administrator);
    await waitExpression('window.__fixtureFetches.every(row=>row.done)');
    assert.equal(await evaluate('document.querySelector("#registrations-section").hidden'),true);
    assert.equal(await evaluate('document.querySelector("#users-section").hidden'),false);
    const before=count(endpoints.requests);
    await evaluate('window.dispatchEvent(new Event("focus"))');
    await waitExpression('window.__fixtureFetches.every(row=>row.done)');
    assert.equal(count(endpoints.requests),before);
  });
  await check('expired administrator session redirects without displaying requests',async()=>{
    let release;const gate=new Promise(done=>release=done);
    try {await reset({[endpoints.requests]:{status:401,body:{message:'登录已失效'},gate}},'/account',administrator);}
    finally {pageUser=null;scenario[endpoints.session]={status:200,body:{authenticated:false}};release();}
    await waitExpression('location.pathname==="/login"');
    assert.equal(await evaluate('!!document.querySelector("#registration-list")'),false);
  });
  for (const width of [320,375,1440]) for(const state of ['login','register','pending','closed','admin-pending','admin-history']) {
    await check('layout '+width+'px '+state+': no horizontal overflow + screenshot',async()=>{
      await command('Emulation.setDeviceMetricsOverride',{width,height:width<500?812:1000,deviceScaleFactor:1,mobile:false});
      if(state.startsWith('admin')){
        await adminReady({[endpoints.requests]:listReply([{...application(),username:'a'.repeat(40),displayName:'匿名'.repeat(30)},application('two','approved'),application('three','rejected')])});
        if(state==='admin-history')await chooseFilter('');
      }else{
        await reset(state==='closed'?{[endpoints.config]:{status:200,body:{enabled:false,mode:'admin'}}}:{});
        if(state!=='login')await registerMode();
        if(state==='pending'){await fillRegistration();await click('#register-submit');await waitExpression('!document.querySelector("#registration-sent").hidden');}
      }
      await screenshot(width+'-'+state);
      const size=await evaluate('({width:innerWidth,document:document.documentElement.scrollWidth,body:document.body.scrollWidth})');
      assert.ok(size.document<=size.width+1&&size.body<=size.width+1,JSON.stringify(size));
    });
  }
  await check('no JavaScript exceptions or attempted external/unexpected services', async () => {
    assert.deepEqual(exceptions, []); assert.deepEqual(blocked, []); assert.deepEqual(unexpected, []);
  });
} catch (error) {
  results.push({ name: 'harness', passed: false, error: error.stack }); console.error(error.stack);
} finally {
  if (socket?.readyState === WebSocket.OPEN) { try { await command('Browser.close'); } catch { /* Chrome can close socket before reply. */ } socket.close(); }
  if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
    await Promise.race([once(chrome, 'exit'), delay(2000)]);
    if (chrome.exitCode === null && chrome.signalCode === null) { chrome.kill(); await Promise.race([once(chrome, 'exit'), delay(2000)]); }
  }
  server.closeAllConnections(); await new Promise(done => server.close(done));
  // Verify the exact absolute deletion target before removing only this run's unique profile.
  assert.equal(dirname(resolve(profile)), tempRoot);
  assert.ok(basename(profile).startsWith('registration-browser-'));
  console.log('Verified disposable profile cleanup target:', profile);
  try { await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  catch (error) { results.push({ name: 'temporary profile cleanup', passed: false, error: error.message }); }
  const report = { scope: 'Real Chrome frontend regression with local mock API; NOT Worker/DO/backend/mail/production integration', runtime: { node: process.version, platform: process.platform, browser: browserVersion }, passed: results.filter(row => row.passed).length, failed: results.filter(row => !row.passed).length, results, screenshots, exceptions, blockedExternalRequests: blocked, unexpectedRequests: unexpected };
  await writeFile(resolve(runDir, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('REGISTRATION BROWSER MOCK:', report.passed, 'passed,', report.failed, 'failed');
  console.log('Artifacts:', runDir);
  if (report.failed) process.exitCode = 1;
}
