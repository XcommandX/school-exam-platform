import { lstat, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validateTask, version } from '../content/task-format.mjs';

export const defaultResourceRoot = fileURLToPath(new URL('../../question-banks/toefl/', import.meta.url));
const manifestName = 'RESOURCE_MANIFEST.json';
const metadataFiles = new Set([manifestName, 'README.md']);
const limit = 100 * 1024 * 1024;
const audioTypes = new Set(['.mp3', '.wav', '.m4a', '.ogg', '.webm']);
const imageTypes = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (where, message) => { throw new Error(`${where}: ${message}`); };

function safePath(name) {
  if (typeof name !== 'string' || !name || /[\\:\x00-\x1f\x7f%?#]/.test(name) || path.posix.isAbsolute(name) ||
      name.split('/').some(part => !part || part.startsWith('.') || /[. ]$/.test(part))) {
    fail('resource', 'unsafe relative path');
  }
  return name;
}

function resourceKind(name) {
  safePath(name);
  if (name === 'bank.json') return 'bank';
  const directory = name.split('/')[0], extension = path.posix.extname(name).toLowerCase();
  if (directory === 'audio' && audioTypes.has(extension) && name.includes('/')) return 'audio';
  if (directory === 'images' && imageTypes.has(extension) && name.includes('/')) return 'images';
  fail(name, 'only bank.json and approved audio/images are allowed');
}

function contentBoundary(value, where = 'bank') {
  if (typeof value === 'string') {
    const rules = [
      ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
      ['access token', /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|gsk_[A-Za-z0-9_]{20,}|sk-proj-[A-Za-z0-9_-]{20,})\b/],
      ['developer home path', /\/(?:Users|home)\/[A-Za-z0-9_.-]+\/|[A-Z]:\\Users\\/],
    ];
    for (const [label, pattern] of rules) if (pattern.test(value)) fail(where, `possible ${label}`);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const wordLabels = /^bank\.vocabGroups\.\d+\.formLabels$/.test(where);
  for (const [key, child] of Object.entries(value)) {
    // Word-form labels use inflected words as keys, including “responses”.
    if (wordLabels) {
      if (typeof child !== 'string') fail(where, 'word-form labels must be text');
      contentBoundary(key, where + '.word'); contentBoundary(child, where + '.label');
      continue;
    }
    // Field names identify runtime state; words in question text remain content.
    if (/^(?:password(?:[_-]?(?:hash|salt))?|salt|secret|(?:access|auth|refresh|api|session)[_-]?token|(?:api|content)[_-]?key|session(?:Id|_id)?|user(?:Id|_id|Name|_name)|owner(?:Id|_id)|history|attempt(?:s|Id|_id)?|draft(?:s|Id|_id)?|recordings|recorded|recordingHashes|recordingCloudState|answers|responses?|selected(?:Answer|Option)|chosen(?:Answer|Option)|student(?:Id|_id|Name|_name)|aiScores|wordState|mastered|lastReviewed|lastSeen|lastLogin|conflictCopy|selfEvaluation)$/i.test(key)) {
      fail(`${where}.${key}`, 'personal/runtime field is forbidden');
    }
    contentBoundary(child, `${where}.${key}`);
  }
}

function mediaReferences(value, where = 'bank', refs = new Set()) {
  if (!value || typeof value !== 'object') return refs;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'string') {
      const localField = ['audio', 'audio_url', 'visual_asset_url'].includes(key);
      if (localField && child) {
        const kind = resourceKind(child);
        if (kind !== (key === 'visual_asset_url' ? 'images' : 'audio')) fail(`${where}.${key}`, 'media kind does not match the reference field');
        refs.add(child);
      }
    } else mediaReferences(child, `${where}.${key}`, refs);
  }
  return refs;
}

export function validate(bank, manifest) {
  if (!object(manifest) || manifest.schema_version !== 1 || manifest.kind !== 'toefl-shared-bank' ||
      manifest.bank !== 'bank.json' || !Array.isArray(manifest.files) || !manifest.files.length ||
      !object(manifest.counts) || !object(manifest.source)) fail(manifestName, 'unsupported manifest');
  contentBoundary(manifest, 'manifest');
  const names = new Set(), foldedNames = new Set(), counts = { records: 0, questions: 0, audio: 0, images: 0 };
  for (const entry of manifest.files) {
    if (!object(entry)) fail(manifestName, 'invalid file entry');
    const kind = resourceKind(entry.path), folded = entry.path.toLowerCase();
    if (names.has(entry.path) || foldedNames.has(folded)) fail(entry.path, 'duplicate or case-colliding file');
    names.add(entry.path); foldedNames.add(folded);
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes >= limit || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      fail(entry.path, 'invalid byte size or SHA-256; every file must be below 100 MiB');
    }
    if (kind !== 'bank') counts[kind]++;
  }
  if (!names.has('bank.json')) fail(manifestName, 'bank.json is not listed');
  if (!object(bank) || !Array.isArray(bank.records) || !bank.records.length) fail('bank', 'nonempty records array required');
  const allowed = new Set(['records', 'fixture', 'coverage', 'vocab', 'vocabGroups', 'vocabularyMetadata', 'generatedAt', 'source']);
  for (const [key, value] of Object.entries(bank)) {
    if (!allowed.has(key)) fail('bank', `unknown metadata ${key}`);
    if (['vocab', 'vocabGroups'].includes(key) && (!Array.isArray(value) || value.some(item => !object(item)))) fail(`bank.${key}`, 'content object array required');
    if (['coverage', 'vocabularyMetadata'].includes(key) && !object(value)) fail(`bank.${key}`, 'metadata object required');
    if (key === 'fixture' && typeof value !== 'boolean') fail('bank.fixture', 'boolean required');
    if (key === 'generatedAt' && typeof value !== 'string') fail('bank.generatedAt', 'text required');
    if (key === 'source' && typeof value !== 'string' && !object(value)) fail('bank.source', 'text or metadata object required');
  }
  contentBoundary(bank);
  const identities = new Set();
  for (const record of bank.records) {
    validateTask({ formatVersion: version, task: record });
    const identity = record.module + ':' + record.id;
    if (identities.has(identity)) fail(identity, 'duplicate task identity');
    identities.add(identity); counts.records++; counts.questions += record.items.length;
  }
  for (const ref of mediaReferences(bank)) if (!names.has(ref)) fail(ref, 'referenced media is not in the manifest');
  for (const key of Object.keys(counts)) {
    if (!Number.isSafeInteger(manifest.counts[key]) || manifest.counts[key] !== counts[key]) fail(manifestName, `incorrect ${key} count`);
  }
  return counts;
}

async function inventory(root, relative = '', names = []) {
  const current = relative ? path.join(root, relative) : root, stat = await lstat(current);
  if (stat.isSymbolicLink()) fail(relative || 'resource root', 'symbolic links are forbidden');
  // Finder metadata is not a resource and must never enter a build or manifest.
  if (path.posix.basename(relative) === '.DS_Store' && stat.isFile()) return names;
  if (stat.isDirectory()) {
    if (relative) {
      safePath(relative);
      if (!['audio', 'images'].includes(relative.split('/')[0])) fail(relative, 'unexpected resource directory');
    }
    for (const entry of await readdir(current)) await inventory(root, relative ? relative + '/' + entry : entry, names);
  } else {
    safePath(relative);
    if (!stat.isFile()) fail(relative, 'regular file required');
    if (stat.size >= limit) fail(relative, 'file must be below 100 MiB');
    if (!metadataFiles.has(relative)) resourceKind(relative);
    names.push(relative);
  }
  return names;
}

async function readJSON(file) {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readFile(file)));
}

export async function checkResources({ resourceRoot = defaultResourceRoot, verifyHashes = true } = {}) {
  const root = path.resolve(resourceRoot), actual = await inventory(root);
  const manifest = await readJSON(path.join(root, manifestName)), bank = await readJSON(path.join(root, 'bank.json'));
  const counts = validate(bank, manifest), listed = new Set(manifest.files.map(entry => entry.path));
  for (const name of actual) if (!metadataFiles.has(name) && !listed.has(name)) fail(name, 'file is not listed in the manifest');
  const present = new Set(actual);
  for (const entry of manifest.files) {
    if (!present.has(entry.path)) fail(entry.path, 'manifest file is missing');
    const file = path.join(root, entry.path), stat = await lstat(file);
    if (stat.size !== entry.bytes) fail(entry.path, 'byte size does not match manifest');
    if (verifyHashes && createHash('sha256').update(await readFile(file)).digest('hex') !== entry.sha256) fail(entry.path, 'SHA-256 does not match manifest');
  }
  return { bank, manifest, files: manifest.files, mediaPaths: manifest.files.filter(entry => entry.path !== 'bank.json').map(entry => entry.path), counts };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3 || process.argv[2]?.startsWith('--')) throw new Error('Usage: node back-end/toefl/scripts/check-resources.mjs [resource-root]');
  const result = await checkResources({ resourceRoot: process.argv[2] || defaultResourceRoot });
  console.log(`TOEFL resources: ${result.counts.records} records, ${result.counts.questions} questions, ${result.counts.audio} audio, ${result.counts.images} images; ${result.files.length} verified files.`);
}
