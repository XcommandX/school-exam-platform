const toeflFrontendRoot = require('node:path').resolve(__dirname, '../../../../front-end/toefl');
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const src=fs.readFileSync(toeflFrontendRoot+'/four-app.js','utf8');
function take(name){let a=src.indexOf('function '+name+'('),b=src.indexOf('\nfunction ',a+1);return (src.slice(a-6,a)==='async '?'async ':'')+src.slice(a,b)}
(async()=>{
 const tomorrow=Date.now()+86400000;
 let c={wordState:{child:{mastered:false,due:tomorrow,streak:2,interval:3,lastCorrect:true,updated:10},children:{note:'plural',updated:11}}};vm.createContext(c);vm.runInContext(take('wordProgress'),c);
 let p=c.wordProgress({word:'child',forms:['children']});assert.equal(p.due,tomorrow);assert.equal(p.streak,2);assert.equal(p.note,'plural');
 // A generated plan launches its first task once, including rapid duplicate clicks.
 let release,started=[],renders=0;c={navigationEpoch:0,learningRequests:new Map(),s:{},createDailyPlan:()=>new Promise(r=>release=r),renderLearning:()=>renders++,runDailyTask:async id=>started.push(id)};vm.createContext(c);vm.runInContext(take('beginDaily'),c);
 let first=c.beginDaily();await c.beginDaily();release({tasks:[{id:'done',done:1},{id:'next'}]});await first;assert.deepEqual(started,['next']);assert.equal(renders,1);assert.equal(c.learningRequests.size,0);
 // Random groups are scoped to the current filtered pool, clamped to availability,
 // and the group selector does not start a session until explicitly submitted.
 let html='',closed=false,selected={value:'2'},button={isConnected:true},queue;
 let dialog={setAttribute(){},addEventListener(){},querySelector:k=>k==='#random-count'?selected:button,close(){closed=true}};
 c={navigationEpoch:0,s:{count:5,subject:'reading',module:'reading-t1',view:'bank'},names:{reading:'阅读'},modules:{'reading-t1':'补全单词'},esc:x=>x,pool:()=>[{key:'one',complete:true},{key:'two',complete:true},{key:'incomplete',complete:false}],openPanel:(id,h)=>{html=h;return dialog},start:async keys=>{queue=Array.from(keys);c.s.view='exam'}};vm.createContext(c);vm.runInContext(take('openRandomPractice'),c);c.openRandomPractice();assert.equal(queue,undefined);assert(html.includes('2 组'));assert(!html.includes('5 组'));await button.onclick();assert.equal(queue.length,2);assert(!queue.includes('incomplete'));assert.equal(closed,true);
 // Unanswered future reviews remain out of the default review scope, but are
 // available after an explicit switch. Learning navigation preserves its origin.
 let output='';c={navigationEpoch:0,pageEntry:null,searchTimer:null,clearTimeout(){},s:{ltab:'review'},learningQueue:()=>[{record:'r',id:'due',dueNow:true},{record:'r',id:'future',dueNow:false}],byKey:new Map([['r',{title:'Reading',module:'reading-t1'}]]),names:{reading:'阅读'},modules:{'reading-t1':'填词'},learningRow:()=>null,dailyId:()=>'',learningReviewRow:r=>r.id,learningFocus:()=>'',dailyTaskInfo:()=>({detail:''}),dueText:()=>'',esc:x=>x,Learn:{cards:[],inCategory:()=>true},suspendSession(){},haltFlow(){},clearInterval(){},timer:null,shell:h=>output=h};vm.createContext(c);vm.runInContext(take('renderLearning'),c);c.renderLearning();assert(output.includes('1 题'));assert(!output.includes('future'));c.s.lonlydue=false;c.renderLearning();assert(output.includes('2 题'));assert(output.includes('future'));
 assert(src.includes('learningReturn:options.learningReturn'));assert(src.includes('learningReturn:session.learningReturn'));
 console.log('PASS: grouped-word review dates retained; first daily task launches once; random grouping respects scope and availability; due filtering and review return route preserved.');
})().catch(e=>{console.error(e);process.exitCode=1});
