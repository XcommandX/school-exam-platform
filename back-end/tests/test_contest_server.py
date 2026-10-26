"""Loopback HTTP tests use only temporary stores and original fixture content."""
import hashlib
import http.client
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import unittest

import sys

REPOSITORY = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPOSITORY / 'back-end'))
TEST_ROOT = REPOSITORY / 'local-data/agent-output/contest-tests'
TEST_ROOT.mkdir(parents=True, exist_ok=True)


from tools.contests.import_contest_bank import import_bank
from server.serve_platform import CONTEST_PUBLIC_FILES, TOEFL_PUBLIC_FILES, create_server
from shared.contest_bank import MATHJAX_INTEGRITY, MATHJAX_VERSION, canonical_bytes
from test_contest_import import write_source
from test_contest_schema import png


class ContestServerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir=TEST_ROOT)
        self.root = Path(self.temporary.name) / 'repo'; self.root.mkdir()
        self.private = self.root / 'local-data'
        subprocess.run(['git', 'init', '--quiet', str(self.root)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        (self.root / '.gitignore').write_text('local-data/\n')
        web = self.root / 'front-end/contests'; web.mkdir(parents=True)
        for name in CONTEST_PUBLIC_FILES:
            (web / name).write_text('<!doctype html><html><head><title>Original example</title></head><body></body></html>' if name == 'index.html' else '// fixture')
        shutil.copytree(REPOSITORY / 'front-end/contests/examples', web / 'examples')
        (web / 'source.json').write_text('NEVER_SERVED')
        (self.root / '.env').write_text('NEVER_SERVED')
        sat = self.root / 'front-end/sat/html'; sat.mkdir(parents=True)
        (sat / 'index.html').write_text('<html><head></head><body>Synthetic SAT</body></html>')
        preview = self.private / 'builds/toefl/preview'; preview.mkdir(parents=True)
        for name in TOEFL_PUBLIC_FILES:
            path = preview / name; path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('<html><head></head><body>Synthetic TOEFL</body></html>' if name == 'index.html' else 'fixture')
        (preview.parent / 'build-info.json').write_text(json.dumps({
            'mode': 'local-anonymous-intake', 'productionCredentials': False,
            'productionData': False, 'deployable': False}))
        fixtures = self.root / 'back-end/toefl/fixtures'; fixtures.mkdir(parents=True)
        (fixtures / 'anonymous-bank.json').write_text(json.dumps({
            'fixture': True, 'records': [{'source': 'ANONYMOUS_FIXTURE', 'items': []}]}))
        self.server = create_server(self.root, 0, self.private)
        self.worker = threading.Thread(target=self.server.serve_forever, daemon=True); self.worker.start()
        self.user = self.server.auth.store.create_user('contest-fixture-student', 'fixture-password')
        self.cookie = ''
        status, body, headers = self.request('/api/auth/login', method='POST', body={
            'username': self.user['username'], 'password': 'fixture-password'}, authenticated=False)
        self.assertEqual(status, 200, body)
        self.cookie = headers['Set-Cookie'].split(';', 1)[0]

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.worker.join()
        self.temporary.cleanup()

    def request(self, route, headers=None, method='GET', *, body=None, authenticated=True):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        request_headers = {'Cookie': self.cookie} if authenticated else {}
        if body is not None:
            request_headers.update({'Content-Type': 'application/json',
                                    'Origin': f'http://127.0.0.1:{self.server.server_port}'})
        request_headers.update(headers or {})
        conn.request(method, route, body=json.dumps(body) if body is not None else None, headers=request_headers)
        response = conn.getresponse(); result = response.status, response.read(), dict(response.getheaders())
        conn.close(); return result

    def test_authentication_covers_api_pages_assets_and_vendor(self):
        source = self.root.parent / 'source'; source.mkdir()
        data = write_source(source)
        import_bank(source, repository=self.root, acknowledge_rights=True)
        self.install_vendor_fixture()
        routes = ['/api/contests/catalog', '/api/contests/catalog?mode=example',
                  '/api/contests/exams/' + data['exam']['id'],
                  '/api/contests/exams/' + data['exam']['id'] + '?mode=example',
                  '/contests/', '/contests/index.html', '/contests/timer.js',
                  '/contest-assets/assets/generated-test.png',
                  '/contest-vendor/mathjax/es5/tex-svg.js']
        for route in routes:
            with self.subTest(route=route):
                self.assertEqual(self.request(route)[0], 200)
                expected = 401 if route.startswith('/api/') else 302 if route in {'/contests/', '/contests/index.html'} else 404
                for headers in ({}, {'Cookie': 'study_session=invalid'}):
                    status, body, _ = self.request(route, headers, authenticated=False)
                    self.assertEqual(status, expected)
                    self.assertNotIn(b'generated-test', body)
        status, _, headers = self.request('/contests?mode=example', authenticated=False)
        self.assertEqual(status, 302)
        self.assertEqual(headers['Location'], '/login?next=%2Fcontests%3Fmode%3Dexample')

    def test_contest_bootstrap_is_bound_to_csp_nonce(self):
        import re
        status, body, headers = self.request('/contests/')
        self.assertEqual(status, 200)
        match = re.search(rb'<script nonce="([A-Za-z0-9_-]+)">window.PlatformSession=(.*?);</script>', body)
        self.assertIsNotNone(match)
        self.assertIn("'nonce-" + match[1].decode() + "'", headers['Content-Security-Policy'])
        self.assertEqual(json.loads(match[2])['user']['id'], self.user['id'])
        self.assertNotIn("script-src 'self' 'unsafe-inline'", headers['Content-Security-Policy'])

    def test_session_identity_and_revocation_apply_to_contests(self):
        session = json.loads(self.request('/api/auth/session')[1])
        self.assertTrue(session['authenticated'])
        self.assertEqual(session['user']['id'], self.user['id'])
        self.assertEqual(session['user']['role'], 'student')
        other = self.server.auth.store.create_user('contest-fixture-other', 'fixture-password')
        token, _ = self.server.auth.store.login(other['username'], 'fixture-password')
        other_session = json.loads(self.request('/api/auth/session', {'Cookie': 'study_session=' + token})[1])
        self.assertEqual(other_session['user']['id'], other['id'])
        self.assertNotEqual(other_session['user']['id'], session['user']['id'])
        # A later login revokes the old browser's cookie, including contest access.
        self.server.auth.store.login(self.user['username'], 'fixture-password')
        self.assertEqual(self.request('/api/contests/catalog')[0], 401)
        self.assertEqual(self.request('/contests/')[0], 302)
        self.assertEqual(self.request('/contests/timer.js')[0], 404)

    def test_sat_toefl_routes_and_admin_permissions_preserved(self):
        self.assertEqual(self.request('/sat/')[2]['Location'], '/sat/html/index.html')
        for route, marker in (('/sat/html/index.html', b'Synthetic SAT'), ('/toefl/', b'Synthetic TOEFL')):
            status, body, headers = self.request(route)
            # Latest main normalizes TOEFL paths to URL separators on Windows.
            self.assertEqual(status, 200)
            self.assertIn(marker, body)
            self.assertEqual(headers['Cache-Control'], 'no-store')
            self.assertNotIn('Content-Security-Policy', headers)
            self.assertEqual(self.request(route, authenticated=False)[0], 302)
        self.assertEqual(self.request('/api/sat-packs')[0], 200)
        self.assertEqual(self.request('/api/toefl/status')[0], 200)
        self.assertEqual(self.request('/api/admin/users')[0], 403)
        self.assertEqual(self.request('/api/question-bank', method='POST')[0], 403)

    def test_contest_endpoints_remain_read_only(self):
        status, body, _ = self.request('/api/question-bank/status')
        self.assertEqual(status, 200)
        headers = {'X-Account-ID': self.user['id'], 'X-SAT-Bank-Token': json.loads(body)['token']}
        for method in ('POST', 'PUT', 'PATCH', 'DELETE'):
            for route in ('/api/contests/catalog', '/api/contests/exams/example-amc10-2026'):
                with self.subTest(method=method, route=route):
                    self.assertIn(self.request(route, headers, method, body={})[0], (404, 405, 501))
        self.assertFalse((self.private / 'contests').exists())

    def test_empty_bank_is_never_implicit_example(self):
        status, body, headers = self.request('/api/contests/catalog')
        self.assertEqual(status, 200)
        catalog = json.loads(body)
        self.assertEqual((catalog['mode'], catalog['totalProblems'], catalog['exams'], catalog['errors']), ('private', 0, [], []))
        self.assertFalse(catalog['mathjaxAvailable'])
        self.assertEqual(headers['Cache-Control'], 'no-store')
        self.assertEqual(self.request('/api/contests/exams/example-amc10-2026')[0], 404)
        self.assertEqual(self.request('/api/contests/exams/not-present?mode=example')[0], 404)
        self.assertFalse((self.private / 'contests').exists())

    def test_explicit_examples_and_mode_validation(self):
        body = json.loads(self.request('/api/contests/catalog?mode=example')[1])
        self.assertEqual((body['mode'], body['totalProblems'], len(body['exams'])), ('example', 10, 4))
        for summary in body['exams']:
            status, raw, _ = self.request('/api/contests/exams/' + summary['id'] + '?mode=example')
            self.assertEqual(status, 200)
            document = json.loads(raw)
            self.assertEqual(document['revision'], summary['revision'])
            self.assertEqual(document['mode'], 'example')
        for query in ('?mode=all', '?mode=', '?mode=private&mode=example'):
            self.assertEqual(self.request('/api/contests/catalog' + query)[0], 400)

    def test_private_import_assets_allowlist_and_hot_revision(self):
        source = self.root.parent / 'source'; source.mkdir()
        data = write_source(source)
        result = import_bank(source, repository=self.root, acknowledge_rights=True)
        catalog = json.loads(self.request('/api/contests/catalog')[1])
        self.assertEqual(catalog['totalProblems'], 2)
        status, body, _ = self.request('/api/contests/exams/' + data['exam']['id'])
        self.assertEqual(status, 200)
        document = json.loads(body)
        self.assertEqual(document['mode'], 'private')
        self.assertIn('/contest-assets/assets/generated-test.png', document['problems'][0]['statement']['html'])
        status, body, headers = self.request('/contest-assets/assets/generated-test.png')
        self.assertEqual((status, body, headers['Content-Type']), (200, png(), 'image/png'))
        self.assertIn('sandbox', headers['Content-Security-Policy'])
        self.assertEqual(self.request('/contest-assets/assets/unreferenced.svg')[0], 404)
        version = self.private / 'contests/versions' / result['version']
        (version / 'assets/generated-test.png').write_bytes(b'changed')
        self.assertEqual(self.request('/contest-assets/assets/generated-test.png')[0], 404)
        example = json.loads(self.request('/api/contests/exams/' + data['exam']['id'] + '?mode=example')[1])
        self.assertNotEqual(example['revision'], document['revision'])
        self.assertEqual(json.loads(self.request('/api/contests/catalog?mode=example')[1])['totalProblems'], 10)

    def test_static_routes_traversal_host_and_post_guards(self):
        self.assertEqual(self.request('/contests')[0], 302)
        status, _, headers = self.request('/contests/')
        self.assertEqual(status, 200)
        self.assertIn("script-src 'self'", headers['Content-Security-Policy'])
        self.assertEqual(headers['Cache-Control'], 'no-store')
        self.assertIn('timer.js', CONTEST_PUBLIC_FILES)
        for name in CONTEST_PUBLIC_FILES:
            self.assertEqual(self.request('/contests/' + name)[0], 200)
        for route in ('/contests/examples/amc10.json', '/contests/source.json', '/contests/../.env',
                      '/contests/%2e%2e/.env', '/contests/%252e%252e/.env', '/contests/%5c.env',
                      '/contest-assets/../.env', '/contest-assets/assets/%2e%2e/.env',
                      '/local-data/contests/current.json', '/.git/config', '/.env',
                      '/api/contests/exams/../catalog', '/api/contests/exams/a/b',
                      '/contest-vendor/mathjax/manifest.json', '/contest-vendor/mathjax/package.json',
                      '/contest-vendor/mathjax/es5/../manifest.json'):
            self.assertEqual(self.request(route)[0], 404, route)
        self.assertEqual(self.request('/api/contests/catalog', {'Host': 'attacker.invalid'})[0], 403)
        self.assertNotEqual(self.request('/api/contests/catalog', method='POST')[0], 200)

    def test_static_file_symlink_is_not_followed(self):
        target = self.root / 'front-end/contests/model.js'; target.unlink()
        try:
            target.symlink_to(self.root / '.env')
        except (OSError, NotImplementedError):
            self.skipTest('Creating filesystem symlinks is unavailable on this host.')
        self.assertEqual(self.request('/contests/model.js')[0], 404)

    def install_vendor_fixture(self):
        base = self.private / 'contest-vendor/mathjax'
        (base / 'es5/ui').mkdir(parents=True)
        artifacts = {'es5/tex-svg.js': b'/* generated mock tex SVG */', 'es5/ui/safe.js': b'/* generated mock safe */'}
        for name, body in artifacts.items(): (base / name).write_bytes(body)
        (base / 'es5/not-allowed.js').write_text('NEVER_SERVED')
        manifest = {'version': MATHJAX_VERSION, 'integrity': MATHJAX_INTEGRITY,
                    'files': {name: hashlib.sha256(body).hexdigest() for name, body in artifacts.items()}}
        (base / 'manifest.json').write_bytes(canonical_bytes(manifest))
        return base

    def test_vendor_requires_hash_allowlist_and_safe_plugin(self):
        base = self.install_vendor_fixture()
        self.assertTrue(json.loads(self.request('/api/contests/catalog')[1])['mathjaxAvailable'])
        self.assertEqual(self.request('/contest-vendor/mathjax/es5/tex-svg.js')[0], 200)
        self.assertEqual(self.request('/contest-vendor/mathjax/es5/ui/safe.js')[0], 200)
        self.assertEqual(self.request('/contest-vendor/mathjax/es5/not-allowed.js')[0], 404)
        (base / 'es5/ui/safe.js').write_text('modified')
        self.assertEqual(self.request('/contest-vendor/mathjax/es5/ui/safe.js')[0], 404)
        self.assertFalse(json.loads(self.request('/api/contests/catalog')[1])['mathjaxAvailable'])


if __name__ == '__main__':
    unittest.main()
