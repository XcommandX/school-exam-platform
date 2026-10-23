'use strict';
// Real HTTP authentication and browser navigation, using an isolated synthetic database.
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const path=require('node:path');
const fs=require('node:fs/promises');
const {chromium}=require('playwright');
const repo=path.resolve(__dirname,'../..');
const fixture=String.raw`
import sys, tempfile
from pathlib import Path
sys.path.insert(0, str(Path.cwd() / 'back-end'))
from server.serve_platform import create_server
with tempfile.TemporaryDirectory() as directory:
    server = create_server(Path.cwd(), 0, private_root=directory, sat_library_root=Path(directory)/'library')
    for name,role in [('SyntheticAdmin','admin'),('SyntheticStudent','student')]:
        server.auth.store.create_user(name, 'Synthetic-test-924', role)
    print(server.server_port, flush=True)
    server.serve_forever()
`;
const child=spawn(process.env.PYTHON||'python3',['-u','-c',fixture],{cwd:repo,stdio:['ignore','pipe','pipe']});
let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
const serverReady=new Promise((resolve,reject)=>{let output='';child.stdout.on('data',chunk=>{output+=chunk;const port=output.trim();if(/^\d+$/.test(port))resolve(Number(port));});child.on('exit',code=>reject(Error('Fixture server exited '+code+' '+stderr)));setTimeout(()=>reject(Error('Fixture server timeout '+stderr)),20000).unref();});
(async()=>{
 let browser;
 const report={syntheticOnly:true,checks:[],screenshots:[]};
 const errors=[];
 try{
  const port=await serverReady,base='http://127.0.0.1:'+port;
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{channel:'chrome'})});
  const a=await browser.newContext({viewport:{width:1440,height:1000}}),b=await browser.newContext({viewport:{width:390,height:844}});
  const p=await a.newPage(),q=await b.newPage();
  for(const page of [p,q]){page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(15000);}
  const login=async(page,name)=>{await page.goto(base+'/login');await page.locator('#username').fill(name);await page.locator('#password').fill('Synthetic-test-924');await page.locator('#login-submit').click();await page.waitForURL(base+'/');await page.waitForFunction(()=>window.PlatformAuth?.user?.id);};
  const call=async(page,url,method='GET',body)=>page.evaluate(async({url,method,body})=>{try{return{status:200,value:await PlatformAuth.api(url,{method,...(body===undefined?{}:{body})})}}catch(error){return{status:error.status,error:error.message}}},{url,method,body});
  const out=path.join(repo,'local-data/test-artifacts/unified-auth');await fs.mkdir(out,{recursive:true});
  await p.goto(base+'/');assert.match(p.url(),/\/login\?next=/);
  await p.locator('#username').fill('SyntheticAdmin');await p.locator('#password').fill('Wrong-password');await p.locator('#login-submit').click();await p.locator('#login-status.error').waitFor();assert.match(await p.locator('#login-status').innerText(),/用户名或密码/);
  await p.screenshot({path:path.join(out,'login-desktop.png'),fullPage:true,animations:'disabled'});report.screenshots.push('login-desktop.png');
  await login(p,'SyntheticAdmin');assert.match(await p.locator('#account-button').innerText(),/SyntheticAdmin/);
  assert.equal(await p.evaluate(()=>document.cookie.includes('study_session')),false);
  const aId=await p.evaluate(()=>PlatformAuth.user.id);
  let home=await call(p,'/api/me/home');assert.equal(home.value.revision,0);
  await p.locator('#account-button').click();await p.locator('#account-menu [data-dialog=plan]').click();
  await p.locator('[name=dailyGoal]').fill('47');await p.locator('#plan-form button[type=submit]').click();
  await p.waitForFunction(()=>document.getElementById('today-progress').textContent.endsWith('/ 47'));
  home=await call(p,'/api/me/home');assert.equal(home.value.value.plan.dailyGoal,47);
  const concurrent=await call(p,'/api/me/home','PUT',{revision:home.value.revision,value:{...home.value.value,plan:{dailyGoal:48,note:'Updated in another page'}}});assert.equal(concurrent.value.value.plan.dailyGoal,48);
  await p.locator('#account-menu [data-dialog=plan]').click();await p.locator('#plan-form [name=dailyGoal]').fill('49');await p.locator('#plan-form button[type=submit]').click();
  await p.locator('[data-reload-home]').waitFor();assert.equal((await call(p,'/api/me/home')).value.value.plan.dailyGoal,48);
  await p.locator('[data-reload-home]').click();await p.locator('#home-dialog').waitFor({state:'hidden'});
  await p.locator('#account-menu [data-dialog=plan]').click();assert.equal(await p.locator('#plan-form [name=dailyGoal]').inputValue(),'48');
  await p.locator('#plan-form [name=dailyGoal]').fill('47');await p.locator('#plan-form button[type=submit]').click();await p.locator('#home-dialog').waitFor({state:'hidden'});
  report.checks.push('home conflict preserves server data until explicitly reloaded and edited');
  await p.goto(base+'/toefl/');await p.waitForFunction(()=>window.PracticeCloud?.userId&&document.querySelector('.account-name'));
  assert.equal(await p.locator('.account-name').innerText(),'SyntheticAdmin');assert.equal(await p.evaluate(()=>PracticeCloud.userId),aId);
  await p.evaluate(async()=>{PracticeCloud.queue('four.words.v1',{'original-synthetic-word':{known:true,note:'Synthetic account isolation'}});await PracticeCloud.refresh(true);});
  let state=await call(p,'/api/toefl/state');assert.ok(state.value.items.find(row=>row.key==='four.words.v1').value['original-synthetic-word']);
  await p.screenshot({path:path.join(out,'toefl-account.png'),fullPage:true,animations:'disabled'});report.screenshots.push('toefl-account.png');
  report.checks.push('home and TOEFL share identity; real plan and TOEFL state persisted');
  await login(q,'SyntheticStudent');const bId=await q.evaluate(()=>PlatformAuth.user.id);
  assert.equal((await call(q,'/api/admin/users')).status,403);
  assert.equal((await call(q,'/api/me/home')).value.value,null);
  assert.deepEqual((await call(q,'/api/toefl/state')).value.items,[]);
  const mismatch=await q.evaluate(async id=>{const r=await fetch('/api/toefl/state',{headers:{'X-Account-ID':id}});return r.status;},aId);assert.equal(mismatch,409);
  assert.equal(await q.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  report.checks.push('student cannot administer or read another account; mobile home fits');
  await p.goto(base+'/account');await p.getByRole('heading',{name:'账号管理',exact:true}).waitFor();
  await p.screenshot({path:path.join(out,'accounts-desktop.png'),fullPage:true,animations:'disabled'});report.screenshots.push('accounts-desktop.png');
  await p.locator('#create-user').click();
  await p.locator('#account-form [name=username]').fill('SyntheticCreated');
  await p.locator('#account-form [name=displayName]').fill('Synthetic Created');
  await p.locator('#account-form [name=password]').fill('Synthetic-test-924');
  await p.locator('#account-form button[type=submit]').click();
  await p.locator('#account-dialog').waitFor({state:'hidden'});
  const createdRow=p.locator('#user-list tr').filter({hasText:'SyntheticCreated'});
  await createdRow.waitFor();
  const created=(await call(p,'/api/admin/users')).value.users.find(user=>user.username==='SyntheticCreated');assert.ok(created.id);
  await p.locator('#user-search').fill('SyntheticCreated');assert.equal(await p.locator('#user-list tr').count(),1);
  await createdRow.locator('[data-action=edit]').click();
  await p.locator('#account-form [name=displayName]').fill('Updated Synthetic');
  await p.locator('#account-form [name=role]').selectOption('admin');
  await p.locator('#account-form button[type=submit]').click();
  await p.locator('#confirm-ok').click();await p.locator('#account-dialog').waitFor({state:'hidden'});
  await p.waitForFunction(()=>document.getElementById('user-list').textContent.includes('Updated Synthetic'));
  assert.equal((await call(p,'/api/admin/users')).value.users.find(user=>user.id===created.id).role,'admin');
  await createdRow.locator('[data-action=reset]').click();
  await p.locator('#account-form [name=password]').fill('Synthetic-created-new');
  await p.locator('#account-form [name=confirmPassword]').fill('Synthetic-created-new');
  await p.locator('#account-form button[type=submit]').click();await p.locator('#confirm-ok').click();await p.locator('#account-dialog').waitFor({state:'hidden'});
  await createdRow.locator('[data-action=toggle]').click();await p.locator('#confirm-ok').click();
  await p.waitForFunction(()=>document.querySelector('#user-list .status-pill')?.textContent==='已停用');
  assert.equal((await call(p,'/api/admin/users')).value.users.find(user=>user.id===created.id).active,false);
  await createdRow.locator('[data-action=toggle]').click();await p.locator('#confirm-ok').click();
  await p.waitForFunction(()=>document.querySelector('#user-list .status-pill')?.textContent==='已启用');
  await p.locator('#user-search').fill('');
  report.checks.push('account management UI creates, filters, edits roles, resets passwords, disables and reactivates accounts');
  await call(p,'/api/admin/users/'+bId,'PATCH',{active:false});
  await q.evaluate(()=>PlatformAuth.verify());await q.waitForURL(/\/login/);
  await call(p,'/api/admin/users/'+bId,'PATCH',{active:true});
  await call(p,'/api/admin/users/'+bId+'/password','POST',{password:'Synthetic-new-925'});
  await q.locator('#username').fill('SyntheticStudent');await q.locator('#password').fill('Synthetic-test-924');await q.locator('#login-submit').click();await q.locator('#login-status.error').waitFor();
  await q.locator('#password').fill('Synthetic-new-925');await q.locator('#login-submit').click();await q.waitForURL(base+'/');
  report.checks.push('create, disable, reactivate and password reset enforce backend permissions');
  await p.goto(base+'/sat/');await p.waitForFunction(()=>window.SATPlatformBridge?.dbName&&window.SATApp?.ready);assert.equal(await p.evaluate(()=>SATPlatformBridge.dbName),'SchoolExamPlatform:account:'+aId+':sat:v1');
  await q.goto(base+'/sat/');await q.waitForFunction(()=>window.SATPlatformBridge?.dbName);assert.equal(await q.evaluate(()=>SATPlatformBridge.dbName),'SchoolExamPlatform:account:'+bId+':sat:v1');
  report.checks.push('SAT uses separate per-account database without modifying exam engine');
  const second=await browser.newContext(),r=await second.newPage();r.on('pageerror',error=>errors.push(error.message));await login(r,'SyntheticAdmin');
  assert.equal((await call(r,'/api/me/home')).value.value.plan.dailyGoal,47);
  assert.ok((await call(r,'/api/toefl/state')).value.items.find(row=>row.key==='four.words.v1'));
  await p.evaluate(()=>PlatformAuth.verify());await p.waitForURL(/\/login/);
  report.checks.push('new browser restores server records and revokes previous session');
  await r.evaluate(()=>PlatformAuth.logout());await r.waitForURL(/\/login/);const after=await r.request.get(base+'/api/me/home');assert.equal(after.status(),401);
  await q.goto(base+'/account');await q.locator('#edit-profile').click();
  await q.locator('#account-form [name=displayName]').fill('Updated Student');await q.locator('#account-form button[type=submit]').click();await q.locator('#account-dialog').waitFor({state:'hidden'});
  assert.equal(await q.locator('#identity-name').innerText(),'Updated Student');assert.equal(await q.locator('#users-section').isVisible(),false);
  assert.equal(await q.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await q.screenshot({path:path.join(out,'account-mobile.png'),fullPage:true,animations:'disabled'});report.screenshots.push('account-mobile.png');
  await q.locator('#change-password').click();await q.locator('#account-form [name=currentPassword]').fill('Synthetic-new-925');await q.locator('#account-form [name=password]').fill('Synthetic-self-new');await q.locator('#account-form [name=confirmPassword]').fill('Synthetic-self-new');await q.locator('#account-form button[type=submit]').click();await q.waitForURL(/\/login\?reason=password/);
  const passwordEnded=await q.request.get(base+'/api/me/home');assert.equal(passwordEnded.status(),401);
  report.checks.push('student account page edits profile, fits mobile, and own password change revokes session');
  await q.screenshot({path:path.join(out,'login-mobile.png'),fullPage:true,animations:'disabled'});report.screenshots.push('login-mobile.png');assert.equal(await q.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  report.checks.push('logout revokes access; mobile login fits');assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(out,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({ok:true,...report}));
 }finally{await browser?.close();child.kill();}
})().catch(error=>{console.error(error);console.error(stderr);process.exitCode=1;});
