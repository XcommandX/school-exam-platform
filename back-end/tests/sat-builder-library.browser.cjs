'use strict';
// Original, in-memory fixtures only. The temporary server reads frontend source
// files; every API request is intercepted before it reaches that server.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),http=require('node:http'),path=require('node:path');
const {chromium}=require('playwright');
const repo=path.resolve(__dirname,'../..');
const mime={'.js':'application/javascript','.css':'text/css','.html':'text/html','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf','.svg':'image/svg+xml'};
const block=text=>({type:'markdown',text});
const inputProfile={id:'sat-spr-input/0.1-draft',status:'requires-rule-review',maxNonnegativeCharacters:5,maxNegativeCharacters:6,allowedForms:['integer','decimal','fraction'],allowMixedNumber:false};

function originalCollection(name,section,responseType,count){
  const collectionId='synthetic-builder-'+name,packId='sat:pack:builder-'+name,sourceId=`pack:${encodeURIComponent(packId)}@1`;
  const title='Original Builder '+name,questionType=section==='math'?'Algebra':'Information and Ideas',spr=responseType==='student-produced-response';
  const manifest={schemaVersion:'sat-question-pack/0.1-draft',documentType:'sat-question-pack',status:'draft',exam:'sat',id:packId,revision:1,title,section,responseType,contentFormat:'markdown-latex/0.1-draft',files:{items:'items.json',solutions:'solutions.json'},assets:[],...(spr?{inputProfile}:{})};
  const items=Array.from({length:count},(_,index)=>({id:'sat:item:builder-'+name+'-'+(index+1),revision:1,classification:{skill:questionType},content:[block('Original '+name+' context '+(index+1))],prompt:[block('Original '+name+' prompt '+(index+1)+'?')],source:{kind:'original'},...(spr?{}:{options:'ABCD'.split('').map(letter=>({id:letter,content:[block('Original '+name+' choice '+letter)]}))})}));
  const solutions=items.map(item=>({itemId:item.id,itemRevision:1,answer:{type:responseType,status:'verified',...(spr?{comparison:'exact-rational-or-listed-decimal',acceptedRationals:['4'],acceptedDecimalSpellings:[]}:{optionId:'A'})},explanation:{status:'provided',content:[block('Original builder explanation.')]},provenance:{kind:'original'}}));
  const fileName=name+'/pack.json',source={id:sourceId,fileName,displayName:title,section:section==='math'?'Math':'Reading and Writing',questionCount:count,defaultDurationSeconds:section==='math'?2100:1920,packIdentity:{id:packId,revision:1,section,responseType},collectionId,libraryCollectionId:collectionId};
  const questions=items.map((item,index)=>({id:`${sourceId}:${encodeURIComponent(item.id)}@1`,passage:item.content[0].text,prompt:item.prompt[0].text,options:(item.options||[]).map(option=>option.content[0].text),questionType,section:source.section,responseType,packId,packRevision:1,itemId:item.id,itemRevision:1,libraryCollectionId:collectionId,metadata:{sourceId,sourceFileName:fileName,sourceQuestionIndex:index,libraryCollectionId:collectionId},indexOnly:true}));
  const refs=items.map(item=>({packId,packRevision:1,itemId:item.id,itemRevision:1}));
  const modules=[{section,moduleNumber:1,questionCount:count,durationSeconds:source.defaultDurationSeconds,items:refs}];
  const metadata={collectionId,title,category:section==='math'?'math':'reading-writing',sourceCategory:section==='math'?'数学':'英语',subgroup:'',questionCount:count,fullSAT:false,sectionCounts:{[section]:count},modules:modules.map(({items,...module})=>module)};
  const files=[['pack.json',manifest],['items.json',{items}],['solutions.json',{visibility:'authoring-only',solutions}]].map(([file,value])=>({path:name+'/'+file,mediaType:'application/json',text:JSON.stringify(value)}));
  return {source,questions,metadata,payload:{...metadata,packs:[{id:packId,revision:1,title,section,responseType,questionCount:count,files}],assessment:null,modules}};
}

const rw=originalCollection('rw','reading-writing','single-choice',10);
const math=originalCollection('mcq','math','single-choice',10);
const spr=originalCollection('spr','math','student-produced-response',6);
const collections=[rw,math,spr],indexed=collections.flatMap(collection=>collection.questions);
const index={schemaVersion:1,available:true,sources:collections.map(collection=>collection.source),questions:indexed,errors:[]};
const catalog={schemaVersion:1,available:true,errors:[],categories:['full-length','reading-writing','math'].map(id=>({id,title:id,collections:collections.filter(collection=>collection.metadata.category===id).map(collection=>collection.metadata)}))};
const server=http.createServer(async(req,res)=>{try{
  assert.equal(req.method,'GET');
  const pathname=new URL(req.url,'http://localhost').pathname;
  if(pathname.startsWith('/api/'))throw Error('All APIs must be intercepted');
  let file;
  if(pathname.startsWith('/sat/'))file=path.resolve(repo,'front-end/sat',pathname.slice(5));
  else if(pathname==='/web/sat-bridge.js')file=path.join(repo,'front-end/web/sat-bridge.js');
  else throw Error('Unknown source');
  assert.ok(file.startsWith(path.join(repo,'front-end/sat')+path.sep)||file===path.join(repo,'front-end/web/sat-bridge.js'));
  let data=await fs.readFile(file);
  if(pathname==='/sat/html/index.html')data=Buffer.from(data.toString().replace('<head>','<head><script src="/web/sat-bridge.js"></script>'));
  res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');res.end(data);
}catch{res.statusCode=404;res.end('missing');}});

async function intercept(page,control={}){
  const requests=[],unexpected=[],errors=[];
  page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.stack||error.message));
  await page.route('**/api/**',async route=>{
    const request=route.request(),pathname=new URL(request.url()).pathname;requests.push(pathname);
    let value,status=200;
    if(request.method()!=='GET'){unexpected.push(request.method()+' '+pathname);status=405;value={error:'Synthetic checks forbid writes'};}
    else if(pathname==='/api/sat-library/question-index'){
      if(control.indexFailure){status=503;value={error:'Synthetic temporary index failure'};}else value=index;
    }
    else if(pathname==='/api/sat-library')value=catalog;
    else if(pathname.startsWith('/api/sat-library/collections/')){
      const collection=collections.find(collection=>pathname==='/api/sat-library/collections/'+collection.metadata.collectionId);
      if(control.collectionFailure===collection?.metadata.collectionId){control.collectionFailure=null;status=503;value={error:'Synthetic temporary collection failure'};}
      else if(collection)value=collection.payload;
      else{unexpected.push(pathname);status=404;value={error:'Unknown synthetic collection'};}
    }
    else if(pathname==='/api/question-bank/status')value={service:'sat-question-bank-v1',token:'original-builder-regression'};
    else if(pathname==='/api/question-bank')value={files:[],errors:[]};
    else if(pathname==='/api/sat-packs'||pathname==='/api/sat-test-collection')value={collectionId:null,packs:[],assessment:null};
    else{unexpected.push(pathname);status=404;value={error:'Unconfigured synthetic API'};}
    await route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
  });
  return {requests,unexpected,errors};
}

async function seedLocal(page){
  return page.evaluate(async()=>{
    const source={id:'builder-local',fileName:'builder-local.json',displayName:'Original Local',section:'Reading and Writing',questionCount:2,defaultDurationSeconds:1920,contentHash:'original-builder-local-hash',importedAt:1};
    const questions=Array.from({length:2},(_,index)=>({id:'builder-local:'+index,section:'Reading and Writing',responseType:'single-choice',passage:'Original local context '+index,prompt:'Original local prompt '+index+'?',options:['Original A','Original B','Original C','Original D'],correctOption:0,questionType:'',explanation:'Original local explanation.',metadata:{sourceId:source.id,sourceFileName:source.fileName,sourceQuestionIndex:index,importedAt:1}}));
    await SATStorage.importSet(source,questions);
    const answer={selectedOption:1,numericResponse:'',answered:true,correctOption:0,correctness:false,timeSpentMs:10,markedForReview:false,eliminatedOptions:[],highlights:[]};
    const completed={id:'builder-history-completed',practiceName:'Original completed sentinel',status:'completed',questionIds:[questions[0].id],sourceIds:[source.id],totalQuestions:1,correctCount:0,incorrectCount:1,unansweredCount:0,ungradedCount:0,elapsedMs:10,durationSeconds:1920,startedAt:1,completedAt:2,savedAt:2,answers:{[questions[0].id]:answer}};
    const pending={...completed,id:'builder-history-pending',practiceName:'Original pending sentinel',status:'incomplete',resumable:true,correctCount:0,incorrectCount:0,unansweredCount:1,remainingTimeMs:1920000,completedAt:null,savedAt:3,answers:{[questions[0].id]:{...answer,selectedOption:null,answered:false,correctness:null}}};
    await SATStorage.saveAttempt(completed);await SATStorage.saveAttempt(pending);
    await SATStorage.setSetting('activeSATPackCollection',{collectionId:'builder-original-active',archivedAt:1});
    await SATStorage.migrateModel();
    localStorage.setItem('sat-reading-practice-v1',JSON.stringify({builderRuntimeSentinel:true}));
    localStorage['sat-reading-practice-v1']='original-private-app-sentinel';
    return {completed:await SATStorage.get('attempts',completed.id),pending:await SATStorage.get('attempts',pending.id),wrong:await SATStorage.get('wrongBook',questions[0].id),runtime:localStorage.getItem('sat-reading-practice-v1')};
  });
}

async function assertHistory(page,before,{runtime=false}={}){
  const after=await page.evaluate(async()=>({completed:await SATStorage.get('attempts','builder-history-completed'),pending:await SATStorage.get('attempts','builder-history-pending'),wrong:await SATStorage.get('wrongBook','builder-local:0'),marker:(await SATStorage.get('settings','activeSATPackCollection'))?.value,runtime:localStorage.getItem('sat-reading-practice-v1'),original:localStorage['sat-reading-practice-v1']}));
  assert.deepEqual(after.completed,before.completed);assert.deepEqual(after.pending,before.pending);assert.deepEqual(after.wrong,before.wrong);
  assert.equal(after.marker.collectionId,'builder-original-active');assert.equal(after.original,'original-private-app-sentinel');
  if(runtime)assert.equal(after.runtime,before.runtime,'index browsing and loading must preserve the saved runtime');
}

const selectedRequests=requests=>requests.filter(url=>url.startsWith('/api/sat-library/collections/'));
const waitIndex=page=>page.waitForFunction(()=>SATBuilderLibrary.state.status==='ready');
const openBuilder=async page=>{await page.locator('[data-action=practiceBuilder]').first().click();await page.locator('#practiceName').waitFor();await waitIndex(page);};
const filter=(page,name,value)=>page.locator('[data-filter="'+name+'"]').selectOption(value);
const clear=page=>page.locator('[data-action=clear-selection]').click();
const selected=page=>page.locator('#selectedCount').innerText();
const resetFilters=async page=>{await filter(page,'section','');await filter(page,'sourceId','');await filter(page,'questionType','');await page.locator('[data-filter=search]').fill('');};

async function runMain(page,trace,control,url){
  await page.goto(url);await page.evaluate(()=>SATApp.ready);await waitIndex(page);
  const before=await seedLocal(page);await page.reload();await page.evaluate(()=>SATApp.ready);await waitIndex(page);
  assert.equal(await page.locator('.dashboard-stats>div').first().locator('strong').innerText(),'28','dashboard includes all indexed questions and existing local questions');
  assert.equal(selectedRequests(trace.requests).length,0,'boot and dashboard must not download collections');
  assert.equal(await page.evaluate(async()=>(await SATStorage.all('questions')).length),2,'index previews are not bulk-imported as answerable questions');
  await openBuilder(page);
  assert.match(await page.locator('.app-pagination').innerText(),/of 28 questions/);
  assert.equal(await page.locator('[data-select-question]').count(),8,'the first page stays bounded');
  const sourceOptions=await page.locator('[data-filter=sourceId] option').evaluateAll(options=>options.map(option=>option.value));
  for(const collection of collections)assert.ok(sourceOptions.includes(collection.source.id),'every indexed source is selectable');
  await page.locator('[data-action=page-next]').click();
  await page.locator('[data-action=select-all]').click();
  assert.equal(await selected(page),'28 Questions','Select All spans all filtered pages');
  await page.locator('[data-action=page-prev]').click();assert.equal(await page.locator('[data-select-question]:checked').count(),8);
  await clear(page);await filter(page,'section','math');await page.locator('[data-action=select-all]').click();assert.equal(await selected(page),'16 Questions');
  await clear(page);await filter(page,'section','reading-writing');await page.locator('[data-action=select-all]').click();assert.equal(await selected(page),'12 Questions');
  await clear(page);await resetFilters(page);await filter(page,'questionType','Algebra');await page.locator('[data-action=select-all]').click();assert.equal(await selected(page),'16 Questions','raw new-pack skills remain filterable');
  await clear(page);await resetFilters(page);await filter(page,'questionType','__wrongBook');await page.locator('[data-action=select-all]').click();assert.equal(await selected(page),'1 Questions','Wrong Book keeps local historical membership');
  await clear(page);await resetFilters(page);await filter(page,'sourceId',rw.source.id);await page.locator('[data-action=select-all]').click();assert.equal(await selected(page),'10 Questions');
  await clear(page);await page.locator('[data-filter=search]').fill('Original rw prompt 10?');await page.locator('[data-action=select-all]').click();assert.equal(await selected(page),'1 Questions','search reaches indexed prompts beyond the current page');
  assert.match(await page.locator('#practiceName').inputValue(),/Original Builder rw.*\(1 questions\)/,'automatic subset names use the indexed source');
  await page.locator('#practiceName').fill('My Handwritten Set');await resetFilters(page);await filter(page,'section','math');
  assert.equal(await page.locator('#practiceName').inputValue(),'My Handwritten Set','filter changes preserve a handwritten name');
  await resetFilters(page);await clear(page);
  const chosen=[rw.questions[9].id,spr.questions[0].id];
  await filter(page,'sourceId',rw.source.id);await page.locator('[data-filter=search]').fill('Original rw prompt 10?');await page.locator('[data-select-question]').check();
  await filter(page,'sourceId',spr.source.id);await page.locator('[data-filter=search]').fill('Original spr prompt 1?');await page.locator('[data-select-question]').check();
  assert.equal(await selected(page),'2 Questions');
  const minutes=page.locator('[data-duration=custom][data-part=minutes]'),seconds=page.locator('[data-duration=custom][data-part=seconds]');
  await minutes.fill('2');await seconds.fill('3');await seconds.press('Enter');
  assert.equal(selectedRequests(trace.requests).length,0,'filters, pagination, and selections only consume the question index');
  await assertHistory(page,before,{runtime:true});
  await page.locator('[data-action=start]').click();await page.locator('.practice-ready').waitFor();
  const plan=await page.evaluate(()=>structuredClone(SATApp.appState.activePractice));
  assert.deepEqual(new Set(plan.questionIds),new Set(chosen));assert.equal(plan.name,'My Handwritten Set');assert.deepEqual(plan.modules.map(module=>module.durationSeconds),[123,123],'hydrating a subset must not overwrite its chosen duration with source defaults');
  assert.deepEqual(selectedRequests(trace.requests).sort(),[rw,spr].map(collection=>'/api/sat-library/collections/'+collection.metadata.collectionId).sort(),'start downloads only collections containing selected questions');
  const hydrated=await page.evaluate(async ids=>Promise.all(ids.map(id=>SATStorage.get('questions',id))),chosen);
  assert.ok(hydrated.every(question=>question.packContent&&question.answerRule&&!question.indexOnly),'only selected collections provide runtime content and answer rules');
  assert.equal(hydrated.find(question=>question.section==='Math').responseType,'student-produced-response');
  assert.equal(await page.locator('[data-module-time]:not([disabled]):not([readonly])').count(),2,'ordinary Builder timing remains adjustable');
  await assertHistory(page,before,{runtime:true});
  await page.locator('[data-action=ready-back]').click();await openBuilder(page);await page.locator('[data-action=builder-source]').click();
  await page.locator('input[name=practice-source][value="'+spr.source.id+'"]').check();
  assert.equal(await selected(page),'6 Questions','By Source includes the entire indexed source');
  const sprMinutes=page.locator('[data-duration="'+spr.source.id+'"][data-part=minutes]'),sprSeconds=page.locator('[data-duration="'+spr.source.id+'"][data-part=seconds]');
  await sprMinutes.fill('1');await sprSeconds.fill('30');await sprSeconds.press('Enter');
  await page.locator('[data-action=start]').click();await page.locator('.practice-ready').waitFor();
  const sourcePlan=await page.evaluate(()=>structuredClone(SATApp.appState.activePractice));
  assert.equal(sourcePlan.questionIds.length,6);assert.match(sourcePlan.name,/Original Builder spr/);assert.equal(sourcePlan.modules[0].durationSeconds,90,'whole-source Builder duration remains a learner setting');
  await page.locator('[data-action=begin]').click();await page.locator('#modal[open]').waitFor();await page.locator('#modalActions button').click();
  await page.locator('#numericResponse').fill('4');
  const runtime=await page.evaluate(()=>JSON.parse(localStorage.getItem('sat-reading-practice-v1')));assert.equal(runtime.questionStates[0].numericResponse,'4');
  await page.locator('#exitButton').click();await page.locator('[data-more=exit]').click();await page.locator('#modalActions').getByRole('button',{name:'Save and Exit',exact:true}).click();await page.locator('.sat-hero').waitFor();
  const saved=await page.evaluate(id=>SATStorage.get('attempts',id),runtime.activePractice.id);assert.equal(saved.status,'incomplete');assert.equal(saved.resumable,true);assert.equal(saved.questionSnapshots.length,6);
  assert.equal(await page.locator('.dashboard-stats>div').first().locator('strong').innerText(),'28','importing selected collections must not double-count their index rows');
  const requestsBeforeResume=selectedRequests(trace.requests).length;
  await page.locator('[data-action=resume][data-id="'+runtime.activePractice.id+'"]').click();await page.locator('#numericResponse').waitFor();
  if(await page.locator('#modal[open]').count())await page.locator('#modalActions button').click();
  assert.equal(await page.locator('#numericResponse').inputValue(),'4');assert.equal(selectedRequests(trace.requests).length,requestsBeforeResume,'saved Builder practices resume from stored snapshots');
  await page.locator('#exitButton').click();await page.locator('[data-more=exit]').click();await page.locator('#modalActions').getByRole('button',{name:'Save and Exit',exact:true}).click();await page.locator('.sat-hero').waitFor();
  await assertHistory(page,before);
  // A different, unloaded source can fail and retry without losing selection.
  await openBuilder(page);await page.locator('[data-action=builder-source]').click();await page.locator('input[name=practice-source][value="'+math.source.id+'"]').check();
  control.collectionFailure=math.metadata.collectionId;await page.locator('[data-action=start]').click();await page.locator('#appNotice:not([hidden])').waitFor();await page.waitForFunction(()=>!SATApp.appState.busy);
  assert.equal(await page.locator('.practice-ready').count(),0);assert.equal(await selected(page),'10 Questions');assert.equal(await page.locator('[data-action=start]').isEnabled(),true);
  await page.locator('[data-action=start]').click();await page.locator('.practice-ready').waitFor();assert.equal(await page.evaluate(()=>SATApp.appState.activePractice.questionIds.length),10);
  await page.locator('[data-action=ready-back]').click();
  assert.ok(!trace.requests.includes('/api/sat-library-backup'),'Builder never activates or archives a collection');await assertHistory(page,before);
}

async function runIndexRetry(page,trace,control,url){
  control.indexFailure=true;await page.goto(url);await page.evaluate(()=>SATApp.ready);await page.waitForFunction(()=>SATBuilderLibrary.state.status==='error');
  await page.locator('[data-action=practiceBuilder]').first().click();await page.locator('[data-action=builder-library-refresh]').waitFor();
  assert.equal(selectedRequests(trace.requests).length,0);control.indexFailure=false;
  await page.locator('[data-action=builder-library-refresh]').click();await waitIndex(page);await page.locator('[data-action=select-all]').click();assert.equal(await selected(page),'26 Questions','Retry makes the complete index available without reloading the app');
  assert.equal(selectedRequests(trace.requests).length,0);
}

(async()=>{
  // Index fixtures deliberately contain only searchable previews and identities.
  assert.ok(indexed.every(question=>question.indexOnly&&!('answerRule'in question)&&!('correctOption'in question)&&!('packContent'in question)&&!('packAssets'in question)&&!('explanation'in question)));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try{
    browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{channel:'chrome'})});
    const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),control={},trace=await intercept(page,control),url='http://127.0.0.1:'+server.address().port+'/sat/html/index.html';
    await runMain(page,trace,control,url);assert.deepEqual(trace.unexpected,[]);assert.deepEqual(trace.errors,[]);
    const retryContext=await browser.newContext({viewport:{width:1440,height:1000}}),retryPage=await retryContext.newPage(),retryControl={},retryTrace=await intercept(retryPage,retryControl);
    await runIndexRetry(retryPage,retryTrace,retryControl,url);assert.deepEqual(retryTrace.unexpected,[]);assert.deepEqual(retryTrace.errors,[]);
    console.log(JSON.stringify({ok:true,syntheticOnly:true,indexedQuestions:indexed.length,localQuestions:2,selectedCollectionRequests:selectedRequests(trace.requests).length,indexRetry:true}));
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
