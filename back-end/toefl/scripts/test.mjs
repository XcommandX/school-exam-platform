import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { build, moduleRoot } from './build.mjs';
import { checkSource } from './check-source.mjs';

await checkSource();
const built = await build();
const suites = [
  [path.join(moduleRoot, 'tests/frontend'), moduleRoot, '.cjs'],
  [built.cloud, built.cloud, '.mjs'],
  [path.join(moduleRoot, 'tests/integration'), moduleRoot, '.mjs']
];
let passed = 0, failed = 0;
for (const [directory, cwd, extension] of suites) {
  for (const name of (await readdir(directory)).filter(n => n.startsWith('test-') && n.endsWith(extension)).sort()) {
    const result = spawnSync(process.execPath, [path.join(directory, name)], { cwd, encoding: 'utf8', timeout: 60000 });
    if (result.status === 0) { passed++; console.log(`PASS ${name}`); }
    else { failed++; console.error(`FAIL ${name}\n${result.stdout || ''}${result.stderr || ''}${result.error?.message || ''}`); }
  }
}
console.log(`Local intake checks: ${passed} passed, ${failed} failed. External AI and production databases were not used.`);
process.exitCode = failed ? 1 : 0;
