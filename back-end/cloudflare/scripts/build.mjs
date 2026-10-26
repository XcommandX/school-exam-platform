#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkResources } from '../../toefl/scripts/check-resources.mjs';
import { AssetWriter, MAX_ASSET_BYTES, MAX_ASSET_FILES, MAX_DATA_PART_BYTES,
  assertNoSymlink, safeRelativePath, sha256, verifyBuildPaths, writeToeflData } from './build-helpers.mjs';

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export const WEB_FILES = Object.freeze([
  'account.css', 'account.html', 'account.js', 'app.js', 'home-model.js', 'index.html',
  'login.css', 'login.html', 'login.js', 'platform-auth.js', 'sat-account-sync.js',
  'sat-bridge.js', 'styles.css', 'toefl-bridge.js',
]);
const fontFamilies = [
  'AMS-Regular', 'Caligraphic-Bold', 'Caligraphic-Regular', 'Fraktur-Bold', 'Fraktur-Regular',
  'Main-Bold', 'Main-BoldItalic', 'Main-Italic', 'Main-Regular', 'Math-BoldItalic', 'Math-Italic',
  'SansSerif-Bold', 'SansSerif-Italic', 'SansSerif-Regular', 'Script-Regular',
  'Size1-Regular', 'Size2-Regular', 'Size3-Regular', 'Size4-Regular', 'Typewriter-Regular',
];
export const SAT_FILES = Object.freeze([
  'html/index.html',
  ...['base', 'content-renderer', 'dashboard', 'exam-math', 'exam', 'library', 'math-tools', 'practice-timing'].map(name => `css/${name}.css`),
  ...['app', 'builder-library', 'content-renderer', 'exam', 'importer', 'library', 'line-reader',
    'material-text', 'math-tools', 'practice-model', 'question-bank', 'sat-pack', 'sat-session',
    'shortcuts', 'storage'].map(name => `js/${name}.js`),
  'data/question-categories.js', 'data/question-categories.json', 'data/questions.js', 'data/examples/synthetic-practice.json',
  'vendor/dompurify/purify.min.js', 'vendor/katex/katex.min.css', 'vendor/katex/katex.min.js',
  'vendor/marked/marked.umd.js',
  ...fontFamilies.flatMap(name => ['ttf', 'woff', 'woff2'].map(extension => `vendor/katex/fonts/KaTeX_${name}.${extension}`)),
]);
export const AP_FILES = Object.freeze(['index.html', 'styles.css', 'app.js', 'ap-model.js', 'examples/synthetic-practice.json']);
export const TOEFL_FILES = Object.freeze(['index.html', 'four.css', 'four-logic.js', 'four-learning.js', 'four-app.js', 'favicon.svg']);

export const HTML_TEMPLATES = Object.freeze({
  '/': '/web/index.html', '/index.html': '/web/index.html', '/web/index.html': '/web/index.html',
  '/login': '/web/login.html', '/login/': '/web/login.html', '/web/login.html': '/web/login.html',
  '/account': '/web/account.html', '/accounts': '/web/account.html', '/web/account.html': '/web/account.html',
  '/ap/': '/ap/index.html', '/ap/index.html': '/ap/index.html',
  '/sat/html/index.html': '/sat/html/index.html', '/toefl/': '/toefl/index.html', '/toefl/index.html': '/toefl/index.html',
});

export function browserFiles() {
  return [
    ...WEB_FILES.map(name => ({ source: `front-end/web/${name}`, target: `web/${name}` })),
    ...AP_FILES.map(name => ({ source: `front-end/ap/${name}`, target: `ap/${name}` })),
    ...SAT_FILES.map(name => ({ source: `front-end/sat/${name}`, target: `sat/${name}` })),
    ...TOEFL_FILES.map(name => ({ source: `front-end/toefl/${name}`, target: `toefl/${name}` })),
    { source: 'front-end/toefl/clients/cloud-client.js', target: 'web/toefl-cloud.js' },
  ];
}

function subprocess(executable, args, options = {}) {
  const result = spawnSync(executable, args, { stdio: 'inherit', ...options, shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${executable} exited with ${result.status ?? result.signal}.`);
}

export async function trackedFiles(root, outputFile) {
  await assertNoSymlink(outputFile, { allowMissing: true });
  const fd = openSync(outputFile, 'wx');
  try {
    // Explicit file descriptor: no captured pipes, including on sandboxed Windows.
    subprocess('git', ['-C', root, 'ls-files', '--cached', '-z'], { stdio: ['ignore', fd, 'inherit'] });
  } finally { closeSync(fd); }
  return new Set((await readFile(outputFile, 'utf8')).split('\0').filter(Boolean));
}

async function checkedSource(root, relative, tracked) {
  safeRelativePath(relative);
  if (!tracked.has(relative)) throw new Error(`Source must be Git-tracked: ${relative}`);
  const target = path.join(root, ...relative.split('/'));
  await assertNoSymlink(target);
  if (!(await lstat(target)).isFile()) throw new Error(`Regular source file required: ${relative}`);
  return target;
}

export async function copyBrowserFiles(root, writer, tracked) {
  const sources = [];
  for (const { source, target } of browserFiles()) {
    await writer.write(target, await readFile(await checkedSource(root, source, tracked)), { source });
    sources.push(source);
  }
  return sources;
}

function mediaType(relative) {
  return { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.webm': 'audio/webm',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.svg': 'image/svg+xml' }[path.posix.extname(relative).toLowerCase()] ?? 'application/octet-stream';
}

export function staticCatalogs(counts) {
  const status = { available: true, contentMode: 'shared-bank', recordCount: counts.records,
    questionCount: counts.questions, practiceUrl: '/toefl/' };
  const exams = Object.entries({ sat: 'SAT', ap: 'AP', toefl: 'TOEFL', vocab: 'Personal Vocab' }).map(([id, name]) => ({
    id, name, available: ['sat', 'toefl', 'ap'].includes(id), questionCount: id === 'toefl' ? counts.questions : 0,
    sourceCount: id === 'toefl' ? counts.records : 0, sources: [], sections: [], ...(id === 'toefl' ? { preview: status } : {}),
  }));
  return {
    '/api/toefl/status': status,
    '/api/platform/catalog': { schemaVersion: 1, exams, errors: [], auth: { mode: 'session', loginEnabled: true, authenticated: true } },
    '/api/sat-packs': { collectionId: null, packs: [], assessment: null },
    '/api/question-bank/status': { service: 'sat-question-bank-v1', project: 'study-space-cloudflare',
      name: 'SAT cloud question bank', token: '', writable: false },
    '/api/question-bank': { files: [], errors: [] },
    ...Object.fromEntries(exams.map(({ id }) => [`/api/exams/${id}/sources`, { schemaVersion: id === 'ap' ? 2 : 1, exam: id, sources: [], errors: [] }])),
  };
}

export async function build({ root = repositoryRoot, python = process.env.PYTHON || 'python' } = {}) {
  const paths = await verifyBuildPaths(root);
  root = paths.root;
  await mkdir(paths.buildRoot, { recursive: true });
  // Every deletion below uses only the previously checked, fixed dedicated paths.
  // Never call the original TOEFL build (it has a different destructive default).
  await rm(paths.stageRoot, { recursive: true, force: true });
  await mkdir(paths.stageRoot);
  const trackedFile = path.join(paths.stageRoot, 'git-tracked.txt');
  const tracked = await trackedFiles(root, trackedFile);
  for (const { source } of browserFiles()) await checkedSource(root, source, tracked);
  const resourceRoot = path.join(root, 'back-end/question-banks/toefl');
  await checkedSource(root, 'back-end/question-banks/toefl/RESOURCE_MANIFEST.json', tracked);
  await checkedSource(root, 'back-end/question-banks/toefl/bank.json', tracked);
  console.log('Validating all shared TOEFL resources and SHA-256 hashes...');
  const resources = await checkResources({ resourceRoot });
  for (const { path: relative } of resources.files) await checkedSource(root, `back-end/question-banks/toefl/${relative}`, tracked);
  const manifestSha256 = sha256(await readFile(path.join(resourceRoot, 'RESOURCE_MANIFEST.json')));

  console.log('Exporting canonical shared SAT catalogs, question index and complete collections...');
  subprocess(python, ['-B', fileURLToPath(new URL('./export_catalog.py', import.meta.url)),
    '--repository', root, '--output', paths.stageRoot, '--tracked-file', trackedFile], {
    cwd: root, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1' },
  });
  const exported = JSON.parse(await readFile(path.join(paths.stageRoot, 'export-info.json'), 'utf8'));
  if (exported.schemaVersion !== 1 || !exported.routes || !exported.counts) throw new Error('Invalid SAT export manifest.');

  // Invalidate the previous success marker before touching its assets.
  await verifyBuildPaths(root);
  await rm(paths.buildInfoPath, { force: true });
  await rm(paths.assetsRoot, { recursive: true, force: true });
  await mkdir(paths.assetsRoot);
  const writer = new AssetWriter(paths.assetsRoot), protectedRoutes = {};
  const sourceFiles = await copyBrowserFiles(root, writer, tracked);
  const data = await writeToeflData(writer, resources.bank);
  for (const { path: relative, bytes, sha256: expectedHash } of resources.files) {
    if (relative === 'bank.json') continue;
    const source = `back-end/question-banks/toefl/${relative}`;
    const content = await readFile(await checkedSource(root, source, tracked));
    if (content.length !== bytes || sha256(content) !== expectedHash) throw new Error(`Resource changed during build: ${relative}`);
    const target = 'toefl/' + relative;
    if (content.length > MAX_ASSET_BYTES) protectedRoutes['/' + target] = await writer.route('/' + target, target, content, mediaType(relative), { source });
    else await writer.write(target, content, { source });
  }
  for (const [route, descriptor] of Object.entries(exported.routes)) {
    safeRelativePath(descriptor.file);
    if (!route.startsWith('/api/sat-library') || descriptor.asset !== '/_catalog/' + descriptor.file) throw new Error('Unsafe SAT export route.');
    const source = path.join(paths.stageRoot, ...descriptor.file.split('/'));
    await assertNoSymlink(source);
    protectedRoutes[route] = { ...await writer.route(route, descriptor.asset.slice(1), await readFile(source), descriptor.contentType),
      ...(descriptor.status !== 200 ? { status: descriptor.status } : {}) };
  }
  for (const [route, value] of Object.entries(staticCatalogs(resources.counts))) {
    protectedRoutes[route] = await writer.route(route, `_catalog/static/${route.slice('/api/'.length)}.json`, JSON.stringify(value) + '\n');
  }
  // Only the tracked original example is deployable; never enumerate local AP libraries.
  const apExample = JSON.parse(await readFile(await checkedSource(root, 'front-end/ap/examples/synthetic-practice.json', tracked), 'utf8'));
  if (apExample.contentMode !== 'synthetic' || apExample.documents?.length !== 0) throw new Error('AP cloud example must be original and self-contained.');
  protectedRoutes['/api/ap/example'] = await writer.route('/api/ap/example', '_catalog/static/ap/example.json', JSON.stringify(apExample) + '\n');
  const routesManifest = { schemaVersion: 1, htmlTemplates: HTML_TEMPLATES, protectedRoutes };
  await writer.write('_catalog/routes.json', JSON.stringify(routesManifest) + '\n');
  const inventory = await writer.audit();
  const info = { schemaVersion: 1, mode: 'cloudflare-shared-bank', productionCredentials: false,
    privateActivityData: false, deployable: true, generatedAt: new Date().toISOString(),
    assetsDirectory: 'local-data/builds/cloudflare/assets', routeManifest: '/_catalog/routes.json',
    limits: { maxAssetBytes: MAX_ASSET_BYTES, maxAssetFiles: MAX_ASSET_FILES, maxToeflPartBytes: MAX_DATA_PART_BYTES },
    htmlTemplates: HTML_TEMPLATES, protectedRoutes, sourceFiles,
    toefl: { ...resources.counts, vocabulary: resources.bank.vocab?.length ?? 0, manifestSha256, data },
    sat: exported.counts, catalogErrors: exported.errors, ...inventory };
  await writeFile(paths.buildInfoPath, JSON.stringify(info, null, 2) + '\n', { flag: 'wx' });
  await verifyBuildPaths(root);
  await rm(paths.stageRoot, { recursive: true, force: true });
  console.log(JSON.stringify({ output: info.assetsDirectory, files: info.fileCount, bytes: info.totalBytes,
    largestAssetBytes: info.largestAssetBytes, toefl: resources.counts, toeflParts: data.parts.length, sat: info.sat }, null, 2));
  return info;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error('This build accepts no CLI path overrides; output is fixed under local-data/builds/cloudflare.');
  await build();
}
