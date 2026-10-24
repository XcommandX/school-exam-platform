// Anonymous, in-memory fixtures only. No local-data or real accounts are read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import nodeCrypto, { createHash, pbkdf2Sync } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import {
  AuthStore, AuthError, PlatformAuthStore, hashPassword, verifyPassword,
  validateUsername, validateDisplayName, validatePassword,
  PASSWORD_ITERATIONS, SESSION_SECONDS, SESSION_IDLE_SECONDS, LOGIN_WINDOW_SECONDS, MAX_AUTH_BODY_BYTES,
} from '../src/auth.mjs';

const SETUP_TOKEN = 'anonymous_fixture_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const PASSWORD = 'anonymous-fixture-password';

function sqliteStorage(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  t.after(() => db.close());
  let depth = 0;
  return {
    db,
    sql: {
      exec(query, ...bindings) {
        const statement = db.prepare(query);
        return statement.all(...bindings);
      },
    },
    transactionSync(callback) {
      const name = `auth_test_${depth++}`;
      db.exec(`SAVEPOINT ${name}`);
      try {
        const value = callback();
        assert.equal(Boolean(value?.then), false, 'transactionSync must never receive an async callback');
        db.exec(`RELEASE SAVEPOINT ${name}`);
        return value;
      } catch (error) {
        db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
        db.exec(`RELEASE SAVEPOINT ${name}`);
        throw error;
      } finally { depth--; }
    },
  };
}

function fixture(t, extra = {}) {
  const storage = sqliteStorage(t);
  const time = { now: 1_800_000_000 };
  const options = { setupToken: SETUP_TOKEN, clock: () => time.now, ...extra };
  const store = new AuthStore(storage, options);
  const bootstrap = (changes = {}) => store.bootstrap({ setupToken: SETUP_TOKEN, username: 'fixture-admin', password: PASSWORD, ...changes });
  const login = (username = 'fixture-admin', password = PASSWORD, address = 'anonymous-test-address') => store.login({ username, password, address });
  return { storage, time, options, store, bootstrap, login };
}

async function rejectsCode(operation, status, code) {
  await assert.rejects(async () => operation(), error => {
    assert(error instanceof AuthError);
    assert.equal(error.status, status);
    if (code) assert.equal(error.code, code);
    return true;
  });
}

function gateCodec() {
  let gate = null;
  const codec = {
    async hash(password) {
      const result = hashPassword(password);
      if (gate?.kind === 'hash') {
        const current = gate;
        current.entered++;
        await current.promise;
      }
      return result;
    },
    async verify(password, encoded) {
      const result = verifyPassword(password, encoded);
      if (gate?.kind === 'verify') {
        const current = gate;
        current.entered++;
        await current.promise;
      }
      return result;
    },
  };
  return {
    codec,
    hold(kind) {
      assert.equal(gate, null);
      let release;
      const current = { kind, entered: 0, promise: new Promise(resolve => { release = resolve; }) };
      gate = current;
      return { get entered() { return current.entered; }, release() { gate = null; release(); } };
    },
  };
}

async function rpc(object, path, body = {}, options = {}) {
  const response = await object.fetch(new Request(`http://auth.internal${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...options,
  }));
  return { response, value: await response.json() };
}

test('PBKDF2 is exactly 600000 SHA256 with 24-byte random salts and compatible hex format', () => {
  const first = hashPassword(PASSWORD), second = hashPassword(PASSWORD);
  assert.match(first, /^pbkdf2_sha256\$600000\$[a-f0-9]{48}\$[a-f0-9]{64}$/);
  assert.notEqual(first, second);
  const [algorithm, iterations, salt, hash] = first.split('$');
  assert.equal(algorithm, 'pbkdf2_sha256');
  assert.equal(Number(iterations), PASSWORD_ITERATIONS);
  assert.equal(pbkdf2Sync(PASSWORD, Buffer.from(salt, 'hex'), 600000, 32, 'sha256').toString('hex'), hash);
  assert.equal(verifyPassword(PASSWORD, first), true);
  assert.equal(verifyPassword('incorrect-password', first), false);
  assert.equal(verifyPassword(PASSWORD, first.replace('$600000$', '$100000$')), false);
  assert.equal(verifyPassword(PASSWORD, first.replace('$600000$', '$2000001$')), false);
  assert.equal(verifyPassword(PASSWORD, 'not-a-hash'), false);
  assert.equal(verifyPassword('\ud800', first), false);
});

test('600k portable PBKDF2 matches independent Node vectors for UTF-8, long HMAC keys and NUL', () => {
  const salt = Buffer.from('00112233445566778899aabbccddeeff0123456789abcdef', 'hex');
  assert.equal(salt.length, 24, 'the existing stored format requires a 24-byte salt');
  for (const password of ['密码🔐\u0000abc', 'p'.repeat(256), 'é'.repeat(100)]) {
    const reference = pbkdf2Sync(password, salt, PASSWORD_ITERATIONS, 32, 'sha256').toString('hex');
    assert.equal(verifyPassword(password, `pbkdf2_sha256$600000$${salt.toString('hex')}$${reference}`), true);
    const actual = hashPassword(password).split('$');
    assert.equal(actual[3], pbkdf2Sync(password, Buffer.from(actual[2], 'hex'), 600000, 32, 'sha256').toString('hex'));
  }
});

test('hash and verify still work when native PBKDF2 explicitly refuses 600k', () => {
  const original = nodeCrypto.pbkdf2Sync;
  nodeCrypto.pbkdf2Sync = () => { throw new Error('simulated production native PBKDF2 iteration limit'); };
  syncBuiltinESMExports();
  try {
    assert.throws(() => pbkdf2Sync(PASSWORD, new Uint8Array(24), 600000, 32, 'sha256'), /iteration limit/);
    const encoded = hashPassword(PASSWORD);
    assert.equal(verifyPassword(PASSWORD, encoded), true);
  } finally {
    nodeCrypto.pbkdf2Sync = original;
    syncBuiltinESMExports();
  }
});

test('username, display name, and password validation retain the Python/client contract', () => {
  for (const value of ['Abc', 'a_b-c.d', 'a'.repeat(40)]) assert.equal(validateUsername(value), value);
  for (const value of ['ab', '_abc', '中文', 'abc\n', 'a'.repeat(41), {}, null]) {
    assert.throws(() => validateUsername(value), { code: 'invalid_username' });
  }
  assert.equal(validateDisplayName('  匿名测试  '), '匿名测试');
  assert.equal(validateDisplayName('😀'.repeat(60)), '😀'.repeat(60));
  assert.equal(validateDisplayName('\u0085姓名\u0085'), '姓名');
  assert.equal(validateDisplayName('\ufeff'), '\ufeff'); // Python str.strip does not remove BOM.
  for (const value of ['', ' ', '😀'.repeat(61), 'Name\n', 'a\u007f', '\ud800', {}]) {
    assert.throws(() => validateDisplayName(value), { code: 'invalid_display_name' });
  }
  assert.equal(validatePassword('😀'.repeat(6)), '😀'.repeat(6));
  assert.equal(validatePassword('a'.repeat(256)), 'a'.repeat(256));
  for (const value of ['12345', 'a'.repeat(257), 'valid\ud800', {}]) assert.throws(() => validatePassword(value), { code: 'invalid_password' });
});

test('schema restarts are idempotent and a fresh store contains no default users', async t => {
  const f = fixture(t);
  assert.deepEqual(f.store.session({ token: null }), { authenticated: false, loginEnabled: true, user: null, expiresAt: null });
  assert.equal(f.storage.db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 0);
  const session = await f.bootstrap();
  const restarted = new AuthStore(f.storage, f.options);
  assert.equal(restarted.session({ token: session.token }).user.id, session.user.id);
  assert.equal(f.storage.db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 1);
  assert.equal(f.storage.db.prepare('SELECT COUNT(*) AS count FROM auth_meta WHERE key=?').get('setup_complete').count, 1);
  assert.equal(restarted.tokenSalt, f.store.tokenSalt);
  assert.equal(restarted.dummyPassword, f.store.dummyPassword);
});

test('bootstrap requires a strong configured secret and cannot reset or repeat', async t => {
  const f = fixture(t, { setupToken: undefined });
  await rejectsCode(() => f.bootstrap(), 503, 'setup_unavailable');
  for (const setupToken of ['', 'weak-password', 'a'.repeat(43), 'contains spaces even with enough characters']) {
    const store = new AuthStore(f.storage, { ...f.options, setupToken });
    await rejectsCode(() => store.bootstrap({ setupToken, username: 'fixture-admin', password: PASSWORD }), 503, 'setup_unavailable');
  }
  const store = new AuthStore(f.storage, { ...f.options, setupToken: SETUP_TOKEN });
  await rejectsCode(() => store.bootstrap({ setupToken: 'wrong', username: 'fixture-admin', password: PASSWORD }), 403, 'invalid_setup_token');
  const result = await store.bootstrap({ setupToken: SETUP_TOKEN, username: 'fixture-admin', password: PASSWORD });
  assert.equal(result.user.role, 'admin');
  assert.equal(result.user.displayName, 'fixture-admin');
  const stored = f.storage.db.prepare('SELECT password_hash FROM users').get().password_hash;
  await rejectsCode(() => store.bootstrap({ setupToken: SETUP_TOKEN, username: 'other-admin', password: 'new-password' }), 409, 'setup_completed');
  assert.equal(f.storage.db.prepare('SELECT password_hash FROM users').get().password_hash, stored);
  // Persistent consumption survives even accidental removal of all users.
  f.storage.db.exec('DELETE FROM users');
  await rejectsCode(() => new AuthStore(f.storage, { ...f.options, setupToken: SETUP_TOKEN }).bootstrap({
    setupToken: SETUP_TOKEN, username: 'new-admin', password: PASSWORD,
  }), 409, 'setup_completed');
});

test('bootstrap user-empty guard and racing hashes cannot create two administrators', async t => {
  const gates = gateCodec(), f = fixture(t, { passwordCodec: gates.codec });
  const gate = gates.hold('hash');
  const attempts = [f.bootstrap(), f.bootstrap({ username: 'other-admin' })];
  assert.equal(gate.entered, 2);
  gate.release();
  const results = await Promise.allSettled(attempts);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'setup_completed');
  f.storage.db.prepare('DELETE FROM auth_meta WHERE key=?').run('setup_complete');
  await rejectsCode(() => f.bootstrap(), 409, 'setup_completed');
});

test('session storage is salted, single-session, redacted, restart-safe and logout revokes', async t => {
  const f = fixture(t), initial = await f.bootstrap();
  const session = await f.login(' FIXTURE-ADMIN ');
  assert.match(session.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(f.store.session({ token: initial.token }).authenticated, false);
  assert.equal(session.expiresAt, (f.time.now + SESSION_SECONDS) * 1000);
  assert.deepEqual(Object.keys(session.user).sort(), ['active', 'createdAt', 'displayName', 'id', 'lastLoginAt', 'name', 'role', 'updatedAt', 'username'].sort());
  const row = f.storage.db.prepare('SELECT * FROM sessions').get();
  assert.notEqual(row.token_hash, createHash('sha256').update(session.token).digest('hex'));
  assert.equal(JSON.stringify(row).includes(session.token), false);
  assert.equal(f.store.session({ token: `${session.token}\n` }).authenticated, false);
  assert.equal(f.store.session({ token: {} }).authenticated, false);
  const restarted = new AuthStore(f.storage, f.options);
  assert.equal(restarted.session({ token: session.token }).authenticated, true);
  assert.deepEqual(restarted.logout({ token: session.token }), { ok: true });
  assert.equal(restarted.session({ token: session.token }).authenticated, false);
  await rejectsCode(() => restarted.logout({ token: session.token }), 401, 'session_expired');
});

test('idle expiry at two hours and absolute lifetime at twelve hours are enforced', async t => {
  const f = fixture(t), session = await f.bootstrap();
  f.time.now += 59;
  f.store.session({ token: session.token });
  assert.equal(f.storage.db.prepare('SELECT last_seen_at FROM sessions').get().last_seen_at, f.time.now - 59);
  f.time.now += 1;
  f.store.session({ token: session.token });
  assert.equal(f.storage.db.prepare('SELECT last_seen_at FROM sessions').get().last_seen_at, f.time.now);
  f.time.now += SESSION_IDLE_SECONDS;
  assert.equal(f.store.session({ token: session.token }).authenticated, false);
  assert.equal(f.storage.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
  const next = await f.login();
  const start = f.time.now;
  for (let hour = 1; hour < 12; hour++) {
    f.time.now = start + hour * 3600;
    assert.equal(f.store.session({ token: next.token }).authenticated, true);
  }
  f.time.now = start + SESSION_SECONDS;
  assert.equal(f.store.session({ token: next.token }).authenticated, false);
});

test('admin authorization is enforced for every internal management operation', async t => {
  const f = fixture(t), admin = await f.bootstrap();
  const created = await f.store.createUser({ token: admin.token, username: 'fixture-student', password: PASSWORD });
  const student = await f.login('fixture-student');
  assert.equal(created.user.role, 'student');
  await rejectsCode(() => f.store.users({ token: null }), 401, 'session_expired');
  await rejectsCode(() => f.store.users({ token: student.token }), 403, 'admin_required');
  await rejectsCode(() => f.store.createUser({ token: student.token, username: 'evil-admin', password: PASSWORD, role: 'admin' }), 403, 'admin_required');
  await rejectsCode(() => f.store.updateUser({ token: student.token, targetId: student.user.id, changes: { role: 'admin' } }), 403, 'admin_required');
  await rejectsCode(() => f.store.updateUser({ token: student.token, targetId: student.user.id, changes: { role: 'admin' }, ownProfile: true }), 400);
  await rejectsCode(() => f.store.updateUser({ token: student.token, targetId: admin.user.id, changes: { displayName: 'Unauthorized' }, ownProfile: true }), 403);
  await rejectsCode(() => f.store.password({ token: student.token, targetId: admin.user.id, newPassword: 'reset-password' }), 403, 'admin_required');
  const updated = f.store.updateUser({ token: student.token, targetId: student.user.id, changes: { displayName: ' 匿名学生 ' }, ownProfile: true });
  assert.equal(updated.displayName, '匿名学生');
  assert.equal(updated.user, undefined);
  assert.equal(f.store.session({ token: student.token }).authenticated, true);
  assert.equal(f.store.users({ token: admin.token }).users.length, 2);
});

test('case-insensitive username uniqueness and frontend creation/update validation', async t => {
  const f = fixture(t), admin = await f.bootstrap();
  await rejectsCode(() => f.store.createUser({ token: admin.token, username: 'FIXTURE-ADMIN', password: PASSWORD }), 409, 'username_exists');
  await rejectsCode(() => f.store.createUser({ token: admin.token, username: 'valid-user', password: PASSWORD, role: {} }), 400);
  await rejectsCode(() => f.store.updateUser({ token: admin.token, targetId: admin.user.id, changes: { active: 1 } }), 400);
  await rejectsCode(() => f.store.updateUser({ token: admin.token, targetId: admin.user.id, changes: { username: 'rename-user' } }), 400);
  await rejectsCode(() => f.store.updateUser({ token: admin.token, targetId: admin.user.id, changes: {} }), 400);
  await rejectsCode(() => f.store.updateUser({ token: admin.token, targetId: '0'.repeat(32), changes: { active: false } }), 404, 'not_found');
});

test('last active administrator cannot be disabled or demoted', async t => {
  const f = fixture(t), admin = await f.bootstrap();
  await rejectsCode(() => f.store.updateUser({ token: admin.token, targetId: admin.user.id, changes: { active: false } }), 409, 'last_admin');
  await rejectsCode(() => f.store.updateUser({ token: admin.token, targetId: admin.user.id, changes: { role: 'student' } }), 409, 'last_admin');
  const second = await f.store.createUser({ token: admin.token, username: 'second-admin', password: PASSWORD, role: 'admin' });
  f.store.updateUser({ token: admin.token, targetId: second.user.id, changes: { active: false } });
  await rejectsCode(() => f.store.updateUser({ token: admin.token, targetId: admin.user.id, changes: { role: 'student' } }), 409, 'last_admin');
  f.store.updateUser({ token: admin.token, targetId: second.user.id, changes: { active: true } });
  const other = await f.login('second-admin');
  f.store.updateUser({ token: admin.token, targetId: admin.user.id, changes: { role: 'student' } });
  assert.equal(f.store.session({ token: admin.token }).authenticated, false);
  await rejectsCode(() => f.store.updateUser({ token: other.token, targetId: other.user.id, changes: { active: false } }), 409, 'last_admin');
});

test('password change/reset, role change and disable all revoke sessions', async t => {
  const f = fixture(t), admin = await f.bootstrap();
  const { user } = await f.store.createUser({ token: admin.token, username: 'fixture-student', password: PASSWORD });
  let session = await f.login(user.username);
  await rejectsCode(() => f.store.password({ token: session.token, currentPassword: 'incorrect', newPassword: 'changed-password' }), 400, 'incorrect_password');
  assert.equal(f.store.session({ token: session.token }).authenticated, true);
  assert.deepEqual(await f.store.password({ token: session.token, currentPassword: PASSWORD, newPassword: 'changed-password' }), { ok: true, reauthenticate: true });
  assert.equal(f.store.session({ token: session.token }).authenticated, false);
  session = await f.login(user.username, 'changed-password');
  assert.deepEqual(await f.store.password({ token: admin.token, targetId: user.id, newPassword: 'reset-password' }), { ok: true });
  assert.equal(f.store.session({ token: session.token }).authenticated, false);
  session = await f.login(user.username, 'reset-password');
  f.store.updateUser({ token: admin.token, targetId: user.id, changes: { role: 'admin' } });
  assert.equal(f.store.session({ token: session.token }).authenticated, false);
  session = await f.login(user.username, 'reset-password');
  f.store.updateUser({ token: admin.token, targetId: user.id, changes: { active: false } });
  assert.equal(f.store.session({ token: session.token }).authenticated, false);
  await rejectsCode(() => f.login(user.username, 'reset-password'), 401, 'invalid_credentials');
  f.store.updateUser({ token: admin.token, targetId: user.id, changes: { active: true } });
  assert.equal((await f.login(user.username, 'reset-password')).authenticated, true);
});

test('five failed attempts persist across restart, expire after fifteen minutes and never log secrets', async t => {
  const f = fixture(t), admin = await f.bootstrap();
  const submittedPassword = 'never-log-this-password', address = '192.0.2.42', username = 'nonexistent-user';
  for (let index = 0; index < 5; index++) await rejectsCode(() => f.login(username, submittedPassword, address), 401, 'invalid_credentials');
  const restarted = new AuthStore(f.storage, f.options);
  await rejectsCode(() => restarted.login({ username: username.toUpperCase(), password: submittedPassword, address: 'another-address' }), 429, 'rate_limited');
  const privateRows = JSON.stringify({ audit: f.storage.db.prepare('SELECT * FROM audit_events').all(), failures: f.storage.db.prepare('SELECT * FROM login_failures').all() });
  for (const secret of [submittedPassword, address, username, admin.token, SETUP_TOKEN]) assert.equal(privateRows.includes(secret), false);
  f.time.now += LOGIN_WINDOW_SECONDS;
  await rejectsCode(() => restarted.login({ username, password: submittedPassword, address }), 401, 'invalid_credentials');
});

test('address failure cap is thirty even across thirty different usernames', async t => {
  const f = fixture(t);
  for (let index = 0; index < 30; index++) await rejectsCode(() => f.login(`missing-user-${index}`, 'incorrect-password', 'shared-address'), 401, 'invalid_credentials');
  await rejectsCode(() => f.login('yet-another-user', 'incorrect-password', 'shared-address'), 429, 'rate_limited');
  await rejectsCode(() => f.login('yet-another-user', 'incorrect-password', 'different-address'), 401, 'invalid_credentials');
});

test('in-flight reservations share atomic limits; failed login does not revoke current session', async t => {
  const gates = gateCodec(), f = fixture(t, { passwordCodec: gates.codec }), admin = await f.bootstrap();
  const gate = gates.hold('verify');
  const attempts = Array.from({ length: 10 }, (_, index) => f.login('fixture-admin', 'incorrect-password', `parallel-address-${index}`));
  const all = Promise.allSettled(attempts);
  assert.equal(gate.entered, 5);
  gate.release();
  const results = await all;
  assert.equal(results.filter(result => result.reason?.status === 401).length, 5);
  assert.equal(results.filter(result => result.reason?.status === 429).length, 5);
  assert.equal(f.store.session({ token: admin.token }).authenticated, true);
  await rejectsCode(() => f.login(), 429, 'rate_limited');
});

test('successful login releases only its own reservation, not other failures', async t => {
  const gates = gateCodec(), f = fixture(t, { passwordCodec: gates.codec });
  await f.bootstrap();
  const gate = gates.hold('verify');
  const attempts = [f.login('fixture-admin', 'wrong-password'), f.login()];
  const all = Promise.allSettled(attempts);
  assert.equal(gate.entered, 2);
  gate.release();
  const results = await all;
  assert.equal(results[0].reason.code, 'invalid_credentials');
  assert.equal(results[1].value.authenticated, true);
  const buckets = f.storage.db.prepare('SELECT failures FROM login_failures').all();
  assert.equal(buckets.length, 2);
  assert(buckets.every(row => row.failures === 1));
});

test('a stale successful login cannot decrement a new fifteen-minute failure window', async t => {
  const gates = gateCodec(), f = fixture(t, { passwordCodec: gates.codec });
  await f.bootstrap();
  const gate = gates.hold('verify');
  const pending = f.login();
  assert.equal(gate.entered, 1);
  f.time.now += LOGIN_WINDOW_SECONDS;
  // Same username/address, but the first window has expired during the check.
  const failed = f.login('fixture-admin', 'incorrect-password');
  const both = Promise.allSettled([pending, failed]);
  assert.equal(gate.entered, 2);
  gate.release();
  const results = await both;
  assert.equal(results[0].value.authenticated, true);
  assert.equal(results[1].reason.code, 'invalid_credentials');
  const rows = f.storage.db.prepare('SELECT failures,expires_at FROM login_failures').all();
  assert.equal(rows.length, 2);
  assert(rows.every(row => row.failures === 1 && row.expires_at === f.time.now + LOGIN_WINDOW_SECONDS));
});

test('parallel successful logins still leave only one valid session', async t => {
  const gates = gateCodec(), f = fixture(t, { passwordCodec: gates.codec }), initial = await f.bootstrap();
  const gate = gates.hold('verify');
  const pending = Promise.all([f.login(), f.login()]);
  assert.equal(gate.entered, 2);
  gate.release();
  const results = await pending;
  assert.equal(f.storage.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 1);
  assert.equal(f.store.session({ token: initial.token }).authenticated, false);
  assert.equal(results.filter(session => f.store.session({ token: session.token }).authenticated).length, 1);
});

test('failure-table capacity never evicts an unexpired reservation to admit a spray', async t => {
  const f = fixture(t);
  const insert = f.storage.db.prepare('INSERT INTO login_failures(bucket,failures,expires_at) VALUES (?,?,?)');
  f.storage.transactionSync(() => {
    for (let index = 0; index < 10_000; index++) insert.run(`anonymous-capacity-fixture-${index}`, 1, f.time.now + 10);
  });
  await rejectsCode(() => f.login(), 429, 'rate_limited');
  assert.equal(f.storage.db.prepare('SELECT COUNT(*) AS count FROM login_failures').get().count, 10_000);
  f.time.now += 10;
  await rejectsCode(() => f.login(), 401, 'invalid_credentials');
  assert.equal(f.storage.db.prepare('SELECT COUNT(*) AS count FROM login_failures').get().count, 2);
});

test('login rechecks security version after disable/enable and role reversal while hashing', async t => {
  const gates = gateCodec(), f = fixture(t, { passwordCodec: gates.codec }), admin = await f.bootstrap();
  const { user } = await f.store.createUser({ token: admin.token, username: 'fixture-student', password: PASSWORD });
  for (const changes of [[{ active: false }, { active: true }], [{ role: 'admin' }, { role: 'student' }]]) {
    const gate = gates.hold('verify');
    const pending = f.login(user.username);
    assert.equal(gate.entered, 1);
    for (const change of changes) f.store.updateUser({ token: admin.token, targetId: user.id, changes: change });
    gate.release();
    await rejectsCode(() => pending, 401, 'invalid_credentials');
    assert.equal(f.storage.db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id=?').get(user.id).count, 0);
  }
});

test('login cannot issue a stale session after password reset during hash', async t => {
  const gates = gateCodec(), f = fixture(t, { passwordCodec: gates.codec }), admin = await f.bootstrap();
  const { user } = await f.store.createUser({ token: admin.token, username: 'fixture-student', password: PASSWORD });
  const gate = gates.hold('verify');
  const pending = f.login(user.username);
  await f.store.password({ token: admin.token, targetId: user.id, newPassword: 'reset-password' });
  gate.release();
  await rejectsCode(() => pending, 401, 'invalid_credentials');
  assert.equal((await f.login(user.username, 'reset-password')).authenticated, true);
});

test('async create/password operations recheck actor token after revocation', async t => {
  const gates = gateCodec(), f = fixture(t, { passwordCodec: gates.codec }), admin = await f.bootstrap();
  const { user } = await f.store.createUser({ token: admin.token, username: 'fixture-student', password: PASSWORD });
  let gate = gates.hold('hash');
  const create = f.store.createUser({ token: admin.token, username: 'should-not-exist', password: PASSWORD });
  f.store.logout({ token: admin.token });
  gate.release();
  await rejectsCode(() => create, 401, 'session_expired');
  assert.equal(f.storage.db.prepare('SELECT COUNT(*) AS count FROM users WHERE username=?').get('should-not-exist').count, 0);
  const actor = await f.login();
  gate = gates.hold('hash');
  const reset = f.store.password({ token: actor.token, targetId: user.id, newPassword: 'should-not-apply' });
  f.store.logout({ token: actor.token });
  gate.release();
  await rejectsCode(() => reset, 401, 'session_expired');
  assert.equal((await f.login(user.username)).authenticated, true);
});

test('own password verification cannot finish after an administrator resets the account', async t => {
  const gates = gateCodec(), f = fixture(t, { passwordCodec: gates.codec }), admin = await f.bootstrap();
  const { user } = await f.store.createUser({ token: admin.token, username: 'fixture-student', password: PASSWORD });
  const session = await f.login(user.username);
  const gate = gates.hold('verify');
  const ownChange = f.store.password({ token: session.token, currentPassword: PASSWORD, newPassword: 'stale-own-password' });
  assert.equal(gate.entered, 1);
  await f.store.password({ token: admin.token, targetId: user.id, newPassword: 'administrator-reset-password' });
  gate.release();
  await rejectsCode(() => ownChange, 401, 'session_expired');
  assert.equal((await f.login(user.username, 'administrator-reset-password')).authenticated, true);
});

test('an admin losing role while creating an account cannot finish the pending write', async t => {
  const gates = gateCodec(), f = fixture(t, { passwordCodec: gates.codec }), first = await f.bootstrap();
  await f.store.createUser({ token: first.token, username: 'second-admin', password: PASSWORD, role: 'admin' });
  const second = await f.login('second-admin');
  const gate = gates.hold('hash');
  const create = f.store.createUser({ token: second.token, username: 'must-not-create', password: PASSWORD });
  f.store.updateUser({ token: first.token, targetId: second.user.id, changes: { role: 'student' } });
  gate.release();
  await rejectsCode(() => create, 401, 'session_expired');
  assert.equal(f.storage.db.prepare('SELECT COUNT(*) AS count FROM users WHERE username=?').get('must-not-create').count, 0);
});

test('two administrator resets cannot overwrite intervening security changes', async t => {
  const gates = gateCodec(), f = fixture(t, { passwordCodec: gates.codec }), admin = await f.bootstrap();
  const { user } = await f.store.createUser({ token: admin.token, username: 'fixture-student', password: PASSWORD });
  const gate = gates.hold('hash');
  const first = f.store.password({ token: admin.token, targetId: user.id, newPassword: 'first-password' });
  const second = f.store.password({ token: admin.token, targetId: user.id, newPassword: 'second-password' });
  const all = Promise.allSettled([first, second]);
  gate.release();
  const results = await all;
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'user_changed');
});

test('PBKDF2 runtime failure is explicit and never downgrades or creates users', async t => {
  const f = fixture(t, { passwordCodec: { hash() { throw new Error('not supported; never expose bindings'); }, verify() { throw new Error('not supported'); } } });
  await rejectsCode(() => f.bootstrap(), 503, 'crypto_unavailable');
  assert.equal(f.storage.db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 0);
  await rejectsCode(() => f.login(), 503, 'crypto_unavailable');
  const weak = fixture(t, { passwordCodec: { hash() { return `pbkdf2_sha256$100000$${'00'.repeat(24)}$${'00'.repeat(32)}`; }, verify: verifyPassword } });
  await rejectsCode(() => weak.bootstrap(), 503, 'crypto_unavailable');
});

test('SQL rollback keeps bootstrap all-or-nothing on audit/storage errors', async t => {
  const f = fixture(t);
  f.storage.db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'anonymous storage failure'); END");
  await assert.rejects(() => f.bootstrap());
  assert.equal(f.storage.db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 0);
  assert.equal(f.storage.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
  assert.equal(f.storage.db.prepare('SELECT COUNT(*) AS count FROM auth_meta WHERE key=?').get('setup_complete').count, 0);
  f.storage.db.exec('DROP TRIGGER fail_audit');
  assert.equal((await f.bootstrap()).authenticated, true);
});

test('internal fetch RPC preserves contracts, strict fields and no tokens outside login/bootstrap', async t => {
  const storage = sqliteStorage(t), object = new PlatformAuthStore({ storage }, { SETUP_TOKEN });
  let result = await rpc(object, '/session', { token: null });
  assert.equal(result.value.authenticated, false);
  assert.equal(result.response.headers.get('Cache-Control'), 'no-store');
  const setup = await rpc(object, '/bootstrap', { setupToken: SETUP_TOKEN, username: 'rpc-admin', password: PASSWORD });
  assert.equal(setup.response.status, 201);
  const token = setup.value.token;
  assert.equal(typeof token, 'string');
  result = await rpc(object, '/users', { token });
  assert.equal(result.response.status, 200);
  assert.equal(JSON.stringify(result.value).includes(token), false);
  result = await rpc(object, '/create-user', { token, username: 'rpc-student', password: PASSWORD });
  assert.equal(result.response.status, 201);
  const targetId = result.value.user.id;
  result = await rpc(object, '/update-user', { token, targetId, changes: { displayName: '匿名学生' } });
  assert.equal(result.value.user.displayName, '匿名学生');
  result = await rpc(object, '/password', { token, targetId, newPassword: 'rpc-new-password' });
  assert.deepEqual(result.value, { ok: true });
  result = await rpc(object, '/login', { username: 'rpc-student', password: 'rpc-new-password', address: 'anonymous-address' });
  assert.equal(result.value.authenticated, true);
  const studentToken = result.value.token;
  result = await rpc(object, '/session', { token: studentToken });
  assert.equal(result.value.user.id, targetId);
  assert.equal('token' in result.value, false);
  assert.equal('sessionId' in result.value, false);
  result = await rpc(object, '/update-user', { token: studentToken, targetId, changes: { displayName: '匿名新名' }, ownProfile: true });
  assert.equal(result.value.displayName, '匿名新名');
  result = await rpc(object, '/password', { token: studentToken, currentPassword: 'rpc-new-password', newPassword: 'changed-rpc-password' });
  assert.deepEqual(result.value, { ok: true, reauthenticate: true });
  result = await rpc(object, '/logout', { token });
  assert.deepEqual(result.value, { ok: true });
  for (const [path, body] of [['/users', { actorId: setup.value.user.id }], ['/session', { token: null, role: 'admin' }], ['/bootstrap', { setupToken: SETUP_TOKEN, username: 'rpc-admin', password: PASSWORD, role: 'admin' }]]) {
    assert.equal((await rpc(object, path, body)).response.status, 400);
  }
});

test('internal request decoder rejects oversized, duplicate, malformed JSON and unsafe Unicode', async t => {
  const object = new PlatformAuthStore({ storage: sqliteStorage(t) }, {});
  for (const body of ['{}', '[]', 'null', '{"token":null,"token":"other"}', '{"token":1e999}', '{"token":"\\ud800"}', '{"token":null} garbage']) {
    assert.equal((await rpc(object, '/session', {}, { body })).response.status, 400);
  }
  assert.equal((await rpc(object, '/session', {}, { headers: { 'Content-Type': 'text/plain' } })).response.status, 415);
  assert.equal((await rpc(object, '/session', {}, { body: `{"token":"${'a'.repeat(MAX_AUTH_BODY_BYTES)}"}` })).response.status, 413);
  assert.equal((await rpc(object, '/session', {}, { method: 'GET', body: undefined })).response.status, 405);
  assert.equal((await rpc(object, '/missing', {})).response.status, 404);
  assert.equal((await rpc(object, '/session?token=secret', { token: null })).response.status, 400);
  const invalidBytes = new Uint8Array([123, 34, 116, 111, 107, 101, 110, 34, 58, 34, 0xff, 34, 125]);
  assert.equal((await rpc(object, '/session', {}, { body: invalidBytes })).response.status, 400);
});
