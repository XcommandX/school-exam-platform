import { readFile, mkdir, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const version = 'toefl-task/1';
const schema = JSON.parse(await readFile(new URL('../schemas/task.schema.json', import.meta.url), 'utf8'));
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
export const taskKey = task => `${task.module}:${task.id}`;
const fail = (where, message) => { throw new Error(`${where}: ${message}`); };
function matches(value, type) {
  return type === 'null' ? value === null : type === 'array' ? Array.isArray(value) : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) : type === 'integer' ? Number.isSafeInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === type;
}
// Deliberately bounded schema subset; schema keywords are checked by tests.
function check(value, rule, where) {
  if (rule.$ref) rule = schema.$defs[rule.$ref.split('/').at(-1)];
  if (rule.type && ![].concat(rule.type).some(type => matches(value, type))) fail(where, `expected ${rule.type}`);
  if (rule.const !== undefined && value !== rule.const) fail(where, 'unsupported format version');
  if (rule.enum && !rule.enum.includes(value)) fail(where, 'unsupported value');
  if (typeof value === 'string' && ((rule.minLength && value.length < rule.minLength) || (rule.pattern && !new RegExp(rule.pattern).test(value)))) fail(where, 'invalid text');
  if (typeof value === 'number' && rule.minimum !== undefined && value < rule.minimum) fail(where, 'value is below minimum');
  if (Array.isArray(value)) {
    if (rule.minItems && value.length < rule.minItems) fail(where, 'empty list');
    if (rule.items) value.forEach((item, i) => check(item, rule.items, `${where}[${i}]`));
  } else if (value && typeof value === 'object') {
    for (const key of rule.required || []) if (!own(value, key)) fail(where, `missing ${key}`);
    for (const [key, item] of Object.entries(value)) {
      if (rule.properties && own(rule.properties,key)) check(item, rule.properties[key], `${where}.${key}`);
      else if (rule.additionalProperties === false) fail(where, `unknown field ${key}`);
    }
  }
}
function contentOnly(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:password|passwordHash|accessToken|authToken|secret|userId|username|response|recordings|attempts|history|aiScores|wordState)$/i.test(key)) fail(key, 'personal/runtime data is forbidden');
    contentOnly(child);
  }
}
const kinds = { 'reading-t1':'complete_word', 'reading-t2':'choice_question', 'reading-t3':'choice_question', 'listening-t1':'choice_question', 'listening-t2':'choice_question', 'listening-t3':'choice_question', 'listening-t4':'choice_question', 'speaking-t1':'repeat', 'speaking-t2':'interview', 'writing-t1':'build_sentence', 'writing-t2':['email','write_email'], 'writing-t3':['discussion','academic_discussion'] };
export function validateTask(document) {
  check(document, schema, 'task'); contentOnly(document);
  const r = document.task, ids = new Set();
  for (const q of r.items) {
    if (ids.has(q.id)) fail(taskKey(r), 'duplicate question ID'); ids.add(q.id);
    if (![].concat(kinds[r.module]).includes(q.kind)) fail(q.id, 'question kind does not match module');
    if (q.kind === 'complete_word') {
      for (const key of ['prefix','missingLetters','answer']) if (typeof q[key] !== 'string') fail(q.id, `missing ${key}`);
      if (q.prefix + q.missingLetters !== q.answer) fail(q.id, 'prefix and missing letters do not reconstruct answer');
    }
    if (q.kind === 'choice_question') {
      if (!q.choices?.length || !q.choices.some(c => c.id === q.answer) || new Set(q.choices.map(c => c.id)).size !== q.choices.length) fail(q.id, 'invalid choices or answer');
    }
    if (q.kind === 'build_sentence' && (!Array.isArray(q.tokens) || !q.sentence_parts?.some(p => p.type === 'blank') || !q.answer_text)) fail(q.id, 'sentence template, tokens and answer_text are required');
  }
  for (const part of r.content || []) if (part.kind !== 'text' && part.item_id && !ids.has(part.item_id)) fail(r.id, 'gap references unknown question');
  for (const range of [...(r.audioRanges || []), ...(r.transcriptSentences || [])].filter(Boolean)) if (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start < 0 || range.end <= range.start) fail(r.id, 'invalid audio range');
  for (const ref of assetReferences(r)) safeAsset(ref);
  return document;
}
export function assetReferences(r) {
  return [...new Set([r.audio, ...r.items.flatMap(q => [q.audio_url, q.visual_asset_url])].filter(Boolean))];
}
function safeAsset(ref) {
  if (typeof ref !== 'string') fail('asset', 'path must be text');
  if (/^https:\/\//.test(ref)) return;
  if (!/^(audio|images)\/[A-Za-z0-9_.\/-]+$/.test(ref) || ref.split('/').some(s => !s || s === '..' || s === '.')) fail('asset', 'unsafe asset path');
}
function safeRelative(ref) {
  if (typeof ref !== 'string' || ref.includes('\\') || ref.includes(':') || ref.startsWith('/') || ref.split('/').some(s => !s || s === '..' || s === '.')) fail('library', 'unsafe task path');
  return ref;
}
async function noLinks(root, ref) {
  let current = root;
  for (const part of safeRelative(ref).split('/')) { current = path.join(current, part); if ((await lstat(current)).isSymbolicLink()) fail(ref, 'symbolic links are forbidden'); }
  return current;
}
const dump = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag:'wx', mode:0o600 });
export async function exportBank(bank, destination) {
  if (!bank || !Array.isArray(bank.records)) fail('bank', 'records array required');
  for (const key of Object.keys(bank)) if (!['records','fixture','coverage','vocab','vocabGroups','vocabularyMetadata','generatedAt','source'].includes(key)) fail('bank',`unknown metadata ${key}`);
  const entries = [], seen = new Set();
  // Validate everything before creating the output folder.
  const documents = bank.records.map(task => {
    const document = validateTask({formatVersion:version, task:structuredClone(task)}), key = taskKey(task);
    if (seen.has(key)) fail(key, 'duplicate task ID; date versions must have distinct source IDs'); seen.add(key);
    const name = createHash('sha256').update(task.id).digest('hex').slice(0,24);
    entries.push({key, path:`tasks/${task.module}/${name}.json`}); return document;
  });
  await mkdir(destination, { mode:0o700 });
  for (let i=0;i<documents.length;i++) { const file=path.join(destination,entries[i].path);await mkdir(path.dirname(file),{recursive:true,mode:0o700});await dump(file,documents[i]); }
  const {records,...metadata}=bank;await dump(path.join(destination,'library.json'),{formatVersion:'toefl-library/1',metadata,tasks:entries});
  return {tasks:documents.length,parts:documents.reduce((n,d)=>n+d.task.items.length,0)};
}
export async function importBank(root, {assetRoot}={}) {
  const manifest=JSON.parse(await readFile(await noLinks(root,'library.json'),'utf8'));
  if (manifest.formatVersion !== 'toefl-library/1' || !Array.isArray(manifest.tasks) || !manifest.metadata || own(manifest.metadata,'records')) fail('library','invalid manifest');
  for (const key of Object.keys(manifest.metadata)) if (!['fixture','coverage','vocab','vocabGroups','vocabularyMetadata','generatedAt','source'].includes(key)) fail('library',`unknown metadata ${key}`);
  const records=[],keys=new Set(),paths=new Set(),assets=new Set();
  for (const entry of manifest.tasks) {
    safeRelative(entry.path);
    if (keys.has(entry.key) || paths.has(entry.path)) fail('library','duplicate task or file'); keys.add(entry.key); paths.add(entry.path);
    const document=validateTask(JSON.parse(await readFile(await noLinks(root,entry.path),'utf8')));
    if (taskKey(document.task)!==entry.key) fail(entry.path,'task identity changed');
    for (const ref of assetReferences(document.task)) { assets.add(ref);if (assetRoot && !/^https:/.test(ref) && !(await lstat(await noLinks(assetRoot,ref))).isFile()) fail(ref,'missing asset'); }
    records.push(document.task);
  }
  return {bank:{...manifest.metadata,records},report:{tasks:records.length,parts:records.reduce((n,r)=>n+r.items.length,0),assets:assets.size,checkedLocalAssets:!!assetRoot}};
}
export const schemaPath=fileURLToPath(new URL('../schemas/task.schema.json',import.meta.url));
