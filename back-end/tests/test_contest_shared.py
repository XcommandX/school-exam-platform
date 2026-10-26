import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'back-end'))
from shared.contest_bank import canonical_bytes, normalize_exam
from shared.contest_shared import SharedContestStore, validate_shared


class SharedContestTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name)
        self.root = self.repo / 'back-end/question-banks/contests'
        self.root.mkdir(parents=True)
        raw = json.loads((ROOT / 'front-end/contests/examples/amc10.json').read_text(encoding='utf-8'))
        summary, document = normalize_exam(raw['exam'], raw['problems'])
        self.eid = summary['id']
        payloads = {'exams/' + self.eid + '.json': canonical_bytes(document), 'catalog.json': canonical_bytes({'exams': [summary]})}
        bank = {'schemaVersion': 1, 'exams': [summary], 'assets': {}, 'files': {n: hashlib.sha256(b).hexdigest() for n, b in payloads.items()}}
        payloads['bank-manifest.json'] = canonical_bytes(bank)
        self.resource = {'schemaVersion': 1, 'kind': 'contest-shared-bank', 'revision': hashlib.sha256(payloads['bank-manifest.json']).hexdigest(), 'files': []}
        for name, body in payloads.items():
            p = self.root / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(body)
            self.resource['files'].append({'path': name, 'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()})
        self.save()

    def save(self):
        (self.root / 'RESOURCE_MANIFEST.json').write_bytes(canonical_bytes(self.resource))

    def test_native_adapter_and_revision(self):
        resource, bank = validate_shared(self.root)
        store = SharedContestStore(self.repo)
        self.assertEqual(store.catalog()['totalProblems'], bank['exams'][0]['problem_count'])
        self.assertEqual(store.exam(self.eid)['id'], self.eid)
        self.assertFalse(store.mathjax_available())

    def test_vendor_reads_remain_bound_to_initial_verified_hashes(self):
        from shared.contest_bank import MATHJAX_VERSION, MATHJAX_INTEGRITY
        payloads = {'LICENSE': b'synthetic license', 'es5/tex-svg.js': b'/* synthetic renderer */',
                    'es5/ui/safe.js': b'/* synthetic safe */'}
        manifest = {'version': MATHJAX_VERSION, 'integrity': MATHJAX_INTEGRITY,
                    'files': {name: hashlib.sha256(body).hexdigest() for name, body in payloads.items()}}
        payloads['manifest.json'] = canonical_bytes(manifest)
        for name, body in payloads.items():
            relative = 'vendor/mathjax/' + name
            target = self.root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(body)
            self.resource['files'].append({'path': relative, 'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()})
        self.save()
        store = SharedContestStore(self.repo)
        self.assertTrue(store.mathjax_available())
        self.assertIsNone(store.vendor('es5/input/tex/extensions/require.js'))
        changed = b'/* altered after startup */'
        (self.root / 'vendor/mathjax/es5/tex-svg.js').write_bytes(changed)
        manifest['files']['es5/tex-svg.js'] = hashlib.sha256(changed).hexdigest()
        (self.root / 'vendor/mathjax/manifest.json').write_bytes(canonical_bytes(manifest))
        with self.assertRaisesRegex(ValueError, 'MathJax changed'): store.vendor('es5/tex-svg.js')
        self.assertFalse(store.mathjax_available())

    def test_missing_tracking_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Git-tracked'): validate_shared(self.root, set())

    def test_tamper_rejected(self):
        (self.root / 'catalog.json').write_text('{}')
        with self.assertRaisesRegex(ValueError, 'hash/size'): validate_shared(self.root)

    def test_unlisted_personal_file_never_returned(self):
        (self.root / 'student.sqlite').write_bytes(b'PRIVATE')
        resource, _ = validate_shared(self.root)
        self.assertNotIn('student.sqlite', [e['path'] for e in resource['files']])

    def test_listed_private_or_traversal_rejected(self):
        for name in ['student.sqlite', '../secret.json', 'assets/../../secret.png']:
            with self.subTest(name=name):
                self.resource['files'].append({'path': name, 'bytes': 0, 'sha256': '0'*64})
                self.save()
                with self.assertRaises(ValueError): validate_shared(self.root)
                self.resource['files'].pop()

    def test_export_shared_and_original_examples_separately(self):
        for name in ['amc10.json', 'amc12.json', 'aime.json', 'usamo.json']:
            target = self.repo / 'front-end/contests/examples' / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((ROOT / 'front-end/contests/examples' / name).read_bytes())
        output = self.repo / 'local-data/builds/cloudflare/.catalog-stage'
        output.mkdir(parents=True)
        tracked = output / 'git-tracked.txt'
        tracked.write_text('\0'.join(p.relative_to(self.repo).as_posix() for p in self.repo.rglob('*') if p.is_file()), encoding='utf-8')
        spec = importlib.util.spec_from_file_location('contest_export_test', ROOT / 'back-end/cloudflare/scripts/export_contests.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        result = module.export_contests(self.repo, output, tracked)
        self.assertEqual(result['counts']['privateExams'], 1)
        self.assertEqual(result['counts']['exampleExams'], 4)
        self.assertIn('/api/contests/exams/' + self.eid, result['routes'])
        self.assertEqual(result['media'], [])

if __name__ == '__main__': unittest.main()
