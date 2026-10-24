// Anonymous in-memory SQLite fixtures; production codec is tested in workerd.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { AuthStore, hashPassword, REGISTRATION_SECONDS, REGISTRATION_LEASE_SECONDS, REGISTRATION_HISTORY_SECONDS, MAX_PENDING_REGISTRATIONS, MAX_REGISTRATION_HISTORY } from '../src/auth.mjs';
import { AUTH_SCHEMA_VERSION } from '../src/auth-schema.mjs';
import worker from '../src/worker.mjs';
const origin = 'https://registration-fixture.invalid';
const application = { username: 'fixture-student', displayName: '匿名学生', password: 'anonymous-password' };
const setupToken = 'anonymous_setup_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const encoded = hashPassword(application.password);
const codec = { hash: () => encoded, verify: (password, hash) => password === application.password && hash === encoded };
function storage(t) {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); t.after(() => db.close()); let depth = 0;
  return { db, sql: { exec(query, ...args) { return db.prepare(query).all(...args); } }, transactionSync(fn) {
    const name = `registration_${depth++}`; db.exec(`SAVEPOINT ${name}`);
    try { const result = fn(); assert(!result?.then); db.exec(`RELEASE ${name}`); return result; }
    catch (error) { db.exec(`ROLLBACK TO ${name}`); db.exec(`RELEASE ${name}`); throw error; } finally { depth--; }
  } };
}
function fixture(t, options = {}) {
  const backing = storage(t), time = { now: 1_800_000_000 };
  const opts = { clock: () => time.now, setupToken, passwordCodec: codec, ...options };
  const store = new AuthStore(backing, opts);
  return { backing, time, opts, store,
    register: (changes = {}) => store.register({ ...application, address: '192.0.2.1', ...changes }),
    admin: () => store.bootstrap({ setupToken, username: 'fixture-admin', displayName: '管理员甲', password: application.password }),
    requests: token => store.registrations({ token }),
    decide: (token, requestId, approve = true) => store.decideRegistration({ token, requestId, approve }),
  };
}
const one = (f, sql, ...args) => f.backing.db.prepare(sql).get(...args);
const rejects = (fn, code) => assert.rejects(async () => fn(), error => error.code === code);
function gate() { let release, entered; const reached = new Promise(r => entered = r), waiting = new Promise(r => release = r); return { release, reached, async hold() { entered(); await waiting; } }; }

test('registration requires active administrator, not email secrets; no applicant login before approval', async t => {
  const f = fixture(t);
  assert.deepEqual(f.store.registrationConfigValue(), { enabled: false, mode: 'admin' });
  await rejects(() => f.register(), 'registration_unavailable');
  const admin = await f.admin();
  assert.deepEqual(f.store.registrationConfigValue(), { enabled: true, mode: 'admin' });
  assert.equal((await f.register()).pending, true);
  const row = one(f, 'SELECT * FROM registration_requests');
  assert.equal(row.password_hash, encoded); assert.equal(row.status, 'pending');
  assert(!JSON.stringify(row).includes(application.password));
  await rejects(() => f.store.login({ ...application, address: '192.0.2.1' }), 'invalid_credentials');
  const result = f.requests(admin.token);
  assert.equal(result.pendingCount, 1);
  assert.deepEqual(Object.keys(result.requests[0]).sort(), ['id','username','displayName','status','createdAt','reviewedAt','reviewedBy'].sort());
  assert.equal(result.requests[0].createdAt, f.time.now * 1000);
  assert.deepEqual(f.decide(admin.token, row.id), { approved: true });
  assert.equal(one(f, 'SELECT COUNT(*) AS n FROM sessions').n, 1, 'approval creates no session');
  assert.equal(one(f, 'SELECT password_hash FROM registration_requests').password_hash, null);
  const user = await f.store.login({ ...application, address: '192.0.2.1' }); assert.equal(user.user.role, 'student');
  await rejects(() => f.requests(user.token), 'admin_required');
  await rejects(() => f.decide(user.token, row.id), 'admin_required');
  await rejects(() => f.decide(admin.token, row.id), 'registration_changed');
  assert.equal(f.requests(admin.token).requests[0].reviewedBy, '管理员甲');
  assert.equal(one(f, "SELECT actor_id FROM audit_events WHERE action='registration.approve'").actor_id, admin.user.id);
});

test('all administrators share pending and processed history; rejection clears hash and permits reapply', async t => {
  const f = fixture(t), a = await f.admin();
  await f.store.createUser({ token: a.token, username: 'second-admin', displayName: '管理员乙', password: application.password, role: 'admin' });
  const b = await f.store.login({ username: 'second-admin', password: application.password, address: '192.0.2.2' });
  await f.register(); const id = f.requests(a.token).requests[0].id;
  assert.deepEqual(f.requests(a.token), f.requests(b.token));
  assert.deepEqual(f.decide(b.token, id, false), { rejected: true });
  assert.equal(one(f, 'SELECT password_hash FROM registration_requests WHERE id=?', id).password_hash, null);
  assert.equal(one(f, 'SELECT COUNT(*) n FROM users').n, 2);
  f.time.now++;
  await f.register(); const listed = f.requests(a.token);
  assert.equal(listed.pendingCount, 1); assert.equal(listed.requests[0].status, 'pending');
  assert.equal(listed.requests[1].reviewedBy, '管理员乙');
  await rejects(() => f.decide(a.token, id), 'registration_changed');
  f.store.logout({ token: b.token });
  await rejects(() => f.decide(b.token, listed.requests[0].id), 'session_expired');
});

test('case-insensitive pending and existing usernames cannot overwrite submitted credentials', async t => {
  const f = fixture(t), a = await f.admin(); await f.register();
  await rejects(() => f.register({ username: application.username.toUpperCase(), displayName: 'replacement' }), 'registration_pending');
  assert.equal(one(f, 'SELECT display_name FROM registration_requests').display_name, application.displayName);
  f.decide(a.token, f.requests(a.token).requests[0].id);
  await rejects(() => f.register(), 'username_exists');
});

test('exact seven day expiry and thirty day history retention remove credentials and free names', async t => {
  const f = fixture(t); await f.admin(); await f.register();
  const id = one(f, 'SELECT id FROM registration_requests').id;
  f.time.now += REGISTRATION_SECONDS;
  const a = await f.store.login({ username: 'fixture-admin', password: application.password, address: '192.0.2.2' });
  await rejects(() => f.decide(a.token, id), 'registration_changed');
  assert.equal(f.requests(a.token).requests.length, 0);
  await f.register(); f.decide(a.token, f.requests(a.token).requests[0].id, false);
  f.time.now += REGISTRATION_HISTORY_SECONDS; f.store.cleanupRegistrations();
  assert.equal(one(f, 'SELECT COUNT(*) n FROM registration_requests').n, 0);
});

test('hash lease prevents races; late completion cannot promote/delete replacement; hash errors release lease', async t => {
  const f = fixture(t), a = await f.admin(), held = gate();
  f.store.passwordCodec = { ...codec, async hash() { await held.hold(); return encoded; } };
  const original = f.register(); await held.reached;
  assert.equal(f.requests(a.token).pendingCount, 0);
  await rejects(() => f.register(), 'registration_pending');
  f.time.now += REGISTRATION_LEASE_SECONDS;
  f.store.passwordCodec = codec; await f.register();
  const id = one(f, 'SELECT id FROM registration_requests').id;
  held.release(); await rejects(() => original, 'registration_unavailable');
  assert.equal(one(f, 'SELECT id FROM registration_requests').id, id);
  f.decide(a.token, id, false);
  f.store.passwordCodec = { ...codec, hash() { throw Error('private crypto failure'); } };
  await rejects(() => f.register(), 'crypto_unavailable');
  assert.equal(one(f, "SELECT COUNT(*) n FROM registration_requests WHERE status='hashing'").n, 0);
});

test('racing decisions create one student; audit failure rolls user and decision back', async t => {
  const f = fixture(t), a = await f.admin(); await f.register(); const id = f.requests(a.token).requests[0].id;
  const audit = f.store._audit; f.store._audit = () => { throw Error('storage failure'); };
  assert.throws(() => f.decide(a.token, id));
  assert.equal(one(f, 'SELECT COUNT(*) n FROM users').n, 1);
  assert.equal(one(f, 'SELECT status FROM registration_requests').status, 'pending');
  f.store._audit = audit;
  const results = await Promise.allSettled([Promise.resolve().then(() => f.decide(a.token, id)), Promise.resolve().then(() => f.decide(a.token, id, false))]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'registration_changed');
  assert.equal(one(f, 'SELECT COUNT(*) n FROM users').n, 2);
});

test('v1/v2 upgrades and restarts preserve users/sessions/setup, destroy old bearer requests', async t => {
  for (const version of ['1','2']) {
    const f = fixture(t), a = await f.admin(); await f.register();
    f.backing.db.prepare("UPDATE auth_meta SET value=? WHERE key='schema_version'").run(version);
    f.backing.db.exec("CREATE TABLE pending_registrations (token_hash TEXT, password_hash TEXT); INSERT INTO pending_registrations VALUES ('old-token','old-hash')");
    const before = one(f, 'SELECT * FROM users');
    f.store = new AuthStore(f.backing, f.opts); f.store = new AuthStore(f.backing, f.opts);
    assert.equal(one(f, "SELECT value FROM auth_meta WHERE key='schema_version'").value, AUTH_SCHEMA_VERSION);
    assert.deepEqual(one(f, 'SELECT * FROM users'), before);
    assert.equal(f.store.session({ token: a.token }).authenticated, true);
    assert.equal(one(f, "SELECT name FROM sqlite_master WHERE name='pending_registrations'"), undefined);
    assert.equal(one(f, 'SELECT COUNT(*) n FROM registration_requests').n, 1);
    await rejects(() => f.store.dispatch('/registration-approve', { token: 'old-token', address: 'x' }), 'not_found');
  }
});

test('IP/global/day limit reservations survive restarts and count duplicate/failing attempts', async t => {
  const f = fixture(t); await f.admin(); await f.register();
  for (let i = 1; i < 5; i++) await rejects(() => f.register(), 'registration_pending');
  f.store = new AuthStore(f.backing, f.opts);
  await rejects(() => f.register(), 'rate_limited');
  for (let i = 0; i < 15; i++) await rejects(() => f.register({ address: '192.0.2.' + (i + 2) }), 'registration_pending');
  await rejects(() => f.register({ address: '192.0.2.99' }), 'rate_limited');
  f.time.now += 600;
  await rejects(() => f.register({ address: '192.0.2.99' }), 'registration_pending');
  f.backing.db.exec("UPDATE registration_limits SET attempts=100 WHERE bucket='registration-day'");
  await rejects(() => f.register({ address: '192.0.2.100' }), 'rate_limited');
});

test('pending and history bounds are enforced; cleanup removes expired limiter buckets', async t => {
  const f = fixture(t), a = await f.admin();
  const insert = f.backing.db.prepare('INSERT INTO registration_requests(id,username,username_key,display_name,status,created_at,expires_at,lease_expires_at,reviewed_at) VALUES (?,?,?,?,?,?,?,?,?)');
  for (let i = 0; i < MAX_PENDING_REGISTRATIONS; i++) insert.run(i.toString(16).padStart(32,'0'), 'user'+i, 'user'+i, 'Fixture', 'hashing', f.time.now, f.time.now + REGISTRATION_SECONDS, f.time.now + 120, null);
  await rejects(() => f.register(), 'registration_capacity');
  f.time.now += 120; f.store.cleanupRegistrations();
  for (let i = 0; i <= MAX_REGISTRATION_HISTORY; i++) insert.run(i.toString(16).padStart(32,'0'), 'old'+i, 'old'+i, 'Fixture', 'rejected', f.time.now, f.time.now, f.time.now, f.time.now);
  const history = f.requests(a.token).requests;
  assert.equal(history.length, MAX_REGISTRATION_HISTORY);
  assert.equal(history[0].username, 'old' + MAX_REGISTRATION_HISTORY, 'same-second list orders newest insertion first');
  assert.equal(one(f, 'SELECT id FROM registration_requests WHERE id=?', '0'.repeat(32)), undefined);
  // A late decision on an old-created application must survive same-second trimming.
  await f.register({ address: '192.0.2.9' });
  const current = one(f, "SELECT id FROM registration_requests WHERE status='pending'").id;
  f.backing.db.prepare('UPDATE registration_requests SET created_at=? WHERE id=?').run(f.time.now - 100, current);
  f.decide(a.token, current, false);
  assert.equal(one(f, 'SELECT status FROM registration_requests WHERE id=?', current).status, 'rejected');
  assert.equal(one(f, 'SELECT COUNT(*) n FROM registration_requests').n, MAX_REGISTRATION_HISTORY);
  f.time.now += 86400; f.store.cleanupRegistrations();
  assert.equal(one(f, 'SELECT COUNT(*) n FROM registration_limits').n, 0);
});

test('HTTP boundary strictly enforces cookies, origin, account binding, fields, methods and retired APIs', async t => {
  const f = fixture(t), a = await f.admin();
  const env = { AUTH: { getByName: () => ({ async fetch(input, init) {
    const request = new Request(input, init);
    try { const { status, value } = await f.store.dispatch(new URL(request.url).pathname, await request.json()); return Response.json(value, { status }); }
    catch (e) { return Response.json({ error: e.message, code: e.code, ...e.extra }, { status: e.status || 503 }); }
  } }) } };
  async function call(path, body, extra = {}, method = body === undefined ? 'GET' : 'POST') {
    const headers = { ...(body === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json' }), ...extra };
    const response = await worker.fetch(new Request(origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    return { status: response.status, value: await response.json(), headers: response.headers };
  }
  const headers = { Cookie: 'study_session=' + a.token, 'X-Account-ID': a.user.id };
  assert.deepEqual((await call('/api/auth/registration-config')).value, { enabled: true, mode: 'admin' });
  assert.equal((await call('/api/auth/register', { ...application, role: 'admin' })).status, 400);
  assert.equal((await call('/api/auth/register', application, { Origin: 'https://evil.invalid' })).status, 403);
  const submitted = await call('/api/auth/register', application); assert.equal(submitted.status, 202); assert.equal(submitted.headers.get('Set-Cookie'), null);
  const id = one(f, 'SELECT id FROM registration_requests').id, path = '/api/admin/registrations/' + id + '/approve';
  assert.equal((await call('/api/admin/registrations')).status, 401);
  assert.equal((await call('/api/admin/registrations', undefined, headers)).value.pendingCount, 1);
  assert.equal((await call(path, {}, { Cookie: headers.Cookie })).status, 409);
  assert.equal((await call(path, { role: 'admin' }, headers)).status, 400);
  assert.equal((await call(path + '?token=x', {}, headers)).status, 400);
  assert.equal((await call(path, {}, { ...headers, Origin: 'https://evil.invalid' })).status, 403);
  assert.equal((await call(path, undefined, headers)).status, 405);
  assert.equal((await call(path, {}, headers)).status, 200);
  assert.equal((await call(path, {}, headers)).status, 409);
  for (const old of ['/registration-review','/registration-review/','/web/registration-review.html','/web/registration-review.js','/api/auth/registration-review','/api/auth/registration-approve']) assert.equal((await call(old)).status, 410);
  f.store.logout({ token: a.token }); assert.equal((await call('/api/admin/registrations', undefined, headers)).status, 401);
});
