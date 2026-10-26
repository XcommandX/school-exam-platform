import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const MAX_ASSET_BYTES = 25 * 1024 * 1024;
export const MAX_ASSET_FILES = 20_000;
export const MAX_DATA_PART_BYTES = 8 * 1024 * 1024;
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

const forbiddenSegments = new Set(['.git', '.env', 'node_modules', 'private-data', 'local-data',
  'backups', 'uploads', 'docs', 'tests', 'fixtures', 'sources', 'clients', '__pycache__']);

export function safeRelativePath(value) {
  if (typeof value !== 'string' || !value || /[\\:%?#\x00-\x1f\x7f]/u.test(value)
      || value.split('/').some(part => !part || part.startsWith('.') || /[. ]$/u.test(part)
        || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) {
    throw new Error(`Unsafe relative asset path: ${JSON.stringify(value)}`);
  }
  return value;
}

export function safeAssetPath(value) {
  safeRelativePath(value);
  if (!['web', 'sat', 'toefl', 'contests', '_catalog'].includes(value.split('/')[0])
      || value.split('/').some(part => forbiddenSegments.has(part.toLowerCase()))
      || /(?:^|\/)(?:AGENTS|README|LICENSE)(?:\.|$)/iu.test(value)
      || /\.(?:py|pyc|md|sqlite3?|db|pem|key|p12|zip|log|map)$/iu.test(value)) {
    throw new Error(`Non-browser/private asset path is forbidden: ${value}`);
  }
  return value;
}

// Inspect every ancestor, not only the final file. Junctions/symlinks must never
// redirect a shared source or the dedicated build directory into private data.
export async function assertNoSymlink(target, { allowMissing = false } = {}) {
  const absolute = path.resolve(target), { root } = path.parse(absolute);
  let cursor = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    let stat;
    try { stat = await lstat(cursor); } catch (error) {
      if (allowMissing && error.code === 'ENOENT') return absolute;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`Symbolic paths are forbidden: ${cursor}`);
  }
  return absolute;
}

export function dedicatedBuildPaths(repositoryRoot) {
  const root = path.resolve(repositoryRoot);
  const buildRoot = path.join(root, 'local-data', 'builds', 'cloudflare');
  return { root, buildRoot, assetsRoot: path.join(buildRoot, 'assets'),
    buildInfoPath: path.join(buildRoot, 'build-info.json'), stageRoot: path.join(buildRoot, '.catalog-stage') };
}

export async function verifyBuildPaths(repositoryRoot) {
  const paths = dedicatedBuildPaths(repositoryRoot);
  await assertNoSymlink(paths.root);
  if (await realpath(paths.root) !== paths.root) throw new Error('Repository root must use its canonical path.');
  for (const target of [paths.buildRoot, paths.assetsRoot, paths.buildInfoPath, paths.stageRoot]) {
    if (!target.startsWith(paths.root + path.sep) || target === paths.root) throw new Error('Invalid build target.');
    await assertNoSymlink(target, { allowMissing: true });
  }
  return paths;
}

export function scriptJSON(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/gu, character =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export class AssetWriter {
  constructor(root, { maxAssetBytes = MAX_ASSET_BYTES, maxFiles = MAX_ASSET_FILES } = {}) {
    if (!Number.isSafeInteger(maxAssetBytes) || maxAssetBytes < 128 || maxAssetBytes > MAX_ASSET_BYTES
        || !Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > MAX_ASSET_FILES) {
      throw new Error('Asset limits may be reduced for tests but must not exceed the free-tier limits.');
    }
    this.root = path.resolve(root);
    this.maxAssetBytes = maxAssetBytes;
    this.maxFiles = maxFiles;
    this.files = new Map();
    this.folded = new Set();
  }

  async write(relative, input, { source } = {}) {
    safeAssetPath(relative);
    const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
    if (bytes.length > this.maxAssetBytes) throw new Error(`Asset exceeds ${this.maxAssetBytes} bytes: ${relative}`);
    if (this.folded.has(relative.toLowerCase())) throw new Error(`Duplicate/case-colliding asset: ${relative}`);
    if (this.files.size >= this.maxFiles) throw new Error(`Asset file count exceeds ${this.maxFiles}.`);
    const target = path.join(this.root, ...relative.split('/'));
    await assertNoSymlink(target, { allowMissing: true });
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: 'wx' });
    const record = { path: '/' + relative, bytes: bytes.length, sha256: sha256(bytes), ...(source ? { source } : {}) };
    this.files.set(relative, record);
    this.folded.add(relative.toLowerCase());
    return record;
  }

  // The route preserves the original bytes. The Worker concatenates raw chunk
  // streams before decoding; JSON and UTF-8 characters may cross chunk borders.
  async route(route, relative, input, contentType = 'application/json; charset=utf-8', options = {}) {
    if (typeof route !== 'string' || !route.startsWith('/')) throw new Error('An absolute route is required.');
    safeRelativePath(route.slice(1));
    safeAssetPath(relative);
    const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
    const common = { contentType, bytes: bytes.length, sha256: sha256(bytes) };
    if (bytes.length <= this.maxAssetBytes) {
      await this.write(relative, bytes, options);
      return { asset: '/' + relative, ...common };
    }
    const chunks = [], chunkBytes = [];
    const stem = sha256(Buffer.from(route));
    for (let start = 0, index = 0; start < bytes.length; start += this.maxAssetBytes, index++) {
      const chunk = bytes.subarray(start, start + this.maxAssetBytes);
      const name = `_catalog/chunks/${stem}/part-${String(index).padStart(5, '0')}.bin`;
      await this.write(name, chunk, options);
      chunks.push('/' + name);
      chunkBytes.push(chunk.length);
    }
    return { chunks, chunkBytes, ...common };
  }

  async audit() {
    const seen = new Set();
    const visit = async (folder, prefix = '') => {
      await assertNoSymlink(folder);
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        const relative = prefix + entry.name, target = path.join(folder, entry.name);
        if (entry.isDirectory()) await visit(target, relative + '/');
        else {
          if (!entry.isFile()) throw new Error(`Non-regular build entry: ${relative}`);
          safeAssetPath(relative);
          const expected = this.files.get(relative);
          if (!expected) throw new Error(`Unexpected asset in output: ${relative}`);
          const actual = await readFile(target);
          if (actual.length !== expected.bytes || sha256(actual) !== expected.sha256) {
            throw new Error(`Asset changed during build: ${relative}`);
          }
          if (actual.length > this.maxAssetBytes) throw new Error(`Oversized output asset: ${relative}`);
          seen.add(relative);
        }
      }
    };
    await visit(this.root);
    if (seen.size !== this.files.size || seen.size > this.maxFiles) throw new Error('Incomplete/oversized asset inventory.');
    const files = [...this.files.values()].sort((a, b) => a.path.localeCompare(b.path, 'en'));
    return { files, fileCount: files.length, totalBytes: files.reduce((sum, item) => sum + item.bytes, 0),
      largestAssetBytes: files.reduce((largest, item) => Math.max(largest, item.bytes), 0) };
  }
}

export async function writeToeflData(writer, bank, { maxPartBytes = MAX_DATA_PART_BYTES } = {}) {
  if (!Number.isSafeInteger(maxPartBytes) || maxPartBytes < 128 || maxPartBytes > MAX_DATA_PART_BYTES) {
    throw new Error('TOEFL executable parts must not exceed 8 MiB.');
  }
  const limit = Math.min(maxPartBytes, writer.maxAssetBytes), serialized = JSON.stringify(bank);
  if (typeof serialized !== 'string') throw new Error('A JSON bank is required.');
  const parts = [];
  for (let start = 0; start < serialized.length;) {
    let low = 1, high = Math.min(serialized.length - start, limit), selected = 0, content;
    while (low <= high) {
      const count = Math.floor((low + high) / 2);
      const candidate = `export default ${scriptJSON(serialized.slice(start, start + count))};\n`;
      if (Buffer.byteLength(candidate) <= limit) { selected = count; content = candidate; low = count + 1; }
      else high = count - 1;
    }
    if (!selected) throw new Error('TOEFL part limit is too small.');
    const relative = `toefl/_data/part-${String(parts.length).padStart(5, '0')}.js`;
    await writer.write(relative, content, { source: 'back-end/question-banks/toefl/bank.json' });
    parts.push('/' + relative);
    start += selected;
  }
  // Awaited imports, unlike script insertion/document.write, also work when the
  // existing bridge dynamically imports this module after account bootstrap.
  const loader = '// Generated shared data; load through the authenticated TOEFL bridge.\n'
    + 'const parts = [];\n'
    + parts.map(relative => `parts.push((await import(${JSON.stringify('./' + relative.slice('/toefl/'.length))})).default);`).join('\n')
    + '\nwindow.FOUR_DATA = JSON.parse(parts.join(""));\nparts.length = 0;\n';
  await writer.write('toefl/four-data.js', loader);
  return { loader: '/toefl/four-data.js', parts, serializedBytes: Buffer.byteLength(serialized),
    serializedSha256: sha256(serialized), maxPartBytes: limit };
}
