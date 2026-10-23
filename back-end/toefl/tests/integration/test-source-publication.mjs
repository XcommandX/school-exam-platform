import assert from 'node:assert/strict';
import { validatePath, validateSourcePath, checkText, checkSource } from '../../scripts/check-source.mjs';
import { spawnSync } from 'node:child_process';
import { sourceRoot } from '../../scripts/check-source.mjs';

for (const value of ['../private.json', '/etc/passwd', 'src/../../secret', 'src\\secret', 'src//secret', 'C:/secret', 'src/./secret', 'src/secret\0.txt']) {
  assert.throws(() => validatePath(value), /Invalid source path/);
}
assert.equal(validatePath('back-end/toefl/src/worker.mjs'), 'back-end/toefl/src/worker.mjs');
for (const value of ['front-end/toefl/four-app.js', 'back-end/toefl/src/worker.mjs', 'docs/toefl/README.md']) {
  assert.equal(validateSourcePath(value), value);
}
for (const value of ['front-end/sat/app.js', 'back-end/toefl-extra/data.json', 'local-data/toefl/questions.json', 'docs/README.md']) {
  assert.throws(() => validateSourcePath(value), /outside the TOEFL source directories/);
}
for (const directory of ['front-end/toefl', 'back-end/toefl', 'docs/toefl']) {
  for (const file of ['unreviewed-source.js', 'private-data/questions.json', 'nested/.DS_Store']) {
    const ignored = spawnSync('git', ['check-ignore', '--no-index', '--quiet', '--', directory + '/' + file], { cwd: sourceRoot });
    if (!ignored.error) assert.equal(ignored.status, 0, directory + '/' + file + ' must stay ignored');
  }
}
assert.throws(() => checkText('src/key.js', 'ghp_' + 'x'.repeat(36)), /access token/);
assert.throws(() => checkText('src/key.js', '-----BEGIN ' + 'RSA PRIVATE KEY-----'), /private key/);
assert.throws(() => checkText('src/path.js', '/' + 'Users/example/private/file'), /home path/);
assert.throws(() => checkText('back-end/toefl/src/reset.sql', 'DELETE' + ' FROM users;'), /destructive SQL/);
checkText('back-end/toefl/src/schema.sql', 'CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY);');
const result = await checkSource();
assert.equal(result.anonymousRecords, 12);
assert(result.files > 60);
console.log('PASS: reviewed-file checksums, original anonymous bank, unsafe path/token/private-key and destructive SQL publication guards.');
