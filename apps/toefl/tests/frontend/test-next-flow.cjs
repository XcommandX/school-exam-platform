const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const src=fs.readFileSync('src/frontend/four-app.js','utf8');
const learningContext={window:{}};vm.createContext(learningContext);vm.runInContext(fs.readFileSync('src/frontend/four-learning.js','utf8'),learningContext);const Learn=learningContext.window.PracticeLearning;
function take(name){let a=src.indexOf('function '+name+'('),b=src.indexOf('\nfunction ',a+1),async=src.slice(a-6,a)==='async ';if(b<0)b=src.length;return (async?'async ':'')+src.slice(a,b).replace(/\nasync $/,'')}
function context(values,names){let c={esc:x=>String(x??''),history:[],Learn,...values};vm.createContext(c);for(let n of names)vm.runInContext(take(n),c);return c}
(async()=>{
 let r={key:'r',module:'writing-t1',items:[{id:'q1'},{id:'q2'}]},c=context({session:{index:0,queue:['r']},s:{q:0},recorder:null,recordStarting:null},['examNavigation']);
 let html=c.examNavigation(r,null);assert(html.includes('data-a="next" class="primary"'));assert(!html.includes('data-a="finish" class="primary"'));c.s.q=1;html=c.examNavigation(r,null);assert(html.includes('data-a="finish" class="primary"'));assert(!html.includes('data-a="next"'));
 c.s.q=0;html=c.examNavigation(r,{phase:'playing'});assert(!html.includes('class="primary"'),'waiting for audio has no competing navigation action');
 c.recorder={stopping:true};html=c.examNavigation(r,{phase:'answer',oral:true});assert(html.includes('class="primary" disabled'),'recording must save before navigation');
 c.session={index:0,queue:['r','second'],fullSet:true,section:0,sections:[{start:0,end:1},{start:1,end:2}]};c.s.q=1;c.recorder=null;assert(c.examNavigation(r,null).includes('提交本模块'));
 let rows=['a','b','c'].map(key=>({key,module:'reading-t1',complete:true}));c=context({s:{},byKey:new Map(rows.map(r=>[r.key,r])),practiceContext:()=>({module:'reading-t1'}),pool:scope=>scope.mastery==='all'?rows:[rows[2]]},['nextMaterial']);
 assert.equal(c.nextMaterial('b',{module:'reading-t1'}).key,'c','mastered current material can disappear from eligible pool without resetting its position');assert.equal(c.nextMaterial('c',{module:'reading-t1'}),null,'last material must not wrap to the beginning');
 let record={key:'r',module:'reading-t1',title:'Material',items:[{id:'q1'},{id:'q2'}]},plan={id:'daily:yesterday',tasks:[{id:'first',done:1},{id:'second'}]};
 c=context({study:null,review:{dailyTask:{plan:plan.id}},s:{},learningRow:()=>plan,dailyTaskInfo:()=>({title:'Next task'}),byKey:new Map([['r',record]]),nextMaterial:()=>null},['reviewContinuation']);
 assert.equal(c.reviewContinuation().plan,'daily:yesterday');assert.equal(c.reviewContinuation().label,'下一项练习');plan.tasks[1].done=1;assert.equal(c.reviewContinuation().label,'完成今日学习');
 c.review={learningReturn:'review',results:[{id:'r',items:[{id:'q1'}]}]};c.learningQueue=()=>[{record:'r',qid:'q1',dueNow:true},{record:'r',qid:'q2',dueNow:true}];assert.equal(c.reviewContinuation().qid,'q2');c.learningQueue=()=>[{record:'r',qid:'q1',dueNow:true}];assert.equal(c.reviewContinuation().kind,'review-done','a just-answered mistake must not immediately repeat');
 c.review={queue:['r'],focusItems:{r:['q1']}};assert.equal(c.reviewContinuation().qid,'q2');c.review={preview:true};assert.equal(c.reviewContinuation().kind,'sets');
 let launched=[];c=context({learningRow:id=>id===plan.id?{...plan,tasks:[{id:'next'}]}:null,runDailyTask:async(...args)=>launched.push(args),s:{},renderLearning(){},toast(){}},['continueDailyPlan']);await c.continueDailyPlan(plan.id);assert.deepEqual(launched,[['next',plan.id]],'next daily task keeps its original plan instead of switching at midnight');
 // Answer review has one forward action even while showing a longer exam.
 c=context({s:{reviewIndex:0},reviewContinuation:()=>({label:'完成'} )},['reviewNavigation']);html=c.reviewNavigation([{r:record},{r:record}]);assert.equal((html.match(/class="primary"/g)||[]).length,1);assert(html.includes('下一题解析'));
 c=context({reviewItems:r=>r.items.map((q,i)=>({q,i}))},['reviewEntries']);assert.equal(c.reviewEntries([{...record,items:[{id:'q1'},{id:'q2'}]}]).length,1,'a fill passage is reviewed as one material');assert.equal(c.reviewEntries([{...record,module:'listening-t1'}]).length,2,'listening answers remain sequential questions');
 console.log('PASS: contextual next/submit actions; audio and recording-save guards; filtered material order without wraparound; daily and review continuation without repeating answered items; midnight-safe task plans; one primary review action.');
})().catch(e=>{console.error(e);process.exitCode=1});
