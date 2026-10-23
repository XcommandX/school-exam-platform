const toeflFrontendRoot = require('node:path').resolve(__dirname, '../../../../front-end/toefl');
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const src=fs.readFileSync(toeflFrontendRoot+'/four-app.js','utf8');
function take(name){let a=src.indexOf('function '+name+'('),b=src.indexOf('\nfunction ',a+1);return (src.slice(a-6,a)==='async '?'async ':'')+src.slice(a,b).replace(/\nasync $/,'')}
function setup(){
 let entries=[],position=-1,saved=[],browserBackCalls=0,events={};
 let c={app:{querySelectorAll:()=>[]},s:{view:'bank',subject:'reading',module:'reading-t1',query:'Coral',page:3,mode:'mock'},session:null,review:null,study:null,history:[],drafts:[],scrollY:240,JSON,Map,Set,URLSearchParams,console,requestAnimationFrame:fn=>fn(),setTimeout:()=>1,clearTimeout(){},events,byKey:new Map([['reading-t1:a',{key:'reading-t1:a',module:'reading-t1',complete:true,duration:60,items:[]}]]),L:{grade:()=>({})},ensureRecords:async()=>true,ensureVocab:async()=>true,stopRecording:async()=>true,persist(){},restoreRecordings(){},toast(){}};
 c.suspendSession=()=>{if(c.session){saved.push(structuredClone(c.session));c.session=null}};
 c.window={PracticeCloud:{userId:'nav-qa'},location:{search:''},addEventListener:(name,fn)=>events[name]=fn,scrollTo:(x,y)=>c.scrollY=y,history:{state:null,replaceState(value){this.state=structuredClone(value);if(position<0){entries.push(this.state);position=0}else entries[position]=this.state},pushState(value){this.state=structuredClone(value);entries.splice(position+1);entries.push(this.state);position=entries.length-1},back(){browserBackCalls++;if(position>0){this.state=entries[--position];events.popstate({state:this.state})}}}};
 for(let [name,view] of [['renderHome','home'],['renderBank','bank'],['renderSets','sets'],['renderLearning','learning'],['renderVocab','vocab'],['renderHistory','history'],['renderReview','review'],['renderExam','exam']])c[name]=()=>{c.s.view=view;vm.runInContext('syncRoute()',c)};
 vm.createContext(c);vm.runInContext(src.slice(src.indexOf('let routeSnapshot='),src.indexOf('function sourceBadges(')),c);
 return {c,entries,saved,get browserBackCalls(){return browserBackCalls}};
}
(async()=>{
 let t=setup(),c=t.c;vm.runInContext('syncRoute();pageEntry=makeEntry("bank",s,240)',c);let entry=vm.runInContext('pageEntry',c);
 c.session={id:'first',entry,values:{a:'retained'}};c.s.view='exam';vm.runInContext('syncRoute()',c);assert.equal(t.entries.length,2);
 c.session=null;c.review={id:'first',entry};c.s.view='review';vm.runInContext('syncRoute()',c);assert.equal(t.entries.length,2,'submission replaces the current exercise instead of stacking another page');
 c.review=null;c.session={id:'second',entry,values:{answer:'draft survives'}};c.s.view='exam';vm.runInContext('syncRoute()',c);assert.equal(t.entries.length,2,'next exercise remains inside the same history slot');
 await c.goBack();assert.equal(c.s.view,'bank');assert.equal(c.s.query,'Coral');assert.equal(c.s.page,3);assert.equal(c.scrollY,240);assert.equal(t.saved.at(-1).values.answer,'draft survives');assert.equal(t.browserBackCalls,0,'in-site Return never invokes browser Back');assert.equal(t.entries.length,2);
 // Native browser Back from a fresh chain reaches its entry, not the preceding question.
 t=setup();c=t.c;vm.runInContext('syncRoute();pageEntry=makeEntry("bank",s)',c);entry=vm.runInContext('pageEntry',c);c.session={id:'one',entry};c.s.view='exam';vm.runInContext('syncRoute()',c);c.session=null;c.review={id:'one',entry};c.s.view='review';vm.runInContext('syncRoute()',c);c.session={id:'two',entry};c.review=null;c.s.view='exam';vm.runInContext('syncRoute()',c);c.window.history.back();await new Promise(setImmediate);assert.equal(c.s.view,'bank');
 // Saved metadata restores purpose-specific entries and still offers a real home exit.
 c.s.view='exam';c.session={id:'daily',dailyTask:{plan:'daily:today'},entry:{view:'learning',state:{ltab:'today'},y:0}};vm.runInContext('pageEntry=session.entry;syncRoute()',c);assert.equal(c.entryLabel(),'返回今日学习');await c.goBack();assert.equal(c.s.view,'learning');assert.equal(c.s.ltab,'today');
 c.s.view='review';c.review={id:'history'};c.session=null;vm.runInContext('pageEntry=makeEntry("history",{hquery:"saved",hpage:2});syncRoute()',c);assert.equal(c.entryLabel(),'返回考试记录');await c.goHome();assert.equal(c.s.view,'home');
 // A browser return into legacy question-by-question history is normalized to an entry.
 c.events.popstate({state:{owner:'nav-qa',depth:1,toeflRoute:{state:{view:'review',subject:'reading',module:'reading-t1',query:'legacy'},attempt:'old',y:0}}});await new Promise(setImmediate);assert.equal(c.s.view,'bank');assert.equal(c.s.query,'legacy');
 // Home cancels an earlier load, preventing a late response from reopening the exercise.
 t=setup();c=t.c;vm.runInContext('syncRoute()',c);vm.runInContext(take('start'),c);c.practiceContext=()=>({module:'reading-t1'});let release;c.ensureRecords=()=>new Promise(resolve=>release=resolve);let pending=c.start(['reading-t1:a']);await c.goHome();release(true);await pending;assert.equal(c.s.view,'home');assert.equal(c.session,null);assert.equal(t.saved.length,0);
 // Failed durable recording saves block an exit instead of losing the current answer.
 c.s.view='exam';c.session={id:'must-stay',values:{answer:'unsaved'}};c.stopRecording=async()=>false;await c.goHome();assert.equal(c.s.view,'exam');assert.equal(c.session.values.answer,'unsaved');
 // Non-leaf Return consistently reaches Home; it must not recall a stale practice entry.
 t=setup();c=t.c;c.s.view='history';vm.runInContext('pageEntry=makeEntry("bank",{query:"old practice"});syncRoute()',c);await c.goBack();assert.equal(c.s.view,'home');
 // Parse only published entry parameters, without applying account or redirect values.
 t=setup();c=t.c;vm.runInContext(take('entryFromUrl'),c);
 const parse=search=>JSON.parse(JSON.stringify(c.entryFromUrl(search)));
 assert.equal(parse(''),null);
 assert.deepEqual(parse('?view=home'),{view:'home',state:{},y:0});
 for(const section of ['reading','listening','speaking','writing']){
  assert.deepEqual(parse('?section='+section),{view:'bank',state:{subject:section,module:section+'-t1',query:'',page:0},y:0});
  assert.equal(parse('?view=practice&section='+section).state.module,section+'-t1');
  assert.equal(parse('?view=mock&section='+section).state.setSubject,section);
  assert.equal(parse('?view=plan&section='+section).state.lsubject,section);
  assert.equal(parse('?view=wrongBook&section='+section).state.lsubject,section);
  for(const view of ['report','history'])assert.equal(parse('?view='+view+'&section='+section).state.hsubject,section);
 }
 assert.deepEqual(parse('?view=mock'),{view:'sets',state:{setSubject:'full'},y:0});
 assert.deepEqual(parse('?view=plan'),{view:'learning',state:{ltab:'today'},y:0});
 assert.deepEqual(parse('?view=wrongBook'),{view:'mistakes',state:{ltab:'review'},y:0});
 for(const view of ['progress','vocab'])assert.equal(parse('?view='+view+'&section=reading').view,view);
 assert.deepEqual(parse('?view=home&section=reading'),{view:'home',state:{},y:0});
 assert.equal(parse('?view=constructor'),null);
 assert.equal(parse('?view=__proto__&section=reading'),null);
 assert.equal(parse('?view=invalid&section=reading'),null);
 assert.equal(parse('?section=math'),null);
 assert.deepEqual(parse('?view=practice&section=listening&username=ignored&token=ignored&returnUrl=https://other.test'),{view:'bank',state:{subject:'listening',module:'listening-t1',query:'',page:0},y:0});
 // Execute the actual startup choice with harmless render stubs: native owner route wins.
 const startIndex=src.indexOf('const initialRoute=window.history.state;'),endIndex=src.indexOf('\n})();',startIndex);
 assert.ok(startIndex>=0&&endIndex>startIndex,'The startup route choice is present.');
 const startup=src.slice(startIndex,endIndex);
 t=setup();c=t.c;vm.runInContext(take('entryFromUrl'),c);c.window.location.search='?view=mock&section=speaking';c.window.history.state={owner:'nav-qa',depth:1,navigationVersion:2,toeflRoute:{state:{view:'history',hsubject:'reading'},y:0}};vm.runInContext(startup,c);await new Promise(setImmediate);assert.equal(c.s.view,'history');assert.equal(c.s.hsubject,'reading');assert.equal(c.s.setSubject,undefined);
 t=setup();c=t.c;vm.runInContext(take('entryFromUrl'),c);c.window.location.search='?view=mock&section=speaking';c.window.history.state={owner:'different-account',toeflRoute:{state:{view:'history',hquery:'must not restore'}}};vm.runInContext(startup,c);await new Promise(setImmediate);assert.equal(c.s.view,'sets');assert.equal(c.s.setSubject,'speaking');assert.notEqual(c.s.hquery,'must not restore');
 t=setup();c=t.c;vm.runInContext(take('entryFromUrl'),c);c.window.location.search='?token=ignored&returnUrl=https://other.test';vm.runInContext(startup,c);assert.equal(c.s.view,'home');
 console.log('PASS: stable entry navigation, native Back and owner-scoped restoration, direct Home, filtered URL entry mapping without auth/redirect forwarding, draft preservation, stale-load cancellation and failed-save exit guard.');
})().catch(e=>{console.error(e);process.exitCode=1});
