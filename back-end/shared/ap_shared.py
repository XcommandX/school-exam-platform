"""Canonical, fail-closed reader for explicitly authorized shared AP materials.

This validates integrity/structure, not PDF visual privacy or editorial accuracy.
Legacy contentMode='private' means non-synthetic and is deliberately unchanged.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re

from .ap_schema import validate_ap_set

SHARED_AP = 'back-end/question-banks/ap'
MANIFEST = 'RESOURCE_MANIFEST.json'
HASH_RE = re.compile(r'[a-f0-9]{64}')
FILE_RE = re.compile(r'(?:sets/[a-z0-9][a-z0-9-]{0,119}\.json|assets/[a-f0-9]{64}\.pdf)')


def canonical_bytes(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + '\n').encode('utf-8')


def strict_json(payload):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('Duplicate JSON key.')
            result[key] = value
        return result
    def constant(value):
        raise ValueError('Nonfinite JSON number.')
    return json.loads(payload, object_pairs_hook=pairs, parse_constant=constant)


def safe_path(base, relative):
    """Check lexical components before resolving; reject links/junctions."""
    base = Path(base).absolute()
    if not isinstance(relative, str) or '\\' in relative or ':' in relative:
        raise ValueError('Unsafe AP path.')
    parts = relative.split('/')
    if any(part in ('', '.', '..') for part in parts):
        raise ValueError('Unsafe AP path.')
    target = base.joinpath(*parts)
    for item in (target, *target.parents):
        if item.is_symlink() or getattr(item, 'is_junction', lambda: False)():
            raise ValueError('AP paths must not contain symbolic links or junctions.')
    if not target.resolve().is_relative_to(base.resolve()):
        raise ValueError('AP path escapes its root.')
    return target


def inventory(base):
    """Exact shallow shared tree, including hidden/ignored entries."""
    base = Path(base)
    found = set()
    def walk_error(error):
        raise error
    for folder, dirs, files in os.walk(base, followlinks=False, onerror=walk_error):
        for name in dirs + files:
            path = Path(folder) / name
            relative = path.relative_to(base).as_posix()
            safe_path(base, relative)
            if name in dirs:
                if relative not in ('sets', 'assets'):
                    raise ValueError('Unknown shared AP directory.')
            elif not path.is_file():
                raise ValueError('Shared AP entry is not a regular file.')
            else:
                found.add(relative)
    return found


def load_shared_ap(root, tracked=None):
    """Read repository shared AP bank, optionally enforcing git-tracked paths.

    files paths are relative to SHARED_AP; counts.bytes excludes the manifest.
    An absent bank is an error here (callers choose their empty-bank policy).
    """
    root = Path(root).absolute()
    base = safe_path(root, SHARED_AP)
    manifest_path = safe_path(base, MANIFEST)
    manifest = strict_json(manifest_path.read_bytes())
    if (not isinstance(manifest, dict) or set(manifest) != {'schemaVersion', 'files'}
            or type(manifest['schemaVersion']) is not int or manifest['schemaVersion'] != 1
            or not isinstance(manifest['files'], list)):
        raise ValueError('Invalid shared AP resource manifest.')
    expected, files, docs, ids, references = {MANIFEST}, [], [], set(), set()
    if tracked is not None and f'{SHARED_AP}/{MANIFEST}' not in tracked:
        raise ValueError('Shared AP manifest is not tracked.')
    for entry in manifest['files']:
        if (not isinstance(entry, dict) or set(entry) != {'path', 'bytes', 'sha256'}
                or not isinstance(entry['path'], str) or not FILE_RE.fullmatch(entry['path'])
                or type(entry['bytes']) is not int or entry['bytes'] <= 0
                or not isinstance(entry['sha256'], str) or not HASH_RE.fullmatch(entry['sha256'])):
            raise ValueError('Invalid shared AP file entry.')
        relative = entry['path']
        if relative in expected:
            raise ValueError('Duplicate shared AP file path.')
        expected.add(relative)
        if tracked is not None and f'{SHARED_AP}/{relative}' not in tracked:
            raise ValueError('Shared AP file is not tracked.')
        path = safe_path(base, relative)
        if not path.is_file():
            raise ValueError('Missing shared AP file.')
        payload = path.read_bytes()
        digest = hashlib.sha256(payload).hexdigest()
        if len(payload) != entry['bytes'] or digest != entry['sha256']:
            raise ValueError('Shared AP file hash or size mismatch.')
        if relative.startswith('sets/'):
            document = validate_ap_set(strict_json(payload))
            fingerprint = hashlib.sha256(canonical_bytes({k: v for k, v in document.items() if k != 'revision'})).hexdigest()
            if document['contentMode'] != 'private' or document['revision'] != fingerprint:
                raise ValueError('Shared AP set must preserve its non-synthetic revision fingerprint.')
            if document['id'] in ids:
                raise ValueError('Duplicate shared AP set id.')
            ids.add(document['id'])
            docs.append(document)
            references.update('assets/' + source['asset'].split('/')[-1] for source in document['documents'])
        elif not payload.startswith(b'%PDF-') or path.stem != digest:
            raise ValueError('Shared PDF header or content-addressed filename mismatch.')
        files.append(dict(entry))
    if inventory(base) != expected:
        raise ValueError('Unknown or missing shared AP files.')
    pdfs = {item['path'] for item in files if item['path'].startswith('assets/')}
    if references != pdfs:
        raise ValueError('Shared PDFs must be exactly the referenced documents.')
    questions = [q for document in docs for q in document['questions']]
    counts = {
        'sets': len(docs), 'questions': len(questions),
        'mcq': sum(q['type'] == 'mcq' for q in questions),
        'frq': sum(q['type'] == 'free-response' for q in questions),
        'gradableMcq': sum(q['type'] == 'mcq' and q['correctOption'] is not None for q in questions),
        'practiceSets': sum(bool(doc['questions']) for doc in docs),
        'documentOnlySets': sum(not doc['questions'] and doc['kind'] != 'reference' for doc in docs),
        'referenceSets': sum(doc['kind'] == 'reference' for doc in docs),
        'pdfs': len(pdfs), 'files': len(files), 'bytes': sum(f['bytes'] for f in files),
        'largestFileBytes': max((f['bytes'] for f in files), default=0),
    }
    return {'sets': docs, 'files': files, 'counts': counts}
