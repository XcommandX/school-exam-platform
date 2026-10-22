import assert from 'node:assert/strict';
import { validatePath, checkText, checkSource } from '../../scripts/check-source.mjs';

for (const value of ['../private.json', '/etc/passwd', 'src/../../secret', 'src\\secret', 'src//secret', 'C:/secret', 'src/./secret', 'src/secret\0.txt']) {
  assert.throws(() => validatePath(value), /Invalid source path/);
}
assert.equal(validatePath('src/cloud/worker.mjs'), 'src/cloud/worker.mjs');
assert.throws(() => checkText('src/key.js', 'ghp_' + 'x'.repeat(36)), /access token/);
assert.throws(() => checkText('src/key.js', '-----BEGIN ' + 'RSA PRIVATE KEY-----'), /private key/);
assert.throws(() => checkText('src/path.js', '/' + 'Users/example/private/file'), /home path/);
assert.throws(() => checkText('src/cloud/reset.sql', 'DELETE' + ' FROM users;'), /destructive SQL/);
checkText('src/cloud/schema.sql', 'CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY);');
const result = await checkSource();
assert.equal(result.anonymousRecords, 12);
assert(result.files > 60);
console.log('PASS: reviewed-file checksums, original anonymous bank, unsafe path/token/private-key and destructive SQL publication guards.');
