"""Synthetic-only shared AP integrity and reproducible preparation fixtures."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from shared.ap_shared import (SHARED_AP, MANIFEST, canonical_bytes, load_shared_ap,
                              safe_path)
from tools.ap.publish_shared import prepare_shared
from test_ap_schema import example_set

PDF = b'%PDF-1.4\nOriginal synthetic AP document fixture.\n%%EOF\n'


def fixture_set():
    doc = example_set(True)
    doc['documents'][0]['asset'] = 'question-assets/ap/' + hashlib.sha256(PDF).hexdigest() + '.pdf'
    doc['revision'] = hashlib.sha256(canonical_bytes({k: v for k, v in doc.items() if k != 'revision'})).hexdigest()
    return doc


def write_shared(root, document=None):
    document = document or fixture_set()
    base = root / SHARED_AP
    (base / 'sets').mkdir(parents=True, exist_ok=True)
    (base / 'assets').mkdir(exist_ok=True)
    (base / 'sets' / (document['id'][3:] + '.json')).write_bytes(canonical_bytes(document))
    (base / 'assets' / (hashlib.sha256(PDF).hexdigest() + '.pdf')).write_bytes(PDF)
    refresh_manifest(root)
    return document


def refresh_manifest(root):
    base = root / SHARED_AP
    entries = []
    for path in sorted([*base.glob('sets/*.json'), *base.glob('assets/*.pdf')]):
        payload = path.read_bytes()
        entries.append({'path': path.relative_to(base).as_posix(), 'bytes': len(payload),
                        'sha256': hashlib.sha256(payload).hexdigest()})
    (base / MANIFEST).write_bytes(canonical_bytes({'schemaVersion': 1, 'files': entries}))


class SharedAPTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.doc = write_shared(self.root)
        self.base = self.root / SHARED_AP
        self.manifest = self.base / MANIFEST
        self.set_path = next((self.base / 'sets').glob('*.json'))
        self.pdf = next((self.base / 'assets').glob('*.pdf'))

    def test_valid_counts_and_tracked_contract(self):
        loaded = load_shared_ap(self.root)
        self.assertEqual(loaded['sets'], [self.doc])
        self.assertEqual(loaded['counts']['sets'], 1)
        self.assertEqual(loaded['counts']['pdfs'], 1)
        self.assertEqual(loaded['counts']['questions'], 1)
        tracked = {f'{SHARED_AP}/{entry["path"]}' for entry in loaded['files']}
        with self.assertRaises(ValueError):
            load_shared_ap(self.root, tracked)
        tracked.add(f'{SHARED_AP}/{MANIFEST}')
        self.assertEqual(load_shared_ap(self.root, tracked), loaded)
        tracked.remove(f'{SHARED_AP}/{loaded["files"][0]["path"]}')
        with self.assertRaises(ValueError):
            load_shared_ap(self.root, tracked)

    def test_manifest_required_and_duplicate_keys_rejected(self):
        self.manifest.unlink()
        with self.assertRaises(OSError):
            load_shared_ap(self.root)
        self.manifest.write_text('{"schemaVersion":1,"schemaVersion":1,"files":[]}')
        with self.assertRaises(ValueError):
            load_shared_ap(self.root)

    def test_unknown_files_directories_and_fields(self):
        extra = self.base / '.DS_Store'
        extra.write_bytes(b'private sentinel')
        with self.assertRaises(ValueError):
            load_shared_ap(self.root)
        extra.unlink()
        extra.mkdir()
        with self.assertRaises(ValueError):
            load_shared_ap(self.root)
        extra.rmdir()
        manifest = json.loads(self.manifest.read_text())
        manifest['personalSourcePath'] = 'sentinel'
        self.manifest.write_text(json.dumps(manifest))
        with self.assertRaises(ValueError):
            load_shared_ap(self.root)

    def test_corrupt_bytes_and_sizes_rejected(self):
        before = self.pdf.read_bytes()
        self.pdf.write_bytes(before + b'corruption')
        with self.assertRaises(ValueError):
            load_shared_ap(self.root)
        self.pdf.write_bytes(before)
        manifest = json.loads(self.manifest.read_text())
        manifest['files'][0]['bytes'] += 1
        self.manifest.write_text(json.dumps(manifest))
        with self.assertRaises(ValueError):
            load_shared_ap(self.root)

    def test_pdf_header_hash_filename_and_references(self):
        self.pdf.write_bytes(b'not a pdf')
        refresh_manifest(self.root)
        with self.assertRaises(ValueError):
            load_shared_ap(self.root)
        self.pdf.write_bytes(PDF + b'changed')
        refresh_manifest(self.root)
        with self.assertRaises(ValueError):
            load_shared_ap(self.root)
        self.pdf.write_bytes(PDF)
        extra = b'%PDF-unused'
        (self.pdf.parent / (hashlib.sha256(extra).hexdigest() + '.pdf')).write_bytes(extra)
        refresh_manifest(self.root)
        with self.assertRaises(ValueError):
            load_shared_ap(self.root)

    def test_duplicate_ids_and_personal_fields(self):
        duplicate = self.set_path.with_name('duplicate.json')
        duplicate.write_bytes(self.set_path.read_bytes())
        refresh_manifest(self.root)
        with self.assertRaises(ValueError):
            load_shared_ap(self.root)
        duplicate.unlink()
        doc = copy.deepcopy(self.doc)
        doc['selectedAnswer'] = 'personal sentinel'
        self.set_path.write_bytes(canonical_bytes(doc))
        refresh_manifest(self.root)
        with self.assertRaises(ValueError):
            load_shared_ap(self.root)

    def test_rehashed_manifest_does_not_allow_stale_revision_or_synthetic_sets(self):
        doc = copy.deepcopy(self.doc)
        doc['title'] = 'Changed content retaining old revision'
        self.set_path.write_bytes(canonical_bytes(doc))
        refresh_manifest(self.root)
        with self.assertRaises(ValueError):
            load_shared_ap(self.root)
        doc = copy.deepcopy(self.doc)
        doc['revision'] = 'f' * 64
        self.set_path.write_bytes(canonical_bytes(doc))
        refresh_manifest(self.root)
        with self.assertRaises(ValueError):
            load_shared_ap(self.root)
        doc['contentMode'] = 'synthetic'
        doc['revision'] = hashlib.sha256(canonical_bytes({k: v for k, v in doc.items() if k != 'revision'})).hexdigest()
        self.set_path.write_bytes(canonical_bytes(doc))
        refresh_manifest(self.root)
        with self.assertRaises(ValueError):
            load_shared_ap(self.root)

    def test_unsafe_manifest_paths(self):
        original = self.manifest.read_bytes()
        for name in ('../secret.json', 'sets/../secret.json', 'sets\\test.json',
                     'C:/secret.json', '/absolute.json', 'sets/test.json:stream', 'sets/.hidden.json'):
            manifest = json.loads(original)
            manifest['files'][0]['path'] = name
            self.manifest.write_text(json.dumps(manifest))
            with self.subTest(name=name), self.assertRaises(ValueError):
                load_shared_ap(self.root)

    def test_symlink_file_rejected(self):
        outside = self.root / 'outside.pdf'
        outside.write_bytes(PDF)
        self.pdf.unlink()
        try:
            self.pdf.symlink_to(outside)
        except OSError:
            self.skipTest('Symlink privileges unavailable.')
        with self.assertRaises(ValueError):
            load_shared_ap(self.root)


class PrepareSharedTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        base = Path(self.temporary.name)
        self.source, self.repo = base / 'private', base / 'repo'
        self.doc = fixture_set()
        digest = hashlib.sha256(PDF).hexdigest()
        self.bank = self.source / 'question-banks/ap' / (self.doc['id'][3:] + '.json')
        self.bank.parent.mkdir(parents=True)
        self.bank.write_bytes(canonical_bytes(self.doc))
        self.pdf = self.source / self.doc['documents'][0]['asset']
        self.pdf.parent.mkdir(parents=True)
        self.pdf.write_bytes(PDF)
        manifest = {'importerVersion': 1, 'sets': [{'id': self.doc['id'], 'revision': self.doc['revision']}],
                    'assets': [digest], 'sourceManifest': {'sources': [{'sha256': digest, 'sourceKeyHash': 'a'*64}]}}
        self.manifest = self.source / 'ap-import-manifest.json'
        self.manifest.write_bytes(canonical_bytes(manifest))
        (self.source / 'accounts.sqlite').write_bytes(b'PERSONAL ACCOUNT SENTINEL')
        (self.bank.parent / 'unreferenced.json').write_bytes(b'PERSONAL ANSWER SENTINEL')
        (self.source / 'ap-import-report.json').write_bytes(b'PERSONAL REPORT SENTINEL')

    def test_reproducible_only_manifest_referenced_bytes(self):
        result = prepare_shared(self.source, self.repo)
        self.assertEqual(result['written'], 3)
        before = {p: (p.read_bytes(), p.stat().st_mtime_ns) for p in (self.repo / SHARED_AP).rglob('*') if p.is_file()}
        self.assertEqual(prepare_shared(self.source, self.repo)['written'], 0)
        self.assertEqual(before, {p: (p.read_bytes(), p.stat().st_mtime_ns) for p in before})
        self.assertEqual((self.repo / SHARED_AP / 'sets' / self.bank.name).read_bytes(), self.bank.read_bytes())
        self.assertNotIn(b'PERSONAL', b''.join(p.read_bytes() for p in before))

    def test_source_tampering_fails_before_output(self):
        self.doc['title'] = 'Modified without revision update'
        self.bank.write_bytes(canonical_bytes(self.doc))
        with self.assertRaises(ValueError):
            prepare_shared(self.source, self.repo)
        self.assertFalse(self.repo.exists())

    def test_pdf_corruption_and_destination_conflict(self):
        self.pdf.write_bytes(PDF + b'corruption')
        with self.assertRaises(ValueError):
            prepare_shared(self.source, self.repo)
        self.assertFalse(self.repo.exists())
        self.pdf.write_bytes(PDF)
        prepare_shared(self.source, self.repo)
        target = self.repo / SHARED_AP / 'sets' / self.bank.name
        target.write_bytes(b'preserve existing changes')
        with self.assertRaises(ValueError):
            prepare_shared(self.source, self.repo)
        self.assertEqual(target.read_bytes(), b'preserve existing changes')


if __name__ == '__main__':
    unittest.main()
