#!/usr/bin/env python3
"""Shared accounts for the loopback development service (Python 3.10+).

Secrets and account data live in local-data/auth, never in source control.
This module does not turn the local HTTP server into a production HTTPS host.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import getpass
import hashlib
import hmac
from http.cookies import CookieError, SimpleCookie
import json
import math
import os
from pathlib import Path
import re
import secrets
import sqlite3
import threading
import time
from urllib.parse import parse_qs, unquote, urlsplit

if __package__:
    from .sat_account_state import SATAccountStore, SATStateError, MAX_ENTITY_BYTES, MAX_SETTINGS_BYTES
else:
    # The CLI and file-based unit-test loader also work without a package install.
    import importlib.util
    _sat_spec = importlib.util.spec_from_file_location('sat_account_state', Path(__file__).with_name('sat_account_state.py'))
    _sat_module = importlib.util.module_from_spec(_sat_spec)
    _sat_spec.loader.exec_module(_sat_module)
    SATAccountStore, SATStateError = _sat_module.SATAccountStore, _sat_module.SATStateError
    MAX_ENTITY_BYTES, MAX_SETTINGS_BYTES = _sat_module.MAX_ENTITY_BYTES, _sat_module.MAX_SETTINGS_BYTES

COOKIE_NAME = 'study_session'
PASSWORD_ITERATIONS = 600_000
SESSION_SECONDS = 12 * 60 * 60
SESSION_IDLE_SECONDS = 2 * 60 * 60
LOGIN_WINDOW_SECONDS = 15 * 60
MAX_JSON_BYTES = 8 * 1024 * 1024
MAX_HOME_BYTES = 16 * 1024
TOEFL_KEYS = frozenset({'four.history.v1', 'four.drafts.v2', 'four.words.v1',
                        'four.learning.v1', 't1lab.history.v1'})
USERNAME_PATTERN = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{2,39}\Z')


class AuthError(Exception):
    def __init__(self, status, message, code='invalid_request', **extra):
        super().__init__(message)
        self.status, self.code, self.extra = status, code, extra


def _now():
    return int(time.time())


def _password(password):
    if not isinstance(password, str) or not 6 <= len(password) <= 256:
        raise AuthError(400, '密码需为 6–256 个字符。', 'invalid_password')
    try:
        password.encode('utf-8')
    except UnicodeEncodeError:
        raise AuthError(400, '密码包含无效字符。', 'invalid_password') from None
    return password


def hash_password(password):
    password = _password(password)
    salt = secrets.token_bytes(24)
    digest = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt, PASSWORD_ITERATIONS)
    return f'pbkdf2_sha256${PASSWORD_ITERATIONS}${salt.hex()}${digest.hex()}'


def verify_password(password, encoded):
    try:
        if not isinstance(password, str) or len(password) > 256:
            return False
        algorithm, iterations, salt, expected = encoded.split('$')
        if algorithm != 'pbkdf2_sha256' or not 100_000 <= int(iterations) <= 2_000_000:
            return False
        actual = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), bytes.fromhex(salt), int(iterations))
        return hmac.compare_digest(actual, bytes.fromhex(expected))
    except (ValueError, TypeError, OverflowError, UnicodeEncodeError):
        return False


def _username(value):
    if not isinstance(value, str) or not USERNAME_PATTERN.fullmatch(value):
        raise AuthError(400, '用户名需为 3–40 位字母、数字、下划线、短横线或点，并以字母或数字开头。', 'invalid_username')
    return value


def _display_name(value):
    if (not isinstance(value, str) or not 1 <= len(value.strip()) <= 60
            or any(ord(c) < 32 or ord(c) == 127 or 0xD800 <= ord(c) <= 0xDFFF for c in value)):
        raise AuthError(400, '显示名称需为 1–60 个字符。', 'invalid_display_name')
    return value.strip()


def _public_user(row):
    return {'id': row['id'], 'username': row['username'], 'name': row['display_name'],
            'displayName': row['display_name'], 'role': row['role'], 'active': bool(row['active']),
            'createdAt': row['created_at'] * 1000, 'updatedAt': row['updated_at'] * 1000,
            'lastLoginAt': row['last_login_at'] * 1000 if row['last_login_at'] else None}


def _json(value):
    try:
        encoded = json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
        encoded.encode('utf-8')
        return encoded
    except (ValueError, TypeError, RecursionError, UnicodeEncodeError):
        raise AuthError(400, '数据不是有效的 JSON。') from None


def _home_value(value):
    if not isinstance(value, dict) or set(value) - {'plan', 'targets', 'preferences'}:
        raise AuthError(400, '首页设置字段不受支持。')
    if len(_json(value).encode('utf-8')) > MAX_HOME_BYTES:
        raise AuthError(413, '首页设置内容过大。')
    result = dict(value)
    if 'plan' in value:
        plan = value['plan']
        if (not isinstance(plan, dict) or set(plan) - {'dailyGoal', 'note'}
                or type(plan.get('dailyGoal')) is not int or not 1 <= plan['dailyGoal'] <= 500
                or not isinstance(plan.get('note', ''), str) or len(plan.get('note', '')) > 500):
            raise AuthError(400, '学习计划需包含 1–500 的每日目标和最多 500 字备注。')
    if 'preferences' in value:
        prefs = value['preferences']
        if (not isinstance(prefs, dict) or set(prefs) - {'reduceMotion'}
                or 'reduceMotion' in prefs and type(prefs['reduceMotion']) is not bool):
            raise AuthError(400, '显示偏好无效。')
    if 'targets' in value:
        targets = value['targets']
        if not isinstance(targets, dict) or set(targets) - {'toefl', 'sat'}:
            raise AuthError(400, '目标分数无效。')
        result['targets'] = {}
        for exam, keys, low, high, step in (
                ('toefl', ['reading', 'listening', 'speaking', 'writing'], 1, 6, .5),
                ('sat', ['english', 'math'], 200, 800, 10)):
            target = targets.get(exam)
            if target is None:
                result['targets'][exam] = None
                continue
            if (not isinstance(target, dict) or set(target) - set(keys + ['total'])
                    or any(type(target.get(k)) not in (int, float) or not math.isfinite(target[k])
                           or not low <= target[k] <= high or target[k] / step != round(target[k] / step)
                           for k in keys)):
                raise AuthError(400, '目标分数超出范围或分档不正确。')
            clean = {k: target[k] for k in keys}
            total = sum(clean.values())
            clean['total'] = math.floor(total / 4 * 2 + .5) / 2 if exam == 'toefl' else total
            result['targets'][exam] = clean
    return result


def _toefl_value(key, incoming, stored, drafts):
    """Preserve the standalone TOEFL cancellation contract across stale writes."""
    if any(not isinstance(row, dict) or not isinstance(row.get('id'), str)
           or not 1 <= len(row['id']) <= 200 for row in incoming):
        raise AuthError(400, '练习记录编号无效。')
    if key == 'four.drafts.v2':
        cancelled = {}
        for row in stored + incoming:
            if isinstance(row, dict) and row.get('cancelled') is True:
                identity, timestamp = row.get('id'), row.get('cancelledAt')
                if (not isinstance(identity, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,150}', identity)
                        or identity in {'cache', 'transcript', 'example'}
                        or type(timestamp) is not int or not 0 < timestamp <= 2**53 - 1):
                    raise AuthError(400, '取消练习编号或时间无效。')
                cancelled.setdefault(identity, {'id': identity, 'cancelled': True, 'cancelledAt': timestamp})
        return [row for row in incoming if isinstance(row, dict) and row.get('id') not in cancelled] + list(cancelled.values())
    if key == 'four.history.v1':
        cancelled = {row.get('id') for row in drafts if isinstance(row, dict) and row.get('cancelled') is True}
        metadata = {'ai', 'aiErrors', 'rubric', 'selfEvaluation'}
        edits = {row.get('id'): row for row in incoming if isinstance(row, dict) and isinstance(row.get('id'), str)}
        retained = []
        for row in stored:
            if not isinstance(row, dict) or not isinstance(row.get('id'), str) or row['id'] not in cancelled:
                continue
            edit = edits.get(row['id'])
            core = {k: v for k, v in row.items() if k not in metadata}
            if edit and core == {k: v for k, v in edit.items() if k not in metadata}:
                retained.append(dict(core, **{k: v for k, v in edit.items() if k in metadata}))
            else:
                retained.append(row)
        return [row for row in incoming if isinstance(row, dict) and isinstance(row.get('id'), str) and row['id'] not in cancelled] + retained
    return incoming


class AuthStore:
    """One connection per operation; transactions serialize security invariants."""

    def __init__(self, db_path, *, clock=None):
        self.path = Path(db_path)
        self.clock = clock or _now
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # Restrict new account storage on POSIX. Windows relies on the user's ACL.
        if os.name == 'posix':
            self.path.parent.chmod(0o700)
        with self._connection() as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)')
            for migration in sorted(Path(__file__).with_name('migrations').glob('*.sql')):
                if not db.execute('SELECT 1 FROM schema_migrations WHERE version=?', (migration.name,)).fetchone():
                    script = migration.read_text(encoding='utf-8')
                    db.executescript('BEGIN IMMEDIATE;\n' + script)
                    db.execute('INSERT OR IGNORE INTO schema_migrations VALUES (?, ?)', (migration.name, self.clock()))
                    db.commit()
        if os.name == 'posix':
            self.path.chmod(0o600)
        self._dummy_password = hash_password(secrets.token_urlsafe(24))

    @contextmanager
    def _connection(self, write=False):
        db = sqlite3.connect(str(self.path), timeout=10, isolation_level=None)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA foreign_keys=ON')
        db.execute('PRAGMA busy_timeout=10000')
        try:
            if write:
                db.execute('BEGIN IMMEDIATE')
            yield db
            if db.in_transaction:
                db.commit()
        except Exception:
            if db.in_transaction:
                db.rollback()
            raise
        finally:
            db.close()

    def _audit(self, db, action, actor=None, target=None, detail=None):
        # Callers supply only field names, roles, and boolean status; never passwords/tokens/state.
        db.execute('INSERT INTO audit_events(occurred_at,actor_id,action,target_id,detail) VALUES (?,?,?,?,?)',
                   (self.clock(), actor, action, target, _json(detail or {})))

    def _actor(self, db, actor_id, admin=False):
        user = db.execute('SELECT * FROM users WHERE id=? AND active=1', (actor_id,)).fetchone()
        if not user:
            raise AuthError(401, '登录已失效，请重新登录。', 'session_expired')
        if admin and user['role'] != 'admin':
            raise AuthError(403, '此操作需要管理员权限。', 'admin_required')
        return user

    def create_user(self, username, password, role='student', display_name=None, actor_id=None):
        username = _username(username)
        display_name = _display_name(display_name if display_name is not None else username)
        if not isinstance(role, str) or role not in {'admin', 'student'}:
            raise AuthError(400, '账号角色无效。')
        password_hash = hash_password(password)
        with self._connection(True) as db:
            if actor_id is not None:
                self._actor(db, actor_id, admin=True)
            identity, now = secrets.token_hex(16), self.clock()
            try:
                db.execute('INSERT INTO users(id,username,username_key,display_name,password_hash,role,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
                           (identity, username, username.casefold(), display_name, password_hash, role, now, now))
            except sqlite3.IntegrityError:
                raise AuthError(409, '该用户名已存在。', 'username_exists') from None
            self._audit(db, 'user.create', actor_id, identity, {'role': role})
            return _public_user(db.execute('SELECT * FROM users WHERE id=?', (identity,)).fetchone())

    def list_users(self, actor_id):
        with self._connection() as db:
            self._actor(db, actor_id, admin=True)
            return [_public_user(row) for row in db.execute('SELECT * FROM users ORDER BY created_at,username_key')]

    def _failure_buckets(self, username, address):
        # Hash untrusted identifiers so rate-limit tables do not retain submitted usernames/IPs.
        return [('user:' + hashlib.sha256(username.casefold().encode('utf-8', 'replace')).hexdigest(), 5),
                ('address:' + hashlib.sha256(address.encode('utf-8')).hexdigest(), 30)]

    def login(self, username, password, address='local'):
        if not isinstance(username, str) or not isinstance(password, str) or len(username) > 128 or len(password) > 256:
            raise AuthError(400, '请输入有效的用户名和密码。')
        username = username.strip()
        now = self.clock()
        buckets = self._failure_buckets(username, address)
        with self._connection(True) as db:
            db.execute('DELETE FROM login_failures WHERE expires_at<=?', (now,))
            for bucket, maximum in buckets:
                entry = db.execute('SELECT * FROM login_failures WHERE bucket=?', (bucket,)).fetchone()
                if entry and entry['failures'] >= maximum:
                    raise AuthError(429, '登录尝试过于频繁，请稍后再试。', 'rate_limited', retryAfter=entry['expires_at'] - now)
            # Reserve capacity before releasing the transaction for expensive
            # hashing. In-flight attempts count toward the same persistent cap.
            for bucket, _maximum in buckets:
                db.execute('INSERT INTO login_failures(bucket,failures,expires_at) VALUES (?,1,?) ON CONFLICT(bucket) DO UPDATE SET failures=failures+1',
                           (bucket, now + LOGIN_WINDOW_SECONDS))
            db.execute('DELETE FROM login_failures WHERE bucket IN (SELECT bucket FROM login_failures ORDER BY expires_at DESC LIMIT -1 OFFSET 10000)')
            user = db.execute('SELECT * FROM users WHERE username_key=?', (username.casefold(),)).fetchone()
        valid = verify_password(password, user['password_hash'] if user else self._dummy_password)
        with self._connection(True) as db:
            # A reset/disable during password hashing must invalidate this attempted login.
            current = db.execute('SELECT * FROM users WHERE id=?', (user['id'],)).fetchone() if user else None
            if not (valid and current and current['active'] and current['password_hash'] == user['password_hash']):
                self._audit(db, 'login.failed', target=user['id'] if user else None)
                # Return after commit so failed attempts persist.
                failure = True
            else:
                failure = False
                # Release only this attempt's reservations. Erasing a bucket
                # would also erase failures or reservations from other threads.
                for bucket, _maximum in buckets:
                    db.execute('UPDATE login_failures SET failures=MAX(0,failures-1) WHERE bucket=?', (bucket,))
                db.execute('DELETE FROM login_failures WHERE failures=0')
                token, session_id = secrets.token_urlsafe(32), secrets.token_hex(16)
                db.execute('DELETE FROM sessions WHERE user_id=? OR expires_at<=?', (user['id'], now))
                db.execute('INSERT INTO sessions VALUES (?,?,?,?,?,?)',
                           (hashlib.sha256(token.encode()).hexdigest(), session_id, user['id'], now, now + SESSION_SECONDS, now))
                db.execute('UPDATE users SET last_login_at=? WHERE id=?', (now, user['id']))
                self._audit(db, 'login.success', user['id'], user['id'])
                current = db.execute('SELECT * FROM users WHERE id=?', (user['id'],)).fetchone()
        if failure:
            raise AuthError(401, '用户名或密码不正确，或账号已停用。', 'invalid_credentials')
        return token, {'user': _public_user(current), 'sessionId': session_id, 'expiresAt': (now + SESSION_SECONDS) * 1000}

    def authenticate_token(self, token):
        if not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9_-]{43}', token):
            return None
        token_hash, now = hashlib.sha256(token.encode()).hexdigest(), self.clock()
        with self._connection(True) as db:
            session = db.execute('SELECT * FROM sessions WHERE token_hash=?', (token_hash,)).fetchone()
            if not session:
                return None
            if session['expires_at'] <= now or session['last_seen_at'] + SESSION_IDLE_SECONDS <= now:
                db.execute('DELETE FROM sessions WHERE token_hash=?', (token_hash,))
                return None
            user = db.execute('SELECT * FROM users WHERE id=? AND active=1', (session['user_id'],)).fetchone()
            if not user:
                db.execute('DELETE FROM sessions WHERE token_hash=?', (token_hash,))
                return None
            if now - session['last_seen_at'] >= 60:
                db.execute('UPDATE sessions SET last_seen_at=? WHERE token_hash=?', (now, token_hash))
            return {'user': _public_user(user), 'sessionId': session['id'], 'expiresAt': session['expires_at'] * 1000}

    def logout(self, session_id, actor_id):
        with self._connection(True) as db:
            db.execute('DELETE FROM sessions WHERE id=? AND user_id=?', (session_id, actor_id))
            self._audit(db, 'logout', actor_id, actor_id)

    def update_user(self, identity, changes, actor_id, *, own_profile=False):
        allowed = {'displayName'} if own_profile else {'displayName', 'role', 'active'}
        if not isinstance(changes, dict) or not changes or set(changes) - allowed:
            raise AuthError(400, '账号更新字段无效。')
        if 'displayName' in changes:
            changes = dict(changes, displayName=_display_name(changes['displayName']))
        if 'role' in changes and (not isinstance(changes['role'], str) or changes['role'] not in {'admin', 'student'}):
            raise AuthError(400, '账号角色无效。')
        if 'active' in changes and type(changes['active']) is not bool:
            raise AuthError(400, '账号启用状态无效。')
        with self._connection(True) as db:
            self._actor(db, actor_id, admin=not own_profile)
            if own_profile and actor_id != identity:
                raise AuthError(403, '只能修改自己的资料。')
            row = db.execute('SELECT * FROM users WHERE id=?', (identity,)).fetchone()
            if not row:
                raise AuthError(404, '账号不存在。', 'not_found')
            role, active = changes.get('role', row['role']), changes.get('active', bool(row['active']))
            if row['role'] == 'admin' and row['active'] and (role != 'admin' or not active):
                count = db.execute("SELECT COUNT(*) FROM users WHERE active=1 AND role='admin'").fetchone()[0]
                if count <= 1:
                    raise AuthError(409, '请至少保留一位启用的管理员。', 'last_admin')
            db.execute('UPDATE users SET display_name=?,role=?,active=?,updated_at=? WHERE id=?',
                       (changes.get('displayName', row['display_name']), role, int(active), self.clock(), identity))
            if role != row['role'] or not active:
                db.execute('DELETE FROM sessions WHERE user_id=?', (identity,))
            self._audit(db, 'user.update', actor_id, identity, {'fields': sorted(changes), 'role': role, 'active': active})
            return _public_user(db.execute('SELECT * FROM users WHERE id=?', (identity,)).fetchone())

    def change_password(self, identity, password, actor_id, *, current_password=None, admin_reset=False):
        password_hash = hash_password(password)
        with self._connection(True) as db:
            self._actor(db, actor_id, admin=admin_reset)
            row = db.execute('SELECT * FROM users WHERE id=?', (identity,)).fetchone()
            if not row:
                raise AuthError(404, '账号不存在。', 'not_found')
            if not admin_reset and (identity != actor_id or not verify_password(current_password, row['password_hash'])):
                raise AuthError(400, '当前密码不正确。', 'incorrect_password')
            db.execute('UPDATE users SET password_hash=?,updated_at=? WHERE id=?', (password_hash, self.clock(), identity))
            db.execute('DELETE FROM sessions WHERE user_id=?', (identity,))
            self._audit(db, 'password.reset' if admin_reset else 'password.change', actor_id, identity)

    def state(self, identity, namespace, key=None):
        with self._connection() as db:
            self._actor(db, identity)
            rows = db.execute('SELECT state_key,value_json,revision FROM account_state WHERE user_id=? AND namespace=? ORDER BY state_key',
                              (identity, namespace)).fetchall()
        values = [{'key': r['state_key'], 'value': json.loads(r['value_json']), 'revision': r['revision']} for r in rows]
        if key is not None:
            match = next((r for r in values if r['key'] == key), None)
            return {'value': match['value'], 'revision': match['revision']} if match else {'value': None, 'revision': 0}
        return {'items': values}

    def save_state(self, identity, namespace, key, value, revision):
        if type(revision) is not int or revision < 0:
            raise AuthError(400, '数据版本无效。')
        if namespace == 'home' and key == 'settings':
            value = _home_value(value)
        elif namespace == 'toefl' and key in TOEFL_KEYS:
            if (key == 'four.words.v1' and not isinstance(value, dict)
                    or key != 'four.words.v1' and not isinstance(value, list)):
                raise AuthError(400, '练习记录类型无效。')
        else:
            raise AuthError(400, '数据类型不受支持。')
        encoded = _json(value)
        if len(encoded.encode('utf-8')) > MAX_JSON_BYTES - 1024:
            raise AuthError(413, '记录内容过大，请先整理历史记录。')
        with self._connection(True) as db:
            self._actor(db, identity)
            row = db.execute('SELECT revision,value_json FROM account_state WHERE user_id=? AND namespace=? AND state_key=?',
                             (identity, namespace, key)).fetchone()
            current = row['revision'] if row else 0
            if revision != current:
                raise AuthError(409, '数据已在另一页面更新，请刷新后重试。', 'revision_conflict', revision=current)
            if namespace == 'toefl' and key in {'four.drafts.v2', 'four.history.v1'}:
                draft_row = db.execute("SELECT value_json FROM account_state WHERE user_id=? AND namespace='toefl' AND state_key='four.drafts.v2'", (identity,)).fetchone()
                drafts = json.loads(draft_row['value_json']) if draft_row else []
                value = _toefl_value(key, value, json.loads(row['value_json']) if row else [], drafts)
                encoded = _json(value)
                if len(encoded.encode('utf-8')) > MAX_JSON_BYTES - 1024:
                    raise AuthError(413, '记录内容过大，请先整理历史记录。')
            next_revision = current + 1
            db.execute('INSERT INTO account_state VALUES (?,?,?,?,?,?) ON CONFLICT(user_id,namespace,state_key) DO UPDATE SET value_json=excluded.value_json,revision=excluded.revision,updated_at=excluded.updated_at',
                       (identity, namespace, key, encoded, next_revision, self.clock()))
            return {'value': value, 'revision': next_revision}


class AuthHTTP:
    def __init__(self, store, *, secure_cookies=False):
        self.store, self.secure_cookies = store, secure_cookies
        self.sat = SATAccountStore(store)
        self._sat_transfers = threading.BoundedSemaphore(2)

    def authenticate(self, cookie_header):
        if not isinstance(cookie_header, str) or not cookie_header:
            return None
        if sum(part.strip().startswith(COOKIE_NAME + '=') for part in cookie_header.split(';')) != 1:
            return None
        cookie = SimpleCookie()
        try:
            cookie.load(cookie_header)
            token = cookie[COOKIE_NAME].value if COOKIE_NAME in cookie else None
        except CookieError:
            return None
        return self.store.authenticate_token(token)

    def _cookie(self, token='', clear=False):
        value = f'{COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={0 if clear else SESSION_SECONDS}'
        if self.secure_cookies:
            value += '; Secure'
        return value

    def _reply(self, handler, status, value, cookie=None):
        data = _json(value).encode('utf-8')
        handler.send_response(status)
        handler.send_header('Content-Type', 'application/json; charset=utf-8')
        handler.send_header('Content-Length', str(len(data)))
        handler.send_header('Cache-Control', 'no-store')
        handler.send_header('X-Content-Type-Options', 'nosniff')
        handler.send_header('Referrer-Policy', 'same-origin')
        if cookie:
            handler.send_header('Set-Cookie', cookie)
        if status == 429:
            handler.send_header('Retry-After', str(value.get('retryAfter', LOGIN_WINDOW_SECONDS)))
        handler.end_headers()
        handler.wfile.write(data)

    def _body(self, handler, maximum=MAX_JSON_BYTES):
        expected = ('https' if self.secure_cookies else 'http') + '://' + handler.headers.get('Host', '')
        host = handler.headers.get('Host', '')
        if (host != f'127.0.0.1:{handler.server.server_port}' or handler.headers.get('Origin') != expected
                or handler.headers.get('Sec-Fetch-Site') not in {None, 'same-origin'}):
            raise AuthError(403, '请从当前网站页面提交操作。', 'invalid_origin')
        if handler.headers.get('Content-Type', '').split(';')[0].strip().lower() != 'application/json':
            raise AuthError(415, '请求必须使用 JSON。', 'json_required')
        if handler.headers.get('Transfer-Encoding'):
            raise AuthError(400, '请求编码不受支持。')
        try:
            length = int(handler.headers.get('Content-Length', '0'))
        except ValueError:
            raise AuthError(400, '请求长度无效。') from None
        if not 0 < length <= maximum:
            raise AuthError(413, '请求为空或内容过大。')
        def pairs(values):
            result = {}
            for key, value in values:
                if key in result:
                    raise ValueError('duplicate key')
                result[key] = value
            return result
        try:
            raw = handler.rfile.read(length)
            if len(raw) != length:
                raise ValueError('incomplete body')
            body = json.loads(raw, object_pairs_hook=pairs,
                              parse_constant=lambda _v: (_ for _ in ()).throw(ValueError('nonfinite')))
        except (ValueError, UnicodeDecodeError, RecursionError):
            raise AuthError(400, 'JSON 内容无效。') from None
        if not isinstance(body, dict):
            raise AuthError(400, '请求需为 JSON 对象。')
        return body

    @staticmethod
    def session_value(session):
        return dict(authenticated=bool(session), loginEnabled=True,
                    user=session['user'] if session else None,
                    expiresAt=session['expiresAt'] if session else None)

    def handle(self, handler, route):
        if route.startswith('/api/sat/'):
            return self._handle_sat(handler)
        routes = {'/api/auth/session': {'GET'}, '/api/auth/login': {'POST'}, '/api/auth/logout': {'POST'},
                  '/api/auth/password': {'POST'}, '/api/me': {'GET', 'PATCH'}, '/api/me/home': {'GET', 'PUT'},
                  '/api/admin/users': {'GET', 'POST'}, '/api/toefl/bootstrap': {'GET'}, '/api/toefl/state': {'GET', 'PUT'}}
        user_match = re.fullmatch(r'/api/admin/users/([a-f0-9]{32})(/password)?', route)
        allowed = routes.get(route) or ({'POST'} if user_match and user_match[2] else {'PATCH'} if user_match else None)
        if allowed is None:
            return False
        try:
            if handler.headers.get('Host') != f'127.0.0.1:{handler.server.server_port}':
                raise AuthError(403, '请从当前网站地址访问。', 'invalid_host')
            if handler.command not in allowed:
                raise AuthError(405, '此接口不支持该操作。', 'method_not_allowed')
            body = self._body(handler) if handler.command in {'POST', 'PATCH', 'PUT'} else None
            if route == '/api/auth/login':
                if set(body) != {'username', 'password'}:
                    raise AuthError(400, '请提供用户名和密码。')
                token, session = self.store.login(body['username'], body['password'], handler.client_address[0])
                self._reply(handler, 200, self.session_value(session), self._cookie(token))
                return True
            session = self.authenticate(handler.headers.get('Cookie'))
            if route == '/api/auth/session':
                self._reply(handler, 200, self.session_value(session))
                return True
            if not session:
                raise AuthError(401, '登录已失效，请重新登录。', 'session_expired')
            user = session['user']
            identity = user['id']
            account_header = handler.headers.get('X-Account-ID')
            if (body is not None and account_header != identity
                    or account_header is not None and account_header != identity):
                raise AuthError(409, '当前账号已切换，请刷新页面后继续。', 'account_changed')
            if route == '/api/auth/logout':
                if body:
                    raise AuthError(400, '退出请求字段无效。')
                self.store.logout(session['sessionId'], identity)
                self._reply(handler, 200, {'ok': True}, self._cookie(clear=True))
            elif route == '/api/auth/password':
                if set(body) != {'currentPassword', 'newPassword'}:
                    raise AuthError(400, '请提供当前密码与新密码。')
                self.store.change_password(identity, body['newPassword'], identity, current_password=body['currentPassword'])
                self._reply(handler, 200, {'ok': True, 'reauthenticate': True}, self._cookie(clear=True))
            elif route == '/api/me':
                value = user if handler.command == 'GET' else self.store.update_user(identity, body, identity, own_profile=True)
                self._reply(handler, 200, value)
            elif route == '/api/admin/users':
                if handler.command == 'GET':
                    self._reply(handler, 200, {'users': self.store.list_users(identity)})
                else:
                    if not {'username', 'password'} <= set(body) or set(body) - {'username', 'password', 'role', 'displayName'}:
                        raise AuthError(400, '账号创建字段无效。')
                    new_user = self.store.create_user(body['username'], body['password'], body.get('role', 'student'), body.get('displayName'), identity)
                    self._reply(handler, 201, {'user': new_user})
            elif user_match:
                if user_match[2]:
                    if set(body) != {'password'}:
                        raise AuthError(400, '请提供新密码。')
                    self.store.change_password(user_match[1], body['password'], identity, admin_reset=True)
                    self._reply(handler, 200, {'ok': True})
                else:
                    self._reply(handler, 200, {'user': self.store.update_user(user_match[1], body, identity)})
            elif route == '/api/me/home':
                if handler.command == 'GET':
                    value = self.store.state(identity, 'home', 'settings')
                else:
                    if set(body) != {'value', 'revision'}:
                        raise AuthError(400, '请提供设置内容与版本。')
                    value = self.store.save_state(identity, 'home', 'settings', body['value'], body['revision'])
                self._reply(handler, 200, value)
            elif route == '/api/toefl/bootstrap':
                self._reply(handler, 200, {'me': dict(user, aiReady=False), 'state': self.store.state(identity, 'toefl')})
            elif route == '/api/toefl/state':
                if handler.command == 'GET':
                    value = self.store.state(identity, 'toefl')
                else:
                    if set(body) != {'key', 'value', 'revision'} or not isinstance(body['key'], str):
                        raise AuthError(400, '请提供记录类型、内容与版本。')
                    value = self.store.save_state(identity, 'toefl', body['key'], body['value'], body['revision'])
                self._reply(handler, 200, value)
        except AuthError as error:
            self._reply(handler, error.status, {'error': str(error), 'code': error.code, **error.extra})
        except (sqlite3.Error, OSError):
            self._reply(handler, 503, {'error': '账号服务暂不可用，请稍后重试。', 'code': 'storage_unavailable'})
        return True

    def _handle_sat(self, handler):
        parsed = urlsplit(handler.path)
        route = parsed.path
        match = re.fullmatch(r'/api/sat/(attempts|wrong-book|settings)/(.+)', route)
        if route not in {'/api/sat/bootstrap', '/api/sat/summary'} and not match:
            return False
        locked = False
        timeout = None
        try:
            if handler.headers.get('Host') != f'127.0.0.1:{handler.server.server_port}':
                raise AuthError(403, '请从当前网站地址访问。', 'invalid_host')
            if handler.command not in ({'GET', 'PUT'} if match else {'GET'}):
                raise AuthError(405, '此接口不支持该操作。', 'method_not_allowed')
            session = self.authenticate(handler.headers.get('Cookie'))
            if not session:
                raise AuthError(401, '登录已失效，请重新登录。', 'session_expired')
            identity = session['user']['id']
            account = handler.headers.get('X-Account-ID')
            if handler.command == 'PUT' and account != identity or account is not None and account != identity:
                raise AuthError(409, '当前账号已切换，请刷新页面后继续。', 'account_changed')
            if match:
                locked = self._sat_transfers.acquire(blocking=False)
                if not locked:
                    raise AuthError(429, '正在同步其他 SAT 记录，请稍后重试。', 'sat_sync_busy', retryAfter=2)
                timeout = handler.connection.gettimeout()
                handler.connection.settimeout(30)
                kind, item_id = match[1], unquote(match[2])
                if handler.command == 'GET':
                    value = self.sat.get(identity, kind, item_id)
                else:
                    maximum = MAX_SETTINGS_BYTES + 4096 if kind == 'settings' else MAX_ENTITY_BYTES + 4096
                    body = self._body(handler, maximum=maximum)
                    value = self.sat.put(identity, kind, item_id, body)
            elif route == '/api/sat/bootstrap':
                query = parse_qs(parsed.query, keep_blank_values=True)
                if set(query) - {'cursor'} or len(query.get('cursor', [])) > 1:
                    raise AuthError(400, 'SAT 同步分页请求无效。')
                value = self.sat.bootstrap(identity, query.get('cursor', [None])[0])
            else:
                value = self.sat.summary(identity)
            self._reply(handler, 200, value)
        except (AuthError, SATStateError) as error:
            self._reply(handler, error.status, {'error': str(error), 'code': error.code, **error.extra})
        except (sqlite3.Error, OSError):
            self._reply(handler, 503, {'error': 'SAT 同步暂不可用，本机记录仍保留。', 'code': 'storage_unavailable'})
        finally:
            if locked:
                handler.connection.settimeout(timeout)
                self._sat_transfers.release()
        return True


def make_auth_handler(private):
    return AuthHTTP(AuthStore(Path(private) / 'auth' / 'platform.sqlite3'))


def main():
    parser = argparse.ArgumentParser(description='Create a local Study Space administrator without saving a plaintext password.')
    parser.add_argument('command', choices=['create-admin'])
    parser.add_argument('--username', required=True)
    parser.add_argument('--display-name')
    parser.add_argument('--database', type=Path, default=Path(__file__).resolve().parents[2] / 'local-data/auth/platform.sqlite3')
    args = parser.parse_args()
    password = getpass.getpass('Password (at least 6 characters): ')
    confirmation = getpass.getpass('Confirm password: ')
    if password != confirmation:
        parser.error('Passwords do not match.')
    try:
        user = AuthStore(args.database).create_user(args.username, password, 'admin', args.display_name)
    except AuthError as error:
        parser.error(str(error))
    print(f'Administrator created: {user["username"]}. Existing accounts were not changed.')


if __name__ == '__main__':
    main()
