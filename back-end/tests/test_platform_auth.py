"""Anonymous account fixtures; no real usernames/passwords are committed."""
import concurrent.futures
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import http.client
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest

MODULE = Path(__file__).resolve().parents[1] / 'server/platform_auth.py'
spec = importlib.util.spec_from_file_location('platform_auth', MODULE)
auth = importlib.util.module_from_spec(spec)
spec.loader.exec_module(auth)


class AccountTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.folder = tempfile.TemporaryDirectory()
        cls.time = [1_800_000_000]
        cls.store = auth.AuthStore(Path(cls.folder.name) / 'accounts.sqlite3', clock=lambda: cls.time[0])
        cls.admin = cls.store.create_user('fixture-admin', 'fixture-pass', role='admin')
        cls.student = cls.store.create_user('fixture-student', 'fixture-pass')

    @classmethod
    def tearDownClass(cls):
        cls.folder.cleanup()

    def assertAuthError(self, status, action):
        with self.assertRaises(auth.AuthError) as caught:
            action()
        self.assertEqual(caught.exception.status, status)
        return caught.exception

    def test_password_hashes_and_migrations_survive_restart(self):
        store = auth.AuthStore(self.store.path, clock=lambda: self.time[0])
        with sqlite3.connect(store.path) as db:
            encoded = db.execute('SELECT password_hash FROM users WHERE id=?', (self.admin['id'],)).fetchone()[0]
            self.assertTrue(encoded.startswith('pbkdf2_sha256$600000$'))
            self.assertNotIn('fixture-pass', encoded)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM schema_migrations').fetchone()[0], len(list(MODULE.with_name('migrations').glob('*.sql'))))
        self.assertAuthError(409, lambda: store.create_user('fixture-admin', 'another-password', role='admin'))
        token, _session = store.login('FIXTURE-ADMIN', 'fixture-pass')
        self.assertEqual(store.authenticate_token(token)['user']['id'], self.admin['id'])

    def test_single_session_expiry_and_logout(self):
        first, _ = self.store.login('fixture-student', 'fixture-pass')
        second, session = self.store.login('fixture-student', 'fixture-pass')
        self.assertIsNone(self.store.authenticate_token(first))
        restarted = auth.AuthStore(self.store.path, clock=lambda: self.time[0])
        self.assertIsNotNone(restarted.authenticate_token(second))
        restarted.logout(session['sessionId'], self.student['id'])
        self.assertIsNone(self.store.authenticate_token(second))
        third, _ = self.store.login('fixture-student', 'fixture-pass')
        self.time[0] += auth.SESSION_IDLE_SECONDS
        self.assertIsNone(self.store.authenticate_token(third))

    def test_last_admin_and_role_permissions(self):
        self.assertAuthError(403, lambda: self.store.list_users(self.student['id']))
        self.assertAuthError(403, lambda: self.store.create_user('bad-create', 'fixture-pass', 'admin', actor_id=self.student['id']))
        self.assertAuthError(409, lambda: self.store.update_user(self.admin['id'], {'active': False}, self.admin['id']))
        self.assertAuthError(409, lambda: self.store.update_user(self.admin['id'], {'role': 'student'}, self.admin['id']))
        self.assertAuthError(400, lambda: self.store.update_user(self.student['id'], {'role': 'admin'}, self.student['id'], own_profile=True))

    def test_password_changes_reset_disable_and_role_revoke(self):
        user = self.store.create_user('fixture-change', 'old-password')
        token, _ = self.store.login(user['username'], 'old-password')
        self.assertAuthError(400, lambda: self.store.change_password(user['id'], 'new-password', user['id'], current_password='incorrect'))
        self.store.change_password(user['id'], 'new-password', user['id'], current_password='old-password')
        self.assertIsNone(self.store.authenticate_token(token))
        token, _ = self.store.login(user['username'], 'new-password')
        self.store.change_password(user['id'], 'reset-password', self.admin['id'], admin_reset=True)
        self.assertIsNone(self.store.authenticate_token(token))
        token, _ = self.store.login(user['username'], 'reset-password')
        self.store.update_user(user['id'], {'role': 'admin'}, self.admin['id'])
        self.assertIsNone(self.store.authenticate_token(token))
        token, _ = self.store.login(user['username'], 'reset-password')
        self.store.update_user(user['id'], {'active': False}, self.admin['id'])
        self.assertIsNone(self.store.authenticate_token(token))
        self.assertAuthError(401, lambda: self.store.login(user['username'], 'reset-password'))
        self.store.update_user(user['id'], {'active': True}, self.admin['id'])
        self.assertIsNotNone(self.store.login(user['username'], 'reset-password')[0])
        # Leave only the original active administrator for other tests.
        self.store.update_user(user['id'], {'role': 'student'}, self.admin['id'])

    def test_persistent_failure_limit_and_no_secret_audit(self):
        for _ in range(5):
            self.assertAuthError(401, lambda: self.store.login('fixture-missing', 'secret-not-to-log', 'fixture-ip'))
        restarted = auth.AuthStore(self.store.path, clock=lambda: self.time[0])
        error = self.assertAuthError(429, lambda: restarted.login('fixture-missing', 'secret-not-to-log', 'fixture-ip'))
        self.assertGreater(error.extra['retryAfter'], 0)
        with sqlite3.connect(self.store.path) as db:
            audit = str(db.execute('SELECT * FROM audit_events').fetchall())
            self.assertNotIn('secret-not-to-log', audit)
            self.assertNotIn('fixture-ip', audit)
            self.assertNotIn('fixture-missing', audit)
        self.time[0] += auth.LOGIN_WINDOW_SECONDS + 1
        self.assertAuthError(401, lambda: restarted.login('fixture-missing', 'secret-not-to-log', 'fixture-ip'))

    def test_parallel_login_attempts_share_atomic_limit(self):
        user = self.store.create_user('fixture-concurrent', 'fixture-pass')
        token, _ = self.store.login(user['username'], 'fixture-pass')
        barrier = threading.Barrier(10)
        def wrong_password(index):
            barrier.wait()
            try:
                self.store.login(user['username'], 'incorrect-pass', f'parallel-address-{index}')
            except auth.AuthError as error:
                return error.status
        with concurrent.futures.ThreadPoolExecutor(max_workers=10) as workers:
            results = list(workers.map(wrong_password, range(10)))
        self.assertEqual(results.count(401), 5)
        self.assertEqual(results.count(429), 5)
        self.assertAuthError(429, lambda: self.store.login(user['username'], 'fixture-pass'))
        self.assertIsNotNone(self.store.authenticate_token(token))

    def test_state_isolation_versions_concurrency_and_validation(self):
        key = 'four.history.v1'
        saved = self.store.save_state(self.admin['id'], 'toefl', key, [{'id': 'test-item'}], 0)
        self.assertEqual(saved['revision'], 1)
        self.assertEqual(self.store.state(self.student['id'], 'toefl'), {'items': []})
        self.assertAuthError(409, lambda: self.store.save_state(self.admin['id'], 'toefl', key, [], 0))
        self.assertAuthError(400, lambda: self.store.save_state(self.admin['id'], 'toefl', 'untrusted.key', [], 0))
        self.assertAuthError(400, lambda: self.store.save_state(self.admin['id'], 'home', 'settings', {'userId': self.student['id']}, 0))
        self.assertAuthError(400, lambda: self.store.save_state(self.admin['id'], 'home', 'settings', {'plan': {'dailyGoal': -1}}, 0))
        self.assertAuthError(400, lambda: self.store.save_state(self.admin['id'], 'home', 'settings', {'targets': {'sat': {'english': 799, 'math': 800}}}, 0))
        def write(_):
            try:
                return self.store.save_state(self.admin['id'], 'toefl', key, [], 1)['revision']
            except auth.AuthError as error:
                return error.status
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as workers:
            self.assertCountEqual(list(workers.map(write, range(2))), [2, 409])
        value = {'plan': {'dailyGoal': 30, 'note': 'fixture'}, 'targets': {'toefl': {'reading': 5, 'listening': 5, 'speaking': 4.5, 'writing': 5}}, 'preferences': {'reduceMotion': True}}
        result = self.store.save_state(self.student['id'], 'home', 'settings', value, 0)
        self.assertEqual(result['value']['targets']['toefl']['total'], 5)
        self.assertIsNone(self.store.state(self.admin['id'], 'home', 'settings')['value'])

    def test_toefl_cancelled_drafts_cannot_be_resurrected(self):
        user = self.store.create_user('fixture-cancel', 'fixture-pass')
        identity = user['id']
        report = {'id': 'saved-report', 'results': [{'response': 'saved answer'}]}
        self.store.save_state(identity, 'toefl', 'four.history.v1', [report], 0)
        markers = [{'id': 'draft-one', 'cancelled': True, 'cancelledAt': 1234},
                   {'id': 'saved-report', 'cancelled': True, 'cancelledAt': 1235}]
        self.store.save_state(identity, 'toefl', 'four.drafts.v2', markers, 0)
        result = self.store.save_state(identity, 'toefl', 'four.drafts.v2', [{'id': 'draft-one', 'answers': ['stale']}], 1)
        self.assertEqual(result['value'], markers)
        result = self.store.save_state(identity, 'toefl', 'four.history.v1', [{'id': 'draft-one', 'results': []}], 1)
        self.assertEqual(result['value'], [report])
        self.assertAuthError(400, lambda: self.store.save_state(identity, 'toefl', 'four.drafts.v2', [{'id': 'invalid id', 'cancelled': True, 'cancelledAt': -1}], 2))


class AuthHTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.folder = tempfile.TemporaryDirectory()
        cls.api = auth.make_auth_handler(cls.folder.name)
        cls.admin = cls.api.store.create_user('http-admin', 'fixture-pass', 'admin')
        cls.student = cls.api.store.create_user('http-student', 'fixture-pass')
        api = cls.api
        class Handler(BaseHTTPRequestHandler):
            def dispatch(self):
                if not api.handle(self, self.path):
                    self.send_error(404)
            do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = dispatch
            def log_message(self, *args):
                pass
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.server.daemon_threads = True
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.origin = f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.folder.cleanup()

    def request(self, method, path, value=None, cookie=None, account=None, headers=None):
        actual = {'Origin': self.origin, 'Content-Type': 'application/json'}
        if cookie:
            actual['Cookie'] = cookie
        if account:
            actual['X-Account-ID'] = account
        actual.update(headers or {})
        actual = {key: value for key, value in actual.items() if value is not None}
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        body = json.dumps(value).encode() if value is not None else None
        connection.request(method, path, body=body, headers=actual)
        response = connection.getresponse()
        result = response.status, dict(response.getheaders()), json.loads(response.read())
        connection.close()
        return result

    def login(self, name='http-admin'):
        status, headers, body = self.request('POST', '/api/auth/login', {'username': name, 'password': 'fixture-pass'})
        self.assertEqual(status, 200)
        self.assertIn('HttpOnly', headers['Set-Cookie'])
        self.assertIn('SameSite=Strict', headers['Set-Cookie'])
        self.assertNotIn('token', body)
        return headers['Set-Cookie'].split(';')[0], body['user']['id']

    def test_session_login_origin_json_and_method_protection(self):
        self.assertEqual(self.request('GET', '/api/auth/session')[2]['authenticated'], False)
        self.assertEqual(self.request('GET', '/api/me')[0], 401)
        credentials = {'username': 'http-admin', 'password': 'fixture-pass'}
        for headers in ({'Origin': 'http://evil.invalid'}, {'Origin': None}, {'Sec-Fetch-Site': 'cross-site'}):
            self.assertEqual(self.request('POST', '/api/auth/login', credentials, headers=headers)[0], 403)
        self.assertEqual(self.request('POST', '/api/auth/login', credentials, headers={'Content-Type': 'text/plain'})[0], 415)
        self.assertEqual(self.request('GET', '/api/auth/login')[0], 405)
        cookie, identity = self.login()
        self.assertEqual(self.request('GET', '/api/auth/session', cookie=cookie)[2]['user']['id'], identity)
        self.assertEqual(self.request('GET', '/api/me', cookie=cookie)[2]['id'], identity)
        self.assertIsNone(self.api.authenticate(cookie + '; ' + cookie))

    def test_account_binding_permissions_profile_and_admin_mutations(self):
        cookie, identity = self.login('http-student')
        self.assertEqual(self.request('GET', '/api/admin/users', cookie=cookie)[0], 403)
        self.assertEqual(self.request('PATCH', '/api/me', {'displayName': 'Fixture'}, cookie)[0], 409)
        self.assertEqual(self.request('PATCH', '/api/me', {'displayName': 'Fixture'}, cookie, self.admin['id'])[0], 409)
        self.assertEqual(self.request('GET', '/api/toefl/bootstrap', cookie=cookie, account=self.admin['id'])[0], 409)
        self.assertEqual(self.request('PATCH', '/api/me', {'displayName': 'Fixture'}, cookie, identity)[2]['displayName'], 'Fixture')
        self.assertEqual(self.request('PATCH', '/api/me', {'role': 'admin'}, cookie, identity)[0], 400)
        admin_cookie, admin_id = self.login()
        status, _, result = self.request('POST', '/api/admin/users', {'username': 'http-new', 'password': 'new-fixture'}, admin_cookie, admin_id)
        self.assertEqual(status, 201)
        new_id = result['user']['id']
        self.assertEqual(self.request('PATCH', '/api/admin/users/' + new_id, {'active': False}, admin_cookie, admin_id)[2]['user']['active'], False)
        self.assertEqual(self.request('POST', '/api/admin/users/' + new_id + '/password', {'password': 'other-fixture'}, admin_cookie, admin_id)[0], 200)

    def test_malformed_fields_are_rejected_without_server_errors(self):
        cookie, identity = self.login()
        self.assertEqual(self.request('POST', '/api/admin/users', {'username': 'invalid-role', 'password': 'fixture-pass', 'role': {}}, cookie, identity)[0], 400)
        self.assertEqual(self.request('PATCH', '/api/me', {'displayName': '\ud800'}, cookie, identity)[0], 400)
        self.assertEqual(self.request('PUT', '/api/toefl/state', {'key': 'four.drafts.v2', 'value': [{'id': []}], 'revision': 0}, cookie, identity)[0], 400)
        self.assertEqual(self.request('GET', '/api/auth/session', headers={'Host': 'evil.invalid'})[0], 403)

    def test_cross_account_data_and_password_logout(self):
        cookie, identity = self.login('http-student')
        value = {'value': {'plan': {'dailyGoal': 42, 'note': ''}}, 'revision': 0}
        self.assertEqual(self.request('PUT', '/api/me/home', value, cookie, identity)[0], 200)
        self.assertEqual(self.request('PUT', '/api/me/home', value, cookie, identity)[0], 409)
        admin_cookie, admin_id = self.login()
        self.assertEqual(self.request('GET', '/api/me/home', cookie=admin_cookie, account=admin_id)[2], {'value': None, 'revision': 0})
        self.assertEqual(self.request('POST', '/api/auth/logout', {}, cookie, identity)[0], 200)
        self.assertEqual(self.request('GET', '/api/me', cookie=cookie)[0], 401)
        cookie, identity = self.login()
        self.assertEqual(self.request('POST', '/api/auth/password', {'currentPassword': 'fixture-pass', 'newPassword': 'changed-fixture'}, cookie, identity)[0], 200)
        self.assertEqual(self.request('GET', '/api/me', cookie=cookie)[0], 401)
        # Restore fixture for independent tests without changing any real account.
        self.api.store.change_password(identity, 'fixture-pass', identity, admin_reset=True)


if __name__ == '__main__':
    unittest.main()
