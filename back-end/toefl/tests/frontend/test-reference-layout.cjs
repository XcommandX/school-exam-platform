const toeflFrontendRoot = require('node:path').resolve(__dirname, '../../../../front-end/toefl');
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const app=fs.readFileSync(toeflFrontendRoot+'/four-app.js','utf8'),c={window:{}};vm.createContext(c);vm.runInContext(fs.readFileSync(toeflFrontendRoot+'/four-learning.js','utf8'),c);const Learn=c.window.PracticeLearning;
assert(Learn.inCategory({lastMiss:100},'wrong'));assert(!Learn.inCategory({lastMiss:100},'unfamiliar'));
assert(Learn.inCategory({unfamiliar:true},'unfamiliar'));assert(!Learn.inCategory({unfamiliar:true},'wrong'));
assert(Learn.inCategory({lastMiss:100,unfamiliar:true},'wrong'));assert(Learn.inCategory({lastMiss:100,unfamiliar:true},'unfamiliar'));
assert(!Learn.inCategory({lastMiss:100,unfamiliar:false},'unfamiliar'));
assert(Learn.inCategory({due:100},'unfamiliar'),'legacy manually added questions keep their category');
function take(name){let a=app.indexOf('function '+name+'(');return app.slice(a,Math.min(...[app.indexOf('\nfunction ',a+10),app.indexOf('\nasync function ',a+10)].filter(x=>x>=0)))}
const r={key:'r',module:'reading-t1',items:[{id:'a'},{id:'b'}]},other={key:'other',module:'reading-t2',items:[{id:'c'}]};
const x={session:{fullSet:true,section:0,sections:[{start:0,end:1},{start:1,end:2}],queue:['r','other'],index:0},s:{q:0},practiceRecord:k=>k==='r'?r:other,questionAnswered:(r,q)=>q.id==='a'};vm.createContext(x);vm.runInContext(take('examOverview'),x);
let html=x.examOverview(null);assert.equal((html.match(/data-a="exam-jump"/g)||[]).length,2,'Review cannot jump into another module');assert(!html.includes('data-record-index="1"'));assert(html.includes('已作答'));x.session.deadline=1;assert.equal(x.examOverview({phase:'answer'}),'','timed listening/speaking cannot revisit earlier questions');
console.log('PASS: independent mistake categories, legacy manual markers, module-bound Review navigation and forward-only audio flow.');
