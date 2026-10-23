"""Source-only exports include reviewed fonts while excluding all local data."""
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SAT = ROOT / 'apps/sat'
SPEC = importlib.util.spec_from_file_location('sat_source_exporter', SAT / 'scripts/prepare_sat_source.py')
EXPORTER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(EXPORTER)


class SatSourceExportTests(unittest.TestCase):
    def test_export_contains_exact_allowlist_all_new_modules_and_verified_font_bytes(self):
        with tempfile.TemporaryDirectory(prefix='sat-export-test-') as temporary:
            output = Path(temporary).resolve() / 'source-only'
            count = EXPORTER.prepare(SAT, output)
            files = {p.relative_to(output).as_posix() for p in output.rglob('*') if p.is_file()}
            expected = set(EXPORTER.COPY_FILES) | set(EXPORTER.GENERATED_FILES) | {EXPORTER.MANIFEST}
            self.assertEqual(files, expected)
            self.assertEqual(count, len(expected))
            for name in ('js/sat-pack.js', 'js/sat-session.js', 'js/math-tools.js', 'js/content-renderer.js',
                         'css/exam-math.css', 'css/math-tools.css', 'css/content-renderer.css',
                         'vendor/katex/katex.min.js', 'vendor/katex/katex.min.css', 'vendor/marked/marked.umd.js',
                         'vendor/dompurify/purify.min.js'):
                self.assertIn(name, files)
            manifest = json.loads((output / EXPORTER.MANIFEST).read_text())
            self.assertEqual(len(manifest['files']), count - 1)
            for entry in manifest['files']:
                self.assertEqual(hashlib.sha256((output / entry['path']).read_bytes()).hexdigest(), entry['sha256'])
            self.assertEqual(len(EXPORTER.BINARY_SOURCE_FILES), 60)
            for name in EXPORTER.BINARY_SOURCE_FILES:
                self.assertEqual((output / name).read_bytes(), (SAT / name).read_bytes())
            self.assertIn('const questions = [];', (output / 'data/questions.js').read_text())
            self.assertEqual(len(json.loads((output / 'data/examples/synthetic-practice.json').read_text())['questions']), 2)
            self.assertFalse(any(part in {'private-data', 'question-bank', 'question-assets', 'backups', '.git', '.DS_Store'}
                                 for name in files for part in Path(name).parts))
            self.assertFalse(any(Path(name).suffix.lower() in {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.har', '.zip', '.sqlite', '.db'} for name in files))
            for name in files:
                if name.endswith('.json'):
                    value = (output / name).read_text()
                    self.assertNotIn('gengdu-2026', value)
                    self.assertNotIn('耕读合集', value)
            # All runtime script/style references and KaTeX font URLs survive.
            html = (output / 'html/index.html').read_text()
            for relative in re.findall(r'(?:src|href)="\.\./([^"]+)"', html):
                self.assertTrue((output / relative).is_file(), relative)
            css = (output / 'vendor/katex/katex.min.css').read_text()
            for relative in re.findall(r'url\(([^)]+)\)', css):
                self.assertTrue((output / 'vendor/katex' / relative.strip('"\'')).is_file(), relative)

    def test_binary_exception_never_applies_to_unlisted_fonts_or_code_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / 'content'
            source.write_bytes(b'\x00\x01\x00\x00' + b'font bytes' * 3)
            known = next(name for name in EXPORTER.BINARY_SOURCE_FILES if name.endswith('.ttf'))
            EXPORTER.validate_source_file(known, source)
            for name in ('js/app.js', 'vendor/katex/fonts/unreviewed.ttf', 'private-data/question-bank.ttf'):
                with self.subTest(name=name), self.assertRaises((UnicodeError, ValueError)):
                    EXPORTER.validate_source_file(name, source)
            source.write_bytes(b'not a font at all')
            with self.assertRaisesRegex(ValueError, 'invalid signature'):
                EXPORTER.validate_source_file(known, source)


if __name__ == '__main__':
    unittest.main()
