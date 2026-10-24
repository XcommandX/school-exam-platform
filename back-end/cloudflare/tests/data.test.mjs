import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {AccountStore} from '../src/data.mjs';
import {ProjectedJSON} from '../src/json-stream.mjs';
import {satProjection,validateSAT} from '../src/validation.mjs';
function storage(){const db=new DatabaseSync(':memory:');return {sql:{exec(query,...args){if(query.includes(';\n')){db.exec(query);return [];}return db.prepare(query).all(...args);}},transactionSync(fn){db.exec('BEGIN');try{const value=fn();db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}}};}
const req=body=>new Request('https://local',{method:'PUT',body:JSON.stringify(body)});
function attempt(id='a',extra={}){return {id,practiceName:'合成练习',status:'completed',completedAt:1,totalQuestions:1,questionIds:['q1'],questionSnapshots:[{id:'q1',section:'math',text:'合成题目'}],answers:{q1:{answered:true,correctness:true}},correctCount:1,incorrectCount:0,unansweredCount:0,ungradedCount:0,...extra};}
const change=(value,mutationId='m1',revision=0)=>({value,mutationId,revision});
const failsCode=code=>error=>error.code===code;
test('account binding prevents accidental cross-account routing',()=>{const store=new AccountStore(storage());store.bind('a');assert.throws(()=>store.bind('b'),failsCode('account_mismatch'));});
test('SAT streamed snapshot roundtrip, idempotency and immutability',async()=>{
  const store=new AccountStore(storage());const value=attempt();
  assert.equal((await (await store.putSAT('attempts','a',req(change(value)))).json()).revision,1);
  assert.deepEqual((await store.get('attempts','a').json()).value,value);
  assert.equal((await (await store.putSAT('attempts','a',req(change(value)))).json()).revision,1);
  await assert.rejects(()=>store.putSAT('attempts','a',req(change({...value,practiceName:'new'}))),failsCode('mutation_reused'));
  const reordered=Object.fromEntries(Object.entries(value).reverse());
  assert.equal((await(await store.putSAT('attempts','a',req(change(reordered,'m2',1)))).json()).revision,1);
  await assert.rejects(()=>store.putSAT('attempts','a',req(change({...value,practiceName:'new'},'m3',1))),failsCode('attempt_completed'));
});
test('SAT compare-and-swap, deletion tombstones and explicit wrong-book restore',async()=>{
  const store=new AccountStore(storage());
  await store.putSAT('attempts','a',req(change(attempt())));
  await assert.rejects(()=>store.putSAT('attempts','a',req(change(attempt(),'m2',0))),failsCode('revision_conflict'));
  await store.putSAT('attempts','a',req({revision:1,deleted:true,mutationId:'delete'}));
  assert.equal((await store.get('attempts','a').json()).deleted,true);
  await assert.rejects(()=>store.putSAT('attempts','a',req(change(attempt(),'m3',2))),failsCode('entity_deleted'));
  const wrong={questionId:'q1',addedAt:1,reason:'manual',questionSnapshot:{id:'q1',content:'sample'}};
  await store.putSAT('wrong-book','q1',req(change(wrong)));
  await store.putSAT('wrong-book','q1',req({revision:1,deleted:true,mutationId:'del'}));
  await assert.rejects(()=>store.putSAT('wrong-book','q1',req(change(wrong,'m2',2))),failsCode('entity_deleted'));
  await store.putSAT('wrong-book','q1',req({...change(wrong,'m3',2),restore:true}));
  assert.equal((await store.get('wrong-book','q1').json()).deleted,false);
});
test('atomic commit re-verifies session and abandoned uploads are removed',async()=>{
  const store=new AccountStore(storage());
  await assert.rejects(()=>store.putSAT('attempts','a',req(change(attempt())),async()=>{throw new Error('session revoked');}));
  assert.equal(store.one('SELECT COUNT(*) AS n FROM chunks').n,0);assert.equal(store.row('attempts','a'),undefined);
});
test('64MiB-class snapshot streams in 256KiB rows without materializing content',async()=>{
  const store=new AccountStore(storage());
  const base=JSON.stringify(change(attempt('big',{questionSnapshots:[{id:'q1',section:'math',image:'MARKER'}]})));
  const [before,after]=base.split('MARKER');let stage=0,count=0;
  const body=new ReadableStream({pull(controller){if(stage===0){controller.enqueue(Buffer.from(before));stage=1;}else if(count++<248)controller.enqueue(Buffer.alloc(256*1024,97));else if(stage===1){controller.enqueue(Buffer.from(after));stage=2;}else controller.close();}});
  const response=await store.putSAT('attempts','big',new Request('https://local',{method:'PUT',body,duplex:'half'}));
  assert.equal(response.status,200);assert.ok(store.one('SELECT MAX(length(body)) AS n FROM chunks').n<=256*1024);
  const parser=new ProjectedJSON({select:satProjection});for await(const bytes of store.get('attempts','big').body)parser.write(bytes);
  assert.equal(parser.end().value.id,'big');assert.ok(store.row('attempts','big').size>60*1024*1024);
});
test('home settings normalize scores and return conflict data',async()=>{
  const store=new AccountStore(storage());
  const body={revision:0,value:{targets:{sat:{english:700,math:710,total:0},toefl:{reading:5,listening:5,speaking:4,writing:4}}}};
  const saved=await(await store.putState('home',req(body))).json();assert.equal(saved.value.targets.sat.total,1410);assert.equal(saved.value.targets.toefl.total,4.5);
  const conflict=await store.putState('home',req(body));assert.equal(conflict.status,409);assert.deepEqual((await conflict.json()).value,saved.value);
});
test('TOEFL cancellation markers survive stale writes and block resurrected history',async()=>{
  const store=new AccountStore(storage());
  const put=(key,value,revision)=>store.putState('toefl',req({key,value,revision}));
  await put('four.drafts.v2',[{id:'draft-1',cancelled:true,cancelledAt:1}],0);
  await put('four.drafts.v2',[{id:'draft-1',answers:'stale'}],1);
  await put('four.history.v1',[{id:'draft-1',answers:'stale'}],0);
  const state=Object.fromEntries((await store.state('toefl').json()).items.map(item=>[item.key,item]));assert.equal(state['four.drafts.v2'].value[0].cancelled,true);assert.deepEqual(state['four.history.v1'].value,[]);
});
test('state chunks support values larger than two MB',async()=>{
  const store=new AccountStore(storage());const value={test:'x'.repeat(3*1024*1024)};
  await store.putState('toefl',req({key:'four.words.v1',revision:0,value}));
  assert.deepEqual((await store.state('toefl').json()).items[0].value,value);
});
test('validating projection retains recovery identities but no question content',()=>{
  const value=attempt('r',{status:'incomplete',resumable:true,completedAt:undefined,runtimeSnapshot:{activePractice:{id:'r',questionIds:['q1'],extra:'ignored'},questionStates:[{note:'ignored'}],currentQuestion:0}});
  const p=new ProjectedJSON({select:satProjection});p.write(Buffer.from(JSON.stringify(change(value))));const body=p.end();
  assert.equal(body.value.questionSnapshots[0].text,undefined);validateSAT('attempts','r',body,1000);
});
