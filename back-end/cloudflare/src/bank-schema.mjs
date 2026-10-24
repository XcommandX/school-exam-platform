// Privacy-filtered v1 compatibility port of shared/question_schema.py.
// This is NOT the new SAT pack schema. No attempts, account fields, arbitrary
// metadata, or original filenames are copied into a normalized document.
import { createHash } from 'node:crypto';
import { InputError, ProjectedJSON, fail } from './json-stream.mjs';

export const EXAMS = Object.freeze(['sat', 'ap', 'toefl', 'vocab']);
export const SCHEMA_VERSION = 1;
export const FORMAT_KINDS = Object.freeze(['underline', 'italic', 'bold']);
export const SAFE_METADATA = Object.freeze({
  sourceExamId: 'string', sourceQuestionId: 'string-or-integer', sourceModule: 'integer',
  sourceQuestionNumberInModule: 'integer', sourceQuestionNumber: 'integer',
  sourceQuestionType: 'string', sourceSection: 'string', sourceTableImageAsset: 'string',
});
export const SET_FIELDS = Object.freeze([
  'schemaVersion', 'exam', 'id', 'title', 'section', 'defaultDurationSeconds',
  'moduleQuestionCounts', 'moduleDurationsSeconds', 'questions',
]);
export const QUESTION_FIELDS = Object.freeze([
  'id', 'section', 'passage', 'passageFormatting', 'passageStyle', 'prompt',
  'promptFormatting', 'options', 'optionsFormatting', 'correctOption', 'questionType',
  'explanation', 'aiExplanation', 'visualStimulus', 'answerProvenance',
  'agentSuggestedAnswer', 'customMetadata', 'moduleIndex', 'questionNumberInModule',
]);
export const VISUAL_FIELDS = Object.freeze(['type', 'position', 'title', 'columns', 'rows', 'note', 'src', 'alt', 'caption']);
const rawSetFields = new Set([...SET_FIELDS, 'sourceId', 'durationSeconds', 'durationMinutes']);
const rawQuestionFields = new Set([...QUESTION_FIELDS, 'answer', 'passageMarkdown', 'metadata']);
const own = (value, key) => Object.hasOwn(value, key);
const get = (value, key, fallback = null) => own(value, key) ? value[key] : fallback;
export const isRecord = value => value !== null && typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const strip = value => value.replace(/^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu, '');
const wellFormed = value => value.isWellFormed ? value.isWellFormed() : !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(value);
const invalid = message => fail(message, 400, 'invalid_question_bank');
const isInteger = value => typeof value === 'number' && Number.isSafeInteger(value);

// JSON.parse loses Python's distinction between 1 and 1.0. Retain float tokens
// while reading input so integer-only fields reject 1.0/1e0 just as Python does,
// and fallback source IDs hash Python's float spelling, including -0.0.
class PythonFloat extends Number {}
const numeric = value => value instanceof PythonFloat ? value.valueOf() : value;
export class BankJSON extends ProjectedJSON {
  constructor(options = {}) { super({ maxCapturedString: 20 * 1024 * 1024, ...options }); }
  retain(weight) {
    this.retainedWeight += weight;
    // A 20MiB compatibility text string alone costs 40MiB in the conservative
    // UTF-16 accounting. Keep this bank-only budget bounded, but not the 24MiB
    // account projection limit which would incorrectly reject legacy imports.
    if (this.retainedWeight > 48 * 1024 * 1024) this.bad('题库结构过于复杂，请拆分 JSON 文件后重试。');
  }
  finishScalar() {
    const wasNumber = this.mode === 'number', literal = this.literal;
    if (wasNumber && /^-?(?:0|[1-9]\d*)$/.test(literal) && !Number.isSafeInteger(Number(literal))) {
      this.bad('JSON 整数超过 JavaScript 安全范围，不能无损导入。');
    }
    const parent = this.stack.at(-1), { keep } = this.scalar;
    const key = parent?.kind === 'object' ? parent.key : parent?.count;
    super.finishScalar();
    if (wasNumber && /[.eE]/.test(literal) && keep) {
      const value = new PythonFloat(Number(literal));
      if (!parent) this.root = value;
      else if (parent.keep) parent.value[key] = value;
    }
  }
}

// Project away private branches even before normalization, but still validate
// the entire JSON (including duplicate keys in branches we intentionally omit).
export function bankProjection(path) {
  if (!path.length) return true;
  if (!rawSetFields.has(path[0])) return false;
  if (path[0] !== 'questions' || path.length < 3) return true;
  if (!rawQuestionFields.has(path[2])) return false;
  if (['customMetadata', 'metadata'].includes(path[2]) && path.length > 3) return own(SAFE_METADATA, path[3]);
  if (path[2] === 'visualStimulus' && path.length > 3) return VISUAL_FIELDS.includes(path[3]);
  return true;
}
export function parseBankJSON(text, { project = true } = {}) {
  if (typeof text !== 'string' || !wellFormed(text)) invalid('Question content must be valid Unicode JSON text.');
  const parser = new BankJSON({ select: project ? bankProjection : () => true });
  // Avoid a second, whole-document UTF-8 allocation. Do not split a surrogate.
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + 32768, text.length);
    if (end < text.length && /[\ud800-\udbff]/.test(text[end - 1])) end--;
    parser.write(new TextEncoder().encode(text.slice(start, end)));
    start = end;
  }
  return parser.end();
}

function text(value, name, nonempty = false) {
  if (typeof value !== 'string' || !wellFormed(value) || nonempty && !strip(value)) {
    invalid(`${name} must be ${nonempty ? 'non-empty ' : ''}text.`);
  }
  return value;
}
function number(value, name, minimum = 1) {
  const n = numeric(value);
  if (typeof n !== 'number' || !Number.isFinite(n) || n < minimum) {
    invalid(`${name} must be a finite number of at least ${minimum}.`);
  }
  return n;
}
function integer(value, name, minimum = 0) {
  if (!isInteger(value) || value < minimum) invalid(`${name} must be an integer of at least ${minimum}.`);
  return value;
}
function formatting(value, content, name) {
  if (value === null) return [];
  if (!Array.isArray(value)) invalid(`${name} must be an array.`);
  return value.map(span => {
    if (!isRecord(span) || !FORMAT_KINDS.includes(span.kind) || !isInteger(span.start) || !isInteger(span.end) ||
        !(0 <= span.start && span.start < span.end && span.end <= content.length)) invalid(`${name} has an invalid text range.`);
    return { start: span.start, end: span.end, kind: span.kind };
  });
}
function markdown(source) {
  // Python re.M anchors only after LF; JS /m also anchors after CR/U+2028/U+2029.
  source = source.replace(/(^|\n)[-+] /g, '$1• ');
  let content = '', last = 0;
  const spans = [], stack = [];
  for (const match of source.matchAll(/(<u>|<\/u>|\*\*|\*)/g)) {
    content += source.slice(last, match.index); last = match.index + match[0].length;
    const token = match[0], kind = token.includes('u>') ? 'underline' : token === '**' ? 'bold' : 'italic';
    if (stack.length && stack.at(-1).kind === kind) {
      const opened = stack.pop(); spans.push({ start: opened.start, end: content.length, kind });
    } else if (token !== '</u>') stack.push({ kind, start: content.length });
  }
  content += source.slice(last);
  if (stack.length) invalid('Unclosed passage Markdown emphasis.');
  return [content, formatting(spans, content, 'passageFormatting')];
}
export function validAssetPath(value) {
  if (typeof value !== 'string' || !wellFormed(value)) return false;
  // Python re.I includes these Unicode equivalents of ASCII i/s/k.
  const folded = value.replace(/[İı]/g, 'i').replace(/ſ/g, 's').replace(/K/g, 'k');
  return /^question-assets\/(?:[^/\\\x00-\x1f?#%:]+\/)*[^/\\\x00-\x1f?#%:]+\.(?:png|jpe?g|webp|gif|svg)$(?![\s\S])/i.test(folded) &&
    !value.split('/').some(part => part === '.' || part === '..');
}
function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  return numeric(value);
}
function visual(value) {
  if (value === null) return null;
  if (!isRecord(value) || !['table', 'image', 'chart'].includes(value.type)) invalid('visualStimulus.type must be table, chart, or image.');
  const result = Object.fromEntries(Object.entries(value).filter(([key]) => VISUAL_FIELDS.includes(key)).map(([key, item]) => [key, clone(item)]));
  if (!own(result, 'position')) result.position = 'before-passage';
  if (!['before-passage', 'after-passage'].includes(result.position)) invalid('Invalid visualStimulus.position.');
  for (const key of ['title', 'note', 'alt', 'caption']) if (own(result, key)) text(result[key], 'visualStimulus.' + key);
  if (result.type === 'table') {
    const { columns, rows } = result;
    if (!Array.isArray(columns) || !columns.length || columns.some(c => typeof c !== 'string') ||
        !Array.isArray(rows) || !rows.length || rows.some(row => !Array.isArray(row) || row.length !== columns.length || row.some(c => typeof c !== 'string'))) {
      invalid('A table needs text columns and matching text rows.');
    }
    for (const c of columns) text(c, 'visualStimulus.columns');
    for (const row of rows) for (const c of row) text(c, 'visualStimulus.rows');
    return Object.fromEntries(Object.entries(result).filter(([key]) => !['src', 'alt', 'caption'].includes(key)));
  }
  if (!validAssetPath(result.src)) invalid('Image src must be a local path inside question-assets/.');
  text(result.alt, 'visualStimulus.alt', true);
  return Object.fromEntries(Object.entries(result).filter(([key]) => !['columns', 'rows', 'note', 'title'].includes(key)));
}
function metadata(value) {
  if (value === null) return {};
  if (!isRecord(value)) invalid('customMetadata must be an object.');
  const result = {};
  for (const [key, type] of Object.entries(SAFE_METADATA)) {
    if (!own(value, key)) continue;
    const item = value[key], stringOK = typeof item === 'string' && wellFormed(item), integerOK = isInteger(item);
    if (!(type === 'string' ? stringOK : type === 'integer' ? integerOK : stringOK || integerOK)) invalid(`Invalid customMetadata.${key}.`);
    if (key === 'sourceTableImageAsset' && !validAssetPath(item)) invalid('Invalid sourceTableImageAsset path.');
    result[key] = item;
  }
  return result;
}
const namespaced = (value, prefix) => typeof value === 'string' && value.startsWith(prefix + ':') &&
  value.length > prefix.length + 1 && !/[^a-zA-Z0-9._-]/.test(value.slice(prefix.length + 1));
function roundEven(value) {
  const lower = Math.floor(value), fraction = value - lower;
  const result = fraction < 0.5 ? lower : fraction > 0.5 ? lower + 1 : lower % 2 === 0 ? lower : lower + 1;
  if (!Number.isSafeInteger(result)) invalid('Duration exceeds the safe integer range.');
  return result;
}

// Python sorts Unicode keys by code point, not UTF-16 code unit.
const compareKeys = (a, b) => {
  const aa = Array.from(a), bb = Array.from(b);
  for (let i = 0; i < Math.min(aa.length, bb.length); i++) {
    if (aa[i] !== bb[i]) return aa[i].codePointAt(0) - bb[i].codePointAt(0);
  }
  return aa.length - bb.length;
};
function pythonFloat(value) {
  if (Object.is(value, -0)) return '-0.0';
  const negative = value < 0, absolute = Math.abs(value);
  if (!absolute) return '0.0';
  const [mantissa, power = '0'] = String(absolute).split('e');
  const dot = mantissa.indexOf('.');
  let digits = mantissa.replace('.', '');
  let exponent = Number(power) + (dot < 0 ? mantissa.length : dot) - 1;
  while (digits[0] === '0') { digits = digits.slice(1); exponent--; }
  digits = digits.replace(/0+$/, '') || '0';
  let result;
  if (exponent < -4 || exponent >= 16) {
    result = digits[0] + (digits.length > 1 ? '.' + digits.slice(1) : '') + 'e' +
      (exponent < 0 ? '-' : '+') + String(Math.abs(exponent)).padStart(2, '0');
  } else if (exponent < 0) result = '0.' + '0'.repeat(-exponent - 1) + digits;
  else if (digits.length <= exponent + 1) result = digits + '0'.repeat(exponent + 1 - digits.length) + '.0';
  else result = digits.slice(0, exponent + 1) + '.' + digits.slice(exponent + 1);
  return (negative ? '-' : '') + result;
}

/** Yield small JSON fragments, never stringify an entire bank/string at once.
 * python=true is json.dumps(ensure_ascii=False, sort_keys=True)'s default spaces.
 * Other mode is deterministic compact JSON used for document-hash deduplication.
 */
export function* jsonFragments(value, { python = false, sortKeys = true } = {}) {
  const options = { python, sortKeys }, comma = python ? ', ' : ',', colon = python ? ': ' : ':';
  if (typeof value === 'string') {
    if (!wellFormed(value)) invalid('JSON contains invalid Unicode.');
    yield '"';
    for (let start = 0; start < value.length;) {
      let end = Math.min(start + 16384, value.length);
      if (end < value.length && /[\ud800-\udbff]/.test(value[end - 1])) end--;
      yield JSON.stringify(value.slice(start, end)).slice(1, -1); start = end;
    }
    yield '"';
  } else if (value === null || typeof value === 'boolean') yield JSON.stringify(value);
  else if (typeof value === 'number' || value instanceof PythonFloat) {
    const n = numeric(value);
    if (!Number.isFinite(n)) invalid('JSON numbers must be finite.');
    yield python && (value instanceof PythonFloat || !Number.isInteger(n)) ? pythonFloat(n) : JSON.stringify(n);
  } else if (Array.isArray(value)) {
    yield '[';
    for (let i = 0; i < value.length; i++) { if (i) yield comma; yield* jsonFragments(value[i], options); }
    yield ']';
  } else if (isRecord(value)) {
    yield '{'; const keys = Object.keys(value); if (sortKeys) keys.sort(compareKeys);
    for (let i = 0; i < keys.length; i++) {
      if (i) yield comma; yield* jsonFragments(keys[i], options); yield colon; yield* jsonFragments(value[keys[i]], options);
    }
    yield '}';
  } else invalid('Only valid JSON values are accepted.');
}
export function pythonJSON(value) { return [...jsonFragments(value, { python: true })].join(''); }
export function documentHash(value) {
  const hash = createHash('sha256');
  for (const part of jsonFragments(value)) hash.update(part, 'utf8');
  return hash.digest('hex');
}

export function normalizeQuestionSet(data, exam = 'sat', sourceKey = null) {
  if (!EXAMS.includes(exam)) invalid('Unsupported exam.');
  if (!isRecord(data) || !Array.isArray(data.questions) || !data.questions.length) invalid('A non-empty questions array is required.');
  if (get(data, 'schemaVersion') !== null && (!isInteger(data.schemaVersion) || data.schemaVersion !== SCHEMA_VERSION)) invalid('Unsupported schema version.');
  if (get(data, 'exam', exam) !== exam) invalid('Question set belongs to another exam.');
  const title = text(get(data, 'title', 'Untitled question set'), 'title', true);
  const section = text(get(data, 'section', exam === 'sat' ? 'Reading and Writing' : ''), 'section');
  if (exam === 'sat' && section !== 'Reading and Writing') invalid('The SAT engine currently supports Reading and Writing.');
  const canonicalId = get(data, 'schemaVersion') === SCHEMA_VERSION ? get(data, 'id') : get(data, 'sourceId');
  if (canonicalId !== null && !namespaced(canonicalId, exam)) invalid('Source ID must use the selected exam namespace.');
  let sourceId = canonicalId;
  if (sourceId === null) {
    const hash = createHash('sha256');
    if (sourceKey === null) {
      const identity = { title, section, questions: data.questions.map(q => isRecord(q) ? Object.fromEntries(
        ['passage', 'passageMarkdown', 'prompt', 'options', 'answer', 'correctOption'].map(key => [key, get(q, key)])) : null) };
      for (const part of jsonFragments(identity, { python: true })) hash.update(part, 'utf8');
    } else hash.update(text(sourceKey, 'source_key'), 'utf8');
    sourceId = exam + ':' + hash.digest('hex').slice(0, 12);
  }
  let duration = get(data, 'defaultDurationSeconds', get(data, 'durationSeconds'));
  if (duration === null) duration = own(data, 'durationMinutes') ? number(data.durationMinutes, 'durationMinutes') * 60 : 1920;
  duration = roundEven(number(duration, 'defaultDurationSeconds'));
  const result = { schemaVersion: SCHEMA_VERSION, exam, id: sourceId, title, section, defaultDurationSeconds: duration, questions: [] };
  const counts = get(data, 'moduleQuestionCounts');
  if (counts !== null) {
    if (!Array.isArray(counts) || !counts.length || counts.some(n => !isInteger(n) || n < 1) || counts.reduce((a, b) => a + b, 0) !== data.questions.length) {
      invalid('moduleQuestionCounts must add up to the question count.');
    }
    result.moduleQuestionCounts = [...counts];
  }
  const durations = get(data, 'moduleDurationsSeconds');
  if (durations !== null) {
    if (!Array.isArray(durations) || !durations.length) invalid('moduleDurationsSeconds must be a non-empty array.');
    for (const value of durations) {
      number(value, 'moduleDurationsSeconds', 60);
      if (exam === 'sat' && numeric(value) > 3840) invalid('SAT module duration must not exceed 3840 seconds.');
    }
    if (counts && durations.length !== counts.length) invalid('Module duration/count arrays must have the same length.');
    result.moduleDurationsSeconds = durations.map(numeric);
  }
  const questionIds = new Set(); let module = 0, moduleOffset = 0;
  for (const [index, raw] of data.questions.entries()) {
    if (!isRecord(raw)) invalid(`Question ${index + 1} must be an object.`);
    const prompt = text(get(raw, 'prompt'), 'prompt', true), options = get(raw, 'options');
    if (!Array.isArray(options) || options.length < 2 || exam === 'sat' && options.length !== 4) invalid('Options need four choices for SAT, at least two for other exams.');
    for (const option of options) text(option, 'option', true);
    let answer = get(raw, 'correctOption', get(raw, 'answer'));
    if (typeof answer === 'string' && answer.length === 1 && /^[A-Z]$/.test(answer)) answer = answer.charCodeAt(0) - 65;
    if (!isInteger(answer) || answer < 0 || answer >= options.length) invalid('correctOption must identify one of the choices.');
    let passage = text(get(raw, 'passage', ''), 'passage'), passageFormatting;
    if (own(raw, 'passageMarkdown')) [passage, passageFormatting] = markdown(text(raw.passageMarkdown, 'passageMarkdown'));
    else passageFormatting = formatting(get(raw, 'passageFormatting'), passage, 'passageFormatting');
    const style = get(raw, 'passageStyle', 'prose');
    if (!['prose', 'poetry', 'literary'].includes(style)) invalid('Invalid passageStyle.');
    const optionFormatting = get(raw, 'optionsFormatting', options.map(() => []));
    if (!Array.isArray(optionFormatting) || optionFormatting.length !== options.length) invalid('optionsFormatting must match the options count.');
    let questionId = canonicalId !== null ? get(raw, 'id') : null;
    if (!namespaced(questionId, sourceId)) questionId = `${sourceId}:q${String(index + 1).padStart(4, '0')}`;
    if (questionIds.has(questionId)) invalid('Question IDs must be unique.');
    questionIds.add(questionId);
    const question = {
      id: questionId, section: text(get(raw, 'section', section), 'question.section'), passage, passageFormatting, passageStyle: style,
      prompt, promptFormatting: formatting(get(raw, 'promptFormatting'), prompt, 'promptFormatting'), options: [...options],
      optionsFormatting: optionFormatting.map((v, i) => formatting(v, options[i], 'optionsFormatting')),
      correctOption: answer, questionType: text(get(raw, 'questionType', ''), 'questionType'),
      explanation: text(get(raw, 'explanation', ''), 'explanation'), aiExplanation: text(get(raw, 'aiExplanation', ''), 'aiExplanation'),
      visualStimulus: visual(get(raw, 'visualStimulus')), customMetadata: metadata(get(raw, 'customMetadata', get(raw, 'metadata'))),
    };
    for (const key of ['answerProvenance', 'agentSuggestedAnswer']) if (own(raw, key)) {
      if (!(key === 'answerProvenance' ? ['source', 'agent'] : ['A', 'B', 'C', 'D']).includes(raw[key])) invalid(`Invalid ${key}.`);
      question[key] = raw[key];
    }
    if (counts) {
      while (index >= moduleOffset + counts[module]) { moduleOffset += counts[module]; module++; }
      question.moduleIndex = module; question.questionNumberInModule = index - moduleOffset + 1;
    } else if (own(raw, 'moduleIndex')) {
      question.moduleIndex = integer(raw.moduleIndex, 'moduleIndex');
      if (own(raw, 'questionNumberInModule')) question.questionNumberInModule = integer(raw.questionNumberInModule, 'questionNumberInModule', 1);
    }
    result.questions.push(question);
  }
  return result;
}
function equalJSON(a, b) {
  if (numeric(a) === numeric(b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equalJSON(v, b[i]));
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(k => own(b, k) && equalJSON(a[k], b[k]));
  }
  return false;
}
export function validateQuestionSet(data) {
  if (!isRecord(data) || Object.keys(data).some(k => !SET_FIELDS.includes(k))) invalid('Unknown question-set fields.');
  if (!isInteger(data.schemaVersion) || data.schemaVersion !== SCHEMA_VERSION || !EXAMS.includes(data.exam)) invalid('Expected canonical question-set schema v1.');
  if (!namespaced(data.id, data.exam)) invalid('Question set ID must use its exam namespace.');
  if (!Array.isArray(data.questions) || !data.questions.length) invalid('A non-empty questions array is required.');
  for (const question of data.questions) {
    if (!isRecord(question) || Object.keys(question).some(k => !QUESTION_FIELDS.includes(k))) invalid('Unknown question fields.');
    const meta = get(question, 'customMetadata', {}), vis = get(question, 'visualStimulus');
    if (!isRecord(meta) || Object.keys(meta).some(k => !own(SAFE_METADATA, k))) invalid('Unapproved question metadata.');
    if (isRecord(vis) && Object.keys(vis).some(k => !VISUAL_FIELDS.includes(k))) invalid('Unapproved visual fields.');
  }
  if (!equalJSON(normalizeQuestionSet(data, data.exam), data)) invalid('Question set is incomplete or not in canonical form.');
}
export function toSATLegacy(data) {
  validateQuestionSet(data);
  if (data.exam !== 'sat') invalid('The SAT adapter accepts SAT question sets only.');
  const result = { id: data.id, sourceId: data.id, title: data.title, section: data.section, durationSeconds: data.defaultDurationSeconds, questions: [] };
  for (const key of ['moduleQuestionCounts', 'moduleDurationsSeconds']) if (own(data, key)) result[key] = clone(data[key]);
  for (const question of data.questions) {
    const legacy = clone(question); legacy.answer = legacy.correctOption; delete legacy.correctOption; result.questions.push(legacy);
  }
  return result;
}
export function referencedAssets(data) {
  const result = new Set();
  for (const question of data.questions) {
    if (question.visualStimulus?.src) result.add(question.visualStimulus.src);
    if (question.customMetadata?.sourceTableImageAsset) result.add(question.customMetadata.sourceTableImageAsset);
  }
  return result;
}
// Python spellings make cross-language contract fixtures straightforward.
export { normalizeQuestionSet as normalize_question_set, validateQuestionSet as validate_question_set,
  toSATLegacy as to_sat_legacy, validAssetPath as valid_asset_path, referencedAssets as referenced_assets, InputError };
