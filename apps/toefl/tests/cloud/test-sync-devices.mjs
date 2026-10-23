import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src=fs.readFileSync(new URL('./cloud-client.js',import.meta.url),'utf8').replace('export async function initializeCloud','async function initializeCloud');
let states=new Map([['four.history.v1',{revision:1,value:[{id:'attempt',ai:{},results:[]}]}],['four.drafts.v2',{revision:1,value:[{id:'draft',values:{a:'old'}}]}]]),network=true;
const json=(d,status=200)=>new Response(JSON.stringify(d),{status});
function device(store=new Map()){
 let events={},applied=[],busy=false;const c={structuredClone,AbortController,AbortSignal,CustomEvent:class{constructor(type,{detail}){this.type=type;this.detail=detail}},setTimeout(){return 1},clearTimeout(){},setInterval(){},BroadcastChannel:class{postMessage(){}},indexedDB:{deleteDatabase(){}},localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)},document:{querySelector(){return null}},window:{addEventListener(k,f){(events[k]||=[]).push(f)},dispatchEvent(e){for(let f of events[e.type]||[])f(e)}},fetch:async(path,init={})=>{if(!network)throw Error('offline');let items=()=>[...states].map(([key,v])=>({key,...structuredClone(v)}));if(path==='/api/bootstrap')return json({me:{id:'test',role:'user'},state:{items:items()}});if(path==='/api/state'&&init.method==='PUT'){let d=JSON.parse(init.body),old=states.get(d.key);if(d.revision!==(old?.revision||0))return json({error:'conflict'},409);let revision=d.revision+1;states.set(d.key,{revision,value:structuredClone(d.value)});return json({revision})}if(path==='/api/state')return json({items:items()});throw Error(path)}};
 vm.createContext(c);vm.runInContext(src,c);let api=c.window.PracticeCloud;api.canApplyState=()=>!busy;c.window.addEventListener('practice-cloud-state',e=>{applied.push(structuredClone(e.detail));api.acceptState(e.detail.key,e.detail.value)});
 return {c,api,store,applied,set busy(v){busy=v},async init(){await vm.runInContext('initializeCloud()',c)},async flush(){await vm.runInContext('flush()',c)}}
}
let A=device(),B=device();await A.init();await B.init();
A.api.queue('four.history.v1',[{id:'attempt',ai:{r:{q1:{score:4}}},results:[]}]);await A.flush();
B.api.queue('four.history.v1',[{id:'attempt',ai:{r:{q2:{score:3}}},results:[]}]);await B.flush();
let h=states.get('four.history.v1').value;assert.equal(h.length,1,'independent per-question grading must merge without duplicate attempts');assert.equal(h[0].ai.r.q1.score,4);assert.equal(h[0].ai.r.q2.score,3);
await A.api.refresh(true);assert.equal(A.applied.at(-1).value[0].ai.r.q2.score,3,'remote progress must reach the current view');
A.busy=true;states.get('four.history.v1').value.push({id:'remote-new'});states.get('four.history.v1').revision++;let n=A.applied.length;await A.api.refresh(true);assert.equal(A.applied.length,n,'never replace an active answer');A.busy=false;await A.api.refresh(true);assert(A.applied.at(-1).value.some(x=>x.id==='remote-new'));
network=false;A.api.queue('four.drafts.v2',[]);await A.flush();assert(A.store.has('account.test.cloud.base.four.drafts.v2'));network=true;
let afterReload=device(A.store);await afterReload.init();await afterReload.flush();assert.deepEqual(states.get('four.drafts.v2').value,[],'offline draft deletion must survive reload and not resurrect');assert(!A.store.has('account.test.cloud.pending.four.drafts.v2'));
// Distinct note and mastery changes should both survive.
let merge=(...args)=>{A.c.args=args;return vm.runInContext('merge(...args)',A.c)};
let word=merge('four.words.v1',{test:{note:'new',mastered:false}},{test:{note:'old',mastered:true}},{test:{note:'old',mastered:false}});assert.equal(word.test.note,'new');assert.equal(word.test.mastered,true);
// Acknowledging one tab must not erase a newer pending write from another tab.
let shared=new Map(),T1=device(shared),T2=device(shared);await T1.init();await T2.init();let originalFetch=T1.c.fetch,releasePut;T1.c.fetch=async(path,init)=>{if(path==='/api/state'&&init?.method==='PUT')await new Promise(resolve=>releasePut=resolve);return originalFetch(path,init)};
T1.api.queue('four.learning.v1',[{id:'first-tab'}]);let sending=T1.flush();await new Promise(setImmediate);T2.api.queue('four.learning.v1',[{id:'second-tab'}]);releasePut();await sending;assert(shared.get('account.test.cloud.pending.four.learning.v1').includes('second-tab'),'one tab cannot acknowledge the other tab pending data');await T2.flush();assert(states.get('four.learning.v1').value.some(x=>x.id==='first-tab'));assert(states.get('four.learning.v1').value.some(x=>x.id==='second-tab'));

// One device cancels while another edits the same draft. A third device has an
// older active copy queued offline and must not revive it after reloading.
const activeDraft={id:'cancelled-draft',values:{answer:'original'}},otherDraft={id:'unrelated-draft',values:{answer:'original'}};
states.set('four.drafts.v2',{revision:1,value:[activeDraft,otherDraft]});
const Canceller=device(),Editor=device(),Offline=device();await Canceller.init();await Editor.init();await Offline.init();
network=false;
Offline.api.queue('four.drafts.v2',[{...activeDraft,values:{answer:'stale offline edit'}},otherDraft]);await Offline.flush();
assert(Offline.store.has('account.test.cloud.pending.four.drafts.v2'),'the offline active copy must really be pending before cancellation');
network=true;
const remoteOther={...otherDraft,values:{answer:'independent remote edit'}};
Editor.api.queue('four.drafts.v2',[{...activeDraft,values:{answer:'concurrent remote edit'}},remoteOther]);await Editor.flush();
Canceller.api.queue('four.drafts.v2',[{...activeDraft,cancelled:true,cancelledAt:1700000000000,recordings:['discarded-audio']},otherDraft]);await Canceller.flush();
function assertCancelledDrafts(value,label){
 assert.equal(value.length,2,label+': do not keep an active conflict copy');
 const tombstone=value.find(item=>item.id===activeDraft.id);
 assert(tombstone,label+': keep a tombstone for the cancelled draft');
 assert.equal(tombstone.cancelled,true,label);
 assert.deepEqual(Object.keys(tombstone).sort(),['cancelled','cancelledAt','id'],label+': discard answer and recording payloads');
 assert(Number.isFinite(tombstone.cancelledAt)&&tombstone.cancelledAt>0,label+': keep a valid cancellation timestamp');
 assert(!value.some(item=>item.conflictCopy),label+': do not preserve the edited draft as a conflict');
 assert.deepEqual(value.find(item=>item.id===otherDraft.id),remoteOther,label+': preserve an unrelated draft and its edit');
}
assertCancelledDrafts(states.get('four.drafts.v2').value,'concurrent cancellation');
const ReloadedOffline=device(Offline.store);await ReloadedOffline.init();
assertCancelledDrafts(JSON.parse(ReloadedOffline.store.get('account.test.four.drafts.v2')),'offline reload');
await ReloadedOffline.flush();
assertCancelledDrafts(states.get('four.drafts.v2').value,'stale active copy resynchronization');
assert(!Offline.store.has('account.test.cloud.pending.four.drafts.v2'),'the stale write must finish syncing rather than remain silently pending');
await Editor.api.refresh(true);
assertCancelledDrafts(JSON.parse(Editor.store.get('account.test.four.drafts.v2')),'previous editor refresh');
console.log('PASS: concurrent draft cancellation and stale offline resynchronization retain lightweight tombstones and preserve unrelated drafts.');
console.log('PASS: two-device nested scores, current-view refresh, active-edit protection, offline deletion across reload and independent vocabulary fields.');

// A server may remove a late cancelled attempt or normalize a tombstone. Its
// acknowledged value, rather than our sent value, becomes the local baseline.
const Normalized=device();await Normalized.init();let normalFetch=Normalized.c.fetch;
Normalized.c.fetch=async(path,init={})=>{if(path==='/api/state'&&init.method==='PUT'){let d=JSON.parse(init.body);if(d.key==='four.history.v1'){d.value=d.value.filter(x=>x.id!=='server-rejected-attempt');let r=await normalFetch(path,{...init,body:JSON.stringify(d)});return json({...await r.json(),value:d.value},r.status)}}return normalFetch(path,init)};
Normalized.api.queue('four.history.v1',[{id:'server-rejected-attempt',results:[]}]);await Normalized.flush();assert.deepEqual(JSON.parse(Normalized.store.get('account.test.four.history.v1')),[]);assert(!Normalized.store.has('account.test.cloud.pending.four.history.v1'),'a normalized acknowledgement clears the acknowledged pending write');
// An edit queued while a normalized acknowledgement is arriving must survive.
let responseReady,continueResponse,putCount=0;const responsePaused=new Promise(resolve=>responseReady=resolve);const initialNormalizedFetch=Normalized.c.fetch;
Normalized.c.fetch=async(path,init={})=>{let r=await initialNormalizedFetch(path,init);if(path==='/api/state'&&init.method==='PUT'&&++putCount===1){responseReady();await new Promise(resolve=>continueResponse=resolve)}return r};
Normalized.api.queue('four.history.v1',[{id:'server-rejected-attempt'}]);const normalizing=Normalized.flush();await responsePaused;Normalized.api.queue('four.history.v1',[{id:'newer-local-edit',results:[]}]);continueResponse();await normalizing;
assert(JSON.parse(Normalized.store.get('account.test.four.history.v1')).some(x=>x.id==='newer-local-edit'),'server normalization must not overwrite a newer pending edit');assert(!Normalized.store.has('account.test.cloud.pending.four.history.v1'));assert(!states.get('four.history.v1').value.some(x=>x.id==='server-rejected-attempt'));
console.log('PASS: normalized server values are applied and acknowledged without losing newer pending edits.');
