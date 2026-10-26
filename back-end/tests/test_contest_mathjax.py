"""Installer tests are offline and never treat fixture bytes as a real release."""
import base64
import hashlib
import io
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
import sys

REPOSITORY = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPOSITORY / 'back-end'))
TEST_ROOT = REPOSITORY / 'local-data/agent-output/contest-tests'
TEST_ROOT.mkdir(parents=True, exist_ok=True)


from unittest.mock import patch

from tools.contests import setup_contest_mathjax as installer


def generated_archive(extra=None):
    result = io.BytesIO()
    with tarfile.open(fileobj=result, mode='w:gz') as bundle:
        values = {'package/LICENSE': b'Original synthetic test only',
                  'package/es5/tex-svg.js': b'/* test, not MathJax */',
                  'package/es5/ui/safe.js': b'/* test, not MathJax */',
                  'package/source/private.ts': b'NEVER_COPY'}
        for name, body in values.items():
            info = tarfile.TarInfo(name); info.size = len(body)
            bundle.addfile(info, io.BytesIO(body))
        if extra: extra(bundle)
    return result.getvalue()


def integrity(body):
    return 'sha512-' + base64.b64encode(hashlib.sha512(body).digest()).decode('ascii')


class ContestMathJaxTests(unittest.TestCase):
    def test_real_pin_rejects_arbitrary_bytes(self):
        with self.assertRaisesRegex(ValueError, 'SHA512'):
            installer.browser_payload(generated_archive())
        with self.assertRaisesRegex(ValueError, 'limit'):
            installer.browser_payload(b'x' * (installer.MAX_ARCHIVE_BYTES + 1))

    def test_allowlisted_files_under_mock_test_pin(self):
        archive = generated_archive()
        with patch.object(installer, 'MATHJAX_INTEGRITY', integrity(archive)):
            files = installer.browser_payload(archive)
        self.assertEqual(set(files), {'LICENSE', 'es5/tex-svg.js', 'es5/ui/safe.js', 'manifest.json'})
        self.assertNotIn('private.ts', ''.join(files))

    def test_tar_links_and_traversal_refused_even_under_mock_pin(self):
        def link(bundle):
            info = tarfile.TarInfo('package/es5/link.js'); info.type = tarfile.SYMTYPE; info.linkname = '/secret'
            bundle.addfile(info)
        def traversal(bundle):
            info = tarfile.TarInfo('package/es5/../../secret.js'); info.size = 1
            bundle.addfile(info, io.BytesIO(b'x'))
        for extra in (link, traversal):
            archive = generated_archive(extra)
            with patch.object(installer, 'MATHJAX_INTEGRITY', integrity(archive)):
                with self.assertRaises(ValueError): installer.browser_payload(archive)

    def test_offline_install_idempotence_and_replace_in_temporary_git(self):
        with tempfile.TemporaryDirectory(dir=TEST_ROOT) as temporary:
            repo = Path(temporary) / 'repo'; repo.mkdir()
            subprocess.run(['git', 'init', '--quiet', str(repo)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            (repo / '.gitignore').write_text('local-data/\n')
            archive = generated_archive(); archive_path = Path(temporary) / 'test.tgz'; archive_path.write_bytes(archive)
            destination = repo / 'local-data/contest-vendor/mathjax'
            with patch.object(installer, 'MATHJAX_INTEGRITY', integrity(archive)):
                result = installer.setup_mathjax(archive_path, destination, repository=repo)
                self.assertEqual(result['status'], 'installed')
                self.assertTrue(installer.installed(destination))
                self.assertEqual(installer.setup_mathjax(archive_path, destination, repository=repo)['status'], 'unchanged')
                (destination / 'es5/tex-svg.js').write_text('corrupted')
                with self.assertRaisesRegex(ValueError, '--replace'):
                    installer.setup_mathjax(archive_path, destination, repository=repo)
                self.assertEqual(installer.setup_mathjax(archive_path, destination, repository=repo, replace=True)['status'], 'replaced')
                self.assertEqual(len(list(destination.parent.glob('previous-mathjax-*'))), 1)
                with self.assertRaisesRegex(ValueError, 'Git-ignored'):
                    installer.setup_mathjax(archive_path, repo / 'public', repository=repo)


if __name__ == '__main__':
    unittest.main()
