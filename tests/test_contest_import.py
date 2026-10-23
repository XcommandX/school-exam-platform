"""Importer/versioned-store regression checks with temporary Git worktrees only."""
import copy
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from scripts.import_contest_bank import import_bank
from shared.contest_bank import ContestStore, canonical_bytes, read_json
from test_contest_schema import fixture, png


def write_source(root, *, with_asset=True):
    data = fixture()
    if with_asset:
        body = png(); name = 'assets/generated-test.png'
        data['problems'][0]['assets'] = [{'local_path': name, 'sha256': hashlib.sha256(body).hexdigest(), 'bytes': len(body)}]
        data['problems'][0]['statement']['html'] += '<img src="' + name + '" alt="Generated test pixel">'
        (root / 'assets').mkdir(parents=True, exist_ok=True)
        (root / name).write_bytes(body)
        (root / 'assets/unreferenced.svg').write_text('<svg><script>not copied</script></svg>')
    rewrite_source(root, data)
    return data


def rewrite_source(root, data):
    (root / 'data/exams').mkdir(parents=True, exist_ok=True)
    exam = dict(data['exam'], problem_ids=[p['id'] for p in data['problems']],
                data_url='data/exams/' + data['exam']['id'] + '.json')
    (root / 'data/problems.json').write_bytes(canonical_bytes(data['problems']))
    (root / 'data/exams.json').write_bytes(canonical_bytes([exam]))
    (root / exam['data_url']).write_bytes(canonical_bytes(data['problems']))


class ContestImportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary.name)
        self.repo = self.base / 'repository'; self.repo.mkdir()
        self.source = self.base / 'source'; self.source.mkdir()
        subprocess.run(['git', 'init', '--quiet', str(self.repo)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        (self.repo / '.gitignore').write_text('private-data/\n', encoding='utf-8')
        self.destination = self.repo / 'private-data/contests'
        self.data = write_source(self.source)
        self.store = ContestStore(self.repo, self.repo / 'private-data')

    def tearDown(self):
        self.temporary.cleanup()

    def perform(self, **kwargs):
        return import_bank(self.source, self.destination, repository=self.repo, acknowledge_rights=True, **kwargs)

    def test_requires_rights_and_actual_git_ignore(self):
        with self.assertRaisesRegex(ValueError, 'acknowledge-rights'):
            import_bank(self.source, self.destination, repository=self.repo)
        with self.assertRaisesRegex(ValueError, 'Git-ignored'):
            import_bank(self.source, self.repo / 'public', repository=self.repo, acknowledge_rights=True)
        with self.assertRaisesRegex(ValueError, 'inside'):
            import_bank(self.source, self.base / 'outside', repository=self.repo, acknowledge_rights=True)
        self.assertFalse(self.destination.exists())

    def test_initial_import_is_private_idempotent_and_readonly_source(self):
        before = {str(p.relative_to(self.source)): p.read_bytes() for p in self.source.rglob('*') if p.is_file()}
        result = self.perform()
        self.assertEqual((result['status'], result['problems'], result['exams'], result['assets']), ('imported', 2, 1, 1))
        self.assertEqual(self.perform()['status'], 'unchanged')
        self.assertEqual(before, {str(p.relative_to(self.source)): p.read_bytes() for p in self.source.rglob('*') if p.is_file()})
        catalog = self.store.catalog()
        self.assertEqual(catalog['totalProblems'], 2)
        self.assertEqual(catalog['mode'], 'private')
        eid = self.data['exam']['id']; exam = self.store.exam(eid)
        self.assertEqual(exam['revision'], catalog['exams'][0]['revision'])
        self.assertEqual(exam['mode'], 'private')
        self.assertNotEqual(exam['revision'], self.store.catalog('example').get('revision'))
        self.assertEqual(self.store.asset('assets/generated-test.png')[0], png())
        self.assertIsNone(self.store.asset('assets/unreferenced.svg'))
        self.assertIsNone(self.store.exam('not-an-exam'))
        self.assertFalse((self.destination / 'versions' / result['version'] / 'assets/unreferenced.svg').exists())
        self.assertEqual(len(list((self.destination / 'versions').iterdir())), 1)
        self.assertFalse((self.destination / 'import.lock').exists())

    def test_replace_is_explicit_and_preserves_prior_version(self):
        first = self.perform(); pointer = (self.destination / 'current.json').read_bytes()
        self.data['problems'][0]['answer']['accepted'] = ['A']; rewrite_source(self.source, self.data)
        with self.assertRaisesRegex(ValueError, '--replace'): self.perform()
        self.assertEqual((self.destination / 'current.json').read_bytes(), pointer)
        result = self.perform(replace=True)
        self.assertEqual(result['status'], 'replaced')
        self.assertEqual(result['previousVersion'], first['version'])
        self.assertTrue((self.destination / 'versions' / first['version'] / 'manifest.json').is_file())
        self.assertNotEqual(result['version'], first['version'])
        self.assertEqual(self.store.exam(self.data['exam']['id'])['problems'][0]['answer']['accepted'], ['A'])

    def test_replacement_validation_error_keeps_previous_bank(self):
        first = self.perform(); pointer = (self.destination / 'current.json').read_bytes()
        self.data['problems'][0]['answer']['accepted'] = ['Z']; rewrite_source(self.source, self.data)
        with self.assertRaises(ValueError): self.perform(replace=True)
        self.assertEqual((self.destination / 'current.json').read_bytes(), pointer)
        self.assertEqual(read_json(self.destination / 'current.json')['version'], first['version'])
        self.assertEqual(self.store.catalog()['totalProblems'], 2)
        self.assertFalse((self.destination / 'import.lock').exists())

    def test_atomic_pointer_failure_keeps_prior_bank(self):
        first = self.perform(); pointer = (self.destination / 'current.json').read_bytes()
        self.data['problems'][0]['solutions'][0]['text_latex'] += ' Revised.'; rewrite_source(self.source, self.data)
        with patch('scripts.import_contest_bank.os.replace', side_effect=OSError('simulated pointer interruption')):
            with self.assertRaises(OSError): self.perform(replace=True)
        self.assertEqual((self.destination / 'current.json').read_bytes(), pointer)
        self.assertEqual(self.store.catalog()['exams'][0]['revision'], self.store.exam(self.data['exam']['id'])['revision'])
        self.assertEqual(self.perform(replace=True)['status'], 'replaced')
        self.assertTrue((self.destination / 'versions' / first['version']).exists())

    def test_corrupt_asset_and_source_disagreement_refused(self):
        (self.source / 'assets/generated-test.png').write_bytes(b'wrong hash')
        with self.assertRaisesRegex(ValueError, 'hash or size'): self.perform()
        self.assertFalse(self.destination.exists())
        write_source(self.source)
        rows = copy.deepcopy(self.data['problems']); rows[0]['statement']['text_latex'] += ' differs'
        (self.source / 'data/problems.json').write_bytes(canonical_bytes(rows))
        with self.assertRaisesRegex(ValueError, 'inconsistent'): self.perform()
        self.assertFalse(self.destination.exists())

    def test_unsafe_svg_rejected_even_with_matching_hash(self):
        body = b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
        (self.source / 'assets/evil.svg').write_bytes(body)
        p = self.data['problems'][0]
        p['statement']['html'] = '<p>Safe question</p><img src="assets/evil.svg">'
        p['assets'] = [{'local_path': 'assets/evil.svg', 'sha256': hashlib.sha256(body).hexdigest()}]
        rewrite_source(self.source, self.data)
        with self.assertRaisesRegex(ValueError, 'SVG'): self.perform()
        self.assertFalse(self.destination.exists())

    def test_force_tracked_private_destination_refused(self):
        self.destination.mkdir(parents=True)
        (self.destination / 'secret.json').write_text('{}')
        subprocess.run(['git', '-C', str(self.repo), 'add', '-f', '--', 'private-data/contests/secret.json'], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        with self.assertRaisesRegex(ValueError, 'tracked|Git-ignored'): self.perform()

    def test_git_negated_output_path_refused(self):
        (self.repo / '.gitignore').write_text('private-data/*\n!private-data/contests/\nprivate-data/contests/*\n!private-data/contests/current.json\n')
        # Even if a directory pattern appears ignored, the actual pointer must be.
        with self.assertRaisesRegex(ValueError, 'Git-ignored'): self.perform()

    def test_corrupted_private_payload_and_manifest_not_served(self):
        result = self.perform(); folder = self.destination / 'versions' / result['version']
        eid = self.data['exam']['id']; path = folder / 'exams' / (eid + '.json')
        path.write_bytes(path.read_bytes() + b' ')
        with self.assertRaisesRegex(ValueError, 'integrity'): self.store.exam(eid)
        with self.assertRaisesRegex(ValueError, 'hash'): self.perform()
        (folder / 'assets/generated-test.png').write_bytes(b'bad')
        with self.assertRaisesRegex(ValueError, 'integrity'): self.store.asset('assets/generated-test.png')
        (folder / 'manifest.json').write_bytes(b'{}')
        catalog = self.store.catalog()
        self.assertEqual(catalog['totalProblems'], 0)
        self.assertTrue(catalog['errors'])
        self.assertIsNone(self.store.exam('not-an-exam', 'example'))

    def test_symlink_input_asset_and_store_refused(self):
        target = self.source / 'assets/generated-test.png'
        external = self.base / 'external.png'; external.write_bytes(png())
        target.unlink()
        try:
            target.symlink_to(external)
        except (OSError, NotImplementedError):
            self.skipTest('Creating filesystem symlinks is unavailable on this host.')
        with self.assertRaisesRegex(ValueError, 'links'): self.perform()
        target.unlink(); target.write_bytes(png())
        self.destination.parent.mkdir()
        elsewhere = self.base / 'elsewhere'; elsewhere.mkdir()
        self.destination.symlink_to(elsewhere, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'links'): self.perform()
        self.assertTrue(self.store.catalog()['errors'])

    def test_existing_lock_refuses_concurrent_import(self):
        self.destination.mkdir(parents=True)
        (self.destination / 'import.lock').write_text('another importer')
        with self.assertRaises(FileExistsError): self.perform()
        self.assertEqual((self.destination / 'import.lock').read_text(), 'another importer')
        self.assertFalse((self.destination / 'current.json').exists())


if __name__ == '__main__':
    unittest.main()
