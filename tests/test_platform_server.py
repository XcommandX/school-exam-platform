"""Integration checks use only generated questions and temporary private data."""
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest

from scripts.serve_platform import create_server
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

    def test_homepage_and_guest_session(self):
        self.assertEqual(self.request('/')[0], 200)
        status, body, _ = self.request('/api/auth/session')
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {'mode': 'guest', 'loginEnabled': False, 'user': None})

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
                      '/web/%2e%2e/%2e%2e/.env', '/sat/scripts/question_bank_server.py']:
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


if __name__ == '__main__':
    unittest.main()
