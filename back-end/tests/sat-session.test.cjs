'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const SATPack = require('../../front-end/sat/js/sat-pack.js');
const scope = {window:{},SATPack,SATModel:{clampDuration:value => Math.max(60,Math.min(3840,Math.round(Number(value)||60)))}};
vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../../front-end/sat/js/sat-session.js'),'utf8'),scope);
const SATSession = scope.window.SATSession;
const plain = value => JSON.parse(JSON.stringify(value));
const rw = id => ({id,section:'Reading and Writing',options:['a','b','c','d'],correctOption:1});
const math = id => ({id,section:'Math',options:['a','b','c','d'],correctOption:2});
const spr = () => ({id:'spr',section:'Math',responseType:'student-produced-response',options:[],correctOption:null,packContent:{},
  inputProfile:{id:'sat-spr-input/0.1-draft',status:'requires-rule-review',maxNonnegativeCharacters:5,maxNegativeCharacters:6,allowedForms:['integer','decimal','fraction'],allowMixedNumber:false},
  answerRule:{status:'verified',type:'student-produced-response',comparison:'exact-rational-or-listed-decimal',acceptedRationals:['2/3'],acceptedDecimalSpellings:['.6666','.6667','0.666','0.667']}});

test('complete source preserves declared module question counts and durations', () => {
  const questions = Array.from({length:7},(_,i) => ({...rw('r'+i),metadata:{sourceId:'source',sourceQuestionIndex:i}}));
  const plan = SATSession.plan(questions,{source:{id:'source',questionCount:7,moduleQuestionCounts:[3,4],moduleDurationsSeconds:[1500,1920]},questionLimit:2,durationSeconds:900});
  assert.deepEqual(plain(plan.modules),[
    {start:0,end:3,section:'Reading and Writing',sectionNumber:1,moduleNumber:1,durationSeconds:1500},
    {start:3,end:7,section:'Reading and Writing',sectionNumber:1,moduleNumber:2,durationSeconds:1920},
  ]);
  assert.equal(plan.questions.length,7); assert.equal(plan.questions[0],questions[0]);
});

test('source metadata only governs the complete source in its original question order', () => {
  const questions = Array.from({length:5},(_,i) => ({...math('m'+i),metadata:{sourceId:'source',sourceQuestionIndex:i}}));
  const source = {id:'source',questionCount:5,moduleQuestionCounts:[1,4],moduleDurationsSeconds:[2100,2100]};
  const reordered = [questions[1],questions[0],...questions.slice(2)];
  const plan = SATSession.plan(reordered,{source,questionLimit:2,durationSeconds:1200});
  assert.deepEqual(plain(plan.modules.map(m => [m.end-m.start,m.durationSeconds])),[[2,1200],[2,1200],[1,1200]]);
  for (const counts of [[0,5],[2,2],[1.5,3.5],[]]) {
    const fallback = SATSession.plan(questions,{source:{...source,moduleQuestionCounts:counts},questionLimit:3,durationSeconds:800});
    assert.deepEqual(plain(fallback.modules.map(m => m.end-m.start)),[3,2]);
  }
});

test('single-section plans label Reading and Writing as Section 1 and Math as Section 2', () => {
  assert.equal(SATSession.plan([rw('r')]).modules[0].sectionNumber,1);
  assert.equal(SATSession.plan([math('m')]).modules[0].sectionNumber,2);
  assert.equal(SATSession.section({section:'math'}),'Math');
  assert.equal(SATSession.section({}),'Reading and Writing');
  assert.equal(SATSession.section(null),'Reading and Writing');
});

test('mixed selections place Reading and Writing first and restart module numbers per section', () => {
  const questions = [math('m1'),rw('r1'),math('m2'),rw('r2'),math('m3')], original = [...questions];
  const plan = SATSession.plan(questions,{questionLimit:1});
  assert.deepEqual(plain(plan.questions.map(q => q.id)),['r1','r2','m1','m2','m3']);
  assert.deepEqual(plain(plan.modules.map(m => [m.start,m.end,m.sectionNumber,m.moduleNumber])),[[0,1,1,1],[1,2,1,2],[2,3,2,1],[3,4,2,2],[4,5,2,3]]);
  assert.deepEqual(questions,original,'planning must not reorder the caller’s array');
});

test('Full SAT practice requires both sections and rejects an empty selection', () => {
  assert.throws(() => SATSession.plan([]),/at least one/);
  assert.throws(() => SATSession.plan([rw('r')],{fullSAT:true}),/both Reading and Writing and Math/);
  assert.throws(() => SATSession.plan([math('m')],{fullSAT:true}),/both Reading and Writing and Math/);
});

test('small Full SAT selections use only actual questions and never invent standard test counts', () => {
  const questions = [math('m1'),rw('r1'),math('m2'),rw('r2'),math('m3')];
  const plan = SATSession.plan(questions,{fullSAT:true,questionLimit:30,durationSeconds:999});
  assert.equal(plan.fullSAT,true); assert.equal(plan.questions.length,5); assert.equal(new Set(plan.questions).size,5);
  assert.deepEqual(plain(plan.modules.map(m => [m.start,m.end,m.section,m.moduleNumber,m.durationSeconds])),[
    [0,1,'Reading and Writing',1,1920], [1,2,'Reading and Writing',2,1920],
    [2,4,'Math',1,2100], [4,5,'Math',2,2100],
  ]);
  const tiny = SATSession.plan([math('m'),rw('r')],{fullSAT:true});
  assert.equal(tiny.modules.length,2); assert.equal(tiny.questions.length,2);
  assert.deepEqual(plain(tiny.modules.map(m => [m.sectionNumber,m.moduleNumber])),[[1,1],[2,1]]);
});

test('Full SAT always uses at most two modules per section with independent fixed times', () => {
  const questions = [...Array.from({length:65},(_,i) => math('m'+i)),...Array.from({length:81},(_,i) => rw('r'+i))];
  const plan = SATSession.plan(questions,{fullSAT:true,questionLimit:1,durationSeconds:60,source:{id:'unused',questionCount:146,moduleQuestionCounts:[146],moduleDurationsSeconds:[60]}});
  assert.equal(plan.modules.length,4); assert.equal(plan.modules.at(-1).end,146);
  assert.deepEqual(plain(plan.modules.map(m => [m.sectionNumber,m.moduleNumber,m.durationSeconds])),[[1,1,1920],[1,2,1920],[2,1,2100],[2,2,2100]]);
  assert.deepEqual(plain(plan.modules.map(m => m.end-m.start)),[41,40,33,32]);
});

test('custom plan uses configured durations and clamps them through the existing model', () => {
  assert.equal(SATSession.plan([math('m')],{durationSeconds:2100}).modules[0].durationSeconds,2100);
  assert.equal(SATSession.plan([rw('r')],{durationSeconds:5}).modules[0].durationSeconds,60);
  assert.equal(SATSession.plan([rw('r')],{durationSeconds:99999}).modules[0].durationSeconds,3840);
  const questions = [rw('r0'),rw('r1')].map((q,i) => ({...q,metadata:{sourceId:'s',sourceQuestionIndex:i}}));
  const plan = SATSession.plan(questions,{durationSeconds:1000,source:{id:'s',questionCount:2,moduleQuestionCounts:[1,1],moduleDurationsSeconds:[1200]}});
  assert.deepEqual(plain(plan.modules.map(m => m.durationSeconds)),[1200,1000]);
});

test('answered and grade preserve legacy multiple-choice behavior and unanswered states', () => {
  const q = rw('legacy');
  assert.equal(SATSession.answered(q,{selectedOption:0}),true);
  assert.equal(SATSession.answered(q,{selectedOption:1}),true);
  assert.equal(SATSession.answered(q,{selectedOption:null}),false);
  assert.equal(SATSession.answered(q,{}),false);
  assert.equal(SATSession.answered(q,undefined),false);
  assert.equal(SATSession.grade(q,{selectedOption:1}),true);
  assert.equal(SATSession.grade(q,{selectedOption:0}),false);
  assert.equal(SATSession.grade(q,{selectedOption:null}),null);
  assert.equal(SATSession.grade(q,undefined),null);
});

test('SPR answers remain separate from selectedOption and use exact SATPack grading', () => {
  const q = spr();
  assert.equal(SATSession.isSPR(q),true); assert.equal(SATSession.isSPR(rw('r')),false);
  assert.equal(SATSession.answered(q,{selectedOption:0,numericResponse:''}),false);
  assert.equal(SATSession.answered(q,{numericResponse:'   '}),false);
  assert.equal(SATSession.answered(q,{numericResponse:'4/6'}),true);
  assert.equal(SATSession.grade(q,{selectedOption:null,numericResponse:'4/6'}),true);
  assert.equal(SATSession.grade(q,{numericResponse:'.6667'}),true);
  assert.equal(SATSession.grade(q,{numericResponse:'.67'}),false);
  assert.equal(SATSession.grade(q,{numericResponse:'200/300'}),false);
  assert.equal(SATSession.grade(q,{numericResponse:''}),null);
  q.answerRule.status = 'needs-review'; assert.equal(SATSession.grade(q,{numericResponse:'2/3'}),null);
  q.answerRule = {status:'missing',type:'student-produced-response'}; assert.equal(SATSession.grade(q,{numericResponse:'2/3'}),null);
});

test('typed single-choice packages only grade verified answers', () => {
  const q = {...math('packed'),packContent:{},answerRule:{status:'verified',type:'single-choice',optionId:'choice-3'}};
  assert.equal(SATSession.grade(q,{selectedOption:2}),true);
  assert.equal(SATSession.grade(q,{selectedOption:0}),false);
  q.answerRule.status = 'needs-review'; q.correctOption = null;
  assert.equal(SATSession.grade(q,{selectedOption:2}),null);
});

test('answer labels preserve numeric text and disclose answers awaiting review', () => {
  const q = spr();
  assert.equal(SATSession.answerLabel(q,{numericResponse:'4/6'}),'4/6');
  assert.equal(SATSession.answerLabel(q,{}),'—');
  assert.equal(SATSession.answerLabel(q,{},true),'2/3 or .6666 or .6667 or 0.666 or 0.667');
  q.answerRule.status = 'needs-review'; assert.equal(SATSession.answerLabel(q,{},true),'Not verified');
  assert.equal(SATSession.answerLabel(rw('r'),{selectedOption:0}),'A');
  assert.equal(SATSession.answerLabel(rw('r'),{},true),'B');
});
