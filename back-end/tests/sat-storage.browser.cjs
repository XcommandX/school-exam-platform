'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const {chromium} = require('playwright');
const root = path.resolve(__dirname,'../..');

test('real IndexedDB collection switching backs up before archiving, retries imports, and keeps SPR mistakes', async () => {
  const packFiles = [];
  for(const name of ['rw-single-choice','math-single-choice','math-spr']){
    const files=[];
    async function walk(directory,relative=''){
      for(const entry of await fs.readdir(directory,{withFileTypes:true})){
        const next=relative?relative+'/'+entry.name:entry.name,full=path.join(directory,entry.name);
        if(entry.isDirectory())await walk(full,next);
        else{const data=await fs.readFile(full);files.push(entry.name.endsWith('.svg')?{path:name+'/'+next,mediaType:'image/svg+xml',dataBase64:data.toString('base64')}:{path:name+'/'+next,mediaType:'application/json',text:data.toString('utf8')});}
      }
    }
    await walk(path.join(root,'docs/drafts/sat-question-packs',name));packFiles.push({files});
  }
  const received=[],requests=[];
  const server=http.createServer(async(req,res)=>{
    requests.push(req.url);res.setHeader('Content-Type','application/json');
    if(req.url==='/api/question-bank/status'){res.end(JSON.stringify({service:'sat-question-bank-v1',token:'synthetic-token'}));return;}
    if(req.url==='/api/sat-packs'){res.end(JSON.stringify({collectionId:'synthetic-bank',packs:packFiles,assessment:{title:'Synthetic',fullSAT:true,modules:[]}}));return;}
    if(req.url==='/api/sat-library-backup'){
      let raw='';for await(const chunk of req)raw+=chunk;received.push({headers:req.headers,body:JSON.parse(raw)});
      res.statusCode=201;res.end(JSON.stringify({saved:true,name:'browser-synthetic.json',sha256:'synthetic-hash'}));return;
    }
    if(req.url==='/'){
      res.setHeader('Content-Type','text/html');res.end('<!doctype html><script>window.SATPlatformBridge={runtimeKey:"platform-test-runtime"};</script>'+['sat-pack.js','storage.js','importer.js','question-bank.js'].map(name=>`<script src="/${name}"></script>`).join(''));return;
    }
    try{if(!['/sat-pack.js','/storage.js','/importer.js','/question-bank.js'].includes(req.url))throw new Error('missing');res.setHeader('Content-Type','text/javascript');res.end(await fs.readFile(path.join(root,'front-end/sat/js',req.url.slice(1))));}
    catch{res.statusCode=404;res.end('{}');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try{
    browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{channel:'chrome'})});
    const page=await browser.newPage(),pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const archiveChecks=await page.evaluate(async()=>{
      const q={id:'old:q',prompt:'Synthetic previous question',options:['a','b','c','d'],correctOption:1,metadata:{sourceId:'old',sourceQuestionIndex:0}};
      await SATStorage.importSet({id:'old',contentHash:'old-hash',fileName:'old.json'},[q]);
      await SATStorage.saveAttempt({id:'complete',status:'completed',completedAt:1,answers:{'old:q':{selectedOption:0,correctOption:1,correctness:false}}});
      await SATStorage.saveAttempt({id:'pending',status:'incomplete',resumable:true,answers:{}});
      localStorage.setItem('sat-reading-practice-v1','ORIGINAL_NAMESPACE_UNTOUCHED');
      localStorage.setItem('platform-test-runtime',JSON.stringify({phase:'section_break',breakEndTimestamp:123456789}));
      let rejected=0;
      for(const backup of [async()=>{throw new Error('disk unavailable');},async()=>({saved:false})]){
        try{await SATStorage.archiveLibraryForCollection('direct',backup);}catch{rejected++;}
      }
      const before={source:(await SATStorage.get('sources','old')).deleted||false,runtime:localStorage.getItem('platform-test-runtime'),marker:await SATStorage.get('settings','activeSATPackCollection')};
      let captured;
      const done=await SATStorage.archiveLibraryForCollection('direct',async snapshot=>{captured=snapshot;return{saved:true,name:'confirmed.json',sha256:'ok'};});
      let called=false;const repeat=await SATStorage.archiveLibraryForCollection('direct',async()=>{called=true;throw new Error('must not run');});
      return {rejected,before,done,repeat,called,captured,source:await SATStorage.get('sources','old'),question:await SATStorage.get('questions','old:q'),attempts:await SATStorage.all('attempts'),wrong:await SATStorage.all('wrongBook'),original:localStorage.getItem('sat-reading-practice-v1'),runtime:localStorage.getItem('platform-test-runtime')};
    });
    assert.equal(archiveChecks.rejected,2);assert.equal(archiveChecks.before.source,false);assert.ok(archiveChecks.before.runtime);assert.equal(archiveChecks.before.marker,undefined);
    assert.equal(archiveChecks.done.changed,true);assert.equal(archiveChecks.repeat.changed,false);assert.equal(archiveChecks.called,false);
    assert.equal(archiveChecks.captured.runtimeSnapshot.phase,'section_break');assert.equal(archiveChecks.captured.sources.length,1);assert.equal(archiveChecks.captured.questions.length,1);assert.equal(archiveChecks.captured.attempts.length,2);assert.equal(archiveChecks.captured.wrongBook.length,1);
    assert.equal(archiveChecks.source.deleted,true);assert.equal(archiveChecks.question.deleted,true);assert.equal(archiveChecks.attempts.find(a=>a.id==='pending').resumable,false);assert.equal(archiveChecks.attempts.find(a=>a.id==='complete').status,'completed');
    assert.equal(archiveChecks.runtime,null);assert.equal(archiveChecks.original,'ORIGINAL_NAMESPACE_UNTOUCHED');assert.equal(archiveChecks.wrong.length,1);
    const first=await page.evaluate(async()=>{await SATBank.init();await SATBank.sync();return{state:SATBank.state,questions:await SATStorage.all('questions'),sources:await SATStorage.all('sources')};});
    assert.deepEqual(first.state.errors,[]);assert.equal(first.state.collectionId,'synthetic-bank');assert.equal(first.state.assessment.title,'Synthetic');
    assert.equal(first.questions.filter(q=>!q.deleted).length,5);assert.equal(first.sources.filter(s=>!s.deleted).length,3);
    assert.equal(received.length,1);assert.equal(received[0].headers['x-sat-bank-token'],'synthetic-token');assert.match(received[0].headers.origin,/^http:\/\/127\.0\.0\.1:/);
    assert.equal(received[0].body.snapshot.sources[0].id,'old');assert.equal(received[0].body.snapshot.targetCollectionId,'synthetic-bank');
    await page.evaluate(()=>SATBank.sync());assert.equal(received.length,1,'unchanged collection must not back up or reset again');
    assert.equal(requests.filter(url=>url==='/api/question-bank').length,0,'active SAT packages must not re-import the old compatibility bank');
    const grading=await page.evaluate(async()=>{
      const questions=(await SATStorage.all('questions')).filter(q=>!q.deleted),numeric=questions.filter(q=>q.responseType==='student-produced-response');
      await SATStorage.saveAttempt({id:'spr-complete',status:'completed',completedAt:2,answers:{[numeric[0].id]:{selectedOption:null,numericResponse:'9',correctness:false},[numeric[1].id]:{selectedOption:null,numericResponse:'2/3',correctness:null}}});
      await SATStorage.saveAttempt({id:'spr-complete',status:'completed',completedAt:3,answers:{[numeric[1].id]:{selectedOption:null,numericResponse:'9',correctness:false}}});
      const wrong=await SATStorage.all('wrongBook');
      const manualSource=(await SATStorage.all('sources')).find(s=>!s.deleted&&s.section==='Math'&&s.responseType==='single-choice');
      await SATStorage.deleteSource(manualSource.id);
      await SATBank.sync();
      const deletionKept=(await SATStorage.get('sources',manualSource.id)).deleted===true&&(await SATStorage.all('questions')).filter(q=>!q.deleted).length===4;
      const manualQuestion=(await SATStorage.all('questions')).find(q=>!q.deleted&&q.section==='Reading and Writing');
      await SATStorage.deleteQuestion(manualQuestion.id);await SATBank.sync();
      const questionDeletionKept=(await SATStorage.get('questions',manualQuestion.id)).deleted===true;
      const activeSource=(await SATStorage.all('sources')).find(s=>!s.deleted);
      await SATStorage.archiveLibraryForCollection('another',async()=>({saved:true}));
      let conflict='';try{await SATStorage.importSet({...activeSource,contentHash:'altered-without-revision'},[]);}catch(error){conflict=error.message;}
      await SATBank.sync();
      return{wrong,numericIds:numeric.map(q=>q.id),deletionKept,questionDeletionKept,manualQuestionStillDeleted:(await SATStorage.get('questions',manualQuestion.id)).deleted,manualSourceStillDeleted:(await SATStorage.get('sources',manualSource.id)).deleted,conflict,state:SATBank.state,active:(await SATStorage.all('questions')).filter(q=>!q.deleted).length,total:(await SATStorage.all('questions')).length};
    });
    assert.ok(grading.wrong.some(w=>w.questionId===grading.numericIds[0]));assert.ok(!grading.wrong.some(w=>w.questionId===grading.numericIds[1]));
    assert.equal(grading.deletionKept,true,'same-collection auto sync must preserve a manual source deletion');assert.equal(grading.manualSourceStillDeleted,true,'revisiting a collection must preserve its deliberate source deletion');
    assert.equal(grading.questionDeletionKept,true);assert.equal(grading.manualQuestionStillDeleted,true,'reactivating an archived source must not restore a previously deleted individual question');
    assert.match(grading.conflict,/different content/);assert.deepEqual(grading.state.errors,[]);assert.equal(grading.active,3);assert.equal(grading.total,6,'revisiting an archived collection must reactivate identical revisions without duplicating them');
    assert.deepEqual(pageErrors,[]);
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
});
