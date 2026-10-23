'use strict';
// Original synthetic data only. Isolates management UI from account transport tests.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),http=require('node:http'),path=require('node:path');
const {chromium}=require('playwright');
const repo=path.resolve(__dirname,'../..'),source=path.join(repo,'front-end/sat');
const mime={'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.woff2':'font/woff2','.ttf':'font/ttf'};
const server=http.createServer(async(req,res)=>{try{
  const route=new URL(req.url,'http://localhost').pathname;if(!route.startsWith('/sat/'))throw Error('Unknown route');
  const file=path.resolve(source,route.slice(5));assert.ok(file.startsWith(source+path.sep));
  res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');res.end(await fs.readFile(file));
}catch{res.statusCode=404;res.end('missing');}});
(async()=>{
 let browser;
 try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{channel:'chrome'})});
  const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[],unexpected=[];
  page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(12000);
  await page.addInitScript(()=>{
    window.PlatformAuth={user:{id:'synthetic-menu-admin',username:'SyntheticMenuAdmin',displayName:'Synthetic Menu Admin',role:'admin'},active:true};
    window.__menuTest={lockError:sessionStorage.getItem('synthetic-lock-blocked')==='true',acquires:0,releases:0,syncs:0,logout:false,status:'已同步',conflicts:[{id:'editable',kind:'attempts',entityId:'menu-28',label:'Synthetic editable practice',canKeepLocal:true,reason:'另一台设备修改了同一条练习记录。'},{id:'completed',kind:'attempts',entityId:'completed-locked',label:'Synthetic completed practice',canKeepLocal:false,reason:'服务器已保存完成的练习。'}],resolved:[],downloaded:[]};
    const event=()=>dispatchEvent(new CustomEvent('sat-account-sync-status',{detail:{status:__menuTest.status,pending:0,conflicts:__menuTest.conflicts.length}}));
    window.SATAccountSync={acquirePractice:async()=>{__menuTest.acquires++;if(__menuTest.lockError)throw new Error('此账号已在另一标签页练习，请先在那里保存并退出。');return true;},releasePractice:()=>{__menuTest.releases++;},ready:Promise.resolve(),initialize:async()=>event(),getStatus:()=>__menuTest.status,sync:async()=>{__menuTest.syncs++;event();},logout:async()=>{__menuTest.logout=true;},getConflicts:async()=>structuredClone(__menuTest.conflicts),resolveConflict:async(id,choice)=>{__menuTest.resolved.push([id,choice]);__menuTest.conflicts=__menuTest.conflicts.filter(row=>row.id!==id);event();},downloadConflict:async id=>{__menuTest.downloaded.push(id);}};
  });
  const apiFixture=async route=>{
    const url=new URL(route.request().url());let value;
    if(route.request().method()!=='GET')throw Error('UI fixture forbids network writes');
    if(url.pathname==='/api/question-bank/status')value={service:'sat-question-bank-v1',token:'synthetic-menu-token'};
    else if(url.pathname==='/api/question-bank')value={files:[],errors:[]};
    else if(url.pathname==='/api/sat-packs'||url.pathname==='/api/sat-test-collection')value={collectionId:null,packs:[],assessment:null};
    else if(url.pathname==='/api/sat-library/question-index')value={schemaVersion:1,available:true,sources:[],questions:[],errors:[]};
    else if(url.pathname==='/api/sat-library')value={schemaVersion:1,available:true,categories:[{id:'full-length',collections:[]},{id:'reading-writing',collections:[]},{id:'math',collections:[]}],errors:[]};
    else{unexpected.push(url.pathname);value={};}
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(value)});
  };await page.route('**/api/**',apiFixture);
  const url='http://127.0.0.1:'+server.address().port+'/sat/html/index.html';
  await page.goto(url);await page.evaluate(()=>SATApp.ready);
  await page.evaluate(async()=>{
    const now=Date.now(),questions=['Math','Reading and Writing'].map((section,index)=>({id:'synthetic-menu:q'+index,section,responseType:'single-choice',passage:'Original synthetic context.',prompt:'Original synthetic question?',options:['First','Second','Third','Fourth'],correctOption:0,questionType:'',explanation:'Original synthetic explanation.',metadata:{sourceId:'synthetic-menu',sourceFileName:'synthetic-menu.json',sourceQuestionIndex:index,importedAt:now}}));
    await SATStorage.importSet({id:'synthetic-menu',fileName:'synthetic-menu.json',displayName:'Synthetic menu fixtures',questionCount:2,defaultDurationSeconds:120,contentHash:'synthetic-menu-original',importedAt:now},questions);
    for(let index=0;index<30;index++){
      const completed=index%2===0,math=index%3===0,q=questions[math?0:1];
      await SATStorage.saveAttempt({id:'menu-'+index,practiceName:'Synthetic '+(math?'Math':'English')+' '+String(index).padStart(2,'0'),status:completed?'completed':'incomplete',resumable:!completed,questionIds:[q.id],sourceIds:['synthetic-menu'],questionSnapshots:[q],modules:[{section:q.section,start:0,end:1,moduleNumber:1,durationSeconds:120}],totalQuestions:1,correctCount:completed?1:0,incorrectCount:0,unansweredCount:completed?0:1,ungradedCount:0,elapsedMs:completed?1000:0,durationSeconds:120,remainingTimeMs:120000,startedAt:now-index*1000,completedAt:completed?now-index*1000:undefined,savedAt:now-index*1000,answers:{[q.id]:{selectedOption:completed?0:null,answered:completed,correctOption:0,correctness:completed?true:null,timeSpentMs:1000,markedForReview:false,eliminatedOptions:[],highlights:[]}}});
    }
  });
  await page.reload();await page.evaluate(()=>SATApp.ready);await page.locator('.recent-practices tbody tr').first().waitFor();
  assert.equal(await page.locator('.recent-practices tbody tr').count(),20);assert.equal(await page.locator('.app-settings-button').count(),0);
  assert.match(await page.locator('#satAccountButton').innerText(),/SyntheticMenuAdmin/);
  await page.locator('#satAccountButton').focus();await page.keyboard.press('ArrowDown');assert.equal(await page.evaluate(()=>document.activeElement.dataset.accountAction),'dashboard');
  await page.keyboard.press('End');assert.equal(await page.evaluate(()=>document.activeElement.dataset.accountAction),'logout');await page.keyboard.press('Escape');assert.equal(await page.locator('#satAccountMenu').isVisible(),false);assert.equal(await page.locator('#satAccountButton').evaluate(el=>el===document.activeElement),true);
  await page.locator('#satAccountButton').click();assert.equal(await page.locator('.sat-account-stats b').allTextContents().then(values=>values.join(',')),'15,15,100%');
  const out=path.join(repo,'local-data/test-artifacts/sat-account-menu');await fs.mkdir(out,{recursive:true});await page.screenshot({path:path.join(out,'menu-desktop.png'),fullPage:true,animations:'disabled'});
  await page.locator('[data-account-action=timingSettings]').click();await page.waitForFunction(()=>SATApp.appState.view==='timingSettings');assert.equal(await page.locator('#satAccountMenu').isVisible(),false);
  await page.locator('#satAccountButton').click();await page.locator('[data-account-action=history]').click();await page.locator('#satHistoryResults').waitFor();
  assert.equal(await page.locator('#satHistoryResults tbody tr').count(),25);await page.locator('[data-action=history-next]').click();assert.equal(await page.locator('#satHistoryResults tbody tr').count(),5);
  await page.locator('[data-history-filter=status]').selectOption('completed');await page.locator('[data-history-filter=section]').selectOption('math');assert.equal(await page.locator('#satHistoryResults tbody tr').count(),5);
  await page.locator('#satHistoryResults [data-action=attempt]').first().click();await page.waitForFunction(()=>SATApp.appState.view==='attemptOverview');assert.equal(await page.locator('#app').getAttribute('data-sat-management'),'');
  await page.locator('#satAccountButton').click();await page.locator('[data-account-action=history]').click();await page.locator('[data-history-filter=status]').selectOption('');await page.locator('[data-history-filter=section]').selectOption('');await page.locator('[data-history-filter=search]').fill('English 29');assert.equal(await page.locator('#satHistoryResults tbody tr').count(),1);
  await page.locator('#satHistoryResults [data-action=delete-attempt]').click();await page.locator('.app-confirm [data-confirm]').click();await page.waitForFunction(async()=>!await SATStorage.get('attempts','menu-29'));await page.locator('#satHistoryResults .app-empty').waitFor();
  await page.locator('[data-history-filter=search]').fill('');await page.screenshot({path:path.join(out,'history-desktop.png'),fullPage:true,animations:'disabled'});
  await page.locator('#satAccountButton').click();await page.locator('[data-account-action=syncConflicts]').click();await page.locator('.sat-sync-conflict').first().waitFor();assert.equal(await page.locator('.sat-sync-conflict').count(),2);assert.equal(await page.locator('[data-action=sync-conflict-local]').count(),1);
  await page.locator('[data-action=sync-conflict-download]').first().click();assert.deepEqual(await page.evaluate(()=>__menuTest.downloaded),['editable']);
  await page.locator('[data-action=sync-conflict-local]').click();await page.waitForFunction(()=>document.querySelectorAll('.sat-sync-conflict').length===1);await page.locator('[data-action=sync-conflict-server]').click();await page.locator('.sat-sync-conflicts .app-empty').waitFor();assert.deepEqual(await page.evaluate(()=>__menuTest.resolved),[['editable','local'],['completed','server']]);
  await page.locator('#satAccountButton').click();await page.locator('[data-account-action=sync]').click();await page.waitForFunction(()=>__menuTest.syncs===1);await page.locator('#satAccountButton').click();
  await page.setViewportSize({width:390,height:844});await page.locator('#satAccountButton').click();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);const rect=await page.locator('#satAccountMenu').boundingBox();assert.ok(rect.x>=0&&rect.x+rect.width<=390);
  await page.screenshot({path:path.join(out,'menu-mobile.png'),fullPage:true,animations:'disabled'});await page.locator('.app-brand').click();assert.equal(await page.locator('#satAccountMenu').isVisible(),false);
  await page.evaluate(async()=>{__menuTest.lockError=true;localStorage.setItem('sat-reading-practice-v1','synthetic-runtime-sentinel');await SATApp.resumePractice('menu-1').catch(()=>{});});
  assert.match(await page.locator('#appNotice').innerText(),/另一标签页/);assert.equal(await page.evaluate(()=>localStorage.getItem('sat-reading-practice-v1')),'synthetic-runtime-sentinel');
  await page.evaluate(()=>SATApp.startPractice(['synthetic-menu:q0'],'Synthetic protected exam',120));await page.locator('.practice-ready').waitFor();assert.equal(await page.locator('.sat-account').count(),0);assert.equal(await page.locator('#app').getAttribute('data-sat-management'),null);
  await page.locator('[data-action=begin]').click();await page.locator('.practice-start-error').waitFor();assert.match(await page.locator('.practice-start-error').innerText(),/另一标签页/);assert.equal(await page.evaluate(()=>SATApp.appState.phase),'ready');assert.equal(await page.evaluate(()=>__menuTest.releases),0);
  await page.evaluate(()=>{__menuTest.lockError=false;__menuTest.originalGet=SATStorage.get;SATStorage.get=async(store,id)=>{if(store==='questions')throw new Error('Synthetic load failure');return __menuTest.originalGet(store,id);};});
  await page.locator('[data-action=begin]').click();await page.waitForFunction(()=>document.querySelector('.practice-start-error')?.textContent==='Synthetic load failure');assert.equal(await page.evaluate(()=>__menuTest.releases),1);
  await page.evaluate(()=>{SATStorage.get=__menuTest.originalGet;__menuTest.originalStart=ExamEngine.start;ExamEngine.start=()=>{throw new Error('Synthetic start failure');};});
  await page.locator('[data-action=begin]').click();await page.waitForFunction(()=>document.querySelector('.practice-start-error')?.textContent==='Synthetic start failure');assert.equal(await page.evaluate(()=>__menuTest.releases),2);
  await page.evaluate(()=>{ExamEngine.start=__menuTest.originalStart;});
  await page.locator('[data-action=begin]').click();await page.locator('#modal[open]').waitFor();await page.locator('#modalActions button').click();await page.waitForFunction(()=>SATApp.appState.view==='exam');assert.equal(await page.locator('.sat-account').count(),0);assert.equal(await page.locator('#app').getAttribute('data-sat-management'),null);
  const savedRuntime=await page.evaluate(()=>{sessionStorage.setItem('synthetic-lock-blocked','true');return JSON.parse(localStorage.getItem('sat-reading-practice-v1'));});
  await page.reload();await page.evaluate(()=>SATApp.ready);await page.locator('.sat-hero').waitFor();assert.match(await page.locator('#appNotice').innerText(),/另一标签页/);assert.equal(await page.evaluate(()=>ExamEngine.isRunning()),false);assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('sat-reading-practice-v1')).activePractice.id),savedRuntime.activePractice.id);
  const standaloneContext=await browser.newContext(),standalone=await standaloneContext.newPage();standalone.on('pageerror',error=>errors.push(error.message));await standalone.route('**/api/**',apiFixture);await standalone.goto(url);await standalone.evaluate(()=>SATApp.ready);assert.equal(await standalone.locator('.sat-account').count(),0);assert.equal(await standalone.locator('.app-settings-button').count(),1);await standaloneContext.close();
  assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
  console.log(JSON.stringify({ok:true,syntheticOnly:true,checks:['account identity and Settings placement','keyboard and outside dismissal','full history pagination filters review deletion','conflict choices protect completed records','sync action','390px menu layout','ready and exam have no account UI','standalone retains original Settings','lock rejection preserves ready and runtime; failed loads and starts release lock'],screenshots:out}));
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
