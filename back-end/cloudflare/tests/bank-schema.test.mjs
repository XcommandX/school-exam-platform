// Original anonymous fixtures only. Python is the contract oracle, never a bank.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  normalizeQuestionSet as normalize, validateQuestionSet as validate, toSATLegacy as legacy,
  referencedAssets, validAssetPath, parseBankJSON, pythonJSON, documentHash,
} from '../src/bank-schema.mjs';

const question = () => ({ prompt: 'Select the letter A.', options: ['A', 'B', 'C', 'D'], answer: 'A' });
const sample = () => ({ title: '原创 😀 synthetic set', durationSeconds: 120, moduleQuestionCounts: [1, 1],
  moduleDurationsSeconds: [60, 60], studentName: 'PRIVATE SYNTHETIC PERSON', attempts: [{ score: 3 }], questions: [
    { ...question(), passageMarkdown: '**A** and *B*.', explanation: 'A is requested.', aiExplanation: 'Synthetic explanation.',
      userSelectedAnswer: 'B', customMetadata: { sourceModule: 1, sourceQuestionId: 27,
        userSelectedAnswer: 'B', studentName: 'PRIVATE SYNTHETIC PERSON', repairAudit: { userAnswer: 'C' } } },
    { ...question(), prompt: 'Select the letter B.', answer: 1 },
  ] });
const invalid = fn => assert.throws(fn, error => error.code === 'invalid_question_bank');

test('allowlist removes private fields recursively, does not mutate input, and retains stable IDs', () => {
  const raw = sample(), before = structuredClone(raw), data = normalize(raw, 'sat', 'fixture.json');
  validate(data); assert.deepEqual(raw, before);
  assert.doesNotMatch(JSON.stringify(data), /studentName|userSelectedAnswer|PRIVATE|attempts|repairAudit/);
  assert.deepEqual(data.questions[0].customMetadata, { sourceModule: 1, sourceQuestionId: 27 });
  assert.equal(data.questions[0].moduleIndex, 0); assert.equal(data.questions[1].moduleIndex, 1);
  raw.questions[0].explanation = 'Corrected explanation.';
  assert.equal(normalize(raw, 'sat', 'fixture.json').id, data.id);
  assert.equal(normalize(raw).id, normalize(before).id);
  const parsed = parseBankJSON(JSON.stringify(raw));
  assert.equal(parsed.studentName, undefined); assert.equal(parsed.questions[0].customMetadata.repairAudit, undefined);
  assert.deepEqual(normalize(parsed), normalize(raw));
});

test('legacy round trip preserves IDs, all safe metadata, formatting, module counts and durations', () => {
  const raw = sample(); Object.assign(raw.questions[0].customMetadata, {
    sourceExamId: 'synthetic-exam', sourceQuestionNumberInModule: 1, sourceQuestionNumber: 1,
    sourceQuestionType: 'synthetic-type', sourceSection: 'Reading and Writing',
    sourceTableImageAsset: 'question-assets/sat/匿名图.png',
  });
  raw.questions[0].answerProvenance = 'agent'; raw.questions[0].agentSuggestedAnswer = 'B';
  const data = normalize(raw), adapted = legacy(data);
  assert.equal(adapted.questions[0].answer, 0); assert.equal(adapted.questions[0].correctOption, undefined);
  assert.deepEqual(normalize(adapted), data); assert.deepEqual(normalize(adapted, 'sat', 'renamed.json'), data);
  assert.deepEqual(referencedAssets(data), new Set(['question-assets/sat/匿名图.png']));
  assert.equal(documentHash(normalize(adapted)), documentHash(data));
  adapted.sourceId = 'toefl:other'; invalid(() => normalize(adapted));
});

test('markdown matches UTF-16 offsets, nesting, bullets, and Python LF-only multiline behavior', () => {
  const raw = { questions: [{ ...question(), passageMarkdown: '😀 **A *B* C**\n+ <u>D</u>\r- E\u2028+ F' }] };
  const q = normalize(raw).questions[0];
  assert.equal(q.passage, '😀 A B C\n• D\r- E\u2028+ F');
  assert.deepEqual(q.passageFormatting, [
    { start: 5, end: 6, kind: 'italic' }, { start: 3, end: 8, kind: 'bold' }, { start: 11, end: 12, kind: 'underline' },
  ]);
  for (const value of ['**unclosed', '**', '<u></u>', '*a **b* c**']) {
    invalid(() => normalize({ questions: [{ ...question(), passageMarkdown: value }] }));
  }
  assert.equal(normalize({ questions: [{ ...question(), passageMarkdown: '</u>A' }] }).questions[0].passage, 'A');
});

test('formatting validates safe integer UTF-16 ranges and keeps only start/end/kind', () => {
  const raw = { questions: [{ ...question(), prompt: '😀 A', promptFormatting: [{ start: 3, end: 4, kind: 'bold', studentName: 'PRIVATE' }],
    optionsFormatting: [[{ start: 0, end: 1, kind: 'underline', secret: 1 }], null, [], []] }] };
  const q = normalize(raw).questions[0];
  assert.deepEqual(q.promptFormatting, [{ start: 3, end: 4, kind: 'bold' }]); assert.deepEqual(q.optionsFormatting[1], []);
  for (const span of [{ start: true, end: 1, kind: 'bold' }, { start: 0, end: 8, kind: 'bold' },
    { start: 0, end: 0, kind: 'bold' }, { start: 0, end: 1, kind: 'script' }, { start: 0.5, end: 1, kind: 'bold' }]) {
    raw.questions[0].promptFormatting = [span]; invalid(() => normalize(raw));
  }
});

test('local asset path allowlist matches Python rules and never permits traversal or URLs', () => {
  for (const path of ['question-assets/a.png', 'question-assets/sat/原创 图.JPG', 'QUESTION-ASSETS/SAT/p.SVG',
    'question-assets/x/.hidden.webp', 'question-assets/..a.gif', 'question-assets/x/a.GİF']) assert.equal(validAssetPath(path), true, path);
  for (const path of ['https://a.test/a.png', '//a.test/a.png', '/question-assets/a.png', 'question-assets/../a.png',
    'question-assets/./a.png', 'question-assets/x//a.png', 'question-assets/a.png\n', 'question-assets/x\\a.png',
    'question-assets/a.png?x=1', 'question-assets/a.png#x', 'question-assets/%2e%2e/a.png',
    'question-assets/data:a.png', 'question-assets/a.html', 'question-assets/a\u0000.png', '', null]) assert.equal(validAssetPath(path), false, String(path));
});

test('visual image/chart/table fields and metadata types are sanitized or rejected', () => {
  const raw = { questions: [{ ...question(), visualStimulus: { type: 'image', src: 'question-assets/sat/fixture.png',
    alt: 'Synthetic diagram', title: 'discarded for image', columns: [{ private: 1 }], caption: 'caption', student: 'PRIVATE' } }] };
  let data = normalize(raw);
  assert.deepEqual(data.questions[0].visualStimulus, { type: 'image', src: 'question-assets/sat/fixture.png', alt: 'Synthetic diagram', caption: 'caption', position: 'before-passage' });
  raw.questions[0].visualStimulus = { type: 'table', columns: ['Column'], rows: [['Cell']], src: 'discarded', alt: 'discarded', title: 'Table', private: 'PRIVATE' };
  data = normalize(raw); assert.deepEqual(data.questions[0].visualStimulus, { type: 'table', columns: ['Column'], rows: [['Cell']], title: 'Table', position: 'before-passage' });
  raw.questions[0].visualStimulus.rows = [[1]]; invalid(() => normalize(raw));
  raw.questions[0].visualStimulus = { type: 'chart', src: 'question-assets/sat/a.svg', alt: '' }; invalid(() => normalize(raw));
  raw.questions[0].visualStimulus = null;
  for (const metadata of [{ sourceModule: true }, { sourceQuestionId: {} }, { sourceExamId: 1 }, { sourceModule: 1.5 },
    { sourceTableImageAsset: 'question-assets/../secret.png' }, []]) {
    raw.questions[0].customMetadata = metadata; invalid(() => normalize(raw));
  }
  raw.questions[0].customMetadata = { sourceModule: -1 }; assert.equal(normalize(raw).questions[0].customMetadata.sourceModule, -1);
});

test('canonical validation rejects incomplete, unknown, duplicate and cross-exam identifiers', () => {
  const mutations = [
    d => { d.attempts = []; }, d => { d.questions[0].private = true; },
    d => { d.questions[0].customMetadata.userSelectedAnswer = 'A'; },
    d => { delete d.questions[0].optionsFormatting; }, d => { d.questions[0].id = 'sat:other:q1'; },
    d => { d.questions[1].id = d.questions[0].id; }, d => { d.exam = 'toefl'; },
    d => { d.questions[0].visualStimulus = { type: 'image', src: 'question-assets/a.png', alt: 'A', private: 'X' }; },
  ];
  for (const mutate of mutations) { const data = normalize(sample()); mutate(data); invalid(() => validate(data)); }
  for (const exam of ['ap', 'toefl', 'vocab']) {
    const data = normalize({ questions: [question()] }, exam, 'same.json');
    assert.ok(data.id.startsWith(exam + ':')); validate(data); invalid(() => legacy(data));
  }
});

test('invalid finite values, booleans, schema/module relations and unsupported enums fail', () => {
  const setChanges = [ { questions: [] }, { schemaVersion: true }, { schemaVersion: 2 }, { defaultDurationSeconds: Infinity },
    { durationMinutes: NaN, durationSeconds: null }, { durationSeconds: true }, { moduleQuestionCounts: [1] }, { moduleQuestionCounts: [true, 1] },
    { moduleDurationsSeconds: [59, 60] }, { moduleDurationsSeconds: [3841, 60] }, { moduleDurationsSeconds: [60] },
    { section: 'Math' }, { sourceId: 'sat:bad\n' }, { sourceId: 'sat:' }, { title: '\u0085' } ];
  for (const changes of setChanges) invalid(() => normalize({ ...sample(), ...changes }));
  for (const changes of [{ answer: true }, { answer: 1.5 }, { correctOption: 4 }, { correctOption: null }, { options: ['A', 'B'] },
    { passage: null }, { passageStyle: 'unknown' }, { moduleIndex: -1 }, { answerProvenance: 'student' },
    { agentSuggestedAnswer: 'E' }, { optionsFormatting: [] }]) {
    invalid(() => normalize({ questions: [{ ...question(), ...changes }] }));
  }
  assert.equal(normalize({ durationSeconds: 120.5, questions: [question()] }).defaultDurationSeconds, 120);
  assert.equal(normalize({ durationSeconds: 121.5, questions: [question()] }).defaultDurationSeconds, 122);
  assert.equal(normalize({ title: '\ufeff', questions: [question()] }).title, '\ufeff'); // Python does not strip BOM.
});

test('strict parser rejects duplicate/escaped keys, NaN, overflow, Unicode and integer precision loss', () => {
  for (const raw of ['{"questions":[],"questions":[]}', '{"questions":[],"questio\\u006es":[]}',
    '{"private":{"x":1,"x":2}}', '{"x":NaN}', '{"x":1e400}', '{"x":9007199254740993}',
    '{"x":"\\ud800"}', '{"x":"\\udc00"}', '{"x":1} trailing', '{"x":01}', '{"x":true,}']) {
    assert.throws(() => parseBankJSON(raw), raw);
  }
  for (const field of ['schemaVersion', 'moduleIndex']) {
    const raw = field === 'schemaVersion' ? '{"schemaVersion":1.0,"questions":[Q]}' : '{"questions":[Q]}';
    const q = JSON.stringify({ ...question(), ...(field === 'moduleIndex' ? { moduleIndex: 'FLOAT' } : {}) }).replace('"FLOAT"', '1.0');
    invalid(() => normalize(parseBankJSON(raw.replace('Q', q))));
  }
  const q = JSON.stringify(question()).replace('"A"}', '0.0}');
  invalid(() => normalize(parseBankJSON('{"questions":[' + q + ']}')));
});

test('source ID and canonical/legacy contents match the complete Python implementation', () => {
  const cases = [sample(), { title: '原创 😀', questions: [{ prompt: '选择 A', options: ['A', 'B', 'C', 'D'], answer: 'A' }] },
    { questions: [{ ...question(), passageMarkdown: '😀 **A**\n- B' }], durationSeconds: 120.5 },
    { questions: [{ ...question(), passage: 'line\r\n\t"\\字\u2028\u0000', visualStimulus: { type: 'chart', src: 'question-assets/sat/a.png', alt: '图' } }] },
  ];
  const floatTokens = ['1e-7', '0.0', '-0.0', '1.0', '1e16', '1e20', '1e21', '0.0001', '0.00001',
    '1.2345678901234568e-5', '1.0000000000000002e20', '5e-324', '1.7976931348623157e308'];
  const floatSources = floatTokens.map(token => JSON.stringify({ questions: [{ ...question(), correctOption: 0, answer: 'FLOAT' }] }).replace('"FLOAT"', token));
  const sources = [...cases.map(c => JSON.stringify(c)), ...floatSources];
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const code = `import sys,json\nsys.path.insert(0,'back-end')\nfrom shared.question_schema import normalize_question_set,validate_question_set,to_sat_legacy\nresult=[]\nfor source in json.loads(sys.stdin.read()):\n d=normalize_question_set(json.loads(source)); validate_question_set(d); result.append([d,to_sat_legacy(d)])\nprint(json.dumps(result,ensure_ascii=True))`;
  const result = spawnSync(process.env.PYTHON || 'python', ['-B', '-X', 'utf8', '-c', code], { cwd: root, input: JSON.stringify(sources), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const expected = JSON.parse(result.stdout);
  for (let i = 0; i < sources.length; i++) {
    const normalized = normalize(parseBankJSON(sources[i]));
    assert.deepEqual(normalized, expected[i][0]); assert.deepEqual(legacy(normalized), expected[i][1]);
  }
  assert.match(expected[1][0].id, /^sat:[a-f0-9]{12}$/);
});

test('large finite floats serialize identically to Python across deterministic edge distributions', () => {
  let seed = 0x5eed1234;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const tokens = [];
  for (let i = 0; i < 600; i++) tokens.push(`${random() < 0.5 ? '-' : ''}${1 + Math.floor(random() * 9)}.${String(Math.floor(random() * 1e15)).padStart(15, '0')}e${Math.floor(random() * 620) - 320}`);
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const result = spawnSync(process.env.PYTHON || 'python', ['-B', '-X', 'utf8', '-c',
    'import sys,json,math\na=json.loads(sys.stdin.read()); print(json.dumps([json.dumps(json.loads(s),ensure_ascii=False,sort_keys=True) for s in a]))'],
  { cwd: root, input: JSON.stringify(tokens), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const expected = JSON.parse(result.stdout);
  for (let i = 0; i < tokens.length; i++) assert.equal(pythonJSON(parseBankJSON(tokens[i], { project: false })), expected[i], tokens[i]);
});

test('Python JSON uses default spaces, Unicode codepoint sorting and float spelling', () => {
  assert.equal(pythonJSON({ z: '字😀', a: [null, true, 1, '\n'] }), '{"a": [null, true, 1, "\\n"], "z": "字😀"}');
  assert.equal(pythonJSON(parseBankJSON('{"z":1.0,"x":-0.0,"y":1e-7,"a":1e16}', { project: false })),
    '{"a": 1e+16, "x": -0.0, "y": 1e-07, "z": 1.0}');
  assert.equal(pythonJSON({ '😀': 1, '\ue000': 2 }), '{"": 2, "😀": 1}');
});
