#!/usr/bin/env node
'use strict';
// Audit one PDF-derived pack at a time. Reports contain IDs, offsets and hashes,
// never question text or formula bodies. This does not certify source answers.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '../../..');
const katex = require(path.join(ROOT, 'front-end/sat/vendor/katex/katex.min.js'));
const DEFAULT_ROOT = path.join(ROOT, 'back-end/question-banks/sat-packs/pdf-official');
const DEFAULT_REPORT = path.join(ROOT, 'local-data/pdf-sat-conversion/latex-review.json');
const forbiddenMath = /\\(?:def|gdef|edef|xdef|let|futurelet|global|newcommand|renewcommand|providecommand|newenvironment|renewenvironment|csname|catcode|includegraphics|href|url|htmlClass|htmlId|htmlStyle|htmlData|html@mathml)(?![A-Za-z])/;

function hash(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function mathToken(source, start) {
  const display = source.startsWith('$$', start);
  const size = display ? 2 : 1;
  if (!display && /\s/.test(source[start + size] || '')) return null;
  for (let end = start + size; end < source.length; end++) {
    if (!display && (source[end] === '\n' || source[end] === '`')) return null;
    if (source[end] === '\\') { end++; continue; }
    if (!source.startsWith(display ? '$$' : '$', end)) continue;
    if (!display && /\s/.test(source[end - 1])) return null;
    const text = source.slice(start + size, end);
    if (!text.trim()) return null;
    return {text, display, start, end: end + size};
  }
  return null;
}

function extractMathFragments(markdown) {
  // Equivalent dollar rules to content-renderer.js, plus Markdown code skipping.
  // Advancing over escaped characters gives correct odd/even backslash parity.
  const fragments = [];
  const unmatched = [];
  let fence = null;
  for (let i = 0; i < markdown.length;) {
    if (i === 0 || markdown[i - 1] === '\n') {
      const newline = markdown.indexOf('\n', i);
      const lineEnd = newline < 0 ? markdown.length : newline;
      const line = markdown.slice(i, lineEnd);
      const match = /^(?: {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
      if (fence) {
        if (match && match[1][0] === fence.char && match[1].length >= fence.size && !match[2].trim()) fence = null;
        i = lineEnd + 1;
        continue;
      }
      if (match) {
        fence = {char: match[1][0], size: match[1].length};
        i = lineEnd + 1;
        continue;
      }
    }
    if (markdown[i] === '\\') { i += 2; continue; }
    if (markdown[i] === '`') {
      let end = i + 1;
      while (markdown[end] === '`') end++;
      const marker = markdown.slice(i, end);
      let closing = markdown.indexOf(marker, end);
      while (closing >= 0 && (markdown[closing - 1] === '`' || markdown[closing + marker.length] === '`')) {
        closing = markdown.indexOf(marker, closing + marker.length);
      }
      i = closing < 0 ? end : closing + marker.length;
      continue;
    }
    if (markdown[i] !== '$') { i++; continue; }
    const fragment = mathToken(markdown, i);
    if (fragment) {
      fragments.push(fragment);
      i = fragment.end;
    } else {
      unmatched.push(i);
      i++;
    }
  }
  return {fragments, unmatched};
}

function parseClass(error) {
  const message = String(error.rawMessage || error.message || '');
  if (/undefined control sequence/i.test(message)) return 'undefined-control-sequence';
  if (/double (sub|super)script/i.test(message)) return 'duplicate-script';
  if (/expected.*}|unexpected.*}|end of input|unbalanced/i.test(message)) return 'unbalanced-group';
  if (/strict mode|LaTeX-incompatible input/i.test(message)) return 'strict-diagnostic';
  return 'parse-error';
}

function validateFormula(formula, displayMode) {
  if (forbiddenMath.test(formula)) return {ok: false, code: 'forbidden-math-command', warnings: []};
  const warnings = new Set();
  const oldWarn = console.warn;
  // KaTeX's font-metric diagnostics can contain source characters. Aggregate the
  // diagnostic without printing source content, including on parse failures.
  console.warn = () => warnings.add('font-metric-warning');
  try {
    katex.renderToString(formula, {
      displayMode, throwOnError: true, trust: false,
      strict(code) {
        if (code === 'unicodeTextInMathMode' || code === 'unknownSymbol') {
          warnings.add(code);
          return 'ignore';
        }
        return 'error';
      },
      macros: {}, globalGroup: false, maxExpand: 100, maxSize: 20, output: 'htmlAndMathml'
    });
    return {ok: true, warnings: [...warnings].sort()};
  } catch (error) {
    return {ok: false, code: parseClass(error), warnings: [...warnings].sort(),
      position: Number.isInteger(error.position) ? error.position : null,
      length: Number.isInteger(error.length) ? error.length : null};
  } finally {
    console.warn = oldWarn;
  }
}

function *packFolders(root) {
  const entries = fs.readdirSync(root, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name));
  if (entries.some(entry => entry.isFile() && entry.name === 'pack.json')) { yield root; return; }
  for (const entry of entries) {
    if (entry.isDirectory()) yield* packFolders(path.join(root, entry.name));
  }
}

function *markdownFields(value, location = '') {
  if (!value || typeof value !== 'object') return;
  if (value.type === 'markdown' && typeof value.text === 'string') {
    yield {text: value.text, location: `${location}/text`};
  }
  if (value.type === 'image' && typeof value.caption === 'string') {
    yield {text: value.caption, location: `${location}/caption`};
  }
  for (const [key, child] of Object.entries(value)) {
    if (child && typeof child === 'object') {
      const pointer = key.replace(/~/g, '~0').replace(/\//g, '~1');
      yield* markdownFields(child, `${location}/${pointer}`);
    }
  }
}

function localDocument(packFolder, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || path.isAbsolute(relative)) throw new Error('invalid-pack-document-path');
  const target = path.resolve(packFolder, relative);
  if (!target.startsWith(packFolder + path.sep)) throw new Error('invalid-pack-document-path');
  return target;
}

function auditRoot(root) {
  root = path.resolve(root);
  const collections = new Set();
  const report = {
    schemaVersion: 'pdf-sat-latex-review/1',
    createdAt: new Date().toISOString(), root: path.relative(ROOT, root),
    policy: 'frontend-strict-with-classified-unicode-warnings',
    totals: {collectionCount: 0, packCount: 0, itemCount: 0, markdownCount: 0,
      formulaCount: 0, parseErrorCount: 0, documentErrorCount: 0, unicodeWarningCount: 0,
      warningFragmentCount: 0, unmatchedDollarCount: 0},
    errorCounts: {}, warningCounts: {}, errors: [], warnings: [], unmatchedDollars: []
  };
  function recordError(entry) {
    report.errors.push(entry);
    report.errorCounts[entry.code] = (report.errorCounts[entry.code] || 0) + 1;
  }
  for (const folder of packFolders(root)) {
    const relative = path.relative(root, folder).split(path.sep).join('/');
    const collectionId = relative.split('/')[0];
    collections.add(collectionId);
    report.totals.packCount++;
    let pack;
    try { pack = JSON.parse(fs.readFileSync(path.join(folder, 'pack.json'), 'utf8')); }
    catch {
      report.totals.documentErrorCount++;
      recordError({collectionId, pack: relative, code: 'unreadable-pack-manifest'});
      continue;
    }
    // The cache is bounded to one pack and stores no text in the final report.
    const cache = new Map();
    for (const kind of ['items', 'solutions']) {
      let document;
      try { document = JSON.parse(fs.readFileSync(localDocument(folder, pack.files[kind]), 'utf8')); }
      catch {
        report.totals.documentErrorCount++;
        recordError({collectionId, packId: pack.id, document: kind, code: 'unreadable-pack-document'});
        continue;
      }
      const rows = document[kind];
      if (!Array.isArray(rows)) {
        report.totals.documentErrorCount++;
        recordError({collectionId, packId: pack.id, document: kind, code: 'missing-document-array'});
        continue;
      }
      if (kind === 'items') report.totals.itemCount += rows.length;
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index];
        const base = {collectionId, packId: pack.id, itemId: row.id || row.itemId || null, document: kind};
        for (const field of markdownFields(row, `/${kind}/${index}`)) {
          report.totals.markdownCount++;
          const {fragments, unmatched} = extractMathFragments(field.text);
          for (const offset of unmatched) {
            report.unmatchedDollars.push({...base, field: field.location, offset});
            report.totals.unmatchedDollarCount++;
          }
          for (let fragmentIndex = 0; fragmentIndex < fragments.length; fragmentIndex++) {
            const fragment = fragments[fragmentIndex];
            report.totals.formulaCount++;
            const digest = hash(`${fragment.display ? 'display' : 'inline'}:${fragment.text}`);
            let result = cache.get(digest);
            if (!result) { result = validateFormula(fragment.text, fragment.display); cache.set(digest, result); }
            const location = {...base, field: field.location, fragmentIndex,
              startOffset: fragment.start, endOffset: fragment.end, formulaSha256: digest,
              formulaLength: fragment.text.length, displayMode: fragment.display};
            if (!result.ok) {
              report.totals.parseErrorCount++;
              recordError({...location, code: result.code, position: result.position, length: result.length});
            }
            if (result.warnings.length) {
              report.totals.warningFragmentCount++;
              report.warnings.push({...location, codes: result.warnings});
              for (const code of result.warnings) {
                report.warningCounts[code] = (report.warningCounts[code] || 0) + 1;
                if (code === 'unicodeTextInMathMode' || code === 'unknownSymbol') report.totals.unicodeWarningCount++;
              }
            }
          }
        }
      }
    }
  }
  report.totals.collectionCount = collections.size;
  report.ok = report.totals.parseErrorCount === 0 && report.totals.documentErrorCount === 0;
  return report;
}

function main(args) {
  let root = DEFAULT_ROOT, reportPath = DEFAULT_REPORT;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root' && args[i + 1]) root = path.resolve(args[++i]);
    else if (args[i] === '--report' && args[i + 1]) reportPath = path.resolve(args[++i]);
    else throw new Error('Usage: review_pdf_latex.cjs [--root path] [--report path]');
  }
  const report = auditRoot(root);
  fs.mkdirSync(path.dirname(reportPath), {recursive: true});
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ok: report.ok, ...report.totals, errorCounts: report.errorCounts,
    warningCounts: report.warningCounts, report: path.relative(ROOT, reportPath)}, null, 2));
  process.exitCode = report.ok ? 0 : 1;
}

module.exports = {extractMathFragments, validateFormula, auditRoot};
if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    console.error(error instanceof Error && error.message.startsWith('Usage:') ? error.message : 'LaTeX audit could not read the requested source.');
    process.exitCode = 2;
  }
}
