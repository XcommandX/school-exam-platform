'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {webcrypto, createHash} = require('node:crypto');
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const SATPack = require('../apps/sat/js/sat-pack.js');
const root = path.resolve(__dirname, '..');
const drafts = path.join(root, 'docs/drafts/sat-question-packs');
const names = ['rw-single-choice','math-single-choice','math-spr'];

function file(relative, data, type = '') {
  const content = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return {name:relative.split('/').pop(),webkitRelativePath:relative,type,size:content.length,
    async text() { return content.toString('utf8'); },
    async arrayBuffer() { return content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength); }};
}
function fixtures(name = 'math-spr', prefix = name) {
  const files = [];
  function walk(dir, relative = '') {
    for (const entry of fs.readdirSync(dir, {withFileTypes:true})) {
      const next = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), next);
      else files.push(file(prefix ? prefix + '/' + next : next, fs.readFileSync(path.join(dir, entry.name))));
    }
  }
  walk(path.join(drafts, name)); return files;
}
async function change(files, suffix, mutation) {
  const index = files.findIndex(f => f.webkitRelativePath.endsWith('/' + suffix) || f.webkitRelativePath === suffix);
  const data = JSON.parse(await files[index].text()); mutation(data);
  files[index] = file(files[index].webkitRelativePath, JSON.stringify(data));
}
async function preview(name = 'math-spr', mutation) {
  const files = fixtures(name); if (mutation) await mutation(files);
  const values = await SATPack.previewFiles(files); assert.equal(values.length, 1); return values[0];
}
async function rejected(name, mutation, pattern) {
  const value = await preview(name, mutation);
  assert.ok(value.errors.length, 'malformed pack must report errors');
  assert.equal(value.questions.length, 0, 'malformed packs must never return importable records');
  if (pattern) assert.match(value.errors.join('\n'), pattern);
}
async function replaceImage(files, raw) {
  const data = Buffer.from(raw), imageIndex = files.findIndex(f => /\.svg$/.test(f.name));
  files[imageIndex] = file(files[imageIndex].webkitRelativePath, data, 'image/svg+xml');
  await change(files, 'pack.json', pack => { pack.assets[0].byteLength = data.length; pack.assets[0].sha256 = createHash('sha256').update(data).digest('hex'); });
}

test('all three original draft packs import without changing their content or identities', async () => {
  const previews = await SATPack.previewFiles(names.flatMap(name => fixtures(name, 'examples/' + name)));
  assert.equal(previews.length, 3); assert.equal(previews.reduce((sum, p) => sum + p.count, 0), 5);
  previews.forEach(p => { assert.deepEqual(p.errors, []); assert.equal(p.packIdentity.revision, 1); assert.match(p.sourceId, /@1$/); assert.match(p.contentHash, /^[0-9a-f]{64}$/); });
  const choice = previews[1].questions[0];
  assert.equal(choice.section, 'Math'); assert.equal(choice.options.length, 4);
  assert.equal(choice.correctOption, 0); assert.match(choice.packAssets['line-graph'].src, /^data:image\/svg\+xml;base64,/);
  assert.equal(Buffer.from(choice.packAssets['line-graph'].src.split(',')[1], 'base64').length, 624);
  assert.equal(previews[2].questions[0].options.length, 0);
});

test('a directly selected package folder and a batch container folder both work', async () => {
  const [p] = await SATPack.previewFiles(fixtures('math-single-choice', ''));
  assert.deepEqual(p.errors, []); assert.equal(p.fileName, 'pack.json');
  assert.equal((await SATPack.previewFiles([]))[0].errors.length, 1);
  assert.equal((await SATPack.previewFiles([file('x/items.json','{}')]))[0].errors.length, 1);
});

test('known content hashes prevent duplicate package imports', async () => {
  const first = await preview();
  const [duplicate] = await SATPack.previewFiles(fixtures(), new Set([first.contentHash]));
  assert.match(duplicate.errors[0], /already been imported/); assert.deepEqual(duplicate.questions, []);
});

test('manifest protocol, section, response type, and SPR-only profile are strict', async () => {
  for (const [field,value] of [['schemaVersion','2'],['section','listening'],['responseType','essay'],['status','official'],['exam','toefl']])
    await rejected('math-spr', files => change(files, 'pack.json', p => {p[field] = value;}));
  await rejected('rw-single-choice', files => change(files, 'pack.json', p => {p.inputProfile = {};}));
});

test('unknown fields and personal answer/history fields are rejected at every boundary', async () => {
  for (const [document, mutate] of [
    ['pack.json', p => {p.studentName = 'private';}],
    ['items.json', p => {p.items[0].selectedAnswer = 0;}],
    ['items.json', p => {p.items[0].source.studentId = 'private';}],
    ['solutions.json', p => {p.solutions[0].provenance.attemptId = 'private';}],
    ['solutions.json', p => {p.solutions[0].answer.numericTolerance = .01;}],
  ]) await rejected('math-spr', files => change(files, document, mutate), /unsupported fields/);
});

test('JSON duplicate keys are rejected before an overwritten field can be imported', async () => {
  await rejected('math-spr', async files => {
    const index = files.findIndex(f => f.name === 'pack.json');
    files[index] = file(files[index].webkitRelativePath, (await files[index].text()).replace('"exam": "sat"','"exam": "toefl", "exam": "sat"'));
  }, /duplicate JSON key/);
});

test('items and solutions pair exactly by item ID and revision', async () => {
  for (const mutate of [p => {p.solutions[0].itemId = 'sat:item:absent';},p => {p.solutions[0].itemRevision = 2;},p => {p.solutions.pop();},p => {p.solutions.push(p.solutions[0]);}])
    await rejected('math-spr', files => change(files, 'solutions.json', mutate));
  await rejected('math-spr', files => change(files, 'items.json', p => {p.items[0].revision = 0;}));
});

test('single choice needs four unique stable options; SPR cannot carry options', async () => {
  await rejected('math-single-choice', files => change(files, 'items.json', p => {p.items[0].options.pop();}), /four options/);
  await rejected('math-single-choice', files => change(files, 'items.json', p => {p.items[0].options[1].id = p.items[0].options[0].id;}), /duplicate id/);
  await rejected('math-single-choice', files => change(files, 'solutions.json', p => {p.solutions[0].answer.optionId = 'absent';}), /unknown option/);
  await rejected('math-spr', files => change(files, 'items.json', p => {p.items[0].options = [];}), /unsupported fields/);
});

test('image-only options are allowed and keep their typed content', async () => {
  const p = await preview('math-single-choice', files => change(files, 'items.json', p => {
    p.items[0].options[0].content = [{type:'image',assetId:'line-graph',alt:'A graph',role:'coordinate-plane'}];
  }));
  assert.deepEqual(p.errors, []); assert.equal(p.questions[0].packContent.options[0].content[0].type, 'image');
});

test('unreviewed and missing answers are imported honestly and never auto-graded', async () => {
  for (const name of ['math-spr','rw-single-choice']) {
    const p = await preview(name, files => change(files, 'solutions.json', p => {
      p.solutions[0].answer = {status:'missing',type:p.solutions[0].answer.type};
      p.solutions[0].explanation = {status:'missing',content:[]};
      p.solutions[1].answer.status = 'needs-review';
    }));
    assert.deepEqual(p.errors, []); assert.equal(p.questions[0].correctOption, null);
    p.questions.forEach(q => assert.equal(SATPack.grade(q, {numericResponse:'3',selectedOption:0}), null));
    assert.equal(p.questions[0].explanation, ''); assert.ok(p.warnings.some(w => /ungraded/.test(w)));
  }
});

test('SPR supports either exact root, equivalent fractions, and only explicitly listed decimals', async () => {
  const p = await preview(), [roots,fraction] = p.questions;
  for (const response of ['3','-3','6/2','-6/2']) assert.equal(SATPack.grade(roots,{numericResponse:response}), true, response);
  for (const response of ['2/3','4/6','20/30','.6666','.6667','0.666','0.667']) assert.equal(SATPack.grade(fraction,{numericResponse:response}), true, response);
  for (const response of ['.67','0.67','.666','200/300','2 / 3','2/0','3,-3','±3']) assert.equal(SATPack.grade(fraction,{numericResponse:response}), false, response);
  assert.equal(SATPack.grade(roots,{numericResponse:''}), null);
  assert.equal(SATPack.grade(roots,{}), null);
});

test('SPR character limits and syntax count the minus sign and reject partial numbers', () => {
  for (const response of ['12345','-12345','.1234','-.1234','20/30','00001']) assert.equal(SATPack.validInput(response), true, response);
  for (const response of ['123456','-123456','3.','+3','1 1/2','1e2','1,000','2/0',' 3','3 ','','-','.','3 cm']) assert.equal(SATPack.validInput(response), false, response);
});

test('SPR editing allows intermediate numeric prefixes without treating them as finished answers', () => {
  for (const value of ['', '-', '.', '-.', '3.', '-3.', '3/', '-3/']) {
    assert.equal(SATPack.canEditInput(value),true,value);
    assert.equal(SATPack.validInput(value),false,value);
  }
  for (const value of ['0','3','-3','12345','-12345','.1234','-.1234','12.34','-12.34','1/234','-1/234','00001']) {
    assert.equal(SATPack.canEditInput(value),true,value);
    assert.equal(SATPack.validInput(value),true,value);
  }
  assert.equal(SATPack.canEditInput('3/0'),true,'a denominator may be edited before the answer is valid');
  assert.equal(SATPack.validInput('3/0'),false);
});

test('SPR editing rejects illegal characters, combined formats, repeated separators and excessive length', () => {
  for (const value of ['abc','3a','3%','$3','+','+3',' 3','3 ','3\n','1 1/2','１２','−3','--','3-','1-2','1..','1//','1/.','1./','1.2/3','1/2.3','1e2','NaN','Infinity','123456','-123456','.12345','-.12345'])
    assert.equal(SATPack.canEditInput(value),false,JSON.stringify(value));
  for (const value of [null,undefined,3,{},[]]) assert.equal(SATPack.canEditInput(value),false);
});

test('SPR rational comparison preserves integers beyond 32-bit and floating point precision', async () => {
  const p = await preview('math-spr', files => change(files, 'solutions.json', p => {
    p.solutions[0].answer.acceptedRationals = ['9007199254740993/9007199254740993'];
    p.solutions[1].answer.acceptedRationals = ['9007199254740992/9007199254740993'];
  }));
  assert.deepEqual(p.errors, []);
  assert.equal(SATPack.grade(p.questions[0],{numericResponse:'1'}), true);
  assert.equal(SATPack.grade(p.questions[1],{numericResponse:'1'}), false);
});

test('SPR answer rules reject duplicate values, zero denominators, tolerance and invalid decimal spellings', async () => {
  for (const mutate of [a => {a.acceptedRationals = ['2/3','4/6'];},a => {a.acceptedRationals = ['2/0'];},a => {a.acceptedDecimalSpellings = ['.66667'];},a => {a.acceptedRationals = []; a.acceptedDecimalSpellings = [];}])
    await rejected('math-spr', files => change(files,'solutions.json',p => {mutate(p.solutions[1].answer);}));
});

test('images must have matching local paths, MIME, byte count and actual SHA-256', async () => {
  for (const [field,value] of [['path','../image.svg'],['path','assets/../image.svg'],['path','https://example.invalid/a.svg'],['path','assets\\a.svg'],['path','/absolute.svg'],['path','assets/%2e%2e/a.svg'],['mediaType','image/png'],['byteLength',1],['sha256','0'.repeat(64)]])
    await rejected('math-single-choice', files => change(files, 'pack.json',p => {p.assets[0][field] = value;}));
  await rejected('math-single-choice', async files => {
    const index = files.findIndex(f => f.name.endsWith('.svg')); files[index] = file(files[index].webkitRelativePath, await files[index].text(), 'image/png');
  }, /MIME/);
  await rejected('math-single-choice', async files => {files.splice(files.findIndex(f => /\.svg$/.test(f.name)),1);}, /missing file/);
});

test('static SVG validation refuses active content, foreign documents, and external references', async () => {
  for (const fragment of [
    '<script>alert(1)</script>', '<rect onclick="alert(1)"/>', '<foreignObject/>',
    '<image href="https://example.invalid/a.png"/>', '<use href="#a"/>', '<rect style="fill:url(https://example.invalid/a)"/>',
    '<rect fill="url(https://example.invalid/a)"/>', '<animate attributeName="x"/>',
    '<g xmlns="http://www.w3.org/1999/xhtml"/>', '<g transform="&#106;avascript:alert(1)"/>',
  ]) await rejected('math-single-choice', files => replaceImage(files, `<svg xmlns="http://www.w3.org/2000/svg">${fragment}</svg>`), /SVG/);
  await rejected('math-single-choice', files => replaceImage(files, '<!DOCTYPE svg [<!ENTITY a SYSTEM "file:///private">]><svg/>'), /SVG/);
});

test('declared raster MIME must match bytes even if its digest and extension were updated', async () => {
  await rejected('math-single-choice', async files => {
    const index = files.findIndex(f => /\.svg$/.test(f.name)), data = Buffer.from('<svg/>');
    files[index] = file(files[index].webkitRelativePath.replace(/svg$/, 'png'),data,'image/png');
    await change(files, 'pack.json',p => Object.assign(p.assets[0],{path:'assets/line-graph.png',mediaType:'image/png',byteLength:data.length,sha256:createHash('sha256').update(data).digest('hex')}));
  }, /bytes do not match/);
});

test('Markdown preserves underlines and math; other raw HTML, executable LaTeX and remote images fail', async () => {
  const valid = await preview('math-spr', files => change(files, 'items.json',p => {p.items[0].content[0].text = '<u>Evidence</u> with $x<y$ and $$y=\\frac{2}{3}$$.';}));
  assert.deepEqual(valid.errors, []); assert.match(SATPack.plainText(valid.questions[0].packContent.content), /Evidence with/);
  for (const value of ['<script>x</script>','<u onclick="x">word</u>','<u>unclosed','![image](https://example.invalid/x)','[link](javascript:alert(1))','$\\href{javascript:x}{x}$'])
    await rejected('math-spr', files => change(files, 'items.json',p => {p.items[0].content[0].text = value;}));
});

test('conflicting copies of an item revision invalidate every involved preview', async () => {
  const first = fixtures('math-spr','one'), second = fixtures('math-spr','two');
  await change(second,'pack.json',p => {p.id = 'sat:pack:second';});
  await change(second,'items.json',p => {p.items[0].prompt[0].text = 'Changed question';});
  const previews = await SATPack.previewFiles([...first,...second]);
  previews.forEach(p => {assert.ok(p.errors.some(e => /Conflicting/.test(e))); assert.equal(p.questions.length, 0);});
});

test('commit preserves typed pack content and revision-bound IDs without changing v1 imports', async () => {
  const writes = [], context = {window:{},crypto:webcrypto,Date,SATStorage:{async importSet(source,questions) {writes.push({source,questions});}}};
  vm.runInNewContext(fs.readFileSync(path.join(root,'apps/sat/js/importer.js'),'utf8'),context);
  const p = await preview(), importer = context.window.SATImporter;
  assert.equal(await importer.commit(p), 2);
  const first = writes[0]; assert.equal(first.source.section, 'Math'); assert.equal(first.source.packIdentity.revision, 1);
  assert.match(first.questions[0].id, /@1:.*@1$/); assert.equal(first.questions[0].itemRevision, 1); assert.equal(first.questions[0].packContent,p.questions[0].packContent);
  const revised = structuredClone(p); revised.packIdentity.revision = 2; revised.sourceId = p.sourceId.replace(/@1$/,'@2'); revised.questions.forEach(q => {q.packRevision = 2;});
  await importer.commit(revised); assert.notEqual(writes[0].questions[0].id,writes[1].questions[0].id);
  await importer.commit({errors:[],questions:[{prompt:'Old',options:['A','B','C','D'],correctOption:1}],fileName:'old.json',contentHash:'legacy'});
  assert.equal(writes[2].source.section, 'Reading and Writing'); assert.equal(writes[2].questions[0].correctOption,1); assert.equal(writes[2].source.packIdentity,undefined);
  await assert.rejects(importer.commit({errors:['invalid'],questions:[]}), /validation errors/);
  assert.equal(writes.length,3);
});
