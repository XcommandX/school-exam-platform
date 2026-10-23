'use strict';
const assert=require('node:assert/strict'),{spawn}=require('node:child_process'),path=require('node:path'),fs=require('node:fs/promises');
const {chromium}=require('playwright');
const repo=path.resolve(__dirname,'../..');
const fixture=String.raw`
import sys,tempfile,json
from pathlib import Path
sys.path.insert(0,str(Path.cwd()/'back-end'))
from server.serve_platform import create_server
from shared.question_schema import normalize_question_set
with tempfile.TemporaryDirectory() as directory:
    server=create_server(Path.cwd(),0,private_root=directory,sat_library_root=Path(directory)/'library')
    for name in ('SyntheticSATOne','SyntheticSATTwo'):
        server.auth.store.create_user(name,'Synthetic-pass-924','student')
    bank=normalize_question_set({'title':'Original account sync fixture','questions':[
        {'prompt':'Original synthetic question one: choose Beta.','options':['Alpha','Beta','Gamma','Delta'],'answer':1},
        {'prompt':'Original synthetic question two: choose Alpha.','options':['Alpha','Beta','Gamma','Delta'],'answer':0}]},exam='sat')
    (Path(directory)/'question-banks/sat/synthetic.json').write_text(json.dumps(bank))
    print(server.server_port,flush=True)
    server.serve_forever()
`;
const child=spawn(process.env.PYTHON||'python3',['-u','-c',fixture],{cwd:repo,stdio:['ignore','pipe','pipe']});
let stderr='';child.stderr.on('data',x=>stderr+=x);
const ready=new Promise((resolve,reject)=>{let s='';child.stdout.on('data',x=>{s+=x;if(/^\d+$/.test(s.trim()))resolve(Number(s.trim()));});child.on('exit',c=>reject(Error('Server exited '+c+' '+stderr)));setTimeout(()=>reject(Error('Server timeout '+stderr)),20000).unref();});
(async()=>{let browser;const errors=[],checks=[];try{
 const base='http://127.0.0.1:'+await ready;
 browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{channel:'chrome'})});
 async function pageFor(name){const c=await browser.newContext({viewport:{width:1440,height:1000}});const p=await c.newPage();p.setDefaultTimeout(20000);p.on('pageerror',e=>errors.push(e.message));await p.goto(base+'/login');await p.locator('#username').fill(name);await p.locator('#password').fill('Synthetic-pass-924');await p.locator('#login-submit').click();await p.waitForURL(base+'/');return p;}
 async function openSAT(p){await p.goto(base+'/sat/');await p.waitForFunction(()=>window.SATApp?.ready);await p.evaluate(()=>SATApp.ready);await p.waitForSelector('.sat-hero');}
 async function sync(p){await p.evaluate(()=>SATAccountSync.sync());const status=await p.evaluate(()=>SATAccountSync.getStatus());assert.match(status,/已同步/,status);}
 const p=await pageFor('SyntheticSATOne');await openSAT(p);
 const qids=await p.evaluate(async()=>{const questions=await SATStorage.all('questions');return questions.filter(q=>!q.deleted).map(q=>q.id);});assert.equal(qids.length,2);
 await p.evaluate(ids=>SATApp.startPractice(ids,'Original saved SAT practice',600),qids);
 assert.equal(await p.locator('[data-sat-management]').count(),0,'ready screen keeps exam styling');
 await p.locator('[data-action=begin]').click();await p.locator('#modal[open]').waitFor();await p.locator('#modalActions button').first().click();
 await p.locator('#options [data-option="0"]').click();
 await p.locator('#exitButton').click();await p.locator('[data-more=exit]').click();await p.locator('#modalActions').getByRole('button',{name:'Save and Exit',exact:true}).click();await p.locator('.sat-hero').waitFor();
 const saved=await p.evaluate(async()=>{const a=(await SATStorage.all('attempts'))[0];await SATStorage.addToWrongBook({questionId:a.questionIds[0],reason:'manual',addedAt:Date.now(),sourceAttemptId:a.id});await SATSettings.setDuration('custom',720);return a;});
 assert.equal(saved.status,'incomplete');assert.ok(saved.runtimeSnapshot);assert.equal(saved.questionSnapshots.length,2);
 await sync(p);
 let summary=await p.evaluate(()=>PlatformAuth.api('/api/sat/summary'));assert.equal(summary.attempts.length,1);assert.equal(summary.attempts[0].id,saved.id);assert.equal('questionSnapshots' in summary.attempts[0],false);
 checks.push('Save and Exit saves resumable attempt, ordered snapshots, wrong book and settings to current account');
 await p.route('**/api/sat/**',route=>route.abort('failed'));
 await p.evaluate(()=>SATSettings.setDuration('custom',960));await p.evaluate(()=>SATAccountSync.sync());
 assert.equal(await p.evaluate(()=>SATSettings.customDuration),960);
 await p.reload();await p.waitForFunction(()=>window.SATApp?.ready);await p.evaluate(()=>SATApp.ready);
 assert.equal(await p.evaluate(()=>SATSettings.customDuration),960);
 await p.unroute('**/api/sat/**');await sync(p);
 checks.push('offline write survives reload and retries without claiming a network save');
 const q=await pageFor('SyntheticSATTwo');await openSAT(q);
 assert.equal(await q.evaluate(async()=>(await SATStorage.all('attempts')).length),0);
 assert.equal(await q.evaluate(async()=>(await SATStorage.all('wrongBook')).length),0);
 assert.equal(await q.evaluate(()=>SATSettings.customDuration),1920);
 checks.push('another student cannot see attempts, wrong book or preferences');
 const r=await pageFor('SyntheticSATOne');await openSAT(r);
 const restored=await r.evaluate(async id=>({attempt:await SATStorage.get('attempts',id),wrong:await SATStorage.all('wrongBook'),duration:SATSettings.customDuration}),saved.id);
 assert.equal(restored.attempt.status,'incomplete');assert.deepEqual(restored.attempt.questionIds,saved.questionIds);assert.deepEqual(restored.attempt.questionSnapshots,saved.questionSnapshots);assert.equal(restored.wrong.length,1);assert.equal(restored.duration,960);
 await r.locator(`[data-action=resume][data-id="${saved.id}"]`).click();
 await r.waitForFunction(()=>ExamEngine.isRunning());
 const selected=await r.evaluate(()=>JSON.parse(localStorage.getItem('sat-reading-practice-v1')).questionStates[0].selectedOption);assert.equal(selected,0);
 await r.evaluate(()=>ExamEngine.finishAttempt({status:'completed',reason:'submitted'}));
 await r.waitForFunction(async()=>(await SATStorage.all('attempts')).some(a=>a.status==='completed'));
 await openSAT(r);await sync(r);
 const complete=await r.evaluate(async id=>SATStorage.get('attempts',id),saved.id);
 assert.equal(complete.status,'completed');assert.equal(complete.correctCount,0);assert.equal(complete.incorrectCount,1,JSON.stringify({answers:complete.answers,questions:complete.questionSnapshots}));assert.equal(complete.unansweredCount,1);
 checks.push('new browser restores snapshots and answers; Resume can complete the same attempt');
 await r.goto(base+'/');await r.waitForFunction(()=>document.getElementById('menu-answers').textContent==='1');
 assert.equal(await r.locator('#menu-accuracy').innerText(),'0%');
 checks.push('Study Space summary reads saved SAT results from the account service');
 await openSAT(r);
 await r.evaluate(async id=>{await SATStorage.removeFromWrongBook((await SATStorage.get('attempts',id)).questionIds[0]);await SATStorage.deleteAttempt(id);},saved.id);await sync(r);
 assert.equal((await r.evaluate(()=>PlatformAuth.api('/api/sat/summary'))).attempts.length,0);
 const again=await pageFor('SyntheticSATOne');await openSAT(again);
 assert.equal(await again.evaluate(async()=>(await SATStorage.all('attempts')).length),0);assert.equal(await again.evaluate(async()=>(await SATStorage.all('wrongBook')).length),0);
 checks.push('deleted records stay deleted after another browser logs in');
 assert.deepEqual(errors,[]);
 const out=path.join(repo,'local-data/test-artifacts/sat-account-flow');await fs.mkdir(out,{recursive:true});await again.screenshot({path:path.join(out,'dashboard.png'),fullPage:true,animations:'disabled'});await fs.writeFile(path.join(out,'result.json'),JSON.stringify({checks,syntheticOnly:true},null,2));
 console.log(JSON.stringify({ok:true,checks,syntheticOnly:true}));
}finally{await browser?.close();child.kill();}})().catch(e=>{console.error(e);console.error(stderr);process.exitCode=1;});
