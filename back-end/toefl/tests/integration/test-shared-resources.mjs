import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkResources, validate } from '../../scripts/check-resources.mjs';

const baseBank = JSON.parse(await readFile(new URL('../../fixtures/anonymous-bank.json', import.meta.url), 'utf8'));
const root = await mkdtemp(path.join(tmpdir(), 'toefl-shared-resources-'));
const resourceRoot = path.join(root, 'bank'), content = new Map([
  ['audio/fixture-tone.wav', Buffer.from('anonymous synthetic audio bytes')],
  ['images/fixture-scene.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
]);
baseBank.records[0].items[0].prompt_text = 'The article discusses password protection, a user response, and learning history.';
baseBank.records[0].items[0].audio_key = 'audio/generated/source-only.mp3';
baseBank.vocabGroups[0].formLabels = { responses: 'plural', history: 'noun' };
let bank, manifest;
async function reset() {
  await rm(resourceRoot, { recursive: true, force: true });
  await mkdir(resourceRoot, { recursive: true });
  bank = structuredClone(baseBank);
  manifest = { schema_version: 1, kind: 'toefl-shared-bank', bank: 'bank.json', files: [],
    counts: { records: bank.records.length, questions: bank.records.reduce((sum, record) => sum + record.items.length, 0), audio: 1, images: 1 },
    source: { kind: 'anonymous-fixture' } };
  for (const [name, bytes] of new Map([['bank.json', Buffer.from(JSON.stringify(bank))], ...content])) {
    await mkdir(path.dirname(path.join(resourceRoot, name)), { recursive: true });
    await writeFile(path.join(resourceRoot, name), bytes);
    manifest.files.push({ path: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  await writeFile(path.join(resourceRoot, 'RESOURCE_MANIFEST.json'), JSON.stringify(manifest));
  await writeFile(path.join(resourceRoot, 'README.md'), 'Anonymous resource check fixture.\n');
}
async function writeManifest() { await writeFile(path.join(resourceRoot, 'RESOURCE_MANIFEST.json'), JSON.stringify(manifest)); }
try {
  await reset();
  const checked = await checkResources({ resourceRoot });
  assert.deepEqual(checked.bank, bank);
  assert.deepEqual(checked.counts, manifest.counts);
  assert.deepEqual(checked.mediaPaths, [...content.keys()]);
  assert.equal(checked.files.length, 3);
  assert.deepEqual(validate(bank, manifest), manifest.counts, 'pure validation is usable without reading files');
  assert.equal(checked.mediaPaths.includes(bank.records[0].items[0].audio_key), false, 'source object keys are not local file references');
  for (const unsafe of ['../bank.json', '/audio/test.wav', 'audio/../test.wav', 'audio\\test.wav', 'audio/%2e%2e/test.wav', 'audio/.DS_Store', 'recordings/test.webm', 'audio/test.exe']) {
    const bad = structuredClone(manifest); bad.files[1].path = unsafe;
    assert.throws(() => validate(bank, bad), /unsafe|approved/);
  }
  for (const edit of [
    value => value.records.push(value.records[0]),
    value => value.records[0].items.push(value.records[0].items[0]),
    value => value.records[0].items[0].response = 'private student answer',
    value => value.records[0].items[0].access_token = 'private token',
    value => value.records[0].items[0].posts = [{ answers: { q: 'private student answer' } }],
    value => value.vocab[0].attemptId = 'private-attempt',
    value => value.records[0].items[0].prompt_text = 'gh' + 'p_' + 'a'.repeat(24),
    value => value.records[0].items[0].prompt_text = '/Us' + 'ers/example/private-source/',
    value => value.records[0].audio = 'audio/not-listed.wav',
    value => value.records[0].audio = 'images/fixture-scene.svg',
    value => value.records[0].audio = 'https://outside.invalid/audio.wav',
    value => value.history = [],
  ]) { const bad = structuredClone(bank); edit(bad); assert.throws(() => validate(bad, manifest)); }
  let bad = structuredClone(manifest); bad.counts.audio++; assert.throws(() => validate(bank, bad), /audio count/);
  bad = structuredClone(manifest); bad.files[1].bytes = 100 * 1024 * 1024; assert.throws(() => validate(bank, bad), /100 MiB/);
  bad = structuredClone(manifest); bad.files.push(bad.files[1]); assert.throws(() => validate(bank, bad), /duplicate/);
  bad = structuredClone(manifest); bad.files.push({ ...bad.files[1], path: 'audio/FIXTURE-TONE.wav' }); assert.throws(() => validate(bank, bad), /case-colliding/);
  await writeFile(path.join(resourceRoot, 'audio/unlisted.wav'), 'extra'); await assert.rejects(() => checkResources({ resourceRoot }), /not listed/);
  await reset();
  for (const folder of ['', 'audio', 'images']) await writeFile(path.join(resourceRoot, folder, '.DS_Store'), 'machine metadata');
  const withMetadata = await checkResources({ resourceRoot });
  assert.deepEqual(withMetadata.counts, manifest.counts, 'Finder metadata at every level does not block the shared build');
  assert.ok(withMetadata.files.every(entry => !entry.path.includes('.DS_Store')), 'Finder metadata is never published');
  await reset(); await mkdir(path.join(resourceRoot, '.DS_Store')); await assert.rejects(() => checkResources({ resourceRoot }), /unsafe/);
  await reset(); await symlink(path.join(resourceRoot, 'bank.json'), path.join(resourceRoot, '.DS_Store')); await assert.rejects(() => checkResources({ resourceRoot }), /symbolic/);
  await reset(); await writeFile(path.join(resourceRoot, '.unexpected'), 'unexpected hidden file'); await assert.rejects(() => checkResources({ resourceRoot }), /unsafe/);
  await reset(); await mkdir(path.join(resourceRoot, 'recordings')); await assert.rejects(() => checkResources({ resourceRoot }), /unexpected/);
  await reset(); await writeFile(path.join(resourceRoot, 'audio/fixture-tone.wav'), Buffer.alloc(content.get('audio/fixture-tone.wav').length, 7));
  await assert.rejects(() => checkResources({ resourceRoot }), /SHA-256/);
  assert.equal((await checkResources({ resourceRoot, verifyHashes: false })).counts.audio, 1, 'hash bypass is explicit and does not bypass structure checks');
  await writeFile(path.join(resourceRoot, 'audio/fixture-tone.wav'), 'wrong size'); await assert.rejects(() => checkResources({ resourceRoot, verifyHashes: false }), /byte size/);
  await reset(); await rm(path.join(resourceRoot, 'images/fixture-scene.svg')); await assert.rejects(() => checkResources({ resourceRoot }), /missing/);
  await reset(); const outside = path.join(root, 'outside.wav'); await writeFile(outside, content.get('audio/fixture-tone.wav'));
  await rm(path.join(resourceRoot, 'audio/fixture-tone.wav')); await symlink(outside, path.join(resourceRoot, 'audio/fixture-tone.wav')); await assert.rejects(() => checkResources({ resourceRoot }), /symbolic/);
  await reset(); const linkedRoot = path.join(root, 'linked'); await symlink(resourceRoot, linkedRoot); await assert.rejects(() => checkResources({ resourceRoot: linkedRoot }), /symbolic/);
  await reset(); manifest.files.splice(1, 1); manifest.counts.audio = 0; await writeManifest(); await assert.rejects(() => checkResources({ resourceRoot }), /not in the manifest/);
} finally { await rm(root, { recursive: true, force: true }); }
console.log('PASS: shared TOEFL bank structure, real media references, exact manifests, size/hash checks, no personal fields, unsafe paths or symlinks; source object keys and natural question text preserved.');
