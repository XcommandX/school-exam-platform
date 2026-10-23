'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {extractMathFragments, validateFormula, auditRoot} = require('../tools/sat/review_pdf_latex.cjs');

assert.deepEqual(extractMathFragments(String.raw`Cost \$10; $x$ and $$x^{2}$$.`).fragments.map(f => [f.text, f.display]), [['x', false], ['x^{2}', true]]);
assert.deepEqual(extractMathFragments('$x$$y$').fragments.map(f => f.text), ['x', 'y']);
assert.deepEqual(extractMathFragments('`$code$`\n```tex\n$ignored$\n```\n$x$').fragments.map(f => f.text), ['x']);
assert.deepEqual(extractMathFragments(String.raw`\\$x$ and $a\$b$`).fragments.map(f => f.text), ['x', String.raw`a\$b`]);
assert.equal(extractMathFragments('$x\ny$').fragments.length, 0);
assert.equal(extractMathFragments('$ x$').fragments.length, 0);
assert.equal(validateFormula(String.raw`0\lt a\lt 1`, false).ok, true);
assert.equal(validateFormula('x^{', false).ok, false);
assert.equal(validateFormula(String.raw`\href{https://example.com}{x}`, false).code, 'forbidden-math-command');
const unicode = validateFormula('x+猫', false);
assert.equal(unicode.ok, true);
assert.ok(unicode.warnings.includes('unicodeTextInMathMode'));

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sat-latex-audit-'));
try {
  const folder = path.join(temporary, 'synthetic-source', 'math-spr');
  fs.mkdirSync(folder, {recursive: true});
  fs.writeFileSync(path.join(folder, 'pack.json'), JSON.stringify({id: 'synthetic-pack', files: {items: 'items.json', solutions: 'solutions.json'}}));
  fs.writeFileSync(path.join(folder, 'items.json'), JSON.stringify({items: [{id: 'synthetic-item', prompt: [{type: 'markdown', text: '$x+1$ and $x^{$'}]}]}));
  fs.writeFileSync(path.join(folder, 'solutions.json'), JSON.stringify({solutions: [{itemId: 'synthetic-item', explanation: {content: [{type: 'markdown', text: '$x=1$'}]}}]}));
  const report = auditRoot(temporary);
  assert.equal(report.ok, false);
  assert.equal(report.totals.formulaCount, 3);
  assert.equal(report.totals.parseErrorCount, 1);
  assert.equal(report.errors[0].itemId, 'synthetic-item');
  assert.equal(report.errors[0].fragmentIndex, 1);
  assert.equal(JSON.stringify(report).includes('x^{'), false);
} finally {
  fs.rmSync(temporary, {recursive: true, force: true});
}
console.log('PDF LaTeX review tests passed.');
