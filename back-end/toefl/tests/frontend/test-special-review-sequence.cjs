const toeflFrontendRoot = require('node:path').resolve(__dirname, '../../../../front-end/toefl');
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const app=fs.readFileSync(toeflFrontendRoot+'/four-app.js','utf8');
const context={window:{}};vm.createContext(context);vm.runInContext(fs.readFileSync(toeflFrontendRoot+'/four-learning.js','utf8'),context);
const Learn=context.window.PracticeLearning,now=Date.now();
const record={key:'writing-t1:fixture',id:'fixture',group:'fixture-group',module:'writing-t1',items:[{id:'source-alpha'},{id:'source-beta'},{id:'source-gamma'}]};
const wrong=id=>({id,correct:false,answered:true,response:'wrong'});
const initial={id:'original',finished:now-2000,results:[{id:record.key,items:record.items.map(q=>wrong(q.id))}]};
const retry={id:'retry-beta',finished:now-1000,focusItems:{[record.key]:['source-beta']},results:[{id:record.key,items:[wrong('source-beta')]}]};
for(const catalog of [new Map([[record.key,record]]),new Map([[record.key,{...record,items:undefined}]])]){
 const rows=Learn.queue([initial,retry],catalog,[],now);
 assert.equal(rows.length,3);
 assert.equal(new Set(rows.map(x=>x.qid)).size,3,'a focused retry must not overwrite the first question or duplicate the retried question');
 assert.equal(rows.find(x=>x.qid==='source-beta').id,'review:writing-t1:fixture-group:1');
}
function take(name){const start=app.indexOf('function '+name+'(');assert(start>=0,name);const ends=[app.indexOf('\nfunction ',start+10),app.indexOf('\nasync function ',start+10)].filter(x=>x>=0);return app.slice(start,Math.min(...ends));}
const display={byKey:new Map([[record.key,record]]),session:{queue:[record.key],index:0,focusItems:{[record.key]:['source-beta']}},practiceRecord:()=>({...record,items:[record.items[1]]}),questionAnswered:()=>false};
vm.createContext(display);vm.runInContext(take('sourceQuestionNumber')+'\n'+take('answerProgress'),display);
assert(display.answerProgress().includes('原题第 2 题'),'focused review identifies its source question instead of presenting every task as the first question');
display.Learn=Learn;vm.runInContext(take('dueText'),display);
assert.match(display.dueText({due:Date.now()+600000}),/分钟后复习/,'a ten-minute retry must not be described as tomorrow');
assert.match(display.dueText({due:Date.now()+7200000}),/小时后复习/);
const round={id:'round-fixture',subject:'writing',onlyDue:true};
const rows=record.items.map((q,i)=>({id:'review:'+Learn.identity(record,q,i),record:record.key,qid:q.id,dueNow:true}));
const c={study:null,s:{lsubject:'writing'},history:[{reviewRound:{...round,completed:[rows[0].id]}}],review:{id:'current',learningReturn:'review',reviewRound:{...round,completed:[rows[1].id]},results:[{id:record.key,items:[wrong('source-beta')]}]},byKey:new Map([[record.key,record]]),learningQueue:()=>rows,Learn};
vm.createContext(c);vm.runInContext(take('reviewContinuation'),c);
assert.equal(c.reviewContinuation().qid,'source-gamma','next review must skip all questions visited in this round, including incorrect ones');
c.history.push({reviewRound:{...round,completed:[rows[2].id]}});
assert.equal(c.reviewContinuation().kind,'review-done','a finite review round must end instead of looping back to its first question');
c.history=[];c.review={...c.review,reviewRound:{...round,onlyDue:false}};c.learningQueue=()=>[{...rows[2],dueNow:false}];
assert.equal(c.reviewContinuation().qid,'source-gamma','explicit all-review mode also advances through not-yet-due questions');
let stored=[];const track={byKey:new Map([[record.key,record]]),Learn,learningRow:()=>null,putLearning:row=>stored.push(row)};
vm.createContext(track);vm.runInContext(take('trackLearning'),track);track.trackLearning(retry);
assert.equal(stored[0].due,retry.finished+600000,'an incorrect focused review is scheduled later instead of becoming immediately due');
assert.equal(stored[0].lastReviewed,retry.finished);
for(const catalog of [new Map([[record.key,record]]),new Map([[record.key,{...record,items:undefined}]])]){
 const scheduled=Learn.queue([initial,retry],catalog,stored,now);
 assert.equal(scheduled.find(row=>row.qid==='source-beta').dueNow,false);
 assert.equal(scheduled.filter(row=>row.dueNow).length,2);
 const corrupted={...stored[0],id:'review:writing-t1:fixture-group:0'};
 const repaired=Learn.queue([initial,retry],catalog,[corrupted],now);
 assert.equal(new Set(repaired.map(row=>row.qid)).size,3,'old position collisions are repaired from full history without deleting another question');
 assert.equal(repaired.find(row=>row.qid==='source-beta').due,stored[0].due);
}
console.log('PASS: source-position identities, cold-catalog retries, finite review rounds, explicit review scope and delayed wrong-answer retry.');
