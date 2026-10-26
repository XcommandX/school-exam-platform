"""Loopback AP routing, PDF ranges, isolation and content-only API tests."""
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.serve_platform import AP_PUBLIC_FILES, create_server
from test_ap_schema import example_set


class APServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temporary.name)
        cls.ap = cls.root / 'front-end/ap'
        cls.ap.mkdir(parents=True)
        for name in AP_PUBLIC_FILES:
            (cls.ap / name).write_text('Original test app', encoding='utf-8')
        (cls.ap / 'examples').mkdir()
        (cls.ap / 'examples/synthetic-practice.json').write_text(json.dumps(example_set()), encoding='utf-8')
        (cls.ap / 'README.md').write_text('Private documentation sentinel')
        cls.server = create_server(cls.root, 0)
        cls.user = cls.server.auth.store.create_user('ap-fixture-student', 'original-fixture-password')
        token, _ = cls.server.auth.store.login('ap-fixture-student', 'original-fixture-password')
        cls.cookie = 'study_session=' + token
        (cls.ap / 'index.html').write_text('<html><head></head><body>AP fixture</body></html>', encoding='utf-8')
        cls.port = cls.server.server_port
        cls.worker = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.worker.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.worker.join()
        cls.temporary.cleanup()

    def setUp(self):
        self.bank = self.root / 'local-data/question-banks/ap/test.json'
        self.doc = example_set(True)
        self.bank.write_text(json.dumps(self.doc), encoding='utf-8')
        self.asset = self.root / 'local-data' / self.doc['documents'][0]['asset']
        self.asset.parent.mkdir(parents=True, exist_ok=True)
        # A byte fixture for HTTP range semantics, not a real exam document.
        self.asset.write_bytes(b'%PDF-1.4\nOriginal synthetic range-test bytes.\n%%EOF')
        self.asset_route = '/' + self.doc['documents'][0]['asset']

    def tearDown(self):
        self.bank.unlink(missing_ok=True)
        self.asset.unlink(missing_ok=True)

    def request(self, route, method='GET', headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        connection.request(method, route, headers={'Cookie': self.cookie, **(headers or {})})
        response = connection.getresponse()
        result = response.status, response.read(), dict(response.getheaders())
        connection.close()
        return result

    def test_ap_requires_unified_session(self):
        for route in ('/ap', '/ap/', '/ap/index.html'):
            status, body, headers = self.request(route, headers={'Cookie': ''})
            self.assertEqual(status, 302)
            self.assertTrue(headers['Location'].startswith('/login?next='))
        for route in ('/api/ap/example', '/api/exams/ap/sources', '/api/exams/ap/sources/ap:test-original'):
            self.assertEqual(self.request(route, headers={'Cookie': ''})[0], 401)
        for route in ('/ap/app.js', self.asset_route):
            self.assertEqual(self.request(route, headers={'Cookie': ''})[0], 404)
        self.assertEqual(self.request(self.asset_route, method='HEAD', headers={'Cookie': ''})[:2], (404, b''))
        html = self.request('/ap/')[1].decode()
        self.assertIn('window.PlatformSession=', html)
        self.assertIn(self.user['id'], html)
        self.assertIn('/web/platform-auth.js', html)

    def test_routes_example_and_v2_source(self):
        self.assertEqual(self.request('/ap/')[0], 200)
        self.assertEqual(self.request('/ap?view=history')[2]['Location'], '/ap/?view=history')
        for name in AP_PUBLIC_FILES:
            self.assertEqual(self.request('/ap/' + name)[0], 200)
        example = json.loads(self.request('/api/ap/example')[1])
        self.assertEqual(example['contentMode'], 'synthetic')
        listing = json.loads(self.request('/api/exams/ap/sources')[1])
        self.assertEqual(listing['schemaVersion'], 2)
        self.assertEqual(listing['sources'][0]['questionCount'], 1)
        self.assertEqual(listing['sources'][0]['documentCount'], 1)
        source = json.loads(self.request('/api/exams/ap/sources/ap%3Atest-original')[1])
        self.assertEqual(source, self.doc)
        catalog = json.loads(self.request('/api/platform/catalog')[1])
        ap = next(exam for exam in catalog['exams'] if exam['id'] == 'ap')
        self.assertTrue(ap['available'])
        self.assertEqual(ap['questionCount'], 1)
        self.assertEqual(json.loads(self.request('/api/question-bank')[1])['files'], [])

    def test_only_referenced_pdf_assets_and_public_app_files(self):
        for route in ('/ap/README.md', '/ap/examples/synthetic-practice.json',
                      '/ap/%2e%2e/web/app.js', '/question-assets/sat/test.pdf',
                      '/local-data/' + self.doc['documents'][0]['asset'],
                      '/question-assets/ap/' + 'c' * 64 + '.pdf',
                      '/question-assets/ap/../test.pdf',
                      '/question-assets/ap/%2e%2e/test.pdf'):
            with self.subTest(route=route):
                self.assertEqual(self.request(route)[0], 404)
        self.assertEqual(self.request('/api/exams/sat/sources/ap:test-original')[0], 404)
        self.assertEqual(self.request(self.asset_route, headers={'Host': 'example.com'})[0], 403)

    def test_pdf_full_partial_suffix_head_and_invalid_ranges(self):
        expected = self.asset.read_bytes()
        status, body, headers = self.request(self.asset_route)
        self.assertEqual((status, body), (200, expected))
        self.assertEqual(headers['Content-Type'], 'application/pdf')
        self.assertEqual(headers['Cache-Control'], 'private, no-store')
        status, body, headers = self.request(self.asset_route, headers={'Range': 'bytes=0-4'})
        self.assertEqual((status, body), (206, b'%PDF-'))
        self.assertEqual(headers['Content-Range'], f'bytes 0-4/{len(expected)}')
        self.assertEqual(self.request(self.asset_route, headers={'Range': 'bytes=-5'})[1], expected[-5:])
        self.assertEqual(self.request(self.asset_route, headers={'Range': 'bytes=5-'})[1], expected[5:])
        self.assertEqual(self.request(self.asset_route, method='HEAD')[:2], (200, b''))
        for value in ('bytes=9999-', 'bytes=5-2', 'bytes=-0', 'bytes=0-1,4-5', 'bytes=-', 'bytes=' + '9' * 5000 + '-', 'nonsense'):
            with self.subTest(value=value):
                self.assertEqual(self.request(self.asset_route, headers={'Range': value})[0], 416)

    def test_changed_manifest_invalidates_cache_and_rejects_personal_fields(self):
        self.request('/api/exams/ap/sources')
        self.doc['questions'][0]['selectedAnswer'] = 0
        self.bank.write_text(json.dumps(self.doc), encoding='utf-8')
        listing = json.loads(self.request('/api/exams/ap/sources')[1])
        self.assertEqual(listing['sources'], [])
        self.assertTrue(listing['errors'])
        self.assertEqual(self.request(self.asset_route)[0], 404)

    def test_duplicate_ap_source_ids_are_reported(self):
        duplicate = self.bank.with_name('zzz-duplicate.json')
        duplicate.write_text(json.dumps(self.doc), encoding='utf-8')
        try:
            listing = json.loads(self.request('/api/exams/ap/sources')[1])
            self.assertEqual(len(listing['sources']), 1)
            self.assertEqual(len(listing['errors']), 1)
            self.assertIn('Duplicate', listing['errors'][0]['error'])
        finally:
            duplicate.unlink(missing_ok=True)

    def test_invalid_example_never_exposes_private_source(self):
        path = self.ap / 'examples/synthetic-practice.json'
        before = path.read_bytes()
        try:
            path.write_text(json.dumps(self.doc), encoding='utf-8')
            self.assertEqual(self.request('/api/ap/example')[0], 503)
        finally:
            path.write_bytes(before)

    def test_invalid_pdf_and_missing_manifest(self):
        self.asset.write_bytes(b'<script>not a PDF</script>')
        self.assertEqual(self.request(self.asset_route)[0], 404)
        self.asset.write_bytes(b'%PDF-original')
        self.bank.unlink()
        self.assertEqual(self.request(self.asset_route)[0], 404)

    def test_symlink_asset_never_served(self):
        original = self.asset.read_bytes()
        target = self.root / 'outside.pdf'
        target.write_bytes(original)
        self.asset.unlink()
        try:
            self.asset.symlink_to(target)
        except OSError:
            self.skipTest('Symlink privileges are not available on this host.')
        self.assertEqual(self.request(self.asset_route)[0], 404)


if __name__ == '__main__':
    unittest.main()
