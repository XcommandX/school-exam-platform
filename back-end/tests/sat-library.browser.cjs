'use strict';
// Original synthetic fixtures only. This server can read frontend source files,
// never local-data; Playwright intercepts every API call before it reaches it.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),http=require('node:http'),path=require('node:path');
const {chromium}=require('playwright');
const repo=path.resolve(__dirname,'../..');
const mime={'.js':'application/javascript','.css':'text/css','.html':'text/html','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf','.svg':'image/svg+xml'};
const block=text=>({type:'markdown',text});
function originalPack(name,section,count){
  const id='sat:pack:synthetic-library-'+name;
  const manifest={schemaVersion:'sat-question-pack/0.1-draft',documentType:'sat-question-pack',status:'draft',exam:'sat',id,revision:1,title:'Original '+name,section,responseType:'single-choice',contentFormat:'markdown-latex/0.1-draft',files:{items:'items.json',solutions:'solutions.json'},assets:[]};
  const items=Array.from({length:count},(_,index)=>({id:'sat:item:'+name+'-'+(index+1),revision:1,classification:{skill:section==='math'?'Algebra':'Information and Ideas'},content:[block('Original synthetic context '+(index+1))],prompt:[block('Original synthetic question '+(index+1)+'?')],source:{kind:'original'},options:'ABCD'.split('').map(letter=>({id:letter,content:[block('Original choice '+letter)]}))}));
  const solutions=items.map(item=>({itemId:item.id,itemRevision:1,answer:{type:'single-choice',status:'verified',optionId:'A'},explanation:{status:'provided',content:[block('Original synthetic explanation.')]},provenance:{kind:'original'}}));
  return {id,revision:1,title:manifest.title,section,responseType:'single-choice',questionCount:count,files:[['pack.json',manifest],['items.json',{items}],['solutions.json',{visibility:'authoring-only',solutions}]].map(([file,value])=>({path:name+'/'+file,mediaType:'application/json',text:JSON.stringify(value)})),refs:items.map(item=>({packId:id,packRevision:1,itemId:item.id,itemRevision:1}))};
}
function collection(collectionId,title,packs,modules,fullSAT=false){
  const sectionCounts={};for(const module of modules)sectionCounts[module.section]=(sectionCounts[module.section]||0)+module.items.length;
  const metadata={collectionId,title,category:fullSAT?'full-length':'math',questionCount:modules.reduce((sum,module)=>sum+module.items.length,0),fullSAT,sectionCounts,modules:modules.map(module=>({section:module.section,moduleNumber:module.moduleNumber,questionCount:module.items.length,durationSeconds:module.durationSeconds})),sourceCategory:fullSAT?'测试':'数学',subgroup:''};
  const sourceModules=modules.map(module=>({...module,questionCount:module.items.length}));
  const assessment=fullSAT?{schemaVersion:'sat-assessment/0.1-draft',documentType:'sat-assessment',status:'draft',exam:'sat',id:'sat:assessment:'+collectionId,revision:1,title,fullSAT:true,questionCount:98,breakDurationSeconds:600,modules:sourceModules}:null;
  return {metadata,payload:{...metadata,packs:packs.map(({refs,...pack})=>pack),assessment,modules:sourceModules}};
}
const mathPack=originalPack('partial-math','math',2);
const partial=collection('synthetic-math','Synthetic Math Module 3',[mathPack],[{section:'math',moduleNumber:3,durationSeconds:2100,items:[...mathPack.refs].reverse()}]);
const rwPack=originalPack('full-rw','reading-writing',54),fullMathPack=originalPack('full-math','math',44);
const full=collection('synthetic-full','Synthetic Full SAT',[rwPack,fullMathPack],[
  {section:'reading-writing',moduleNumber:1,durationSeconds:1920,items:rwPack.refs.slice(0,27)},
  {section:'reading-writing',moduleNumber:2,durationSeconds:1920,items:rwPack.refs.slice(27)},
  {section:'math',moduleNumber:1,durationSeconds:2100,items:fullMathPack.refs.slice(0,22)},
  {section:'math',moduleNumber:2,durationSeconds:2100,items:fullMathPack.refs.slice(22)}],true);
const partialRWPack=originalPack('partial-rw','reading-writing',2);
const partialFull=collection('synthetic-rw-partial','Synthetic Partial Full-Length',[partialRWPack],[{section:'reading-writing',moduleNumber:3,durationSeconds:1920,items:partialRWPack.refs}]);
for(const value of [partialFull.metadata,partialFull.payload])Object.assign(value,{category:'full-length',sourceCategory:'测试'});
const catalog={schemaVersion:1,available:true,errors:[],categories:[{id:'full-length',title:'Full-Length Tests',collections:[full.metadata,partialFull.metadata]},{id:'reading-writing',title:'Reading & Writing',collections:[]},{id:'math',title:'Math',collections:[partial.metadata]}]};
const server=http.createServer(async(req,res)=>{try{
  assert.equal(req.method,'GET');
  const route=new URL(req.url,'http://localhost').pathname;
  if(route.startsWith('/api/'))throw Error('API must be intercepted');
  let file;if(route.startsWith('/sat/'))file=path.resolve(repo,'front-end/sat',route.slice('/sat/'.length));else if(route==='/web/sat-bridge.js')file=path.join(repo,'front-end/web/sat-bridge.js');else throw Error('Unknown source');
  assert.ok(file.startsWith(path.join(repo,'front-end/sat')+path.sep)||file===path.join(repo,'front-end/web/sat-bridge.js'));
  let data=await fs.readFile(file);if(route==='/sat/html/index.html')data=Buffer.from(data.toString().replace('<head>','<head><script src="/web/sat-bridge.js"></script>'));
  res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');res.end(data);
}catch{res.statusCode=404;res.end('missing');}});

(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{channel:'chrome'})}).catch(async error=>{await new Promise(resolve=>server.close(resolve));throw error;});
  const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[],requests=[],unexpected=[];
  const responseControl={nextMath:null};
  page.setDefaultTimeout(15000);
  page.on('pageerror',error=>errors.push(error.stack||error.message));
  await page.route('**/api/**',async route=>{
    const request=route.request(),url=new URL(request.url()),pathname=url.pathname;requests.push(pathname);
    let value;
    if(request.method()!=='GET'){unexpected.push(request.method()+' '+pathname);value={error:'Synthetic regression forbids writes'};}
    else if(pathname==='/api/sat-library/question-index')value={schemaVersion:1,available:false,sources:[],questions:[],errors:[]};
    else if(pathname==='/api/sat-library')value=catalog;
    else if(pathname==='/api/sat-library/collections/synthetic-math'){
      const control=responseControl.nextMath;responseControl.nextMath=null;
      if(control?.kind==='delayed')await control.gate;
      value=structuredClone(partial.payload);
      if(control?.kind==='module-mismatch')value.modules[0].moduleNumber=4;
    }
    else if(pathname==='/api/sat-library/collections/synthetic-full')value=full.payload;
    else if(pathname==='/api/sat-library/collections/synthetic-rw-partial')value=partialFull.payload;
    else if(pathname==='/api/question-bank/status')value={service:'sat-question-bank-v1',token:'original-synthetic-regression'};
    else if(pathname==='/api/question-bank')value={files:[],errors:[]};
    else if(pathname==='/api/sat-packs'||pathname==='/api/sat-test-collection')value={collectionId:null,packs:[],assessment:null};
    else{unexpected.push(pathname);value={error:'Unconfigured synthetic API'};}
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(value)});
  });
  const runtime=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('sat-reading-practice-v1')));
  const begin=async()=>{await page.locator('[data-action=begin]').click();await page.locator('#modal[open]').waitFor();await page.locator('#modalActions button').click();};
  const saveExit=async()=>{await page.locator('#exitButton').click();await page.locator('[data-more=exit]').click();await page.locator('#modalActions').getByRole('button',{name:'Save and Exit',exact:true}).click();await page.locator('.sat-hero').waitFor();};
  try{
    await page.goto('http://127.0.0.1:'+server.address().port+'/sat/html/index.html');await page.evaluate(()=>SATApp.ready);
    // Interaction checks follow the production data-action contract below.
    await runChecks({page,requests,unexpected,errors,runtime,begin,saveExit,responseControl});
    assert.deepEqual(unexpected,[],'all requests must use explicitly configured synthetic APIs');assert.deepEqual(errors,[]);
    console.log(JSON.stringify({ok:true,syntheticOnly:true,selectedCollectionRequests:requests.filter(url=>url.startsWith('/api/sat-library/collections/')).length}));
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});

async function seedHistory(page){
  return page.evaluate(async()=>{
    const q={id:'original-history:q',section:'Math',responseType:'single-choice',passage:'Original history context',prompt:'Original history question?',options:['A','B','C','D'],correctOption:0,questionType:'',explanation:'Original history explanation.',metadata:{sourceId:'original-history',sourceFileName:'original-history.json',sourceQuestionIndex:0,importedAt:1}};
    await SATStorage.importSet({id:'original-history',fileName:'original-history.json',displayName:'Original history',questionCount:1,defaultDurationSeconds:2100,contentHash:'original-history-hash',importedAt:1},[q]);
    const answer={selectedOption:1,numericResponse:'',answered:true,correctOption:0,correctness:false,timeSpentMs:10,markedForReview:false,eliminatedOptions:[],highlights:[]};
    await SATStorage.saveAttempt({id:'original-completed',practiceName:'Original completed sentinel',status:'completed',questionIds:[q.id],sourceIds:['original-history'],totalQuestions:1,correctCount:0,incorrectCount:1,unansweredCount:0,ungradedCount:0,elapsedMs:10,durationSeconds:2100,startedAt:1,completedAt:2,savedAt:2,answers:{[q.id]:answer}});
    await SATStorage.saveAttempt({id:'original-pending',practiceName:'Original pending sentinel',status:'incomplete',resumable:true,questionIds:[q.id],sourceIds:['original-history'],totalQuestions:1,correctCount:0,incorrectCount:0,unansweredCount:1,ungradedCount:0,elapsedMs:0,durationSeconds:2100,remainingTimeMs:2100000,startedAt:1,savedAt:3,answers:{[q.id]:{...answer,selectedOption:null,answered:false,correctness:null}}});
    await SATStorage.setSetting('activeSATPackCollection',{collectionId:'original-active-marker',archivedAt:1});
    await SATStorage.migrateModel();
    localStorage.setItem('sat-reading-practice-v1',JSON.stringify({originalRuntimeSentinel:true}));
    localStorage['sat-reading-practice-v1']='original-private-application-sentinel';
    return {completed:await SATStorage.get('attempts','original-completed'),pending:await SATStorage.get('attempts','original-pending'),runtime:localStorage.getItem('sat-reading-practice-v1')};
  });
}
async function assertHistoryPreserved(page,before,{runtime=false}={}){
  const after=await page.evaluate(async()=>({completed:await SATStorage.get('attempts','original-completed'),pending:await SATStorage.get('attempts','original-pending'),source:await SATStorage.get('sources','original-history'),question:await SATStorage.get('questions','original-history:q'),wrong:await SATStorage.get('wrongBook','original-history:q'),marker:(await SATStorage.get('settings','activeSATPackCollection'))?.value,runtime:localStorage.getItem('sat-reading-practice-v1'),original:localStorage['sat-reading-practice-v1']}));
  assert.deepEqual(after.completed,before.completed);assert.deepEqual(after.pending,before.pending);
  assert.equal(!!after.source.deleted,false);assert.equal(!!after.question.deleted,false);assert.ok(after.wrong);
  assert.equal(after.marker.collectionId,'original-active-marker');assert.equal(after.original,'original-private-application-sentinel');
  if(runtime)assert.equal(after.runtime,before.runtime,'browsing or loading a collection must retain the saved runtime');
}
async function runChecks({page,requests,runtime,begin,saveExit,responseControl}){
  const screenshotDir=path.join(repo,'local-data/screenshots/sat-start-practice');
  await fs.mkdir(screenshotDir,{recursive:true});
  const screenshot=async(name,fullPage=true)=>{
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    return page.screenshot({path:path.join(screenshotDir,name+'.png'),fullPage});
  };
  const rejectForgedTimingChange=async(fullSATOnly=false)=>{
    const before=await page.evaluate(()=>({modules:SATApp.appState.activePractice.modules.map(module=>module.durationSeconds),duration:SATApp.appState.activePractice.durationSeconds}));
    await page.evaluate(fullSATOnly=>{
      const practice=SATApp.appState.activePractice,standardTiming=practice.standardTiming;
      if(fullSATOnly)practice.standardTiming=false;
      const input=document.createElement('input');input.type='number';input.hidden=true;input.dataset.moduleTime='0';input.value='1';
      document.getElementById('app').append(input);
      try{input.dispatchEvent(new Event('change',{bubbles:true}));}finally{input.remove();practice.standardTiming=standardTiming;}
    },fullSATOnly);
    const after=await page.evaluate(()=>({modules:SATApp.appState.activePractice.modules.map(module=>module.durationSeconds),duration:SATApp.appState.activePractice.durationSeconds}));
    assert.deepEqual(after,before,fullSATOnly?'fullSAT rejects a forged timing change independently':'standardTiming rejects a forged timing change');
  };
  const before=await seedHistory(page);
  await page.reload();await page.evaluate(()=>SATApp.ready);
  const openLibrary=async()=>{await page.locator('[data-action=startPractice]').first().click();await page.locator('[data-action=library-category][data-category="测试"]').waitFor();await page.waitForFunction(()=>SATLibrary.state.status==='ready');};
  const category=async value=>{await page.locator('[data-action=library-category][data-category="'+value+'"]').click();};
  const selectedRequests=()=>requests.filter(url=>url.startsWith('/api/sat-library/collections/'));
  const action=(name,id)=>page.locator('[data-action="'+name+'"][data-id="'+id+'"]');
  await openLibrary();
  assert.equal(selectedRequests().length,0,'opening the directory must request metadata only');
  await screenshot('directory-1440');
  await category('英语');await category('数学');
  await action('library-select','synthetic-math').first().click();
  assert.equal(selectedRequests().length,0,'category and card selection must not request any question package');
  await assertHistoryPreserved(page,before,{runtime:true});
  const libraryBefore=await page.evaluate(async()=>({sources:await SATStorage.all('sources'),questions:await SATStorage.all('questions')}));
  let releaseDelayed;
  responseControl.nextMath={kind:'delayed',gate:new Promise(resolve=>{releaseDelayed=resolve;})};
  const delayedRequest=page.waitForRequest(request=>new URL(request.url()).pathname==='/api/sat-library/collections/synthetic-math');
  await action('library-start','synthetic-math').click();await delayedRequest;
  assert.equal(await page.evaluate(()=>SATApp.appState.busy),true,'an outstanding collection request must hold the busy state');
  try{await page.locator('.app-back[data-action=dashboard]').click();await page.locator('.sat-hero').waitFor();}finally{releaseDelayed();}
  await page.waitForFunction(()=>!SATApp.appState.busy);
  assert.equal(await page.evaluate(()=>SATApp.appState.view),'dashboard','a delayed response must not reopen the page the learner left');
  assert.equal(await page.locator('.practice-ready').count(),0);
  assert.equal(await page.evaluate(()=>SATApp.appState.activePractice),null);
  assert.deepEqual(await page.evaluate(async()=>({sources:await SATStorage.all('sources'),questions:await SATStorage.all('questions')})),libraryBefore,'leaving before the response must not import the collection');
  await assertHistoryPreserved(page,before,{runtime:true});
  await openLibrary();await category('数学');
  responseControl.nextMath={kind:'module-mismatch'};
  await action('library-start','synthetic-math').click();
  await page.locator('#appNotice:not([hidden])').waitFor();await page.waitForFunction(()=>!SATApp.appState.busy);
  assert.match(await page.locator('#appNotice').innerText(),/changed.*Reload/i,'a same-size response with a changed module number must report stale metadata');
  assert.equal(await page.locator('.practice-ready').count(),0);
  assert.deepEqual(await page.evaluate(async()=>({sources:await SATStorage.all('sources'),questions:await SATStorage.all('questions')})),libraryBefore,'a metadata mismatch must fail before importing sources or questions');
  await assertHistoryPreserved(page,before,{runtime:true});
  assert.equal(await action('library-start','synthetic-math').isEnabled(),true,'a failed load must release busy and allow another start');
  const rejectedRequestCount=selectedRequests().length;
  await action('library-start','synthetic-math').click();
  await page.locator('.practice-ready').waitFor();
  assert.equal(selectedRequests().length,rejectedRequestCount+1);
  assert.ok(selectedRequests().every(url=>url==='/api/sat-library/collections/synthetic-math'),'all selected requests so far must target only the math collection');
  await assertHistoryPreserved(page,before,{runtime:true});
  const planned=await page.evaluate(()=>structuredClone(SATApp.appState.activePractice));
  assert.equal(planned.modules.length,1);assert.equal(planned.modules[0].moduleNumber,3);
  const itemOrder=await page.evaluate(async ids=>Promise.all(ids.map(async id=>(await SATStorage.get('questions',id)).itemId)),planned.questionIds);
  assert.deepEqual(itemOrder,[mathPack.refs[1].itemId,mathPack.refs[0].itemId],'source module item order must survive importing and session planning');
  await begin();
  await page.locator('#options [data-option="0"]').click();
  assert.match(await page.locator('.section-info h1').innerText(),/Module 3: Math/);
  const started=await runtime();
  await saveExit();
  const saved=await page.evaluate(id=>SATStorage.get('attempts',id),started.activePractice.id);
  assert.equal(saved.status,'incomplete');assert.equal(saved.resumable,true);
  await openLibrary();await category('数学');
  await action('library-resume','synthetic-math').click();
  await page.locator('#questionView').waitFor();
  const resumed=await runtime();assert.equal(resumed.activePractice.id,started.activePractice.id);assert.equal(resumed.questionStates[0].selectedOption,0);
  if(await page.locator('#modal[open]').count())await page.locator('#modalActions button').click();
  await page.locator('#nextButton').click();await page.locator('#options [data-option="1"]').click();
  await page.locator('#nextButton').click();await page.locator('#reviewView').waitFor();await page.locator('#nextButton').click();
  await page.locator('.completion-actions').waitFor();
  const completed=await page.evaluate(id=>SATStorage.get('attempts',id),started.activePractice.id);
  assert.equal(completed.status,'completed');assert.equal(completed.correctCount,1);assert.equal(completed.incorrectCount,1);
  assert.equal(completed.libraryCollectionId,'synthetic-math');
  const originalQuestion=await page.evaluate(async id=>{
    const question=await SATStorage.get('questions',id),db=await SATStorage.open();
    await new Promise((resolve,reject)=>{const tx=db.transaction('questions','readwrite');tx.objectStore('questions').put({...question,prompt:'Current synthetic row changed',packContent:{...question.packContent,prompt:[{type:'markdown',text:'Current synthetic row changed'}]}});tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
    return question;
  },completed.questionIds[0]);
  await page.reload();await page.evaluate(()=>SATApp.ready);await openLibrary();await category('数学');
  await action('library-review','synthetic-math').click();await page.locator('[data-action=review-question]').first().click();
  await page.locator('.single-review').waitFor();
  assert.match(await page.locator('.single-review').innerText(),/Original synthetic question 2/);
  assert.doesNotMatch(await page.locator('.single-review').innerText(),/Current synthetic row changed/,'historical review must use the immutable attempt snapshot');
  await page.evaluate(async question=>{const db=await SATStorage.open();await new Promise((resolve,reject)=>{const tx=db.transaction('questions','readwrite');tx.objectStore('questions').put(question);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});},originalQuestion);
  await page.locator('[data-action=dashboard]').first().click();await openLibrary();await category('数学');
  await action('library-restart','synthetic-math').click();await page.locator('.practice-ready').waitFor();
  assert.notEqual(await page.evaluate(()=>SATApp.appState.activePractice.id),completed.id,'Restart must create a new run');
  assert.deepEqual(await page.evaluate(id=>SATStorage.get('attempts',id),completed.id),completed,'Restart must keep the completed attempt intact');
  await page.locator('[data-action=timing-mode][data-mode=untimed]').click();
  assert.equal(await page.evaluate(()=>SATApp.appState.activePractice.untimed),true);
  await page.locator('[data-action=timing-mode][data-mode=timed]').click();
  assert.equal(await page.evaluate(()=>SATApp.appState.activePractice.untimed),false);
  await page.locator('[data-action=ready-back]').click();
  if(!await page.locator('[data-action=library-category]').count())await openLibrary();
  await category('测试');await action('library-start','synthetic-full').click();await page.locator('.practice-ready').waitFor();
  const fullPlan=await page.evaluate(()=>structuredClone(SATApp.appState.activePractice));
  assert.equal(fullPlan.fullSAT,true);assert.deepEqual(fullPlan.modules.map(module=>module.end-module.start),[27,27,22,22]);
  assert.deepEqual(fullPlan.modules.map(module=>module.durationSeconds),[1920,1920,2100,2100]);
  assert.equal(await page.locator('[data-module-time]:not([disabled]):not([readonly])').count(),0,'full SAT timing controls must be locked');
  assert.equal(await page.locator('.practice-ready footer .practice-timing-toggle').count(),1,'timing mode belongs in the bottom action row');
  const timingBox=await page.locator('[data-action=timing-mode][data-mode=timed]').boundingBox();
  assert.ok(timingBox&&timingBox.x>700,'the timing-mode control belongs on the right');
  await rejectForgedTimingChange();await rejectForgedTimingChange(true);
  await screenshot('ready-1440');
  await page.setViewportSize({width:375,height:812});
  await screenshot('ready-375',false);
  const narrowFooter=await page.locator('.practice-ready footer').evaluate(node=>{
    const footer=node.getBoundingClientRect();
    return{left:footer.left,right:footer.right,top:footer.top,bottom:footer.bottom,scroll:node.scrollWidth,client:node.clientWidth,page:document.documentElement.scrollWidth,viewport:innerWidth,height:innerHeight,children:[...node.querySelectorAll('button')].map(button=>{const rect=button.getBoundingClientRect();return{left:rect.left,right:rect.right};})};
  });
  assert.ok(narrowFooter.page<=narrowFooter.viewport+1,'the narrow ready page must not overflow horizontally');
  assert.ok(narrowFooter.left>=-1&&narrowFooter.right<=narrowFooter.viewport+1,'the narrow footer must fit the viewport');
  assert.ok(narrowFooter.scroll<=narrowFooter.client+1,'the narrow footer must not overflow internally');
  assert.ok(narrowFooter.children.every(child=>child.left>=-1&&child.right<=narrowFooter.viewport+1),'all narrow footer controls must remain inside the viewport');
  assert.ok(narrowFooter.top>=0&&narrowFooter.bottom<=narrowFooter.height+1,'the narrow footer must remain visible at the viewport bottom');
  console.log(JSON.stringify({narrowFooter}));
  await page.setViewportSize({width:1440,height:1000});
  await page.locator('[data-action=timing-mode][data-mode=untimed]').click();
  assert.equal(await page.evaluate(()=>SATApp.appState.activePractice.untimed),true);
  assert.deepEqual(await page.evaluate(()=>SATApp.appState.activePractice.modules.map(module=>module.durationSeconds)),[1920,1920,2100,2100]);
  await page.locator('[data-action=ready-back]').click();
  if(!await page.locator('[data-action=library-category]').count())await openLibrary();
  await category('测试');await action('library-start','synthetic-rw-partial').click();await page.locator('.practice-ready').waitFor();
  const partialFullPlan=await page.evaluate(()=>structuredClone(SATApp.appState.activePractice));
  assert.equal(partialFullPlan.fullSAT,false,'a partial source in Full-Length Tests must not become a full SAT');assert.equal(partialFullPlan.standardTiming,true);
  assert.equal(partialFullPlan.modules[0].moduleNumber,3);assert.equal(partialFullPlan.modules[0].durationSeconds,1920);
  assert.equal(await page.locator('[data-module-time]:not([disabled]):not([readonly])').count(),0,'partial Full-Length Tests also keep standard module timing');
  await rejectForgedTimingChange();
  await page.locator('[data-action=ready-back]').click();
  if(await page.locator('[data-action=library-category]').count())await page.locator('[data-action=dashboard]').first().click();
  await page.locator('[data-action=practiceBuilder]').first().click();
  await page.locator('[data-action=select-all]').click();await page.locator('[data-action=start]').click();await page.locator('.practice-ready').waitFor();
  const editable=page.locator('[data-module-time]:not([disabled]):not([readonly])').first();
  await editable.fill('1.5');await editable.press('Tab');
  assert.equal(await page.evaluate(()=>SATApp.appState.activePractice.modules[0].durationSeconds),90,'Practice Builder keeps adjustable module durations');
  await page.locator('[data-action=ready-back]').click();
  if(!await page.locator('[data-action=library-category]').count())await openLibrary();
  await page.setViewportSize({width:375,height:812});await category('数学');
  const width=await page.evaluate(()=>({body:document.documentElement.scrollWidth,viewport:innerWidth}));assert.ok(width.body<=width.viewport+1,'directory must fit a narrow screen');
  await assertHistoryPreserved(page,before);
  assert.ok(!requests.includes('/api/sat-library-backup'),'library browsing and selection must never activate or archive a collection');
}
