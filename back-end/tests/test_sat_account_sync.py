"""SAT account sync against isolated local-data databases and synthetic questions."""
import concurrent.futures
import copy
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.parse import quote
import uuid

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
from server.platform_auth import AuthStore, make_auth_handler
from server import sat_account_state as sat
from server.serve_platform import create_server

TEMP_ROOT = BACKEND.parent / 'local-data/agent-output/sat-account-sync-tests'
TEMP_ROOT.mkdir(parents=True, exist_ok=True)


def attempt(identity='attempt-fixture', complete=False):
    question = {'id': 'satpack:fixture:题1', 'section': 'Math', 'question': 'Synthetic: 2 + 2?', 'options': ['4', '5'], 'correctOption': 0}
    ids = [question['id']]
    return {'id': identity, 'practiceName': 'Synthetic practice', 'status': 'completed' if complete else 'incomplete',
            'startedAt': 1800000000000, 'savedAt': 1800000001000, 'completedAt': 1800000001000,
            'questionIds': ids, 'questionSnapshots': [question], 'sourceIds': ['fixture-source'],
            'totalQuestions': 1, 'correctCount': 1, 'incorrectCount': 0, 'unansweredCount': 0, 'ungradedCount': 0,
            'answers': {ids[0]: {'answered': True, 'correctness': True, 'selectedOption': 0}},
            'durationSeconds': 1920, 'elapsedMs': 1000, 'remainingTimeMs': 1919000,
            'fullSAT': False, 'resumable': not complete,
            'runtimeSnapshot': None if complete else {'activePractice': {'id': identity, 'questionIds': ids},
                'currentQuestion': 0, 'remainingTimeMs': 1919000, 'questionStates': [{'selectedOption': 0, 'highlights': [{'text': 'Synthetic', 'note': 'test note'}]}]}}


def wrong(identity='satpack:fixture:题1'):
    return {'questionId': identity, 'addedAt': 1800000001000, 'reason': 'manual', 'sourceAttemptId': None,
            'questionSnapshot': {'id': identity, 'question': 'Synthetic wrong-book question'},
            'sourceSnapshot': {'id': 'fixture-source', 'displayName': 'Synthetic source'}}


def body(value=None, revision=0, **extra):
    return dict({'value': value, 'revision': revision, 'mutationId': uuid.uuid4().hex}, **extra)


class SATStoreTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(dir=TEMP_ROOT)
        self.accounts = AuthStore(Path(self.folder.name) / 'auth/platform.sqlite3')
        self.student = self.accounts.create_user('sync-student', 'fixture-pass')['id']
        self.other = self.accounts.create_user('sync-other', 'fixture-pass')['id']
        self.store = sat.SATAccountStore(self.accounts)

    def tearDown(self):
        self.folder.cleanup()

    def error(self, status, function, code=None):
        with self.assertRaises(sat.SATStateError) as caught:
            function()
        self.assertEqual(caught.exception.status, status)
        if code:
            self.assertEqual(caught.exception.code, code)
        return caught.exception

    def test_student_owner_isolation_resume_and_restart(self):
        value = attempt()
        result = self.store.put(self.student, 'attempts', value['id'], body(value))
        self.assertEqual(result['revision'], 1)
        self.assertNotIn('value', result)
        self.assertEqual(self.store.get(self.student, 'attempts', value['id'])['value'], value)
        self.assertEqual(self.store.get(self.other, 'attempts', value['id'])['revision'], 0)
        self.assertEqual(self.store.bootstrap(self.other)['attempts'], [])
        restarted = sat.SATAccountStore(AuthStore(self.accounts.path))
        restored = restarted.get(self.student, 'attempts', value['id'])['value']
        self.assertEqual(restored['runtimeSnapshot']['remainingTimeMs'], 1919000)
        self.assertEqual(restored['runtimeSnapshot']['questionStates'][0]['highlights'][0]['note'], 'test note')
        with sqlite3.connect(self.accounts.path) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM users').fetchone()[0], 2)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM schema_migrations WHERE version='002_sat_accounts.sql'").fetchone()[0], 1)

    def test_retry_idempotence_and_mutation_reuse(self):
        request = body(attempt())
        first = self.store.put(self.student, 'attempts', 'attempt-fixture', request)
        self.assertEqual(self.store.put(self.student, 'attempts', 'attempt-fixture', request), first)
        reordered = dict(reversed(list(request.items())))
        reordered['value'] = dict(reversed(list(request['value'].items())))
        self.assertEqual(self.store.put(self.student, 'attempts', 'attempt-fixture', reordered), first)
        changed = copy.deepcopy(request)
        changed['value']['practiceName'] = 'Changed content'
        self.error(409, lambda: self.store.put(self.student, 'attempts', 'attempt-fixture', changed), 'mutation_reused')
        self.assertEqual(self.store.get(self.student, 'attempts', 'attempt-fixture')['revision'], 1)

    def test_completed_is_immutable_and_deletion_cannot_resurrect(self):
        complete = attempt(complete=True)
        self.store.put(self.student, 'attempts', complete['id'], body(complete))
        duplicate = self.store.put(self.student, 'attempts', complete['id'], body(complete, 1))
        self.assertEqual(duplicate['revision'], 1)
        self.error(409, lambda: self.store.put(self.student, 'attempts', complete['id'], body(attempt(), 1)), 'attempt_completed')
        removed = self.store.put(self.student, 'attempts', complete['id'], body(None, 1, deleted=True))
        self.assertEqual(removed['revision'], 2)
        self.error(409, lambda: self.store.put(self.student, 'attempts', complete['id'], body(complete, 1)), 'revision_conflict')
        self.error(409, lambda: self.store.put(self.student, 'attempts', complete['id'], body(complete, 2)), 'entity_deleted')
        self.error(409, lambda: self.store.put(self.student, 'attempts', complete['id'], body(complete, 2, restore=True)), 'entity_deleted')
        self.assertIsNone(self.store.get(self.student, 'attempts', complete['id'])['value'])
        self.assertTrue(self.store.bootstrap(self.student)['attempts'][0]['deleted'])
        self.assertEqual(self.store.summary(self.student)['attempts'], [])

    def test_wrong_book_snapshots_and_explicit_readd(self):
        value = wrong()
        key = value['questionId']
        self.store.put(self.student, 'wrong-book', key, body(value))
        self.store.put(self.student, 'wrong-book', key, body(None, 1, deleted=True))
        self.error(409, lambda: self.store.put(self.student, 'wrong-book', key, body(value, 2)), 'entity_deleted')
        self.error(409, lambda: self.store.put(self.student, 'wrong-book', key, body(value, 1, restore=True)), 'revision_conflict')
        restored = self.store.put(self.student, 'wrong-book', key, body(value, 2, restore=True))
        self.assertEqual(restored['revision'], 3)
        self.assertEqual(self.store.get(self.student, 'wrong-book', key)['value']['questionSnapshot'], value['questionSnapshot'])

    def test_revision_serializes_concurrent_writers(self):
        value = attempt()
        self.store.put(self.student, 'attempts', value['id'], body(value))
        barrier = threading.Barrier(2)
        def update(index):
            draft = copy.deepcopy(value)
            draft['practiceName'] = f'Writer {index}'
            barrier.wait()
            try:
                return self.store.put(self.student, 'attempts', value['id'], body(draft, 1))['revision']
            except sat.SATStateError as error:
                return error.status
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            self.assertCountEqual(list(executor.map(update, range(2))), [2, 409])

    def test_metadata_pagination_and_summary_exclude_snapshots(self):
        for index in range(5):
            value = attempt(f'fixture-{index}', complete=True)
            self.store.put(self.student, 'attempts', value['id'], body(value))
        with patch.object(sat, 'PAGE_SIZE', 2):
            page1 = self.store.bootstrap(self.student)
            page2 = self.store.bootstrap(self.student, page1['nextCursor'])
            page3 = self.store.bootstrap(self.student, page2['nextCursor'])
        self.assertEqual([len(page['attempts']) for page in (page1, page2, page3)], [2, 2, 1])
        self.assertIsNone(page3['nextCursor'])
        for page in (page1, page2, page3):
            self.assertNotIn('questionSnapshots', json.dumps(page))
            self.assertNotIn('answers', json.dumps(page))
        summary = self.store.summary(self.student)
        self.assertEqual(len(summary['attempts']), 5)
        self.assertEqual(summary['attempts'][0]['section'], 'Math')
        for field in ('questionSnapshots', 'runtimeSnapshot', 'answers', 'Synthetic: 2 + 2?'):
            self.assertNotIn(field, json.dumps(summary))

    def test_setting_whitelist_and_range_validation(self):
        settings = {'appConfig': {'moduleQuestionLimit': 30, 'examTimerWarning': 'proportional'},
                    'practiceDurationPreferences': {'fixture-source': 1920}, 'customPracticeDurationSeconds': 1200,
                    'timingTargets': {'words-in-context': 90, '__uncategorized__': 120},
                    'questionTimer': {'enabled': True, 'mode': 'down'}}
        for key, value in settings.items():
            self.store.put(self.student, 'settings', key, body(value))
        self.assertEqual({row['key'] for row in self.store.bootstrap(self.student)['settings']}, set(settings))
        self.error(404, lambda: self.store.put(self.student, 'settings', 'questionBank', body({})))
        self.error(400, lambda: self.store.put(self.student, 'settings', 'customPracticeDurationSeconds', body(1)))
        self.error(400, lambda: self.store.put(self.student, 'settings', 'questionTimer', body({'enabled': 'yes', 'mode': 'up'})))
        self.error(400, lambda: self.store.put(self.student, 'settings', 'timingTargets', body({'unknown-category': 5})))

    def test_malformed_records_and_account_limits(self):
        for field, invalid in [('questionSnapshots', []), ('totalQuestions', 3), ('totalQuestions', True), ('status', []), ('correctCount', 0), ('runtimeSnapshot', {}), ('answers', {}), ('userId', self.other)]:
            value = attempt()
            value[field] = invalid
            self.error(400, lambda: self.store.put(self.student, 'attempts', value['id'], body(value)))
        self.error(400, lambda: self.store.put(self.student, 'wrong-book', 'bad', body({'questionId': 'bad'})))
        with patch.object(sat, 'MAX_ENTITY_BYTES', 10):
            self.error(413, lambda: self.store.put(self.student, 'attempts', 'attempt-fixture', body(attempt())))
        with patch.object(sat, 'MAX_ACCOUNT_BYTES', 10):
            self.error(413, lambda: self.store.put(self.student, 'attempts', 'attempt-fixture', body(attempt())))
        with patch.object(sat, 'MAX_ACCOUNT_ENTITIES', 1):
            self.store.put(self.student, 'attempts', 'attempt-fixture', body(attempt()))
            self.error(413, lambda: self.store.put(self.student, 'attempts', 'other', body(attempt('other'))))

    def test_mutation_receipts_are_bounded(self):
        for revision in range(20):
            self.store.put(self.student, 'settings', 'customPracticeDurationSeconds', body(60 + revision, revision))
        with sqlite3.connect(self.accounts.path) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM sat_account_mutations').fetchone()[0], sat.MUTATIONS_PER_ENTITY)


class SATHTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.folder = tempfile.TemporaryDirectory(dir=TEMP_ROOT)
        cls.api = make_auth_handler(cls.folder.name)
        cls.student = cls.api.store.create_user('http-sync-student', 'fixture-pass')['id']
        cls.other = cls.api.store.create_user('http-sync-other', 'fixture-pass')['id']
        cls.token, _ = cls.api.store.login('http-sync-student', 'fixture-pass')
        cls.cookie = 'study_session=' + cls.token
        api = cls.api
        class Handler(BaseHTTPRequestHandler):
            def dispatch(self):
                if not api.handle(self, self.path.split('?')[0]):
                    self.send_error(404)
            do_GET = do_PUT = do_POST = do_DELETE = dispatch
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

    def request(self, method, route, data=None, headers=None):
        values = {'Origin': self.origin, 'Content-Type': 'application/json', 'Cookie': self.cookie, 'X-Account-ID': self.student}
        values.update(headers or {})
        values = {key: value for key, value in values.items() if value is not None}
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        connection.request(method, route, json.dumps(data).encode() if data is not None else None, values)
        response = connection.getresponse()
        result = response.status, json.loads(response.read())
        connection.close()
        return result

    def test_student_http_snapshot_roundtrip_and_summary(self):
        value = attempt('http-attempt')
        self.assertEqual(self.request('PUT', '/api/sat/attempts/http-attempt', body(value))[0], 200)
        self.assertEqual(self.request('GET', '/api/sat/attempts/http-attempt')[1]['value'], value)
        wrong_value = wrong('satpack:fixture:中文题')
        url = '/api/sat/wrong-book/' + quote(wrong_value['questionId'], safe='')
        self.assertEqual(self.request('PUT', url, body(wrong_value))[0], 200)
        self.assertEqual(self.request('GET', url)[1]['value'], wrong_value)
        self.assertNotIn('questionSnapshots', json.dumps(self.request('GET', '/api/sat/summary')[1]))

    def test_auth_csrf_old_tab_and_bounded_body(self):
        url = '/api/sat/attempts/security-attempt'
        value = body(attempt('security-attempt'))
        self.assertEqual(self.request('GET', '/api/sat/bootstrap', headers={'Cookie': None})[0], 401)
        self.assertEqual(self.request('PUT', url, value, headers={'Cookie': None})[0], 401)
        for method in ('GET', 'PUT'):
            self.assertEqual(self.request(method, url, value if method == 'PUT' else None, {'X-Account-ID': self.other})[0], 409)
        for headers in ({'Origin': None}, {'Origin': 'http://evil.invalid'}, {'Sec-Fetch-Site': 'cross-site'}):
            self.assertEqual(self.request('PUT', url, value, headers)[0], 403)
        self.assertEqual(self.request('PUT', url, value, {'Content-Type': 'text/plain'})[0], 415)
        self.assertEqual(self.request('PUT', url, value, {'Content-Length': str(sat.MAX_ENTITY_BYTES + 9999)})[0], 413)
        self.assertEqual(self.request('DELETE', url)[0], 405)
        self.assertEqual(self.request('GET', '/api/sat/bootstrap?cursor=invalid')[0], 400)

    def test_large_transfers_have_bounded_concurrency(self):
        self.api._sat_transfers.acquire()
        self.api._sat_transfers.acquire()
        try:
            status, result = self.request('GET', '/api/sat/attempts/busy-fixture')
            self.assertEqual(status, 429)
            self.assertEqual(result['code'], 'sat_sync_busy')
        finally:
            self.api._sat_transfers.release()
            self.api._sat_transfers.release()
        self.assertEqual(self.request('GET', '/api/sat/attempts/busy-fixture')[0], 200)

    def test_private_database_and_snapshots_have_no_static_route(self):
        folder = tempfile.TemporaryDirectory(dir=TEMP_ROOT)
        server = create_server(port=0, private_root=folder.name)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            identity = server.auth.store.create_user('route-student', 'fixture-pass')['id']
            token, _ = server.auth.store.login('route-student', 'fixture-pass')
            server.auth.sat.put(identity, 'attempts', 'private-attempt', body(attempt('private-attempt')))
            for route in ('/local-data/auth/platform.sqlite3', '/back-end/server/sat_account_state.py', '/auth/platform.sqlite3'):
                connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=5)
                connection.request('GET', route, headers={'Cookie': 'study_session=' + token})
                response = connection.getresponse()
                response.read()
                self.assertEqual(response.status, 404)
                connection.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
            folder.cleanup()


if __name__ == '__main__':
    unittest.main()
