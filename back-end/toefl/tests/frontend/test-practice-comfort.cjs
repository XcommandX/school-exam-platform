const toeflFrontendRoot = require('node:path').resolve(__dirname, '../../../../front-end/toefl');
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),src=fs.readFileSync(process.env.TOEFL_FRONTEND_SOURCE||toeflFrontendRoot+'/four-app.js','utf8');const c={};vm.createContext(c);for(const name of ['validAssessment','attemptSummary','practicePulse']){let a=src.indexOf('function '+name+'('),b=src.indexOf('\nfunction ',a+1);vm.runInContext(src.slice(a,b),c)}
const now=new Date(2026,9,20,12).getTime(),entries=[{finished:now,results:[{id:'r',items:[{id:'1',answered:true},{id:'2',answered:false}]}]},{finished:now-86400000,recorded:{'s:q':true},results:[{id:'s',items:[{id:'q',answered:false}]}]},{preview:true,finished:now,results:[{items:[{answered:true}]}]}];let pulse=c.practicePulse(entries,now);assert.equal(pulse.today,1);assert.equal(pulse.total,2);assert.equal(pulse.activeDays,2);assert.equal(pulse.days.length,7);assert.equal(pulse.days[6].count,1);let notesOnly=c.practicePulse([{finished:now,results:[{id:'speaking-t1:x',items:[{id:'q',answered:true,response:'Notes without a recording'}]}]}],now);assert.equal(notesOnly.total,0);
let partial={results:[{id:'r',automatic:false,items:[{id:'a'},{id:'b'}]}],ai:{r:{a:{score:4}}}};assert.equal(c.attemptSummary(partial).label,'AI 4.0 / 5 · 1/2');partial.ai.r.b={score:3};assert.equal(c.attemptSummary(partial).label,'AI 3.5 / 5');partial.ai.r.b.score='5';assert.equal(c.attemptSummary(partial).aiScored,1);console.log('PASS: recent practice counts only actual answers/recordings, previews excluded, partial AI coverage visible and invalid scores ignored.');

function take(name){
 const marker='function '+name+'(',at=src.indexOf(marker);assert(at>=0,name+' exists');
 const start=src.slice(at-6,at)==='async '?at-6:at;
 const ends=['\nfunction ','\nasync function '].map(token=>src.indexOf(token,at+marker.length)).filter(index=>index>=0);
 return src.slice(start,Math.min(...ends));
}
function randomHarness(){
 const records=[1,2,3].map(i=>({key:'reading-t1:original-'+i,module:'reading-t1',complete:true,duration:30,items:[]})),loads=[],panels=[];
 const c={JSON,Map,Set,Math,Date,console,s:{view:'bank',subject:'reading',module:'reading-t1',count:1,timed:false},session:null,drafts:[],pageEntry:null,byKey:new Map(records.map(r=>[r.key,r])),names:{reading:'阅读'},modules:{'reading-t1':'T1 · 补全单词'},esc:value=>String(value),pool:()=>records.slice(),practiceContext:()=>({module:'reading-t1'}),captureEntry:()=>({view:'bank',state:{module:'reading-t1'},y:0}),validEntry:()=>null,makeEntry:()=>({view:'bank',state:{},y:0}),ensureRecords:keys=>new Promise(resolve=>loads.push({keys,resolve})),suspendSession(){},persist(){c.persisted=(c.persisted||0)+1},restoreRecordings(){},renderExam(){c.rendered=(c.rendered||0)+1},toast(){}};
 c.openPanel=()=>{
  const listeners=new Map(),begin={disabled:false,textContent:'开始练习',isConnected:true},count={value:'1'};
  const panel={open:true,begin,setAttribute(){},querySelector(selector){return selector==='#random-begin'?begin:selector==='#random-count'?count:null},addEventListener(name,fn){let list=listeners.get(name)||[];list.push(fn);listeners.set(name,list)},close(){if(!this.open)return;this.open=false;begin.isConnected=false;for(const fn of listeners.get('close')||[])fn({type:'close',target:this})},cancel(cause){if(cause==='escape'){const event={type:'cancel',target:this,defaultPrevented:false,preventDefault(){this.defaultPrevented=true}};for(const fn of listeners.get('cancel')||[])fn(event);if(event.defaultPrevented)return;}this.close()}};
  panels.push(panel);return panel;
 };
 vm.createContext(c);vm.runInContext('let navigationEpoch=0;\n'+take('start')+'\n'+take('openRandomPractice'),c);
 return {c,loads,panels,epoch:()=>vm.runInContext('navigationEpoch',c)};
}
(async()=>{
 for(const cause of ['cancel-button','escape']){
  const h=randomHarness();h.c.openRandomPractice();const panel=h.panels[0],pending=panel.begin.onclick();
  assert.equal(h.loads.length,1);assert(panel.begin.disabled);assert.equal(panel.begin.textContent,'正在加载…');
  panel.cancel(cause);assert.equal(panel.open,false);h.loads[0].resolve(true);await pending;
  assert.equal(h.c.s.view,'bank',cause+' must leave the user in the practice list');assert.equal(h.c.session,null);assert.equal(h.c.rendered,undefined,'A cancelled load must not render an exam');assert.equal(h.c.persisted,undefined,'A cancelled load must not create a draft');
  // A fresh launch after cancellation still succeeds and its automatic close is harmless.
  h.c.openRandomPractice();const next=h.panels[1],started=next.begin.onclick();h.loads[1].resolve(true);await started;
  assert.equal(h.c.s.view,'exam');assert.equal(h.c.session.queue.length,1);assert.equal(h.c.rendered,1);assert.equal(next.open,false);assert.equal(h.epoch(),3,'Closing a successful dialog must not invalidate the new exam');
 }
 // A later navigation owns its epoch; closing the older panel must not cancel it.
 const h=randomHarness();h.c.openRandomPractice();const panel=h.panels[0],pending=panel.begin.onclick();vm.runInContext('navigationEpoch++',h.c);const later=h.epoch();panel.cancel('escape');assert.equal(h.epoch(),later);h.loads[0].resolve(true);await pending;assert.equal(h.c.session,null);
 // Failed loading leaves a usable dialog, and clearing its pending marker prevents spurious cancellation.
 const failed=randomHarness();failed.c.openRandomPractice();const retryPanel=failed.panels[0],first=retryPanel.begin.onclick();failed.loads[0].resolve(false);await first;assert.equal(retryPanel.open,true);assert.equal(retryPanel.begin.disabled,false);assert.equal(retryPanel.begin.textContent,'开始练习');const before=failed.epoch();retryPanel.cancel('cancel-button');assert.equal(failed.epoch(),before);
 console.log('PASS: random-practice cancellation and Escape invalidate only their pending launch, later navigation survives, failed loads remain retryable, and fresh successful launches enter the exam normally.');
})().catch(error=>{console.error(error);process.exitCode=1});

function draftFunction(name){
 const marker='function '+name+'(',at=src.indexOf(marker);assert(at>=0,name+' exists');
 const start=src.slice(at-6,at)==='async '?at-6:at;
 // Top-level state declarations may follow these helpers before the next function.
 const ends=['\nfunction ','\nasync function ','\nconst ','\nlet ','\nvar ','\nwindow.','\napp.'].map(token=>src.indexOf(token,at+marker.length)).filter(index=>index>=0);
 return src.slice(start,Math.min(...ends));
}
const plain=value=>JSON.parse(JSON.stringify(value));
function cancellationHarness(){
 const drafts=['draft-a','draft-b','draft-c'].map((id,index)=>({id,queue:['reading-t1:original'],index:0,updated:index+1,values:{'reading-t1:original':{q:'original fixture '+id}}}));
 const history=[{id:'completed-only',finished:20,results:[{id:'reading-t1:original',items:[{id:'q',correct:true,response:'original completed response'}]}]},{id:'draft-b',finished:10,results:[{id:'reading-t1:original',items:[{id:'q',correct:false,response:'original prior response'}]}]}];
 const existing={id:'cancelled-before',cancelled:true,cancelledAt:1},stored=new Map([['four.drafts.v2',JSON.stringify([...drafts,existing])]]),writes=[],messages=[],purged=[];
 const forbidden=()=>{throw Error('Cancellation must not grade, submit or append history')};
 const c={JSON,Map,Set,Date,Array,Number,console,drafts,history,session:null,navigationEpoch:17,draftCancellations:new Map([[existing.id,existing]]),byKey:new Map([['reading-t1:original',{key:'reading-t1:original',module:'reading-t1'}]]),window:{PracticeCloud:{queue(){if(c.queueFailure)throw Error('Synthetic pending-queue failure')}}},localStorage:{getItem:key=>stored.get(key)??null,setItem(key,value){writes.push({key,value,beforeIds:c.drafts.map(d=>d.id),beforeEpoch:c.navigationEpoch});if(c.storageFailure)throw Error('Synthetic storage failure');stored.set(key,value)},removeItem:key=>stored.delete(key)},toast:message=>messages.push(message),purgeCancelledRecordings:async ids=>purged.push(plain(ids)),recordingUrls:new Map(),recordingHashes:new Map(),recordingCloudState:new Map(),autoRecorded:new Set(),URL:{revokeObjectURL(){}},finish:forbidden,trackLearning:forbidden,L:{grade:forbidden}};
 const saveStart=src.indexOf('const save='),saveEnd=src.indexOf('\n',saveStart);assert(saveStart>=0&&saveEnd>saveStart,'The actual persistence wrapper is present.');
 vm.createContext(c);vm.runInContext(src.slice(saveStart,saveEnd)+'\n'+draftFunction('adoptDraftRows')+'\n'+draftFunction('discardDrafts'),c);
 return {c,stored,writes,messages,purged,historyBefore:JSON.stringify(history),draftsBefore:JSON.stringify(drafts),markersBefore:JSON.stringify([...c.draftCancellations]),savedRows:()=>JSON.parse(stored.get('four.drafts.v2')),ids:()=>c.drafts.map(d=>d.id)};
}
{
 let h=cancellationHarness();assert.equal(h.c.discardDrafts(['draft-b','draft-b']),1);assert.deepEqual(plain(h.ids()),['draft-a','draft-c']);assert.equal(JSON.stringify(h.c.history),h.historyBefore,'Cancelling a draft with an already completed history ID preserves the report');assert.equal(h.c.navigationEpoch,18);
 assert.deepEqual(plain(h.writes[0].beforeIds),['draft-a','draft-b','draft-c']);assert.equal(h.writes[0].beforeEpoch,17,'Only a successful write can advance navigation');assert.deepEqual(h.purged,[['draft-b']]);
 let tomb=h.savedRows().find(row=>row.id==='draft-b');assert.deepEqual(Object.keys(tomb).sort(),['cancelled','cancelledAt','id']);assert.equal(tomb.cancelled,true);assert(Number.isFinite(tomb.cancelledAt)&&tomb.cancelledAt>0);assert(!h.savedRows().some(row=>row.id==='draft-b'&&row.values),'Cancellation persists only a lightweight tombstone for the removed draft');
 const firstWrites=h.writes.length,firstHistory=JSON.stringify(h.c.history),firstEpoch=h.c.navigationEpoch;assert.equal(h.c.discardDrafts(['draft-b','missing-id']),0);assert.equal(h.writes.length,firstWrites);assert.equal(h.c.navigationEpoch,firstEpoch);assert.equal(JSON.stringify(h.c.history),firstHistory,'Repeated cancellation is idempotent and never creates another history item');
 // A reload adopts persisted cancellation rows before accepting any stale live copy.
 const restored=cancellationHarness();restored.c.draftCancellations.clear();const staleB=JSON.parse(h.draftsBefore).find(row=>row.id==='draft-b');restored.c.drafts=restored.c.adoptDraftRows([...h.savedRows(),staleB]);assert.deepEqual(plain(restored.ids()),['draft-a','draft-c']);assert(restored.c.draftCancellations.has('draft-b'));assert(restored.c.draftCancellations.has('cancelled-before'));
 restored.c.drafts=restored.c.adoptDraftRows([staleB]);assert.equal(restored.c.drafts.length,0,'An already adopted cancellation also blocks later stale live-only updates');
 // All selected active drafts can be cancelled together; completed attempts are unchanged.
 h=cancellationHarness();assert.equal(h.c.discardDrafts(h.ids()),3);assert.equal(h.c.drafts.length,0);assert.equal(h.savedRows().filter(row=>row.cancelled).length,4);assert.equal(JSON.stringify(h.c.history),h.historyBefore);assert.equal(h.c.navigationEpoch,18);
 // Both local storage and the durable cloud-pending wrapper must commit before UI state changes.
 for(const failure of ['storageFailure','queueFailure']){
  h=cancellationHarness();const before=h.stored.get('four.drafts.v2');h.c[failure]=true;assert.equal(h.c.discardDrafts(['draft-a']),false);assert.equal(JSON.stringify(h.c.drafts),h.draftsBefore);assert.equal(JSON.stringify([...h.c.draftCancellations]),h.markersBefore,'Failed persistence rolls back all new tombstones');assert.equal(h.c.navigationEpoch,17);assert.equal(h.stored.get('four.drafts.v2'),before);assert.equal(JSON.stringify(h.c.history),h.historyBefore);assert.equal(h.purged.length,0,'Failed cancellation never starts recording cleanup');
  h.c[failure]=false;assert.equal(h.c.discardDrafts(['draft-a']),1);assert.deepEqual(plain(h.ids()),['draft-b','draft-c']);assert.equal(h.c.navigationEpoch,18);
 }
 // Selecting the current attempt rejects the entire batch, preserving every draft.
 h=cancellationHarness();h.c.session={id:'draft-b',values:{q:'currently active original answer'}};assert.equal(h.c.discardDrafts(['draft-a','draft-b']),0);assert.equal(JSON.stringify(h.c.drafts),h.draftsBefore);assert.equal(JSON.stringify([...h.c.draftCancellations]),h.markersBefore);assert.equal(h.c.navigationEpoch,17);assert.equal(h.writes.length,0);assert.equal(h.c.session.values.q,'currently active original answer');assert(h.messages.length>0);
 // Unknown IDs, stale selections and malformed selection containers must not delete unrelated work.
 h=cancellationHarness();for(const selection of [[],['missing-id'],['completed-only'],[null,undefined,{},''],null,'draft-a'])assert.equal(h.c.discardDrafts(selection),0);assert.equal(h.writes.length,0);assert.equal(h.c.navigationEpoch,17);assert.equal(JSON.stringify(h.c.drafts),h.draftsBefore);assert.equal(JSON.stringify(h.c.history),h.historyBefore);
 assert.equal(h.c.discardDrafts(['missing-id','draft-c']),1);assert.deepEqual(plain(h.ids()),['draft-a','draft-b']);assert.equal(h.c.draftCancellations.has('missing-id'),false,'Only an existing selected draft receives a tombstone');
 // Malformed/legacy rows cannot masquerade as a valid persisted cancellation.
 h=cancellationHarness();h.c.draftCancellations.clear();const valid=plain(h.c.drafts[0]);for(const badAt of [0,-1,NaN,Infinity,'20',undefined]){const rows=h.c.adoptDraftRows([valid,{id:valid.id,cancelled:true,cancelledAt:badAt}]);assert.equal(rows.length,1);assert.equal(rows[0].id,valid.id);assert.equal(h.c.draftCancellations.has(valid.id),false)}assert.equal(h.c.adoptDraftRows(null).length,0);assert.equal(h.c.adoptDraftRows([null,{id:'invalid-bank',queue:['missing-key']}]).length,0);
 console.log('PASS: selected/all draft cancellation persists lightweight tombstones before changing state, refresh hides cancelled drafts, failures roll back, active attempts are protected, history is untouched and repeated/stale cancellations are harmless.');
}

(async()=>{
 // A completed report may already be durable even when the caller's history
 // reference is stale after a partially failed save. Its audio must survive.
 const committed=[{id:'kept-report',finished:100,results:[{id:'speaking-t1:fixture',items:[{id:'q1',answered:true}]}]}],history=[];
 const committedBefore=JSON.stringify(committed),memoryBefore=JSON.stringify(history),deleted=[],revoked=[];
 const fixtures=[['kept-report','q1'],['kept-report','q2'],['discarded-draft','q1'],['discarded-draft','q2'],['discarded-draft_extra','q1'],['unrelated-attempt','q1']].map(([attempt,q])=>({key:attempt+':speaking-t1:fixture:'+q,attempt,blob:'fixture audio '+attempt+' '+q}));
 const recordings=new Map(fixtures.map(row=>[row.key,{...row}])),originalRows=JSON.stringify([...recordings.values()]);let transactions=0;
 const db={transaction(store,mode){
  assert.equal(store,'recordings');assert.equal(mode,'readwrite');transactions++;
  const tx={objectStore(name){assert.equal(name,'recordings');return {openCursor(){
   const req={},rows=[...recordings.values()];let index=0;
   const next=()=>queueMicrotask(()=>{const value=rows[index];req.result=value?{value,delete(){deleted.push(value.key);recordings.delete(value.key)},continue(){index++;next()}}:null;req.onsuccess?.();if(!value)queueMicrotask(()=>tx.oncomplete?.())});
   next();return req;
  }}}};return tx;
 }};
 const recordingUrls=new Map(fixtures.map(row=>[row.key,'blob:'+row.key])),recordingHashes=new Map(fixtures.map(row=>[row.key,'hash:'+row.key])),recordingCloudState=new Map(fixtures.map(row=>[row.key,'synced']));
 const c={JSON,Array,Set,Map,Promise,history,recordingUrls,recordingHashes,recordingCloudState,read(key,fallback){assert.equal(key,'four.history.v1');return committed},audioDB:async()=>db,URL:{revokeObjectURL:url=>revoked.push(url)}};
 vm.createContext(c);vm.runInContext(draftFunction('purgeCancelledRecordings'),c);
 await c.purgeCancelledRecordings(['kept-report','discarded-draft']);
 const discarded=fixtures.filter(row=>row.attempt==='discarded-draft').map(row=>row.key),kept=fixtures.filter(row=>row.attempt!=='discarded-draft');
 assert.equal(transactions,1);assert.deepEqual(deleted.sort(),discarded.slice().sort(),'Only selected unfinished-attempt cursor rows are deleted');assert.deepEqual(revoked.sort(),discarded.map(key=>'blob:'+key).sort());
 assert.deepEqual([...recordings.values()],kept,'Persisted report audio, neighbouring IDs and unrelated audio survive');
 for(const state of [recordingUrls,recordingHashes,recordingCloudState])assert.deepEqual([...state.keys()].sort(),kept.map(row=>row.key).sort(),'Only discarded-attempt URL/cache entries are removed');
 assert.notEqual(JSON.stringify([...recordings.values()]),originalRows);assert.equal(JSON.stringify(committed),committedBefore,'Cleanup never changes durable completed history');assert.equal(JSON.stringify(history),memoryBefore,'Cleanup never changes the caller history reference');
 console.log('PASS: actual recording cleanup preserves durable completed-report audio despite stale memory, removes only discarded drafts from IDB/URLs/caches and leaves all history untouched.');
})().catch(error=>{console.error(error);process.exitCode=1});
