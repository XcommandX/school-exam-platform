import { createHash, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import { AUTH_SCHEMA, AUTH_SCHEMA_VERSION } from './auth-schema.mjs';
import { InputError, readJSON } from './json-stream.mjs';

// Requires nodejs_compat. Never replace 600000 with WebCrypto's lower limit.
export const PASSWORD_ITERATIONS = 600_000;
export const SESSION_SECONDS = 12 * 60 * 60;
export const SESSION_IDLE_SECONDS = 2 * 60 * 60;
export const LOGIN_WINDOW_SECONDS = 15 * 60;
export const MAX_AUTH_BODY_BYTES = 16 * 1024;
const MAX_FAILURE_BUCKETS = 10_000;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const codePointLength = value => Array.from(value).length;
const wellFormed = value => !Array.from(value).some(c => {
  const cp = c.codePointAt(0);
  return cp >= 0xd800 && cp <= 0xdfff;
});
// Python str.strip() whitespace, including NEL but not BOM, for contract parity.
const strip = value => value.replace(/^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu, '');
const digest = value => createHash('sha256').update(value, 'utf8').digest();
const hex = size => randomBytes(size).toString('hex');
const invalidCredentials = () => new AuthError(401, '用户名或密码不正确，或账号已停用。', 'invalid_credentials');
const expiredSession = () => new AuthError(401, '登录已失效，请重新登录。', 'session_expired');
const cryptoUnavailable = () => new AuthError(503, '密码验证服务暂不可用；需要支持 PBKDF2-SHA256 600000 次迭代的运行时。', 'crypto_unavailable');

export class AuthError extends Error {
  constructor(status, message, code = 'invalid_request', extra = {}) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export function validateUsername(value) {
  if (typeof value !== 'string' || value.length < 3 || value.length > 40 ||
      !/^[A-Za-z0-9]/.test(value) || /[^A-Za-z0-9_.-]/.test(value)) {
    throw new AuthError(400, '用户名需为 3–40 位字母、数字、下划线、短横线或点，并以字母或数字开头。', 'invalid_username');
  }
  return value;
}

export function validateDisplayName(value) {
  if (typeof value !== 'string' || !wellFormed(value) || /[\u0000-\u001f\u007f]/.test(value) ||
      codePointLength(strip(value)) < 1 || codePointLength(strip(value)) > 60) {
    throw new AuthError(400, '显示名称需为 1–60 个字符。', 'invalid_display_name');
  }
  return strip(value);
}

export function validatePassword(value) {
  if (typeof value !== 'string' || codePointLength(value) < 6 || codePointLength(value) > 256) {
    throw new AuthError(400, '密码需为 6–256 个字符。', 'invalid_password');
  }
  if (!wellFormed(value)) throw new AuthError(400, '密码包含无效字符。', 'invalid_password');
  return value;
}

function parsePassword(encoded) {
  if (typeof encoded !== 'string') return null;
  const parts = encoded.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256' || !/^[0-9]{6,7}$/.test(parts[1]) ||
      parts[2].length !== 48 || /[^a-f0-9]/.test(parts[2]) ||
      parts[3].length !== 64 || /[^a-f0-9]/.test(parts[3])) return null;
  const iterations = Number(parts[1]);
  // This is a fresh cloud environment, not a legacy 100k hash import path.
  if (iterations < PASSWORD_ITERATIONS || iterations > 2_000_000) return null;
  return { iterations, salt: parts[2], expected: parts[3] };
}

export function hashPassword(password) {
  validatePassword(password);
  try {
    const salt = randomBytes(24);
    const hash = pbkdf2Sync(password, salt, PASSWORD_ITERATIONS, 32, 'sha256');
    return `pbkdf2_sha256$${PASSWORD_ITERATIONS}$${salt.toString('hex')}$${hash.toString('hex')}`;
  } catch {
    throw cryptoUnavailable();
  }
}

export function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || codePointLength(password) > 256 || !wellFormed(password)) return false;
  const parsed = parsePassword(encoded);
  if (!parsed) return false;
  try {
    const salt = Uint8Array.from(parsed.salt.match(/../g), pair => parseInt(pair, 16));
    const expected = Uint8Array.from(parsed.expected.match(/../g), pair => parseInt(pair, 16));
    const actual = pbkdf2Sync(password, salt, parsed.iterations, 32, 'sha256');
    return timingSafeEqual(actual, expected);
  } catch {
    // An unsupported native implementation is an operational error, not a bad
    // password, and MUST NOT cause a silently weakened hash or fallback.
    throw cryptoUnavailable();
  }
}

const nativePasswordCodec = Object.freeze({ hash: hashPassword, verify: verifyPassword });

function publicUser(row) {
  return {
    id: row.id, username: row.username, name: row.display_name, displayName: row.display_name,
    role: row.role, active: Boolean(row.active), createdAt: row.created_at * 1000,
    updatedAt: row.updated_at * 1000, lastLoginAt: row.last_login_at ? row.last_login_at * 1000 : null,
  };
}

function sessionValue(session) {
  return {
    authenticated: Boolean(session), loginEnabled: true,
    user: session ? publicUser(session.user) : null,
    expiresAt: session ? session.expiresAt : null,
  };
}

function validateRole(role) {
  if (role !== 'student' && role !== 'admin') throw new AuthError(400, '账号角色无效。');
  return role;
}

function validateIdentity(identity) {
  if (typeof identity !== 'string' || identity.length !== 32 || /[^a-f0-9]/.test(identity)) {
    throw new AuthError(400, '账号编号无效。');
  }
  return identity;
}

function fields(value, required, optional = []) {
  if (!isObject(value) || required.some(key => !own(value, key)) ||
      Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) {
    throw new AuthError(400, '请求字段无效。');
  }
}

/** SQLite DO adapter: storage.sql.exec(query, ...bindings) -> iterable rows,
 * storage.transactionSync(callback) -> callback's result, rolling back throws.
 * clock returns integer epoch SECONDS; all public timestamps are milliseconds.
 * passwordCodec is a test seam for deterministic in-flight interleavings. The
 * real Durable Object always uses nativePasswordCodec, never an env override.
 * Public methods all take the same object as their internal POST RPC body.
 */
export class AuthStore {
  constructor(storage, { clock = () => Math.floor(Date.now() / 1000), setupToken, passwordCodec = nativePasswordCodec } = {}) {
    if (!storage?.sql?.exec || typeof storage.transactionSync !== 'function') {
      throw new TypeError('AuthStore requires SQLite sql.exec and transactionSync');
    }
    this.storage = storage;
    this.sql = storage.sql;
    this.clock = clock;
    this.setupToken = setupToken;
    this.passwordCodec = passwordCodec;
    this._tx(() => {
      for (const statement of AUTH_SCHEMA) this.sql.exec(statement);
      this.sql.exec('INSERT OR IGNORE INTO auth_meta(key,value) VALUES (?,?)', 'schema_version', AUTH_SCHEMA_VERSION);
      if (this._one('SELECT value FROM auth_meta WHERE key=?', 'schema_version').value !== AUTH_SCHEMA_VERSION) {
        throw new AuthError(503, '账号数据库版本不受支持。', 'storage_unavailable');
      }
      this.sql.exec('INSERT OR IGNORE INTO auth_meta(key,value) VALUES (?,?)', 'token_salt', hex(32));
      // An unknown account still performs an equally expensive password check.
      // Random digest, not a shared default account or a known weak password.
      this.sql.exec('INSERT OR IGNORE INTO auth_meta(key,value) VALUES (?,?)', 'dummy_password',
        `pbkdf2_sha256$${PASSWORD_ITERATIONS}$${hex(24)}$${hex(32)}`);
      this.tokenSalt = this._one('SELECT value FROM auth_meta WHERE key=?', 'token_salt').value;
      this.dummyPassword = this._one('SELECT value FROM auth_meta WHERE key=?', 'dummy_password').value;
    });
  }

  _tx(callback) { return this.storage.transactionSync(callback); }
  _all(query, ...bindings) { return Array.from(this.sql.exec(query, ...bindings)); }
  _one(query, ...bindings) { return this._all(query, ...bindings)[0] ?? null; }
  _tokenHash(token) { return digest(`session\0${this.tokenSalt}\0${token}`).toString('hex'); }
  _bucket(kind, value) { return `${kind}:${digest(`${kind}\0${this.tokenSalt}\0${value}`).toString('hex')}`; }
  _audit(action, actor = null, target = null, detail = {}) {
    // Only controlled action/field/role/boolean data. No submitted username,
    // address, password, setup secret, token, or arbitrary exception text.
    this.sql.exec('INSERT INTO audit_events(occurred_at,actor_id,action,target_id,detail) VALUES (?,?,?,?,?)',
      this.clock(), actor, action, target, JSON.stringify(detail));
  }

  _authenticate(token) {
    if (typeof token !== 'string' || token.length !== 43 || /[^A-Za-z0-9_-]/.test(token)) return null;
    const tokenHash = this._tokenHash(token);
    const row = this._one('SELECT * FROM sessions WHERE token_hash=?', tokenHash);
    if (!row) return null;
    const now = this.clock();
    if (row.expires_at <= now || row.last_seen_at + SESSION_IDLE_SECONDS <= now) {
      this.sql.exec('DELETE FROM sessions WHERE token_hash=?', tokenHash);
      return null;
    }
    const user = this._one('SELECT * FROM users WHERE id=? AND active=1', row.user_id);
    if (!user) {
      this.sql.exec('DELETE FROM sessions WHERE token_hash=?', tokenHash);
      return null;
    }
    if (now - row.last_seen_at >= 60) {
      this.sql.exec('UPDATE sessions SET last_seen_at=? WHERE token_hash=?', now, tokenHash);
    }
    return { user, sessionId: row.id, expiresAt: row.expires_at * 1000, tokenHash };
  }

  _require(token, admin = false) {
    const session = this._authenticate(token);
    if (!session) throw expiredSession();
    if (admin && session.user.role !== 'admin') throw new AuthError(403, '此操作需要管理员权限。', 'admin_required');
    return session;
  }

  _newSession(identity) {
    const now = this.clock();
    const token = randomBytes(32).toString('base64url');
    this.sql.exec('DELETE FROM sessions WHERE user_id=? OR expires_at<=?', identity, now);
    this.sql.exec('INSERT INTO sessions(token_hash,id,user_id,created_at,expires_at,last_seen_at) VALUES (?,?,?,?,?,?)',
      this._tokenHash(token), hex(16), identity, now, now + SESSION_SECONDS, now);
    this.sql.exec('UPDATE users SET last_login_at=? WHERE id=?', now, identity);
    const user = this._one('SELECT * FROM users WHERE id=?', identity);
    return { ...sessionValue({ user, expiresAt: (now + SESSION_SECONDS) * 1000 }), token };
  }

  async _hash(password) {
    try {
      const encoded = await this.passwordCodec.hash(password);
      if (!parsePassword(encoded) || Number(encoded.split('$')[1]) !== PASSWORD_ITERATIONS) throw cryptoUnavailable();
      return encoded;
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw cryptoUnavailable();
    }
  }

  async _verify(password, encoded) {
    try { return (await this.passwordCodec.verify(password, encoded)) === true; }
    catch { throw cryptoUnavailable(); }
  }

  _checkSetup(supplied) {
    // The secret is configured by the maintainer, never synthesized on startup.
    // Require >=32 URL-safe characters; use 32 random bytes/base64url in practice.
    if (typeof this.setupToken !== 'string' || this.setupToken.length < 32 || this.setupToken.length > 256 ||
        /[^A-Za-z0-9_-]/.test(this.setupToken) || new Set(this.setupToken).size < 8) {
      throw new AuthError(503, '首次设置未启用，请由维护者配置安全的一次性令牌。', 'setup_unavailable');
    }
    if (typeof supplied !== 'string' || supplied.length > 256 ||
        !timingSafeEqual(digest(supplied), digest(this.setupToken))) {
      throw new AuthError(403, '首次设置令牌无效。', 'invalid_setup_token');
    }
    if (this._one('SELECT 1 FROM auth_meta WHERE key=?', 'setup_complete') || this._one('SELECT 1 FROM users LIMIT 1')) {
      throw new AuthError(409, '首次设置已完成，不能再次创建或重置管理员。', 'setup_completed');
    }
  }

  _insertUser(username, displayName, passwordHash, role) {
    if (this._one('SELECT 1 FROM users WHERE username_key=?', username.toLowerCase())) {
      throw new AuthError(409, '该用户名已存在。', 'username_exists');
    }
    const identity = hex(16), now = this.clock();
    this.sql.exec('INSERT INTO users(id,username,username_key,display_name,password_hash,role,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
      identity, username, username.toLowerCase(), displayName, passwordHash, role, now, now);
    return this._one('SELECT * FROM users WHERE id=?', identity);
  }

  async bootstrap({ setupToken, username, password, displayName }) {
    this._tx(() => this._checkSetup(setupToken));
    username = validateUsername(username);
    displayName = validateDisplayName(displayName ?? username);
    validatePassword(password);
    const passwordHash = await this._hash(password);
    return this._tx(() => {
      this._checkSetup(setupToken); // Critical: user count + one-shot marker in the SAME transaction as creation.
      const user = this._insertUser(username, displayName, passwordHash, 'admin');
      this.sql.exec('INSERT INTO auth_meta(key,value) VALUES (?,?)', 'setup_complete', String(this.clock()));
      this._audit('user.create', null, user.id, { role: 'admin' });
      this._audit('setup.complete', user.id, user.id);
      const result = this._newSession(user.id);
      this._audit('login.success', user.id, user.id);
      return result;
    });
  }

  async login({ username, password, address }) {
    if (typeof username !== 'string' || typeof password !== 'string' || codePointLength(username) > 128 ||
        codePointLength(password) > 256 || !wellFormed(username) || !wellFormed(password) ||
        typeof address !== 'string' || address.length < 1 || address.length > 256 || !wellFormed(address)) {
      throw new AuthError(400, '请输入有效的用户名和密码。');
    }
    username = strip(username);
    const buckets = [[this._bucket('user', username.toLowerCase()), 5], [this._bucket('address', address), 30]];
    const reservation = this._tx(() => {
      const now = this.clock();
      this.sql.exec('DELETE FROM login_failures WHERE expires_at<=?', now);
      const existing = buckets.map(([bucket]) => this._one('SELECT * FROM login_failures WHERE bucket=?', bucket));
      for (let index = 0; index < buckets.length; index++) {
        if (existing[index] && existing[index].failures >= buckets[index][1]) {
          throw new AuthError(429, '登录尝试过于频繁，请稍后再试。', 'rate_limited', { retryAfter: existing[index].expires_at - now });
        }
      }
      const count = this._one('SELECT COUNT(*) AS count FROM login_failures').count;
      // Never evict an unexpired failure/in-flight reservation to make room:
      // doing so would allow a username spray to erase another user's cap.
      if (count + existing.filter(value => !value).length > MAX_FAILURE_BUCKETS) {
        const next = this._one('SELECT MIN(expires_at) AS expiry FROM login_failures').expiry;
        throw new AuthError(429, '登录尝试过于频繁，请稍后再试。', 'rate_limited', { retryAfter: Math.max(1, next - now) });
      }
      const entries = buckets.map(([bucket], index) => {
        const expiresAt = existing[index]?.expires_at ?? now + LOGIN_WINDOW_SECONDS;
        this.sql.exec('INSERT INTO login_failures(bucket,failures,expires_at) VALUES (?,1,?) ON CONFLICT(bucket) DO UPDATE SET failures=failures+1',
          bucket, expiresAt);
        return { bucket, expiresAt };
      });
      return { entries, user: this._one('SELECT * FROM users WHERE username_key=?', username.toLowerCase()) };
    });
    const { user } = reservation;
    const valid = await this._verify(password, user?.password_hash ?? this.dummyPassword);
    const result = this._tx(() => {
      const current = user ? this._one('SELECT * FROM users WHERE id=?', user.id) : null;
      if (!valid || !current?.active || current.password_hash !== user.password_hash || current.security_version !== user.security_version) {
        this._audit('login.failed', null, user?.id ?? null);
        return null; // Commit failures before raising the public 401.
      }
      for (const entry of reservation.entries) {
        // Do not decrement a replacement time-window bucket after a slow check.
        this.sql.exec('UPDATE login_failures SET failures=MAX(0,failures-1) WHERE bucket=? AND expires_at=?', entry.bucket, entry.expiresAt);
      }
      this.sql.exec('DELETE FROM login_failures WHERE failures=0');
      const session = this._newSession(current.id);
      this._audit('login.success', current.id, current.id);
      return session;
    });
    if (!result) throw invalidCredentials();
    return result;
  }

  session({ token }) { return this._tx(() => sessionValue(this._authenticate(token))); }

  logout({ token }) {
    return this._tx(() => {
      const session = this._require(token);
      this.sql.exec('DELETE FROM sessions WHERE token_hash=? AND user_id=?', session.tokenHash, session.user.id);
      this._audit('logout', session.user.id, session.user.id);
      return { ok: true };
    });
  }

  async createUser({ token, username, password, role = 'student', displayName }) {
    this._tx(() => this._require(token, true));
    username = validateUsername(username);
    displayName = validateDisplayName(displayName ?? username);
    validateRole(role);
    validatePassword(password);
    const passwordHash = await this._hash(password);
    return this._tx(() => {
      const actor = this._require(token, true); // Role/session may have changed while hashing.
      const user = this._insertUser(username, displayName, passwordHash, role);
      this._audit('user.create', actor.user.id, user.id, { role });
      return { user: publicUser(user) };
    });
  }

  users({ token }) {
    return this._tx(() => {
      this._require(token, true);
      return { users: this._all('SELECT * FROM users ORDER BY created_at,username_key').map(publicUser) };
    });
  }

  updateUser({ token, targetId, changes, ownProfile = false }) {
    if (typeof ownProfile !== 'boolean') throw new AuthError(400, '账号更新字段无效。');
    const allowed = ownProfile ? ['displayName'] : ['displayName', 'role', 'active'];
    if (!isObject(changes) || !Object.keys(changes).length || Object.keys(changes).some(key => !allowed.includes(key))) {
      throw new AuthError(400, '账号更新字段无效。');
    }
    validateIdentity(targetId);
    changes = { ...changes };
    if (own(changes, 'displayName')) changes.displayName = validateDisplayName(changes.displayName);
    if (own(changes, 'role')) validateRole(changes.role);
    if (own(changes, 'active') && typeof changes.active !== 'boolean') throw new AuthError(400, '账号启用状态无效。');
    return this._tx(() => {
      const actor = this._require(token, !ownProfile);
      if (ownProfile && actor.user.id !== targetId) throw new AuthError(403, '只能修改自己的资料。');
      const row = this._one('SELECT * FROM users WHERE id=?', targetId);
      if (!row) throw new AuthError(404, '账号不存在。', 'not_found');
      const role = changes.role ?? row.role, active = changes.active ?? Boolean(row.active);
      if (row.role === 'admin' && row.active && (role !== 'admin' || !active) &&
          this._one("SELECT COUNT(*) AS count FROM users WHERE active=1 AND role='admin'").count <= 1) {
        throw new AuthError(409, '请至少保留一位启用的管理员。', 'last_admin');
      }
      const securityChanged = role !== row.role || active !== Boolean(row.active);
      this.sql.exec('UPDATE users SET display_name=?,role=?,active=?,updated_at=?,security_version=security_version+? WHERE id=?',
        changes.displayName ?? row.display_name, role, Number(active), this.clock(), Number(securityChanged), targetId);
      if (role !== row.role || !active) this.sql.exec('DELETE FROM sessions WHERE user_id=?', targetId);
      this._audit('user.update', actor.user.id, targetId, { fields: Object.keys(changes).sort(), role, active });
      const user = publicUser(this._one('SELECT * FROM users WHERE id=?', targetId));
      return ownProfile ? user : { user };
    });
  }

  async password({ token, targetId, currentPassword, newPassword }) {
    const adminReset = targetId !== undefined;
    if (adminReset) validateIdentity(targetId);
    const before = this._tx(() => {
      const actor = this._require(token, adminReset);
      const identity = adminReset ? targetId : actor.user.id;
      const user = this._one('SELECT * FROM users WHERE id=?', identity);
      if (!user) throw new AuthError(404, '账号不存在。', 'not_found');
      return { identity, user };
    });
    validatePassword(newPassword);
    if (!adminReset && !await this._verify(currentPassword, before.user.password_hash)) {
      throw new AuthError(400, '当前密码不正确。', 'incorrect_password');
    }
    const passwordHash = await this._hash(newPassword);
    return this._tx(() => {
      const actor = this._require(token, adminReset);
      const current = this._one('SELECT * FROM users WHERE id=?', before.identity);
      if (!current || current.security_version !== before.user.security_version || current.password_hash !== before.user.password_hash) {
        throw new AuthError(409, '账号已变更，请刷新后重试。', 'user_changed');
      }
      this.sql.exec('UPDATE users SET password_hash=?,updated_at=?,security_version=security_version+1 WHERE id=?',
        passwordHash, this.clock(), before.identity);
      this.sql.exec('DELETE FROM sessions WHERE user_id=?', before.identity);
      this._audit(adminReset ? 'password.reset' : 'password.change', actor.user.id, before.identity);
      return adminReset ? { ok: true } : { ok: true, reauthenticate: true };
    });
  }

  async dispatch(path, body) {
    switch (path) {
      case '/bootstrap':
        fields(body, ['setupToken', 'username', 'password'], ['displayName']);
        return { status: 201, value: await this.bootstrap(body) };
      case '/login':
        fields(body, ['username', 'password', 'address']);
        return { status: 200, value: await this.login(body) };
      case '/session':
        fields(body, ['token']);
        return { status: 200, value: this.session(body) };
      case '/logout':
        fields(body, ['token']);
        return { status: 200, value: this.logout(body) };
      case '/create-user':
        fields(body, ['token', 'username', 'password'], ['role', 'displayName']);
        return { status: 201, value: await this.createUser(body) };
      case '/users':
        fields(body, ['token']);
        return { status: 200, value: this.users(body) };
      case '/update-user':
        fields(body, ['token', 'targetId', 'changes'], ['ownProfile']);
        return { status: 200, value: this.updateUser(body) };
      case '/password':
        fields(body, ['token', 'newPassword'], ['targetId', 'currentPassword']);
        if (!own(body, 'targetId') && !own(body, 'currentPassword')) throw new AuthError(400, '请提供当前密码与新密码。');
        return { status: 200, value: await this.password(body) };
      default:
        throw new AuthError(404, '接口不存在。', 'not_found');
    }
  }
}

async function readBody(request) {
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new AuthError(415, '请求必须使用 JSON。', 'json_required');
  }
  const declaredLength = request.headers.get('Content-Length');
  if (declaredLength !== null && (!/^[0-9]+$/.test(declaredLength) || Number(declaredLength) > MAX_AUTH_BODY_BYTES)) {
    throw new AuthError(413, '请求为空或内容过大。');
  }
  return readJSON(request, MAX_AUTH_BODY_BYTES);
}

function reply(status, value) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
  };
  if (status === 429) headers['Retry-After'] = String(value.retryAfter ?? LOGIN_WINDOW_SECONDS);
  return new Response(JSON.stringify(value), { status, headers });
}

/** INTERNAL fetch RPC only. The Worker owns public routes, Origin/account-ID
 * binding, and Secure HttpOnly SameSite=Strict cookies. It must strip `token`
 * from /login and /bootstrap responses before returning browser JSON. Bind ONE
 * named auth DO for the whole platform so bootstrap/session/rate limits agree.
 * No public route may pass arbitrary internal paths/bodies through this DO.
 */
export class PlatformAuthStore {
  constructor(ctx, env) {
    this.store = new AuthStore(ctx.storage, { setupToken: env?.SETUP_TOKEN });
  }

  async fetch(request) {
    try {
      if (request.method !== 'POST') throw new AuthError(405, '此接口不支持该操作。', 'method_not_allowed');
      const url = new URL(request.url);
      if (url.search) throw new AuthError(400, '请求字段无效。');
      const body = await readBody(request);
      const { status, value } = await this.store.dispatch(url.pathname, body);
      return reply(status, value);
    } catch (error) {
      if (error instanceof AuthError || error instanceof InputError) return reply(error.status, { error: error.message, code: error.code, ...error.extra });
      // Do not serialize/log backend errors: they can contain SQL bindings.
      return reply(503, { error: '账号服务暂不可用，请稍后重试。', code: 'storage_unavailable' });
    }
  }
}
