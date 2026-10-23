const toeflFrontendRoot = require('node:path').resolve(__dirname, '../../../../front-end/toefl');
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const src=fs.readFileSync(toeflFrontendRoot+'/four-app.js','utf8');
const learningContext={window:{}};vm.createContext(learningContext);vm.runInContext(fs.readFileSync(toeflFrontendRoot+'/four-learning.js','utf8'),learningContext);const Learn=learningContext.window.PracticeLearning;
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

// Regression: revisiting completed oral work must never silently overwrite it.
{
 const row={key:'speaking-t1:saved',module:'speaking-t1',items:[{id:'q1'},{id:'q2'}]};
 let c=context({s:{q:0},guidedRecord:()=>true,session:{heard:{'speaking-t1:saved:q1':true},recorded:{'speaking-t1:saved:q1':true}}},['ensureFlow']);
 let f=c.ensureFlow(row,{id:'q1',audio_url:'fixture.wav'});assert.equal(f.phase,'answer');assert.equal(f.recordingComplete,true);
 c.s.q=1;f=c.ensureFlow(row,{id:'q2',audio_url:'fixture.wav'});assert.equal(f.phase,'ready');assert.equal(f.recordingComplete,false,'new question waits for source audio');
 c=context({s:{q:0},guidedRecord:()=>true,session:{}},['ensureFlow']);f=c.ensureFlow({...row,audioRole:'intro',audio:'intro.wav'},{id:'q1',audio_url:'question.wav'});assert.equal(f.src,'intro.wav');assert.equal(f.questionSrc,'question.wav');assert.equal(f.intro,true,'first question retains task intro before its prompt');
}
// Module-relative numbering includes all materials without counting earlier modules.
{
 const rows=[{key:'a',module:'reading-t1',items:Array(10).fill({})},{key:'b',module:'reading-t2',items:Array(3).fill({})},{key:'c',module:'reading-t3',items:Array(2).fill({})}];
 let c=context({session:{index:1,queue:['a','b','c']},s:{q:1},practiceRecord:k=>rows.find(r=>r.key===k)},['examPosition']);assert.equal(c.examPosition(rows[1]),'Question 12 of 15');
 c.session={...c.session,fullSet:true,section:1,sections:[{start:0,end:1},{start:1,end:3}]};assert.equal(c.examPosition(rows[1]),'Question 2 of 5');
 c.session.index=0;c.session.fullSet=false;assert.equal(c.examPosition(rows[0]),'Questions 1–10 of 15');
}
// Playback progress uses the current segment, rather than the whole source file.
{
 let progress={},elapsed={},c=context({$:id=>id==='#flow-progress'?progress:elapsed},['updateFlowProgress']);c.updateFlowProgress({start:30,end:50},{currentTime:35,duration:100});assert.equal(progress.value,25);assert.equal(elapsed.textContent,'00:05 / 00:20');c.updateFlowProgress({start:30,end:50},{currentTime:99,duration:100});assert.equal(progress.value,100);
}
console.log('PASS: saved oral answers survive revisits; first prompt retains intro; module question numbering; bounded segment playback progress.');
// Waiting for permission must not prevent hearing the source prompt.
(async()=>{
 let a=src.indexOf("else if(a==='flow-play')"),b=src.indexOf("else if(a==='flow-pause')",a),action=src.slice(a+5,b),renders=0;
 let c={a:'flow-play',session:{flow:{oral:true,phase:'ready'}},app:{querySelectorAll:()=>[]},requestMic:()=>new Promise(()=>{}),persist(){},renderExam(){renders++},toast(){}};
 vm.createContext(c);await vm.runInContext('(async()=>{'+action+'})()',c);assert.equal(c.session.flow.phase,'playing');assert.equal(c.session.flow.shouldPlay,true);assert.equal(renders,1);
 console.log('PASS: permission wait cannot block source playback.');
})().catch(e=>{console.error(e);process.exitCode=1});
{
 let c=context({},['questionVisual']);assert(c.questionVisual({visual_asset_url:'images/fixture-scene.svg'}).includes('src="images/fixture-scene.svg"'));assert.equal(c.questionVisual({visual_asset_url:'https://example.test/scene.jpg'}),'');assert.equal(c.questionVisual({visual_asset_url:'images/../secret.svg'}),'');assert.equal(c.questionVisual({visual_asset_url:'images/a.jpg" onerror="x'}),'');
 console.log('PASS: question scenes load controlled local resources only.');
}
{
 let c=context({recorder:null},['flowClockDisplay']);assert.equal(c.flowClockDisplay({oral:true,phase:'answer',recordingComplete:true}).text,'已保存');assert.equal(c.flowClockDisplay({phase:'playing'}).label,'AUDIO');let display=c.flowClockDisplay({phase:'answer',answerUntil:Date.now()+60000});assert.equal(display.label,'RESPONSE TIME');assert.equal(display.text,'01:00');
 console.log('PASS: restored flow clock reflects its current phase immediately.');
}
