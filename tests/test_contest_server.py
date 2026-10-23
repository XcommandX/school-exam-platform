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

from scripts.import_contest_bank import import_bank
from scripts.serve_platform import CONTEST_PUBLIC_FILES, create_server
from shared.contest_bank import MATHJAX_INTEGRITY, MATHJAX_VERSION, canonical_bytes
from test_contest_import import write_source
from test_contest_schema import REPOSITORY, png


class ContestServerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / 'repo'; self.root.mkdir()
        self.private = self.root / 'private-data'
        subprocess.run(['git', 'init', '--quiet', str(self.root)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        (self.root / '.gitignore').write_text('private-data/\n')
        web = self.root / 'apps/contests'; web.mkdir(parents=True)
        for name in CONTEST_PUBLIC_FILES:
            (web / name).write_text('<!doctype html><title>Original example</title>' if name == 'index.html' else '// fixture')
        shutil.copytree(REPOSITORY / 'apps/contests/examples', web / 'examples')
        (web / 'source.json').write_text('NEVER_SERVED')
        (self.root / '.env').write_text('NEVER_SERVED')
        self.server = create_server(self.root, 0, self.private)
        self.worker = threading.Thread(target=self.server.serve_forever, daemon=True); self.worker.start()

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.worker.join()
        self.temporary.cleanup()

    def request(self, route, headers=None, method='GET'):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        conn.request(method, route, headers=headers or {})
        response = conn.getresponse(); result = response.status, response.read(), dict(response.getheaders())
        conn.close(); return result

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
        for name in CONTEST_PUBLIC_FILES:
            self.assertEqual(self.request('/contests/' + name)[0], 200)
        for route in ('/contests/examples/amc10.json', '/contests/source.json', '/contests/../.env',
                      '/contests/%2e%2e/.env', '/contests/%252e%252e/.env', '/contests/%5c.env',
                      '/contest-assets/../.env', '/contest-assets/assets/%2e%2e/.env',
                      '/private-data/contests/current.json', '/.git/config', '/.env',
                      '/api/contests/exams/../catalog', '/api/contests/exams/a/b',
                      '/contest-vendor/mathjax/manifest.json', '/contest-vendor/mathjax/package.json',
                      '/contest-vendor/mathjax/es5/../manifest.json'):
            self.assertEqual(self.request(route)[0], 404, route)
        self.assertEqual(self.request('/api/contests/catalog', {'Host': 'attacker.invalid'})[0], 403)
        self.assertNotEqual(self.request('/api/contests/catalog', method='POST')[0], 200)

    def test_static_file_symlink_is_not_followed(self):
        target = self.root / 'apps/contests/model.js'; target.unlink()
        try:
            target.symlink_to(self.root / '.env')
        except (OSError, NotImplementedError):
            self.skipTest('Creating filesystem symlinks is unavailable on this host.')
        self.assertEqual(self.request('/contests/model.js')[0], 404)

    def test_vendor_requires_hash_allowlist_and_safe_plugin(self):
        base = self.private / 'contest-vendor/mathjax'
        (base / 'es5/ui').mkdir(parents=True)
        artifacts = {'es5/tex-svg.js': b'/* generated mock tex SVG */', 'es5/ui/safe.js': b'/* generated mock safe */'}
        for name, body in artifacts.items(): (base / name).write_bytes(body)
        (base / 'es5/not-allowed.js').write_text('NEVER_SERVED')
        manifest = {'version': MATHJAX_VERSION, 'integrity': MATHJAX_INTEGRITY,
                    'files': {name: hashlib.sha256(body).hexdigest() for name, body in artifacts.items()}}
        (base / 'manifest.json').write_bytes(canonical_bytes(manifest))
        self.assertTrue(json.loads(self.request('/api/contests/catalog')[1])['mathjaxAvailable'])
        self.assertEqual(self.request('/contest-vendor/mathjax/es5/tex-svg.js')[0], 200)
        self.assertEqual(self.request('/contest-vendor/mathjax/es5/ui/safe.js')[0], 200)
        self.assertEqual(self.request('/contest-vendor/mathjax/es5/not-allowed.js')[0], 404)
        (base / 'es5/ui/safe.js').write_text('modified')
        self.assertEqual(self.request('/contest-vendor/mathjax/es5/ui/safe.js')[0], 404)
        self.assertFalse(json.loads(self.request('/api/contests/catalog')[1])['mathjaxAvailable'])


if __name__ == '__main__':
    unittest.main()
