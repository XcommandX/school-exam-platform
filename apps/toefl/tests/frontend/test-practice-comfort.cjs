const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),src=fs.readFileSync(process.env.TOEFL_FRONTEND_SOURCE||'src/frontend/four-app.js','utf8');const c={};vm.createContext(c);for(const name of ['validAssessment','attemptSummary','practicePulse']){let a=src.indexOf('function '+name+'('),b=src.indexOf('\nfunction ',a+1);vm.runInContext(src.slice(a,b),c)}
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
