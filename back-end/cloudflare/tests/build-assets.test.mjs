import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { AssetWriter, MAX_ASSET_BYTES, MAX_ASSET_FILES, MAX_DATA_PART_BYTES, safeRelativePath,
  safeAssetPath, sha256, verifyBuildPaths, writeToeflData } from '../scripts/build-helpers.mjs';
import { build, browserFiles, copyBrowserFiles, repositoryRoot, staticCatalogs, trackedFiles } from '../scripts/build.mjs';

const testRoot = path.join(repositoryRoot, 'local-data/builds');
async function temporary(t) {
  await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(path.join(testRoot, 'cloudflare-test-'));
  t.after(async () => {
    assert.equal(path.dirname(root), testRoot);
    assert.ok(path.basename(root).startsWith('cloudflare-test-'));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}
async function put(root, relative, content) {
  const target = path.join(root, ...relative.split('/'));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
  return target;
}
function run(executable, args, cwd) {
  const result = spawnSync(executable, args, { cwd, stdio: 'inherit', shell: false,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' } });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${executable} ${args[0]} must succeed`);
}
const python = process.env.PYTHON || 'python';
async function readRoute(assets, descriptor) {
  return Buffer.concat(await Promise.all((descriptor.chunks || [descriptor.asset])
    .map(relative => readFile(path.join(assets, ...relative.slice(1).split('/'))))));
}

async function anonymousRepository(root) {
  const bank = JSON.parse(await readFile(new URL('../../toefl/fixtures/anonymous-bank.json', import.meta.url), 'utf8'));
  for (const { source } of browserFiles()) await put(root, source, '/* Original anonymous browser fixture. */\n');
  await put(root, 'front-end/ap/examples/synthetic-practice.json', await readFile(new URL('../../../front-end/ap/examples/synthetic-practice.json', import.meta.url)));
  await put(root, 'local-data/question-banks/ap/private.json', 'PRIVATE_DO_NOT_EXPORT_8675309');
  const apSet = JSON.parse(await readFile(new URL('../../../front-end/ap/examples/synthetic-practice.json', import.meta.url), 'utf8'));
  const apPDF = Buffer.from('%PDF-1.7\nOriginal synthetic shared AP fixture\n%%EOF\n'), apHash = sha256(apPDF);
  apSet.documents = [{ id: 'source', role: 'questions', label: 'Original synthetic PDF', asset: 'question-assets/ap/' + apHash + '.pdf', pageCount: 1 }];
  apSet.contentMode = 'private';
  for (const question of apSet.questions) { question.sourceDocument = 'source'; question.pages = [1]; }
  const apDraft = await put(root, 'ap-fixture-draft.json', JSON.stringify(apSet));
  run(python, ['-B', '-c', 'import hashlib,json,pathlib,sys; p=pathlib.Path(sys.argv[1]); d=json.loads(p.read_text()); d.pop("revision"); d["revision"]=hashlib.sha256((json.dumps(d,ensure_ascii=False,sort_keys=True,indent=2)+"\\n").encode()).hexdigest(); p.write_text(json.dumps(d,ensure_ascii=False),encoding="utf-8")', apDraft], root);
  const apBytes = await readFile(apDraft);
  const apFiles = [['sets/synthetic.json', apBytes], ['assets/' + apHash + '.pdf', apPDF]];
  for (const [relative, bytes] of apFiles) await put(root, 'back-end/question-banks/ap/' + relative, bytes);
  await put(root, 'back-end/question-banks/ap/RESOURCE_MANIFEST.json', JSON.stringify({ schemaVersion: 1, files: apFiles.map(([relative, bytes]) => ({ path: relative, bytes: bytes.length, sha256: sha256(bytes) })) }));
  const manifest = { schema_version: 1, kind: 'toefl-shared-bank', bank: 'bank.json', files: [],
    counts: { records: bank.records.length, questions: bank.records.reduce((sum, record) => sum + record.items.length, 0), audio: 1, images: 1 },
    source: { kind: 'anonymous-fixture' } };
  const content = new Map([
    ['bank.json', Buffer.from(JSON.stringify(bank))],
    ['audio/fixture-tone.wav', Buffer.from('Original anonymous audio fixture')],
    ['images/fixture-scene.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
  ]);
  for (const [name, bytes] of content) {
    await put(root, 'back-end/question-banks/toefl/' + name, bytes);
    manifest.files.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
  }
  await put(root, 'back-end/question-banks/toefl/RESOURCE_MANIFEST.json', JSON.stringify(manifest));
  await put(root, 'local-data/auth/private.sqlite', 'PRIVATE_DO_NOT_EXPORT_8675309');
  await put(root, 'local-data/sat-packs/active.json', '{"private":"PRIVATE_DO_NOT_EXPORT_8675309"}');
  await put(root, 'local-data/question-banks/sat/personal.json', 'PRIVATE_DO_NOT_EXPORT_8675309');
  await put(root, 'front-end/web/unused-private.js', 'PRIVATE_DO_NOT_EXPORT_8675309');
  await put(root, 'front-end/sat/js/private.test.js', 'PRIVATE_DO_NOT_EXPORT_8675309');
  await put(root, 'front-end/toefl/clients/private.js', 'PRIVATE_DO_NOT_EXPORT_8675309');
  await put(root, 'front-end/sat/vendor/katex/private.map', 'PRIVATE_DO_NOT_EXPORT_8675309');
  await put(root, 'front-end/sat/README.md', 'PRIVATE_DO_NOT_EXPORT_8675309');
  await put(root, 'front-end/web/.DS_Store', 'PRIVATE_DO_NOT_EXPORT_8675309');
  run(python, ['-B', '-c', `
import importlib.util, json, pathlib, sys
code, root = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
sys.path.insert(0, str(code / 'back-end'))
from server.serve_platform import read_sat_library, read_sat_library_question_index
spec = importlib.util.spec_from_file_location('cloudflare_fixture_converter', code / 'back-end/tools/sat/convert_gengdu_sat.py')
converter = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = converter
spec.loader.exec_module(converter)
libraries = []
for name, identity, category, section in [('gengdu-offline', 'synthetic-math', '数学', 'Math'), ('pdf-official', 'synthetic-english', '英语', 'ReadingAndWriting')]:
    library = root / 'back-end/question-banks/sat-packs' / name
    question = {'question_id': 'anonymous-1', 'part_type': section, 'module_number': 3, 'number': 1,
        'question_type': 'choice', 'prompt_html': '<p>Original anonymous question?</p>',
        'choices': [{'label': label, 'html': 'Original ' + label} for label in 'ABCD'], 'correct_answer': 'A'}
    report = converter.convert_document({'title': identity, 'questions': [question]}, library / 'renamed' / identity,
                                        collection_id=identity, mode='bank')
    row = {'collectionId': identity, 'title': identity, 'category': category, 'sourceFile': category + '/original.json',
           'directory': 'historical/path/unused', 'status': 'converted', 'fullSAT': report['fullSAT'], 'questionCount': report['questionCount']}
    rows = [row]
    if name == 'gengdu-offline':
        rows.append({**row, 'collectionId': 'synthetic-unavailable', 'title': 'Unavailable original fixture'})
    (library / 'catalog.json').write_text(json.dumps({'schemaVersion': 'sat-offline-conversion-catalog/1', 'collections': rows}), encoding='utf-8')
    libraries.append(library)
expected = {'/api/sat-library': read_sat_library(tuple(libraries)), '/api/sat-library/question-index': read_sat_library_question_index(tuple(libraries))}
for identity in ('synthetic-math', 'synthetic-english'):
    expected['/api/sat-library/collections/' + identity] = read_sat_library(tuple(libraries), identity)
(root / 'expected-sat.json').write_text(json.dumps(expected), encoding='utf-8')
`, repositoryRoot, root], root);
  run('git', ['init', '--quiet'], root);
  run('git', ['-c', 'core.autocrlf=false', 'add', '--', 'front-end', 'back-end/question-banks'], root);
  return { bank, manifest, content };
}

test('explicit browser list has one remapped client and no wildcard/private sources', async t => {
  const root = await temporary(t), writer = new AssetWriter(path.join(root, 'output'));
  const selected = browserFiles();
  assert.deepEqual(selected.filter(item => item.source.includes('/clients/')),
    [{ source: 'front-end/toefl/clients/cloud-client.js', target: 'web/toefl-cloud.js' }]);
  assert.equal(new Set(selected.map(item => item.target.toLowerCase())).size, selected.length);
  assert.ok(selected.every(({ target }) => !/test|README|\.map|\.md|sources|clients/.test(target)));
  await assert.rejects(copyBrowserFiles(root, writer, new Set()), /must be Git-tracked/);
});

test('asset paths reject traversal, URL ambiguities, Windows aliases and private material', () => {
  for (const name of ['', '/toefl/a.js', '../a.js', 'a//b', 'a/./b', 'a/../b', 'a\\b', 'a%2fb', 'a?b', 'a#b',
    'a:b', 'a\0b', 'a/.env', 'a/end.', 'a/end ', 'a/CON.js', 'a/LPT1']) assert.throws(() => safeRelativePath(name));
  for (const name of ['web/README.md', 'web/tests/a.js', 'toefl/clients/a.js', 'toefl/.DS_Store',
    'sat/private-data/a.json', 'web/accounts.sqlite', 'web/key.pem', '_catalog/backup.zip', 'other/app.js']) {
    assert.throws(() => safeAssetPath(name));
  }
  assert.equal(safeAssetPath('toefl/audio/来源-1.mp3'), 'toefl/audio/来源-1.mp3');
});

test('limits, duplicates, tampering and unplanned files fail closed', async t => {
  const root = await temporary(t), writer = new AssetWriter(root, { maxAssetBytes: 128, maxFiles: 2 });
  assert.throws(() => new AssetWriter(root, { maxAssetBytes: MAX_ASSET_BYTES + 1 }));
  assert.throws(() => new AssetWriter(root, { maxFiles: MAX_ASSET_FILES + 1 }));
  await assert.rejects(writer.write('web/large.js', Buffer.alloc(129)), /exceeds/);
  await writer.write('web/app.js', 'original');
  await assert.rejects(writer.write('web/APP.js', 'duplicate'), /case-colliding/);
  await writer.write('web/style.css', '');
  await assert.rejects(writer.write('web/third.js', ''), /file count/);
  assert.equal((await writer.audit()).fileCount, 2);
  await writeFile(path.join(root, 'web/app.js'), 'changed');
  await assert.rejects(writer.audit(), /changed during build/);
  await writeFile(path.join(root, 'web/app.js'), 'original');
  await put(root, 'web/unexpected.js', 'unlisted');
  await assert.rejects(writer.audit(), /Unexpected asset/);
});

test('oversized route chunks preserve bytes and Unicode even across byte boundaries', async t => {
  const root = await temporary(t), writer = new AssetWriter(root, { maxAssetBytes: 128 });
  const source = Buffer.from(JSON.stringify({ data: '中😀é<&'.repeat(100), metadata: { order: [3, 2, 1] } }));
  const descriptor = await writer.route('/api/sat-library/question-index', '_catalog/index.json', source);
  assert.ok(descriptor.chunks.length > 1);
  assert.deepEqual(await readRoute(root, descriptor), source);
  assert.equal(descriptor.bytes, source.length);
  assert.equal(descriptor.sha256, sha256(source));
  assert.equal(descriptor.chunkBytes.reduce((a, b) => a + b), source.length);
  assert.ok((await writer.audit()).files.every(entry => entry.bytes <= 128));
  const ordinary = await writer.route('/api/sat-library', '_catalog/catalog.json', '{}');
  assert.equal(ordinary.asset, '/_catalog/catalog.json');
});

test('AP colon is allowed only in canonical source URLs, never filesystem paths', async t => {
  const root = await temporary(t), writer = new AssetWriter(root, { maxAssetBytes: 128 });
  const route = await writer.route('/api/exams/ap/sources/ap:fixture', '_catalog/ap/fixture.json', '{}');
  assert.equal(route.asset, '/_catalog/ap/fixture.json');
  for (const bad of ['/api/exams/ap/sources/ap:UPPER', '/api/exams/ap/sources/ap:foo_bar', '/api/exams/ap/sources/ap%3Afixture', '/api/exams/ap/sources/ap:foo/bar', '/api/other/ap:fixture'])
    await assert.rejects(writer.route(bad, '_catalog/ap/bad.json', '{}'), /Unsafe/);
  await assert.rejects(writer.route('/api/exams/ap/sources/ap:valid', '_catalog/ap/ap:valid.json', '{}'), /Unsafe/);
  const pdf = Buffer.from('%PDF-1.7\n' + 'anonymous'.repeat(100));
  const pdfRoute = await writer.route('/question-assets/ap/' + sha256(pdf) + '.pdf', '_catalog/ap-pdfs/' + sha256(pdf) + '.pdf', pdf, 'application/pdf');
  assert.ok(pdfRoute.chunks.length > 1); assert.deepEqual(await readRoute(root, pdfRoute), pdf);
});

test('TOEFL executable modules preserve all data, order and hostile strings with awaited loading', async t => {
  const root = await temporary(t), writer = new AssetWriter(path.join(root, 'assets'));
  await put(root, 'package.json', '{"type":"module"}');
  const hostile = '</script><script>globalThis.INJECTED=true</script>&\u2028\u2029😀\\"';
  const bank = { records: [{ id: 'first', text: hostile.repeat(100) }, { id: 'second', text: '\ud800' }],
    fixture: true, coverage: { metadata: hostile }, vocab: [{ word: '词汇' }], vocabGroups: [{ id: 'group' }],
    vocabularyMetadata: { originalOrder: ['b', 'a'] }, generatedAt: 'original', source: { title: hostile } };
  const result = await writeToeflData(writer, bank, { maxPartBytes: 512 });
  assert.ok(result.parts.length > 1);
  for (const name of result.parts) {
    const code = await readFile(path.join(writer.root, name.slice(1)), 'utf8');
    assert.ok(Buffer.byteLength(code) <= 512);
    assert.doesNotMatch(code, /[<>&\u2028\u2029]/u);
  }
  const previous = globalThis.window;
  globalThis.window = {};
  try {
    await import(pathToFileURL(path.join(writer.root, 'toefl/four-data.js')).href);
    assert.deepEqual(globalThis.window.FOUR_DATA, bank);
    assert.equal(globalThis.INJECTED, undefined);
    assert.equal(result.serializedSha256, sha256(JSON.stringify(bank)));
  } finally { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; }
});

test('a single TOEFL record larger than 8 MiB is losslessly split into bounded executable parts', async t => {
  const root = await temporary(t), writer = new AssetWriter(path.join(root, 'assets'));
  await put(root, 'package.json', '{"type":"module"}');
  const bank = { records: [{ id: 'oversized-original-fixture', text: 'x'.repeat(MAX_DATA_PART_BYTES + 256) }], fixture: true };
  const result = await writeToeflData(writer, bank);
  assert.equal(result.parts.length, 2);
  let recovered = '';
  for (const name of result.parts) {
    assert.ok((await stat(path.join(writer.root, name.slice(1)))).size <= MAX_DATA_PART_BYTES);
    recovered += (await import(pathToFileURL(path.join(writer.root, name.slice(1))).href)).default;
  }
  assert.deepEqual(JSON.parse(recovered), bank);
  await assert.rejects(writeToeflData(writer, {}, { maxPartBytes: MAX_DATA_PART_BYTES + 1 }), /8 MiB/);
});

test('new cloud catalog preserves API shapes without reading or inventing old activity', () => {
  const routes = staticCatalogs({ records: 13, questions: 42 });
  assert.deepEqual(routes['/api/sat-packs'], { collectionId: null, packs: [], assessment: null });
  assert.deepEqual(routes['/api/question-bank'], { files: [], errors: [] });
  assert.equal(routes['/api/question-bank/status'].writable, false);
  assert.equal(routes['/api/question-bank/status'].token, '');
  const exams = routes['/api/platform/catalog'].exams;
  assert.equal(exams.find(exam => exam.id === 'toefl').questionCount, 42);
  assert.equal(exams.find(exam => exam.id === 'sat').questionCount, 0);
  assert.equal(exams.find(exam => exam.id === 'ap').available, true);
  assert.equal(routes['/api/exams/ap/sources'].schemaVersion, 2);
  assert.ok(exams.every(exam => exam.sources.length === 0));
});

test('symbolic output or source parents are refused before copying or deletion', async t => {
  const root = await temporary(t), outside = await temporary(t);
  await mkdir(path.join(root, 'local-data/builds'), { recursive: true });
  await symlink(outside, path.join(root, 'local-data/builds/cloudflare'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(verifyBuildPaths(root), /Symbolic/);
  await put(outside, 'original.txt', 'must survive');
  await assert.rejects(build({ root }), /Symbolic/);
  assert.equal(await readFile(path.join(outside, 'original.txt'), 'utf8'), 'must survive');
  await mkdir(path.join(root, 'front-end'), { recursive: true });
  await symlink(outside, path.join(root, 'front-end/web'), process.platform === 'win32' ? 'junction' : 'dir');
  const selected = browserFiles();
  await assert.rejects(copyBrowserFiles(root, new AssetWriter(path.join(root, 'output')),
    new Set(selected.map(item => item.source))), /Symbolic/);
  const writer = new AssetWriter(path.join(root, 'output'));
  await mkdir(writer.root);
  await symlink(outside, path.join(writer.root, 'web'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(writer.write('web/original.txt', 'must not overwrite'), /Symbolic/);
  assert.equal(await readFile(path.join(outside, 'original.txt'), 'utf8'), 'must survive');
});

test('full anonymous build reuses canonical SAT readers, exact media, tracked allowlists and private boundaries', { timeout: 120_000 }, async t => {
  const root = await temporary(t), { bank, manifest, content } = await anonymousRepository(root);
  const expected = JSON.parse(await readFile(path.join(root, 'expected-sat.json'), 'utf8'));
  const originalLibrary = process.env.SAT_LIBRARY_ROOT;
  process.env.SAT_LIBRARY_ROOT = path.join(root, 'local-data/private-overridden-library');
  let info;
  try { info = await build({ root, python }); }
  finally { if (originalLibrary === undefined) delete process.env.SAT_LIBRARY_ROOT; else process.env.SAT_LIBRARY_ROOT = originalLibrary; }
  const assets = path.join(root, 'local-data/builds/cloudflare/assets');
  assert.equal(info.privateActivityData, false);
  assert.equal(info.productionCredentials, false);
  assert.equal(info.sat.collections, 2);
  assert.equal(info.sat.questions, 2);
  assert.equal(info.sat.indexQuestions, 2);
  assert.equal(info.sat.catalogErrors, 1);
  assert.equal(info.ap.sets, 1); assert.equal(info.ap.pdfs, 1);
  const apSources = JSON.parse(await readRoute(assets, info.protectedRoutes['/api/exams/ap/sources']));
  assert.equal(apSources.schemaVersion, 2); assert.equal(apSources.sources.length, 1);
  const apSet = JSON.parse(await readRoute(assets, info.protectedRoutes['/api/exams/ap/sources/' + apSources.sources[0].id]));
  const apPDFRoute = info.protectedRoutes['/' + apSet.documents[0].asset];
  assert.equal(apPDFRoute.byteRanges, true); assert.equal(apPDFRoute.contentType, 'application/pdf');
  assert.match((await readRoute(assets, apPDFRoute)).toString(), /^%PDF-1.7/);
  const apExam = JSON.parse(await readRoute(assets, info.protectedRoutes['/api/platform/catalog'])).exams.find(exam => exam.id === 'ap');
  assert.equal(apExam.sourceCount, 1); assert.equal(apExam.questionCount, apSet.questions.length); assert.deepEqual(apExam.sources, apSources.sources);
  assert.deepEqual(apExam.sections, [apSet.section]);
  assert.equal(info.toefl.records, bank.records.length);
  assert.equal(info.toefl.questions, manifest.counts.questions);
  assert.ok(info.fileCount < MAX_ASSET_FILES);
  for (const [route, value] of Object.entries(expected)) {
    assert.deepEqual(JSON.parse(await readRoute(assets, info.protectedRoutes[route])), value);
  }
  assert.equal(info.protectedRoutes['/api/sat-library/collections/synthetic-unavailable'].status, 400);
  const routes = JSON.parse(await readFile(path.join(assets, '_catalog/routes.json'), 'utf8'));
  assert.deepEqual(routes.protectedRoutes, info.protectedRoutes);
  assert.deepEqual(routes.htmlTemplates, info.htmlTemplates);
  assert.equal(routes.htmlTemplates['/toefl/'], '/toefl/index.html');
  for (const [name, bytes] of content) if (name !== 'bank.json') {
    assert.deepEqual(await readFile(path.join(assets, 'toefl', name)), bytes);
  }
  for (const entry of info.files) {
    const bytes = await readFile(path.join(assets, entry.path.slice(1)));
    assert.equal(bytes.length, entry.bytes);
    assert.equal(sha256(bytes), entry.sha256);
    assert.ok(entry.bytes <= MAX_ASSET_BYTES);
    assert.equal(bytes.includes('PRIVATE_DO_NOT_EXPORT_8675309'), false, entry.path);
  }
  const before = await readFile(path.join(root, 'local-data/sat-packs/active.json'));
  assert.deepEqual(JSON.parse(await readRoute(assets, info.protectedRoutes['/api/sat-packs'])), { collectionId: null, packs: [], assessment: null });
  assert.deepEqual(await readFile(path.join(root, 'local-data/sat-packs/active.json')), before);
  assert.equal(info.files.some(entry => /clients|private|README|\.DS_Store|\.map|\.test/.test(entry.path)), false);
  assert.ok(info.files.some(entry => entry.path === '/web/toefl-cloud.js'));
  const listing = path.join(root, 'git-list-test.txt');
  assert.ok((await trackedFiles(root, listing)).has('front-end/web/index.html'));
  // A second build is repeatable and only replaces its dedicated output tree.
  const second = await build({ root, python });
  assert.deepEqual(second.files, info.files);
  // The AP reader checks manifest hashes and tracked status before invalidating output.
  const sharedAP = path.join(root, 'back-end/question-banks/ap/sets/synthetic.json');
  const originalAP = await readFile(sharedAP);
  await writeFile(sharedAP, '{}');
  await assert.rejects(build({ root, python }), /exited/);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'local-data/builds/cloudflare/build-info.json'), 'utf8')), second);
  await writeFile(sharedAP, originalAP);
  run('git', ['rm', '--cached', '--quiet', '--', 'back-end/question-banks/ap/sets/synthetic.json'], root);
  await assert.rejects(build({ root, python }), /exited/);
  run('git', ['add', '--', 'back-end/question-banks/ap/sets/synthetic.json'], root);
  // Corrupt shared bytes: fail validation, retaining the last successful build.
  await writeFile(path.join(root, 'back-end/question-banks/toefl/audio/fixture-tone.wav'), 'tampered');
  await assert.rejects(build({ root, python }), /byte size|SHA-256/);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'local-data/builds/cloudflare/build-info.json'), 'utf8')), second);
  assert.deepEqual(await readFile(path.join(root, 'local-data/sat-packs/active.json')), before);
  // A tracked manifest must not smuggle an untracked file with an unexpected
  // suffix past the shared-tree extension preflight.
  await writeFile(path.join(root, 'back-end/question-banks/toefl/audio/fixture-tone.wav'), content.get('audio/fixture-tone.wav'));
  const manifestEntry = expected['/api/sat-library/collections/synthetic-math'].packs[0].files
    .find(entry => entry.path === 'pack.json' || entry.path.endsWith('/pack.json'));
  const packPath = path.join(root, 'back-end/question-banks/sat-packs/gengdu-offline/renamed/synthetic-math', manifestEntry.path);
  const pack = JSON.parse(await readFile(packPath, 'utf8'));
  const itemBytes = await readFile(path.join(path.dirname(packPath), pack.files.items));
  await writeFile(path.join(path.dirname(packPath), 'untracked-items.dat'), itemBytes);
  pack.files.items = 'untracked-items.dat';
  await writeFile(packPath, JSON.stringify(pack));
  await assert.rejects(build({ root, python }), /exited/);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'local-data/builds/cloudflare/build-info.json'), 'utf8')), second);
});
