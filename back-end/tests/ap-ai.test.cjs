'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');
const M = require('../../front-end/ap/ap-model.js');
const ui = fs.readFileSync(require('node:path').resolve(__dirname, '../../front-end/ap/app.js'), 'utf8');
const expected = {sourceId:'ap:test',revision:'a'.repeat(64),questionId:'ap:test:q001',responseHash:'b'.repeat(64),questionType:'argument'};
function result() {return {...expected,version:M.AI_VERSION,status:'scored',rows:{thesis:{score:1,reason:'<img onerror=alert(1)>',evidence:['quote']},evidenceCommentary:{score:3,reason:'reason',evidence:[]},sophistication:{score:0,reason:'reason',evidence:[]}},total:4,feedback:'feedback',strengths:[],improvements:['improve'],limitations:[],createdAt:new Date().toISOString()};}
test('AP rubric validates integer 1+4+1, identity, bounds and limited non-scores', () => {
  assert.equal(M.validateAssessment(result(),expected).total,4);
  for (const mutate of [r=>r.total=5,r=>r.rows.thesis.score=2,r=>r.rows.evidenceCommentary.score=2.5,r=>r.responseHash='c'.repeat(64),r=>r.revision='c'.repeat(64),r=>r.questionType='synthesis',r=>r.feedback='x'.repeat(12001),r=>r.version='toefl']) {const r=result();mutate(r);assert.throws(()=>M.validateAssessment(r,expected));}
  const limited={...result(),status:'limited',rows:null,total:null}; assert.equal(M.validateAssessment(limited,expected).total,null);
  assert.throws(()=>M.validateAssessment({...limited,total:0},expected));
});
class Node {constructor(tag,attrs={},children=[]) {this.tag=tag;Object.assign(this,attrs);this.children=children.flat().filter(x=>x!=null);this.isConnected=true;this.textContent='';} append(...xs){this.children.push(...xs);} replaceChildren(...xs){this.children=xs;} }
function harness({consent=true,enabled=true,post}={}) {
 let alive=true;const calls=[];const state={request:1,view:'review'};const requests=new Set();
 const element=(tag,attrs,...children)=>new Node(tag,attrs,children);
 const context={state,active:()=>alive,M,crypto:webcrypto,TextEncoder,AbortController,setTimeout,clearTimeout,Blob,URL,
  window:{confirm:()=>consent},document:{body:new Node('body')},aiRequests:requests,
  element,button:(label,fn,style,attrs)=>new Node('button',{...attrs,fn},[label]),actions:(...x)=>new Node('actions',{},x),muted:x=>new Node('p',{},[x]),prose:x=>new Node('p',{},[x]),
  getJSON:async()=>({enabled,version:M.AI_VERSION,scoreMin:0,scoreMax:6,scoreStep:1,limits:{responseCharacters:18000}}),
  auth:{api:async(path,options)=>{calls.push({path,options});return post?post(options):{...result(),responseHash:Buffer.from(await webcrypto.subtle.digest('SHA-256',new TextEncoder().encode('essay'))).toString('hex')};}}
 };
 vm.createContext(context);vm.runInContext(ui.slice(ui.indexOf('  function assessmentPanel('),ui.indexOf('  function showDrafts()')),context);
 const record={id:'attempt',answers:{[expected.questionId]:'essay'}};
 const box=context.assessmentPanel({id:expected.sourceId,revision:expected.revision},{id:expected.questionId,responseType:'argument',number:1},record,'essay');
 return {box,calls,state,record,requests,stop:()=>{alive=false;},run:box.children[0].children[0],cancel:box.children[0].children[1],status:box.children[1],output:box.children[3]};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('explicit consent required; config alone never submits and refusal preserves answer', async()=>{const h=harness({consent:false});await flush();assert.equal(h.calls.length,0);await h.run.fn();assert.equal(h.calls.length,0);assert.equal(h.record.answers[expected.questionId],'essay');});
test('completed review request and output are bound to exact essay with plain text rendering',async()=>{const h=harness();await flush();await h.run.fn();assert.equal(h.calls.length,1);assert.equal(h.calls[0].options.body.consent,true);assert.equal(h.calls[0].options.body.attemptId,'attempt');assert.match(h.status.textContent,/4 \/ 6/);assert.ok(h.output.children.some(x=>x.children.includes('<img onerror=alert(1)>')));assert.doesNotMatch(ui,/innerHTML|insertAdjacentHTML/);});
test('disabled config, navigation and account change suppress requests/results',async()=>{
 const disabled=harness({enabled:false});await flush();await disabled.run.fn();assert.equal(disabled.calls.length,0);
 for (const invalidate of [h=>h.stop(),h=>h.state.request++,h=>h.record.answers[expected.questionId]='edited']) {
 let release;const h=harness({post:()=>new Promise(r=>release=r)});await flush();const running=h.run.fn();while(!release) await flush();invalidate(h);release(result());await running;assert.equal(h.output.children.length,0);
 }
});
test('limited responses never display numeric score and errors/cancel keep essay',async()=>{
 const h=harness({post:async()=>{const r=result();r.responseHash=Buffer.from(await webcrypto.subtle.digest('SHA-256',new TextEncoder().encode('essay'))).toString('hex');return {...r,status:'limited',rows:null,total:null};}});await flush();await h.run.fn();assert.match(h.status.textContent,/未评分/);
 const error=harness({post:()=>{throw Object.assign(new Error('quota'),{status:429});}});await flush();await error.run.fn();assert.match(error.status.textContent,/额度/);assert.equal(error.record.answers[expected.questionId],'essay');
 let release;const cancel=harness({post:()=>new Promise(r=>release=r)});await flush();const running=cancel.run.fn();while(!release) await flush();cancel.cancel.fn();release(result());await running;assert.equal(cancel.output.children.length,0);assert.equal(cancel.record.answers[expected.questionId],'essay');
});
test('only completed review attaches assessment; history storage changes and ended sessions revoke it',()=>{assert.match(ui,/false, record\)\)/);assert.match(ui,/record && q\.type === 'free-response'/);assert.match(ui,/function setView\(view\) \{\s*abortAssessments/);assert.match(ui,/platform:session-ended', \(\) => \{\s*abortAssessments/);assert.match(ui,/event\.key === null \|\| event\.key === storageKeys\.history/);});
