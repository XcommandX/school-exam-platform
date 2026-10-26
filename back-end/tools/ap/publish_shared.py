"""Prepare only explicitly authorized imported AP sets and referenced PDFs.

No account data, import report, source paths or whole private directory is copied.
No commits, staging, network access or deployment. Existing different output is
refused rather than overwritten; repeat runs leave identical bytes untouched.
"""
from __future__ import annotations

import argparse
import hashlib
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from shared.ap_schema import ID_RE, validate_ap_set
from shared.ap_shared import (SHARED_AP, MANIFEST, HASH_RE, canonical_bytes,
                              inventory, load_shared_ap, safe_path, strict_json)


def prepare_shared(source_private, repository):
    source = Path(source_private).absolute()
    manifest = strict_json(safe_path(source, 'ap-import-manifest.json').read_bytes())
    if (not isinstance(manifest, dict) or manifest.get('importerVersion') != 1
            or not isinstance(manifest.get('sets'), list) or not isinstance(manifest.get('assets'), list)):
        raise ValueError('Invalid source AP import manifest.')
    allowed_assets = set()
    for digest in manifest['assets']:
        if not isinstance(digest, str) or not HASH_RE.fullmatch(digest) or digest in allowed_assets:
            raise ValueError('Invalid source asset hash list.')
        allowed_assets.add(digest)
    sources = manifest.get('sourceManifest', {}).get('sources', [])
    provenance_hashes = {item.get('sha256') for item in sources if isinstance(item, dict)}
    if not allowed_assets <= provenance_hashes:
        raise ValueError('Source asset hashes missing from source manifest.')
    payloads, ids, references = {}, set(), set()
    for entry in manifest['sets']:
        if (not isinstance(entry, dict) or set(entry) != {'id', 'revision'}
                or not isinstance(entry['id'], str) or not ID_RE.fullmatch(entry['id'])
                or entry['id'] in ids):
            raise ValueError('Invalid or duplicate source set id.')
        ids.add(entry['id'])
        filename = entry['id'][3:] + '.json'
        payload = safe_path(source, 'question-banks/ap/' + filename).read_bytes()
        document = validate_ap_set(strict_json(payload))
        fingerprint = hashlib.sha256(canonical_bytes({k: v for k, v in document.items() if k != 'revision'})).hexdigest()
        if (document['id'] != entry['id'] or document['contentMode'] != 'private'
                or document['revision'] != entry['revision'] or fingerprint != entry['revision']):
            raise ValueError('Source set revision fingerprint mismatch.')
        payloads['sets/' + filename] = payload
        references.update(Path(doc['asset']).stem for doc in document['documents'])
    if not references <= allowed_assets:
        raise ValueError('Referenced PDF is not in source import manifest.')
    for digest in sorted(references):
        payload = safe_path(source, 'question-assets/ap/' + digest + '.pdf').read_bytes()
        if hashlib.sha256(payload).hexdigest() != digest or not payload.startswith(b'%PDF-'):
            raise ValueError('Source PDF header or hash mismatch.')
        payloads['assets/' + digest + '.pdf'] = payload
    entries = [{'path': name, 'bytes': len(payload), 'sha256': hashlib.sha256(payload).hexdigest()}
               for name, payload in sorted(payloads.items())]
    payloads[MANIFEST] = canonical_bytes({'schemaVersion': 1, 'files': entries})
    base = safe_path(repository, SHARED_AP)
    if base.exists() and inventory(base) - payloads.keys():
        raise ValueError('Output contains unrelated files; refusing to overwrite.')
    # Preflight every source and destination before writing any bytes.
    for name, payload in payloads.items():
        target = safe_path(base, name)
        if target.exists() and target.read_bytes() != payload:
            raise ValueError('Shared output differs; review before replacing it.')
    written = 0
    for name, payload in payloads.items():
        target = safe_path(base, name)
        if not target.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open('xb') as stream:
                stream.write(payload)
            written += 1
    result = load_shared_ap(repository)
    return {'counts': result['counts'], 'written': written, 'unchanged': len(payloads) - written}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-private', required=True, type=Path)
    parser.add_argument('--repository', type=Path, default=Path(__file__).resolve().parents[3])
    args = parser.parse_args()
    print(canonical_bytes(prepare_shared(args.source_private, args.repository)).decode(), end='')


if __name__ == '__main__':
    main()
