"""Source-only exports include reviewed fonts while excluding all local data."""
import hashlib
import http.client
import importlib.util
import json
from pathlib import Path
import re
import tempfile
import threading
import unittest
import _paths


ROOT = _paths.ROOT
SAT = ROOT / 'front-end/sat'
SPEC = importlib.util.spec_from_file_location('sat_source_exporter', ROOT / 'back-end/tools/sat/prepare_sat_source.py')
EXPORTER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(EXPORTER)


class SatSourceExportTests(unittest.TestCase):
    def test_export_contains_exact_allowlist_all_new_modules_and_verified_font_bytes(self):
        with tempfile.TemporaryDirectory(prefix='sat-export-test-') as temporary:
            output = Path(temporary).resolve() / 'source-only'
            count = EXPORTER.prepare(ROOT, output)
            files = {p.relative_to(output).as_posix() for p in output.rglob('*') if p.is_file()}
            expected = set(EXPORTER.COPY_FILES) | set(EXPORTER.GENERATED_FILES) | {EXPORTER.MANIFEST}
            self.assertEqual(files, expected)
            self.assertEqual(count, len(expected))
            for name in ('js/sat-pack.js', 'js/sat-session.js', 'js/math-tools.js', 'js/content-renderer.js',
                         'css/exam-math.css', 'css/math-tools.css', 'css/content-renderer.css',
                         'vendor/katex/katex.min.js', 'vendor/katex/katex.min.css', 'vendor/marked/marked.umd.js',
                         'vendor/dompurify/purify.min.js'):
                self.assertIn('front-end/sat/' + name, files)
            manifest = json.loads((output / EXPORTER.MANIFEST).read_text())
            self.assertEqual(len(manifest['files']), count - 1)
            for entry in manifest['files']:
                self.assertEqual(hashlib.sha256((output / entry['path']).read_bytes()).hexdigest(), entry['sha256'])
            self.assertEqual(len(EXPORTER.BINARY_SOURCE_FILES), 60)
            for name in EXPORTER.BINARY_SOURCE_FILES:
                self.assertEqual((output / name).read_bytes(), (ROOT / name).read_bytes())
            self.assertIn('const questions = [];', (output / 'front-end/sat/data/questions.js').read_text())
            self.assertEqual(len(json.loads((output / 'front-end/sat/data/examples/synthetic-practice.json').read_text())['questions']), 2)
            self.assertFalse(any(part in {'local-data', 'private-data', 'question-bank', 'question-assets', 'backups', '.git', '.DS_Store'}
                                 for name in files for part in Path(name).parts))
            self.assertFalse(any(Path(name).suffix.lower() in {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.har', '.zip', '.sqlite', '.db'} for name in files))
            for name in files:
                if name.endswith('.json'):
                    value = (output / name).read_text()
                    self.assertNotIn('gengdu-2026', value)
                    self.assertNotIn('耕读合集', value)
            # All runtime script/style references and KaTeX font URLs survive.
            html = (output / 'front-end/sat/html/index.html').read_text()
            for relative in re.findall(r'(?:src|href)="\.\./([^"]+)"', html):
                self.assertTrue((output / 'front-end/sat' / relative).is_file(), relative)
            css = (output / 'front-end/sat/vendor/katex/katex.min.css').read_text()
            for relative in re.findall(r'url\(([^)]+)\)', css):
                self.assertTrue((output / 'front-end/sat/vendor/katex' / relative.strip('"\'')).is_file(), relative)

    def test_binary_exception_never_applies_to_unlisted_fonts_or_code_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / 'content'
            source.write_bytes(b'\x00\x01\x00\x00' + b'font bytes' * 3)
            known = next(name for name in EXPORTER.BINARY_SOURCE_FILES if name.endswith('.ttf'))
            EXPORTER.validate_source_file(known, source)
            for name in ('front-end/sat/js/app.js', 'front-end/sat/vendor/katex/fonts/unreviewed.ttf', 'local-data/question-bank.ttf'):
                with self.subTest(name=name), self.assertRaises((UnicodeError, ValueError)):
                    EXPORTER.validate_source_file(name, source)
            source.write_bytes(b'not a font at all')
            with self.assertRaisesRegex(ValueError, 'invalid signature'):
                EXPORTER.validate_source_file(known, source)

    def test_exported_server_keeps_runtime_data_outside_frontend_and_serves_local_assets(self):
        with tempfile.TemporaryDirectory(prefix='sat-server-export-') as temporary:
            output = Path(temporary).resolve() / 'source-only'
            EXPORTER.prepare(ROOT, output)
            spec = importlib.util.spec_from_file_location('exported_standalone_server', output / 'back-end/tools/sat/question_bank_server.py')
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            self.assertEqual(module.FRONTEND_ROOT, output / 'front-end/sat')
            self.assertEqual(module.DATA_ROOT, output / 'local-data/standalone-sat')
            server = module.create_server(port=0)
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            def request(route, method='GET', body=None, headers=None):
                connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=5)
                connection.request(method, route, body, headers or {})
                response = connection.getresponse()
                result = response.status, response.read()
                connection.close()
                return result
            try:
                status, raw = request('/api/question-bank/status')
                self.assertEqual(status, 200)
                token = json.loads(raw)['token']
                sample = (output / 'front-end/sat/data/examples/synthetic-practice.json').read_text()
                origin = 'http://127.0.0.1:' + str(server.server_port)
                status, raw = request('/api/question-bank', 'POST', json.dumps({'name': 'original-synthetic.json', 'text': sample}),
                                      {'Origin': origin, 'X-SAT-Bank-Token': token, 'Content-Type': 'application/json'})
                self.assertEqual(status, 201)
                self.assertTrue((output / 'local-data/standalone-sat/question-bank/original-synthetic.json').is_file())
                self.assertFalse((output / 'front-end/sat/question-bank').exists())
                self.assertEqual(request('/html/index.html')[0], 200)
                self.assertEqual(request('/vendor/katex/katex.min.css')[0], 200)
                assets = output / 'local-data/standalone-sat/question-assets'
                assets.mkdir()
                (assets / 'original.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg"><circle cx="10" cy="10" r="5"/></svg>')
                self.assertEqual(request('/question-assets/original.svg')[0], 200)
                self.assertEqual(request('/question-assets/../question-bank/original-synthetic.json')[0], 404)
                self.assertEqual(request('/local-data/standalone-sat/question-bank/original-synthetic.json')[0], 404)
                self.assertEqual(request('/back-end/tools/sat/question_bank_server.py')[0], 404)
            finally:
                server.shutdown()
                server.server_close()
                worker.join()
            with self.assertRaisesRegex(ValueError, 'outside the static frontend'):
                module.create_server(data_root=module.FRONTEND_ROOT / 'question-bank')


if __name__ == '__main__':
    unittest.main()
