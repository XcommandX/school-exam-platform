"""Explicit, hash-checked public copy of the user-authorized contest revision."""
from pathlib import Path
import hashlib
import re
from .contest_bank import (ContestStore, HASH_RE, MATHJAX_VERSION, MATHJAX_INTEGRITY,
    canonical_bytes, decode_json, no_symlinks, normalize_exam, read_json, safe_path, validate_image)

BANK_FILES = re.compile(r'(?:bank-manifest\.json|catalog\.json|exams/[A-Za-z0-9_-]+\.json|assets/[A-Za-z0-9_./-]+|vendor/mathjax/(?:manifest\.json|LICENSE|es5/[A-Za-z0-9_./-]+\.js))\Z')


def validate_shared(root, tracked=None):
    root = no_symlinks(Path(root).absolute())
    resource = read_json(safe_path(root, 'RESOURCE_MANIFEST.json'))
    if resource.get('schemaVersion') != 1 or resource.get('kind') != 'contest-shared-bank':
        raise ValueError('Invalid shared contest resource manifest.')
    revision = resource.get('revision')
    if not isinstance(revision, str) or not HASH_RE.fullmatch(revision):
        raise ValueError('Invalid shared contest revision.')
    files = {}
    for entry in resource['files']:
        name = entry['path']
        if not BANK_FILES.fullmatch(name) or name in files:
            raise ValueError('Unexpected or duplicate shared contest file.')
        if tracked is not None and 'back-end/question-banks/contests/' + name not in tracked:
            raise ValueError('Shared contest payload must be Git-tracked: ' + name)
        body = safe_path(root, name).read_bytes()
        if type(entry['bytes']) is not int or len(body) != entry['bytes'] or hashlib.sha256(body).hexdigest() != entry['sha256']:
            raise ValueError('Shared contest resource hash/size mismatch: ' + name)
        files[name] = entry
    body = safe_path(root, 'bank-manifest.json').read_bytes()
    if hashlib.sha256(body).hexdigest() != revision:
        raise ValueError('Shared contest revision hash mismatch.')
    bank = decode_json(body)
    if bank.get('schemaVersion') != 1: raise ValueError('Invalid bank schema.')
    expected = {'bank-manifest.json'} | set(bank['files'])
    if {p for p in files if not p.startswith('vendor/')} != expected:
        raise ValueError('Shared bank payload set mismatch.')
    ids, referenced = set(), set()
    for summary in bank['exams']:
        eid = summary['id']
        if eid in ids: raise ValueError('Duplicate exam.')
        ids.add(eid)
        name = 'exams/' + eid + '.json'
        doc = read_json(safe_path(root, name))
        normalized, checked = normalize_exam(summary, doc['problems'])
        if normalized != summary or checked != doc: raise ValueError('Noncanonical shared exam.')
        for problem in doc['problems']:
            referenced.update(item['local_path'] for item in problem['assets'])
    if set(bank['files']) != {'exams/' + eid + '.json' for eid in ids} | set(bank['assets']) | {'catalog.json'}:
        raise ValueError('Unexpected bank file.')
    if referenced != set(bank['assets']): raise ValueError('Unreferenced or missing image.')
    for name, sha in bank['files'].items():
        if files[name]['sha256'] != sha: raise ValueError('Bank hash mismatch.')
        if name in bank['assets']:
            if sha != bank['assets'][name]: raise ValueError('Image hash mismatch.')
            validate_image(safe_path(root, name).read_bytes(), name)
    vendor = {p for p in files if p.startswith('vendor/')}
    if vendor:
        info = read_json(safe_path(root, 'vendor/mathjax/manifest.json'))
        if info.get('version') != MATHJAX_VERSION or info.get('integrity') != MATHJAX_INTEGRITY:
            raise ValueError('Unpinned shared MathJax.')
        allowed = {'LICENSE', 'es5/tex-svg.js', 'es5/ui/safe.js'}
        # This manifest is deliberately a minimal explicit subset of the verified installation.
        if set(info['files']) != allowed or vendor != {'vendor/mathjax/' + p for p in allowed | {'manifest.json'}}:
            raise ValueError('Unexpected shared MathJax payload.')
        for name, sha in info['files'].items():
            if files['vendor/mathjax/' + name]['sha256'] != sha: raise ValueError('MathJax hash mismatch.')
    return resource, bank


class SharedContestStore(ContestStore):
    """Native read adapter; caller selects local override or this shared fallback."""
    def __init__(self, repository, private_root=None):
        super().__init__(repository, private_root or Path(repository) / 'local-data')
        self.shared = self.repository / 'back-end/question-banks/contests'
        resource, self._validated = validate_shared(self.shared)
        # Bind later reads to the startup-validated resource manifest, rather than
        # trusting a vendor manifest that may have changed during this process.
        self._vendor_hashes = {entry['path'][len('vendor/mathjax/'):]: entry['sha256']
                               for entry in resource['files']
                               if entry['path'].startswith('vendor/mathjax/')}

    def _active(self):
        return self.shared, self._validated

    def vendor(self, relative):
        if relative not in {'es5/tex-svg.js', 'es5/ui/safe.js'}: return None
        base = self.shared / 'vendor/mathjax'
        expected = self._vendor_hashes.get(relative)
        if expected is None: return None
        body = safe_path(base, relative).read_bytes()
        if hashlib.sha256(body).hexdigest() != expected: raise ValueError('Shared MathJax changed.')
        return body, 'application/javascript; charset=utf-8'
