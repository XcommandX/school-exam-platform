const assert = require('node:assert/strict');
const M = require('../../front-end/contests/model.js');
let checks = 0;
function test(name, run) { run(); checks++; console.log(`PASS ${name}`); }
const exam = {id: 'amc10-2026-example-a', revision: 'a'.repeat(64), title: '原创示例'};
const problem = {id: exam.id + '-01', contest: 'AMC10', number: 1, question_type: 'multiple_choice',
  choices: ['A','B','C','D','E'].map(label => ({label})), answer: {type: 'choice', accepted: ['B','D']},
  quality: {auto_gradable: true, ready_for_practice: true, structurally_complete: true, flags: []}};
test('Multiple accepted answers and invalid selection', () => {
  for (const value of ['B','D']) assert.equal(M.grade(problem, value).status, 'correct');
  assert.equal(M.grade(problem, 'A').status, 'incorrect');
  for (const value of ['', null, 'Z', '<script>']) assert.equal(M.grade(problem, value).status, 'invalid');
});
test('Integer bounds, zero padding and strict syntax', () => {
  const integer = {...problem, question_type: 'integer', answer: {type: 'integer', value: 0}};
  for (const value of ['0','00','000',' 0 ']) assert.equal(M.grade(integer, value).status, 'correct');
  for (const value of ['-1','1000','1.0','1e2','+1','０','', '0000']) assert.equal(M.grade(integer, value).status, 'invalid');
  assert.equal(M.grade({...integer, answer: {type: 'integer', value: 999}}, '999').status, 'correct');
  assert.equal(M.grade({...integer, answer: {type: 'integer', value: 1000}}, '999').status, 'ungraded');
});
test('Quality gates and proof never auto-grade', () => {
  for (const flag of ['answer_source_disagreement','statement_variant_disagreement','answer_disputed']) {
    assert.equal(M.canGrade({...problem, quality: {...problem.quality, flags: [flag]}}), false);
  }
  for (const key of ['auto_gradable','ready_for_practice','structurally_complete']) assert.equal(M.canGrade({...problem, quality: {...problem.quality, [key]: false}}), false);
  assert.equal(M.canGrade({...problem, question_type: 'proof'}), false);
  assert.equal(M.canGrade({...problem, answer: {type: 'choice', accepted: ['X']}}), false);
});
test('First checked result locks and survives reload', () => {
  const state = M.empty();
  assert.equal(M.submit(state, 'private', exam, problem, 'A', 10).status, 'incorrect');
  assert.equal(M.submit(state, 'private', exam, problem, 'B', 20).status, 'locked');
  assert.equal(M.getSession(M.load(JSON.stringify(state)), 'private', exam).responses[problem.id].result, 'incorrect');
  assert.deepEqual(M.summarize(state, 'private', [exam]), {answered: 1, graded: 1, correct: 0, drafts: 0, accuracy: 0});
});
test('Reveal disables statistics without losing draft', () => {
  const state = M.empty();
  M.updateResponse(state, 'private', exam, problem, {value: 'B', revealed: true});
  assert.equal(M.submit(state, 'private', exam, problem, 'B').status, 'ungraded');
  assert.equal(M.summarize(state, 'private', [exam]).graded, 0);
});
test('Separate mode, revision and proof draft records', () => {
  const state = M.empty();
  M.submit(state, 'example', exam, problem, 'B');
  const newer = {...exam, revision: 'b'.repeat(64)};
  M.updateResponse(state, 'private', newer, {...problem, question_type: 'proof'}, {value: 'A complete proof draft.'});
  assert.equal(M.getSession(state, 'private', exam), null);
  assert.equal(M.summarize(state, 'example', [newer]).graded, 0);
  assert.equal(M.summarize(state, 'example', [exam]).correct, 1);
  assert.equal(M.getSession(M.load(JSON.stringify(state)), 'private', newer).responses[problem.id].value, 'A complete proof draft.');
});
test('Corrupt or legacy browser storage is ignored', () => {
  for (const raw of [null, '', '{bad', 'null', '{"version":2}', '{"legacyHistory":[1]}']) assert.deepEqual(M.load(raw), M.empty());
  assert.deepEqual(M.load('{"version":1,"sessions":{"x":{"mode":"private","examId":"../x"}}}'), M.empty());
});
test('More than 500 revisions round-trip without silently losing newest drafts', () => {
  const state = M.empty();
  for (let i = 0; i < 501; i++) {
    const revision = i.toString(16).padStart(64, '0');
    M.updateResponse(state, 'private', {...exam, revision}, problem, {value: `proof-${i}`}, i);
  }
  const restored = M.load(JSON.stringify(state));
  assert.equal(Object.keys(restored.sessions).length, 501);
  assert.equal(M.getSession(restored, 'private', {...exam, revision: (500).toString(16).padStart(64, '0')}).responses[problem.id].value, 'proof-500');
  for (let i = 0; i < 10001; i++) {
    const mark = {mode: 'private', examId: exam.id, id: 'problem-' + i, number: 1};
    state.bookmarks[M.bookmarkKey(mark.mode, mark.id)] = mark;
  }
  assert.equal(Object.keys(M.load(JSON.stringify(state)).bookmarks).length, 10001);
});
test('Catalog filters keep supplemental exams explicit', () => {
  const rows = [
    {id:'a', contest:'AMC10', year:2021, season:'spring', paper:'A'},
    {id:'b', contest:'AMC10', year:2021, season:'fall', paper:'B'},
    {id:'c', contest:'AMC10', year:2002, season:'regular', paper:'P', special_paper:true},
    {id:'d', contest:'USAMO', year:2026, paper:'single'}
  ];
  assert.deepEqual(M.filterExams(rows, {contest:'AMC10'}).map(e => e.id), ['b','a']);
  assert.equal(M.filterExams(rows, {contest:'AMC10',year:'2002',supplemental:true}).length, 1);
  assert.equal(M.filterExams(rows, {query:'秋季'}).length, 1);
});
console.log(`Contest model: ${checks} groups passed.`);
