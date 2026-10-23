"""Integration checks use only generated questions and temporary private data."""
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest

from scripts.serve_platform import create_server, TOEFL_PUBLIC_FILES
from shared.question_schema import normalize_question_set


class PlatformServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temporary.name)
        web = cls.root / 'apps/web'
        web.mkdir(parents=True)
        (web / 'index.html').write_text('<title>Test workspace</title>')
        sat = cls.root / 'apps/sat/html'
        sat.mkdir(parents=True)
        (sat / 'index.html').write_text('<html><head><title>Test SAT</title></head><body>Native SAT</body></html>')
        (cls.root / '.env').write_text('PRIVATE_SENTINEL=never-served')
        module = cls.root / 'apps/toefl'
        preview = module / 'dist/preview'
        for name in TOEFL_PUBLIC_FILES:
            target = preview / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('<html><head></head><body>Anonymous TOEFL</body></html>' if name == 'index.html' else 'fixture')
        (module / 'fixtures').mkdir()
        (module / 'fixtures/anonymous-bank.json').write_text(json.dumps({
            'fixture': True, 'records': [{'source': 'ANONYMOUS_FIXTURE', 'items': [{'id': 'q1'}]}]}))
        (module / 'dist/build-info.json').write_text(json.dumps({'mode': 'local-anonymous-intake',
            'productionCredentials': False, 'productionData': False, 'deployable': False}))
        (module / 'dist/preview/cloud-client.js').write_text('PRIVATE_SENTINEL=never-served')
        cls.server = create_server(cls.root, 0)
        cls.port = cls.server.server_port
        cls.worker = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.worker.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.worker.join()
        cls.temporary.cleanup()

    def request(self, route, method='GET', body=None, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        connection.request(method, route, body=body, headers=headers or {})
        response = connection.getresponse()
        status, data, metadata = response.status, response.read(), dict(response.getheaders())
        connection.close()
        return status, data, metadata

    def test_homepage_and_explicit_local_test_admin(self):
        self.assertEqual(self.request('/')[0], 200)
        status, body, _ = self.request('/api/auth/session')
        self.assertEqual(status, 200)
        session = json.loads(body)
        self.assertEqual(session['mode'], 'test-admin')
        self.assertFalse(session['loginEnabled'])
        self.assertFalse(session['authenticated'])
        self.assertEqual(session['user']['name'], 'admin')
        self.assertTrue(session['user']['isTest'])

    def test_exam_namespaces_and_source_roundtrip(self):
        raw = {'title': 'Synthetic set', 'questions': [{'prompt': 'Choose a test option.',
               'options': ['Alpha', 'Beta', 'Gamma', 'Delta'], 'answer': 'B',
               'customMetadata': {'userSelectedAnswer': 'A'}}]}
        document = normalize_question_set(raw, exam='sat')
        bank = self.root / 'private-data/question-banks/sat/example.json'
        bank.write_text(json.dumps(document))
        try:
            catalog = json.loads(self.request('/api/platform/catalog')[1])
            self.assertEqual([e['id'] for e in catalog['exams']], ['sat', 'ap', 'toefl', 'vocab'])
            self.assertEqual(catalog['exams'][0]['questionCount'], 1)
            self.assertEqual(catalog['exams'][1]['questionCount'], 0)
            status, body, _ = self.request('/api/exams/sat/sources/' + document['id'])
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body)['questions'][0]['correctOption'], 1)
            files = json.loads(self.request('/api/question-bank')[1])['files']
            legacy = json.loads(files[0]['text'])
            self.assertEqual(legacy['questions'][0]['answer'], 1)
            self.assertNotIn('userSelectedAnswer', files[0]['text'])
        finally:
            bank.unlink()

    def test_repository_and_private_files_are_not_static(self):
        for route in ['/.env', '/.git/config', '/private-data/question-banks/sat/example.json',
                      '/sat/SOURCE_MANIFEST.json', '/sat/js/%2e%2e/SOURCE_MANIFEST.json',
                      '/web/%2e%2e/%2e%2e/.env', '/sat/scripts/question_bank_server.py',
                      '/toefl/cloud-client.js', '/toefl/src/cloud/worker.mjs', '/toefl/.env',
                      '/toefl/api/auth/session', '/toefl/images/%2e%2e/cloud-client.js']:
            with self.subTest(route=route):
                self.assertEqual(self.request(route)[0], 404)

    def test_invalid_host_and_cross_origin_writes_rejected(self):
        self.assertEqual(self.request('/api/platform/catalog', headers={'Host': 'example.com'})[0], 403)
        self.assertEqual(self.request('/api/question-bank', method='POST', body='{}',
                                     headers={'Content-Type': 'application/json', 'Origin': 'https://example.com'})[0], 403)

    def test_import_sanitizes_and_adapts_without_history(self):
        info = json.loads(self.request('/api/question-bank/status')[1])
        raw = {'title': 'Generated import', 'questions': [{'prompt': 'Pick one.',
               'options': ['One', 'Two', 'Three', 'Four'], 'answer': 2,
               'customMetadata': {'studentName': 'PRIVATE_SENTINEL', 'userSelectedAnswer': 0}}]}
        payload = json.dumps({'name': 'generated.json', 'text': json.dumps(raw)})
        headers = {'Content-Type': 'application/json', 'Origin': f'http://127.0.0.1:{self.port}',
                   'X-SAT-Bank-Token': info['token']}
        status, body, _ = self.request('/api/question-bank', 'POST', payload, headers)
        self.assertEqual(status, 201)
        response = json.loads(body)
        target = self.root / 'private-data/question-banks/sat' / response['name']
        try:
            self.assertTrue(target.is_file())
            saved = target.read_text()
            self.assertNotIn('PRIVATE_SENTINEL', saved)
            self.assertNotIn('userSelectedAnswer', saved)
            legacy = json.loads(response['text'])
            self.assertEqual(legacy['questions'][0]['answer'], 2)
            self.assertEqual(self.request('/api/question-bank', 'POST', payload, headers)[0], 201)
            adapted_payload = json.dumps({'name': response['name'], 'text': response['text']})
            repeated = json.loads(self.request('/api/question-bank', 'POST', adapted_payload, headers)[1])
            self.assertEqual(repeated['name'], response['name'])
            self.assertEqual(len(list(target.parent.glob('sat-*.json'))), 1)
        finally:
            target.unlink(missing_ok=True)

    def test_sat_revisions_with_same_source_id_remain_in_legacy_sync(self):
        # AP duplicate-ID protection must not silently drop existing SAT revisions.
        info = json.loads(self.request('/api/question-bank/status')[1])
        headers = {'Content-Type': 'application/json', 'Origin': f'http://127.0.0.1:{self.port}',
                   'X-SAT-Bank-Token': info['token']}
        targets = []
        try:
            for answer in (0, 1):
                raw = {'sourceId': 'sat:revision-fixture', 'title': 'Original revision test',
                       'questions': [{'prompt': 'Choose an original fixture option.',
                                      'options': ['First', 'Second', 'Third', 'Fourth'], 'answer': answer}]}
                payload = json.dumps({'name': 'revision.json', 'text': json.dumps(raw)})
                status, body, _ = self.request('/api/question-bank', 'POST', payload, headers)
                self.assertEqual(status, 201)
                targets.append(self.root / 'private-data/question-banks/sat' / json.loads(body)['name'])
            self.assertNotEqual(targets[0], targets[1])
            result = json.loads(self.request('/api/question-bank')[1])
            self.assertEqual(len(result['files']), 2)
            self.assertEqual({json.loads(row['text'])['questions'][0]['answer'] for row in result['files']}, {0, 1})
            listing = json.loads(self.request('/api/exams/sat/sources')[1])
            self.assertEqual(len(listing['sources']), 2)
            self.assertEqual(listing['errors'], [])
        finally:
            for target in targets:
                target.unlink(missing_ok=True)

    def test_sat_redirect_preserves_deep_link(self):
        status, _, headers = self.request('/sat/?view=practiceBuilder&mode=source')
        self.assertEqual(status, 302)
        self.assertEqual(headers['Location'], '/sat/html/index.html?view=practiceBuilder&mode=source')

    def test_sat_uses_separate_adapter_without_changing_source(self):
        path = self.root / 'apps/sat/html/index.html'
        before = path.read_bytes()
        status, body, _ = self.request('/sat/html/index.html')
        self.assertEqual(status, 200)
        self.assertIn(b'<script src="/web/sat-bridge.js"></script>', body)
        self.assertNotIn(b'style=', body)
        self.assertEqual(path.read_bytes(), before)

    def test_toefl_routes_only_anonymous_preview_and_keeps_source(self):
        path = self.root / 'apps/toefl/dist/preview/index.html'
        before = path.read_bytes()
        status, body, _ = self.request('/toefl/?section=reading')
        self.assertEqual(status, 200)
        self.assertIn(b'<script src="/web/toefl-bridge.js"></script>', body)
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(self.request('/toefl/audio/fixture-tone.wav')[0], 200)
        status, _, headers = self.request('/toefl?view=plan')
        self.assertEqual((status, headers['Location']), (302, '/toefl/?view=plan'))
        preview = json.loads(self.request('/api/toefl/status')[1])
        self.assertEqual(preview['contentMode'], 'anonymous-fixture')
        self.assertEqual(preview['questionCount'], 1)
        toefl = next(e for e in json.loads(self.request('/api/platform/catalog')[1])['exams'] if e['id'] == 'toefl')
        self.assertTrue(toefl['available'])
        self.assertEqual(toefl['questionCount'], 0)
        self.assertTrue(toefl['preview']['available'])

    def test_unbuilt_toefl_remains_unavailable(self):
        with tempfile.TemporaryDirectory() as directory:
            server = create_server(directory, 0)
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            try:
                connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=5)
                connection.request('GET', '/toefl/')
                response = connection.getresponse()
                self.assertEqual(response.status, 503)
                response.read()
                connection.close()
            finally:
                server.shutdown()
                server.server_close()
                worker.join()


if __name__ == '__main__':
    unittest.main()
