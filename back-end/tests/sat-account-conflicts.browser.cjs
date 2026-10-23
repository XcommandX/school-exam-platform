'use strict';
// Synthetic HTTP + real IndexedDB regression; never reads the personal account database.
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const path=require('node:path');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'../..');
const fixture=String.raw`
import sys,tempfile
from pathlib import Path
sys.path.insert(0,str(Path.cwd()/'back-end'))
from server.serve_platform import create_server
with tempfile.TemporaryDirectory() as temp:
    server=create_server(Path.cwd(),0,private_root=temp,sat_library_root=Path(temp)/'library')
    for name in ['SyncOriginal','SyncOther']:
        server.auth.store.create_user(name,'Synthetic-pass-924','student')
    print(server.server_port,flush=True)
    server.serve_forever()
`;
const child=spawn(process.env.PYTHON||'python3',['-u','-c',fixture],{cwd:root,stdio:['ignore','pipe','pipe']});
let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
const serverReady=new Promise((resolve,reject)=>{let output='';child.stdout.on('data',chunk=>{output+=chunk;if(/^\d+$/.test(output.trim()))resolve(Number(output.trim()));});child.on('exit',code=>reject(Error('Server exited '+code+' '+stderr)));setTimeout(()=>reject(Error('Server timeout '+stderr)),15000).unref();});
(async()=>{
 let browser;
 const errors=[];
 try{
  const port=await serverReady,base='http://127.0.0.1:'+port;
  browser=await chromium.launch({headless:true,channel:'chrome'});
  const context=await browser.newContext(),other=await browser.newContext(),second=await browser.newContext();
  const a=await context.newPage(),b=await second.newPage(),c=await other.newPage();
  for(const page of [a,b,c]){page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(20000);}
  const login=async(page,name)=>{await page.goto(base+'/login');await page.evaluate(async name=>{const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:name,password:'Synthetic-pass-924'})});if(!r.ok)throw Error('login failed');},name);};
  const open=async page=>{await page.goto(base+'/sat/?view=dashboard');await page.evaluate(async()=>{await SATApp.ready;await SATAccountSync.ready;});};
  const call=(page,url)=>page.evaluate(url=>PlatformAuth.api(url),url);
  const local=(page,kind,id)=>page.evaluate(({kind,id})=>SATStorage.get(kind,id),{kind,id});
  await login(a,'SyncOriginal');await second.addCookies(await context.cookies());await open(a);
  await a.evaluate(async()=>{
    const q={id:'original:q1',section:'Reading and Writing',passage:'Original synthetic passage',prompt:'Pick the synthetic answer.',options:['A','B','C','D'],correctOption:1,metadata:{sourceId:'original-source',sourceFileName:'Original fixture',sourceQuestionIndex:0,importedAt:Date.now()}};
    await SATStorage.importSet({id:'original-source',fileName:'Original fixture',contentHash:'original-fixture',importedAt:Date.now(),questionCount:1},[q]);
    const attempt={id:'original-attempt',practiceName:'Original saved practice',status:'incomplete',resumable:true,startedAt:Date.now(),completedAt:Date.now(),savedAt:Date.now(),questionIds:[q.id],questionSnapshots:[q],sourceIds:['original-source'],totalQuestions:1,correctCount:0,incorrectCount:1,unansweredCount:0,ungradedCount:0,elapsedMs:1234,durationSeconds:600,answers:{[q.id]:{answered:true,correctness:false,selectedOption:0,correctOption:1}},runtimeSnapshot:{activePractice:{id:'original-attempt',name:'Original saved practice',questionIds:[q.id],sourceIds:['original-source'],durationSeconds:600,createdAt:Date.now()},questionStates:[{selectedOption:0,eliminatedOptions:[],highlights:[],timeSpentMs:1234}],currentQuestion:0,remainingTimeMs:598766}};
    await SATStorage.saveAttempt(attempt);
    await SATStorage.addToWrongBook({questionId:q.id,addedAt:Date.now(),reason:'manual',sourceAttemptId:attempt.id});
    await SATStorage.setSetting('customPracticeDurationSeconds',777);
    await SATStorage.setSetting('activeSATPackCollection',{collectionId:'MACHINE_ONLY'});
    await SATAccountSync.sync();
  });
  let remote=await call(a,'/api/sat/attempts/original-attempt');assert.equal(remote.value.runtimeSnapshot.questionStates[0].timeSpentMs,1234);
  assert.equal((await call(a,'/api/sat/wrong-book/original%3Aq1')).value.questionSnapshot.prompt,'Pick the synthetic answer.');
  assert(!(await call(a,'/api/sat/bootstrap')).settings.some(x=>x.key==='activeSATPackCollection'));
  await open(b);
  assert.equal((await local(b,'attempts','original-attempt')).resumable,true);
  assert.equal((await local(b,'questions','original:q1')).prompt,'Pick the synthetic answer.');
  assert.equal((await local(b,'settings','customPracticeDurationSeconds')).value,777);
  assert.equal(await b.evaluate(()=>SATApp.appState.view),'dashboard','downloaded incomplete attempts never auto-start timers');
  await b.evaluate(async()=>{const source=await SATStorage.get('sources','original-source');if(!source.accountSnapshot)throw Error('Expected a source snapshot');let rejected=false;try{await SATStorage.importSet({...source,packIdentity:{id:'original-pack',revision:1},contentHash:'incorrect-revision-content'},[]);}catch{rejected=true;}if(!rejected)throw Error('Changed content under the same version must be rejected');const q=await SATStorage.get('questions','original:q1');await SATStorage.importSet({...source,contentHash:'original-full-source',questionCount:2},[{...q,accountSnapshot:false},{...q,id:'original:q2',metadata:{...q.metadata,sourceQuestionIndex:1}}]);});
  assert.equal((await local(b,'sources','original-source')).accountSnapshot,false);assert(await local(b,'questions','original:q2'),'loading the real source fills questions beyond the saved snapshot');

  await login(c,'SyncOther');await open(c);assert.equal((await c.evaluate(()=>SATStorage.all('attempts'))).length,0);
  console.log('PASS account isolation, first-load restore, portable question snapshots and settings whitelist');
  // Offline writes and a full reload retain a durable outbox and current answers.
  await a.route('**/api/sat/**',route=>route.abort());
  await a.evaluate(async()=>{const value=await SATStorage.get('attempts','original-attempt');value.elapsedMs=2222;value.savedAt=Date.now();value.runtimeSnapshot.questionStates[0].timeSpentMs=2222;await SATStorage.saveAttempt(value);await SATAccountSync.sync();});
  assert.equal((await local(a,'accountSync','attempts:original-attempt')).pending.value.elapsedMs,2222);
  await open(a);assert.equal((await local(a,'attempts','original-attempt')).elapsedMs,2222);assert((await local(a,'accountSync','attempts:original-attempt')).pending);
  await b.evaluate(async()=>{const value=await SATStorage.get('attempts','original-attempt');value.elapsedMs=3333;value.savedAt=Date.now();await SATStorage.saveAttempt(value);await SATAccountSync.sync();});
  await a.unroute('**/api/sat/**');await a.evaluate(()=>SATAccountSync.sync());
  let conflicts=await a.evaluate(()=>SATAccountSync.getConflicts());assert.equal(conflicts.length,1);assert.equal(conflicts[0].canKeepLocal,true);assert.equal((await local(a,'attempts','original-attempt')).elapsedMs,2222,'conflicts cannot silently overwrite local answers');
  await a.evaluate(id=>SATAccountSync.resolveConflict(id,'local'),conflicts[0].id);
  assert.equal((await call(a,'/api/sat/attempts/original-attempt')).value.elapsedMs,2222);
  assert.equal((await a.evaluate(()=>SATAccountSync.getConflicts())).length,0);
  console.log('PASS durable offline outbox and explicit two-device conflict resolution');
  // A server tombstone cannot be silently restored by stale local answers.
  await a.route('**/api/sat/**',route=>route.abort());
  await a.evaluate(async()=>{const value=await SATStorage.get('attempts','original-attempt');value.elapsedMs=4444;await SATStorage.saveAttempt(value);});
  await b.evaluate(async()=>{await SATStorage.deleteAttempt('original-attempt');await SATAccountSync.sync();});
  await a.unroute('**/api/sat/**');await a.evaluate(()=>SATAccountSync.sync());
  conflicts=await a.evaluate(()=>SATAccountSync.getConflicts());assert.equal(conflicts.length,1);assert.equal(conflicts[0].canKeepLocal,false);
  const denied=await a.evaluate(async id=>{try{await SATAccountSync.resolveConflict(id,'local');return false;}catch{return true;}},conflicts[0].id);assert.equal(denied,true);
  await a.evaluate(id=>SATAccountSync.resolveConflict(id,'server'),conflicts[0].id);
  assert.equal(await local(a,'attempts','original-attempt'),undefined);
  assert.equal((await call(a,'/api/sat/attempts/original-attempt')).deleted,true);
  console.log('PASS remote deletions remain tombstones and cannot resurrect a deleted attempt');
  // An edit made while an upload response is outstanding must remain queued.
  const readyToRelease={};let release,intercepted;
  const held=new Promise(resolve=>intercepted=resolve);
  await a.route('**/api/sat/settings/customPracticeDurationSeconds',async route=>{
    if(route.request().method()!=='PUT'||readyToRelease.used){await route.continue();return;}
    readyToRelease.used=true;const response=await route.fetch();intercepted();await new Promise(resolve=>release=resolve);await route.fulfill({response});
  });
  await a.evaluate(()=>SATStorage.setSetting('customPracticeDurationSeconds',800));
  const syncing=a.evaluate(()=>SATAccountSync.sync());await held;
  await a.evaluate(()=>SATStorage.setSetting('customPracticeDurationSeconds',900));release();await syncing;
  await a.unroute('**/api/sat/settings/customPracticeDurationSeconds');await a.evaluate(()=>SATAccountSync.sync());
  assert.equal((await call(a,'/api/sat/settings/customPracticeDurationSeconds')).value,900);
  assert.equal((await local(a,'accountSync','settings:customPracticeDurationSeconds')).pending,null);
  console.log('PASS in-flight acknowledgements preserve newer local settings generations');
  // Same-account tabs share one durable generation and one server revision.
  const tab=await context.newPage();tab.on('pageerror',error=>errors.push(error.message));await open(tab);
  const timerBefore=await call(a,'/api/sat/settings/questionTimer');
  await tab.evaluate(()=>SATStorage.setSetting('questionTimer',{enabled:true,mode:'down'}));
  await Promise.all([a.evaluate(()=>SATAccountSync.sync()),tab.evaluate(()=>SATAccountSync.sync())]);
  const timerAfter=await call(a,'/api/sat/settings/questionTimer');assert.equal(timerAfter.revision,timerBefore.revision+1);assert.equal(timerAfter.value.enabled,true);
  assert.equal((await local(a,'accountSync','settings:questionTimer')).pending,null);
  await tab.close();
  console.log('PASS same-account tabs serialize one durable mutation without duplicate revisions');
  // Different fields merge; changing the same scalar requires a visible choice.
  await a.evaluate(async()=>{await SATStorage.setSetting('appConfig',{moduleQuestionLimit:30,examTimerWarning:'proportional'});await SATAccountSync.sync();});
  await b.evaluate(()=>SATAccountSync.sync());
  await a.route('**/api/sat/**',route=>route.abort());
  await a.evaluate(()=>SATStorage.setSetting('appConfig',{moduleQuestionLimit:20,examTimerWarning:'proportional'}));
  await b.evaluate(async()=>{await SATStorage.setSetting('appConfig',{moduleQuestionLimit:30,examTimerWarning:'fixed'});await SATAccountSync.sync();});
  await a.unroute('**/api/sat/**');await a.evaluate(()=>SATAccountSync.sync());
  assert.deepEqual((await local(a,'settings','appConfig')).value,{moduleQuestionLimit:20,examTimerWarning:'fixed'});
  assert.deepEqual((await call(a,'/api/sat/settings/appConfig')).value,{moduleQuestionLimit:20,examTimerWarning:'fixed'});
  await a.evaluate(async()=>{await SATStorage.setSetting('customPracticeDurationSeconds',925);await SATAccountSync.sync();});
  await b.evaluate(async()=>{await SATStorage.setSetting('customPracticeDurationSeconds',950);await SATAccountSync.sync();});
  let settingsConflicts=await b.evaluate(()=>SATAccountSync.getConflicts());assert(settingsConflicts.some(row=>row.kind==='settings'));
  await b.evaluate(id=>SATAccountSync.resolveConflict(id,'server'),settingsConflicts.find(row=>row.kind==='settings').id);
  assert.equal((await local(b,'settings','customPracticeDurationSeconds')).value,925);
  console.log('PASS disjoint settings merge into both local and server state; scalar conflicts require a choice');
  // One invalid legacy record cannot block unrelated valid uploads.
  await a.evaluate(async()=>{await SATStorage.saveAttempt({id:'invalid-legacy-fixture',status:'incomplete',answers:{}});await SATStorage.setSetting('customPracticeDurationSeconds',1000);await SATAccountSync.sync();});
  assert.equal((await call(a,'/api/sat/settings/customPracticeDurationSeconds')).value,1000);
  assert((await local(a,'accountSync','attempts:invalid-legacy-fixture')).pending);
  assert.doesNotMatch(await a.evaluate(()=>SATAccountSync.getStatus()),/^已同步$/);
  await a.evaluate(async()=>{await SATStorage.deleteAttempt('invalid-legacy-fixture');await SATAccountSync.sync();});
  console.log('PASS rejected records remain local and cannot block valid pending records');
  // A real saved practice may run in only one tab of this account at once.
  await a.evaluate(()=>SATApp.startPractice(['original:q1'],'Original lock practice',600));
  await a.locator('[data-action=begin]').click();await a.locator('#modal[open]').waitFor();await a.locator('#modalActions button').first().click();
  await a.locator('#options [data-option="0"]').click();
  const saveExit=async page=>{await page.locator('#exitButton').click();await page.locator('[data-more=exit]').click();await page.locator('#modalActions').getByRole('button',{name:'Save and Exit',exact:true}).click();await page.locator('.sat-hero').waitFor();};
  await saveExit(a);
  const lockedId=await a.evaluate(async()=>(await SATStorage.all('attempts')).find(row=>row.practiceName==='Original lock practice').id);
  const practiceTab=await context.newPage();practiceTab.on('pageerror',error=>errors.push(error.message));await open(practiceTab);
  await a.evaluate(id=>SATApp.resumePractice(id),lockedId);await a.waitForFunction(()=>ExamEngine.isRunning());
  const rejected=await practiceTab.evaluate(async id=>{try{await SATApp.resumePractice(id);return '';}catch(error){return error.message;}},lockedId);
  assert.match(rejected,/另一标签/);assert.equal(await practiceTab.evaluate(()=>ExamEngine.isRunning()),false);
  await saveExit(a);
  await practiceTab.evaluate(id=>SATApp.resumePractice(id),lockedId);await practiceTab.waitForFunction(()=>ExamEngine.isRunning());await saveExit(practiceTab);await practiceTab.close();
  console.log('PASS a real Resume is blocked in a second tab until the first saves and exits');
  assert.deepEqual(errors,[]);
 }finally{if(browser)await browser.close();child.kill('SIGTERM');}
})().catch(error=>{console.error(error,stderr);process.exitCode=1;});
