import { readFile, writeFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const manifestName = 'SOURCE_MANIFEST.json';

export function validatePath(name) {
  if (typeof name !== 'string' || !name || /[\\:\x00-\x1f]/.test(name) ||
      path.posix.isAbsolute(name) || name.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Invalid source path.');
  }
  return name;
}

export function checkText(name, text) {
  const rules = [
    ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ['access token', /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|gsk_[A-Za-z0-9_]{20,})\b/],
    ['developer home path', /\/(?:Users|home)\/[A-Za-z0-9_.-]+\/|[A-Z]:\\Users\\/],
    ['production deployment identifier', /["']database_id["']\s*:\s*["'][a-f0-9-]{36}["']/i]
  ];
  for (const [label, pattern] of rules) {
    if (pattern.test(text)) throw new Error(`${name}: possible ${label}; review before publication.`);
  }
  if (text.includes('\0')) throw new Error(`${name}: binary source is not allowed.`);
  if (name.endsWith('.sql') && /\b(?:DROP|TRUNCATE|DELETE\s+FROM)\b/i.test(text)) {
    throw new Error(`${name}: destructive SQL is outside this source intake.`);
  }
}

export async function checkSource({ update = false } = {}) {
  const manifestPath = path.join(sourceRoot, manifestName);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.schema_version !== 1 || manifest.hash_algorithm !== 'sha256' ||
      manifest.manifest_file !== manifestName || !Array.isArray(manifest.files) || !manifest.files.length) {
    throw new Error('Unsupported source manifest.');
  }
  const names = new Set();
  for (const entry of manifest.files) {
    const name = validatePath(entry.path);
    if (names.has(name) || name === manifestName) throw new Error('Duplicate or self-hashed manifest entry.');
    names.add(name);
    if (!/\.(?:mjs|cjs|js|json|html|css|md|sql|svg)$/.test(name) && !['.gitignore', '.env.example'].includes(name)) {
      throw new Error(`${name}: file type is outside the source boundary.`);
    }
    if (name.split('/').some(part => ['dist', 'node_modules', 'private-data', '.wrangler', 'recordings', 'backups'].includes(part))) {
      throw new Error(`${name}: runtime or private directory is not publishable.`);
    }
    let current = sourceRoot;
    for (const part of name.split('/')) {
      current = path.join(current, part);
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`${name}: symbolic links are not allowed.`);
    }
    const stat = await lstat(current);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error(`${name}: unexpected source file.`);
    const bytes = await readFile(current);
    checkText(name, new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (!update && digest !== entry.sha256) throw new Error(`${name}: source changed; review then run --update.`);
    if (update) entry.sha256 = digest;
  }

  const bank = JSON.parse(await readFile(path.join(sourceRoot, 'fixtures/anonymous-bank.json'), 'utf8'));
  if (bank.fixture !== true || bank.records?.length !== 12 || bank.records.some(record =>
    record.source !== 'ANONYMOUS_FIXTURE' || !record.id.startsWith('anonymous-'))) {
    throw new Error('Only the 12 original anonymous sample records may be published.');
  }
  const modules = new Set(bank.records.map(record => record.module));
  for (const module of ['reading-t1', 'reading-t2', 'reading-t3', 'listening-t1', 'listening-t2', 'listening-t3', 'listening-t4', 'speaking-t1', 'speaking-t2', 'writing-t1', 'writing-t2', 'writing-t3']) {
    if (!modules.has(module)) throw new Error(`Missing anonymous module ${module}.`);
  }

  // Ignored local data is not exported. Detect even a force-added unlisted file.
  // ZIP downloads without Git can still verify hashes and anonymous data.
  const git = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.'], {
    cwd: sourceRoot, encoding: 'utf8'
  });
  if (git.status === 0) {
    for (const name of git.stdout.split('\0').filter(Boolean)) {
      if (name !== manifestName && !names.has(name)) throw new Error(`${name}: not in the reviewed source manifest.`);
    }
  }
  if (update) await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return { files: names.size + 1, anonymousRecords: bank.records.length, gitIndexChecked: git.status === 0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).some(arg => arg !== '--update')) throw new Error('Only --update is supported.');
  const result = await checkSource({ update: process.argv.includes('--update') });
  console.log(`Source intake: ${result.files} reviewed files; ${result.anonymousRecords} anonymous records; Git index checked: ${result.gitIndexChecked}.`);
}
