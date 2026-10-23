"""Local SAT package/backup routes, using only the committed synthetic packs."""
import base64
import hashlib
import http.client
import json
from pathlib import Path
import shutil
import tempfile
import threading
import unittest
from unittest.mock import patch

from scripts.serve_platform import create_server


DRAFTS = Path(__file__).resolve().parents[1] / 'docs/drafts/sat-question-packs'


class SatPackServerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.private = self.root / 'private-data'
        self.packs = self.private / 'sat-packs'
        self.collection = self.packs / 'synthetic-test'
        self.collection.mkdir(parents=True)
        self.server = create_server(self.root, 0)
        self.port = self.server.server_port
        self.worker = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.worker.start()
        self.addCleanup(self.cleanup)

    def cleanup(self):
        self.server.shutdown()
        self.server.server_close()
        self.worker.join()
        self.temporary.cleanup()

    def request(self, route, method='GET', body=None, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        connection.request(method, route, body=body, headers=headers or {})
        response = connection.getresponse()
        result = response.status, response.read(), dict(response.getheaders())
        connection.close()
        return result

    def activate(self):
        for name in ('rw-single-choice', 'math-single-choice', 'math-spr'):
            shutil.copytree(DRAFTS / name, self.collection / name)
        (self.collection / 'assessment.json').write_text(json.dumps({'title': 'Synthetic assessment', 'fullSAT': True, 'breakDurationSeconds': 600, 'modules': []}))
        (self.collection / 'conversion-report.json').write_text('{"notPublished":true}')
        (self.packs / 'active.json').write_text(json.dumps({'collectionId': 'synthetic-test', 'root': 'synthetic-test'}))

    def change(self, relative, mutation):
        path = self.collection / relative
        document = json.loads(path.read_text())
        mutation(document)
        path.write_text(json.dumps(document))

    def test_absent_active_collection_preserves_legacy_behavior(self):
        status, body, _ = self.request('/api/sat-packs')
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {'collectionId': None, 'packs': [], 'assessment': None})

    def test_declared_files_only_and_catalog_counts_include_active_packages(self):
        self.activate()
        (self.collection / 'private-student-notes.json').write_text('{"PRIVATE_SENTINEL":1}')
        status, body, _ = self.request('/api/sat-packs')
        self.assertEqual(status, 200)
        data = json.loads(body)
        self.assertEqual(data['collectionId'], 'synthetic-test')
        self.assertEqual(sum(p['questionCount'] for p in data['packs']), 5)
        self.assertEqual(len(data['packs']), 3)
        files = [f for p in data['packs'] for f in p['files']]
        self.assertEqual(len(files), 11)
        self.assertNotIn(b'PRIVATE_SENTINEL', body)
        self.assertNotIn(b'notPublished', body)
        images = [f for f in files if 'dataBase64' in f]
        self.assertEqual(len(images), 2)
        self.assertTrue(all(base64.b64decode(f['dataBase64']).startswith(b'<svg') for f in images))
        self.assertTrue(data['assessment']['fullSAT'])
        catalog = json.loads(self.request('/api/platform/catalog')[1])
        sat = next(e for e in catalog['exams'] if e['id'] == 'sat')
        self.assertEqual((sat['questionCount'], sat['sourceCount']), (5, 3))
        self.assertEqual(sat['sections'], ['Math', 'Reading and Writing'])

    def test_private_roots_and_undeclared_reports_are_never_static(self):
        self.activate()
        for route in ('/private-data/sat-packs/active.json', '/sat/sat-packs/active.json',
                      '/sat/private-data/sat-packs/active.json', '/sat/../private-data/sat-packs/active.json',
                      '/api/sat-packs/conversion-report.json', '/private-data/backups/synthetic-test/browser.json'):
            with self.subTest(route=route):
                self.assertEqual(self.request(route)[0], 404)
        self.assertEqual(self.request('/api/sat-packs', headers={'Host': 'external.invalid'})[0], 403)

    def test_path_traversal_and_symlink_collection_are_rejected(self):
        self.activate()
        for invalid in ('../outside', '/absolute', 'synthetic-test/../synthetic-test', 'synthetic-test%2f..'):
            (self.packs / 'active.json').write_text(json.dumps({'collectionId': 'synthetic-test', 'root': invalid}))
            self.assertEqual(self.request('/api/sat-packs')[0], 400)
        (self.packs / 'alias').symlink_to(self.collection, target_is_directory=True)
        (self.packs / 'active.json').write_text(json.dumps({'collectionId': 'synthetic-test', 'root': 'alias'}))
        self.assertEqual(self.request('/api/sat-packs')[0], 400)

    def test_resource_integrity_and_svg_active_content_are_rejected(self):
        self.activate()
        manifest = self.collection / 'math-single-choice/pack.json'
        original = manifest.read_text()
        for field, value in (('sha256', '0' * 64), ('byteLength', 1), ('path', '../secret.svg'), ('mediaType', 'image/png')):
            document = json.loads(original)
            document['assets'][0][field] = value
            manifest.write_text(json.dumps(document))
            self.assertEqual(self.request('/api/sat-packs')[0], 400)
        document = json.loads(original)
        malicious = b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
        (self.collection / 'math-single-choice/assets/line-graph.svg').write_bytes(malicious)
        document['assets'][0].update(byteLength=len(malicious), sha256=hashlib.sha256(malicious).hexdigest())
        manifest.write_text(json.dumps(document))
        status, body, _ = self.request('/api/sat-packs')
        self.assertEqual(status, 400)
        self.assertIn(b'SVG', body)

    def test_collection_transfer_limit_is_enforced(self):
        self.activate()
        with patch('scripts.serve_platform.MAX_PACK_BYTES', 200):
            status, body, _ = self.request('/api/sat-packs')
        self.assertEqual(status, 400)
        self.assertIn(b'transfer limit', body)

    def test_vendor_scripts_styles_and_fonts_load_but_private_formats_do_not(self):
        folder = self.root / 'apps/sat/vendor/example'
        folder.mkdir(parents=True)
        for name in ('render.js', 'render.css', 'font.woff2', 'font.woff', 'font.ttf', 'secret.json', 'source.py'):
            (folder / name).write_bytes(b'synthetic')
        for name in ('render.js', 'render.css', 'font.woff2', 'font.woff', 'font.ttf'):
            status, _, headers = self.request('/sat/vendor/example/' + name)
            self.assertEqual(status, 200)
            self.assertEqual(headers['X-Content-Type-Options'], 'nosniff')
        self.assertIn('font/woff2', self.request('/sat/vendor/example/font.woff2')[2]['Content-Type'])
        for name in ('secret.json', 'source.py'):
            self.assertEqual(self.request('/sat/vendor/example/' + name)[0], 404)

    def test_browser_backup_requires_token_origin_and_active_collection_and_is_durable(self):
        self.activate()
        snapshot = {'schemaVersion': 'sat-library-backup/1', 'targetCollectionId': 'synthetic-test',
                    'sources': [{'id': 'old-source'}], 'questions': [{'id': 'old-question'}],
                    'attempts': [{'id': 'history', 'answers': {'old-question': {'numericResponse': '2/3'}}}],
                    'wrongBook': [{'questionId': 'old-question'}], 'runtimeSnapshot': {'phase': 'section_break', 'breakEndTimestamp': 123456}}
        payload = json.dumps({'collectionId': 'synthetic-test', 'snapshot': snapshot})
        token = json.loads(self.request('/api/question-bank/status')[1])['token']
        headers = {'Content-Type': 'application/json', 'Origin': f'http://127.0.0.1:{self.port}', 'X-SAT-Bank-Token': token}
        self.assertEqual(self.request('/api/sat-library-backup', 'POST', payload, {**headers, 'Origin': 'https://external.invalid'})[0], 403)
        self.assertEqual(self.request('/api/sat-library-backup', 'POST', payload, {**headers, 'X-SAT-Bank-Token': 'bad'})[0], 403)
        self.assertFalse((self.private / 'backups').exists())
        status, body, _ = self.request('/api/sat-library-backup', 'POST', payload, headers)
        self.assertEqual(status, 201)
        result = json.loads(body)
        self.assertTrue(result['saved'])
        target = self.private / 'backups/synthetic-test' / result['name']
        self.assertEqual(json.loads(target.read_text()), snapshot)
        repeated = json.loads(self.request('/api/sat-library-backup', 'POST', payload, headers)[1])
        self.assertEqual(repeated['sha256'], result['sha256'])
        self.assertEqual(len(list(target.parent.glob('browser-*.json'))), 1)
        self.assertEqual(self.request('/private-data/backups/synthetic-test/' + target.name)[0], 404)
        invalid = json.dumps({'collectionId': '../escape', 'snapshot': snapshot})
        self.assertEqual(self.request('/api/sat-library-backup', 'POST', invalid, headers)[0], 400)
        (self.packs / 'active.json').write_text(json.dumps({'collectionId': 'another', 'root': 'synthetic-test'}))
        self.assertEqual(self.request('/api/sat-library-backup', 'POST', payload, headers)[0], 400)


if __name__ == '__main__':
    unittest.main()
