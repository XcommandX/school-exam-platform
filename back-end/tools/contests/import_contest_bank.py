#!/usr/bin/env python3
"""Explicit, offline, rights-acknowledged private contest import (stdlib only).

The source is read-only. All records/resources are validated before activation.
Immutable content-addressed versions are selected with one atomic pointer update;
a failed replacement never changes the previously active bank. Old versions are
retained; this script deliberately does not delete or prune any private data.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid

REPOSITORY = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPOSITORY / 'back-end'))
from shared.contest_bank import (MAX_ASSET_BYTES, canonical_bytes, no_symlinks,
    normalize_exam, read_json, safe_path, validate_image, verify_version, HASH_RE)


def require_ignored(repository, destination, paths=()):
    """Ask Git about the actual paths. String-matching .gitignore is insufficient."""
    repository = no_symlinks(repository).resolve()
    destination = no_symlinks(destination).resolve()
    if destination == repository or not destination.is_relative_to(repository):
        raise ValueError('The private destination must be inside the selected Git worktree.')
    result = subprocess.run(['git', '-C', str(repository), 'check-ignore', '--quiet', '--', str(destination)],
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, check=False)
    if result.returncode != 0:
        raise ValueError('Actual private destination is not Git-ignored (or Git is unavailable).')
    candidates = [no_symlinks(p).absolute() for p in paths]
    for p in candidates:
        if not p.is_relative_to(destination):
            raise ValueError('A planned output escapes the private destination.')
    if candidates:
        # --stdin avoids platform command-line length limits. No --no-index: a
        # force-tracked private file must fail rather than appear safely ignored.
        names = [str(p.relative_to(repository)).replace('\\', '/') for p in candidates]
        checked = subprocess.run(['git', '-C', str(repository), 'check-ignore', '-z', '--stdin'],
                                 input=('\0'.join(names) + '\0').encode('utf-8'),
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
        ignored = set(checked.stdout.decode('utf-8').split('\0'))
        if checked.returncode not in {0, 1} or not set(names) <= ignored:
            raise ValueError('One or more actual output files are tracked or not Git-ignored.')
    tracked = subprocess.run(['git', '-C', str(repository), 'ls-files', '-z', '--', str(destination)],
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if tracked.returncode or tracked.stdout:
        raise ValueError('Private destination contains tracked files, or Git check failed.')
    return destination


def prepare_payload(source_root):
    source = no_symlinks(source_root).resolve()
    rows = read_json(safe_path(source, 'data/problems.json'))
    exams = read_json(safe_path(source, 'data/exams.json'))
    if not isinstance(rows, list) or not 1 <= len(rows) <= 25000 or not isinstance(exams, list) or not 1 <= len(exams) <= 2000:
        raise ValueError('Invalid source bank size.')
    by_id = {}
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get('id'), str) or row['id'] in by_id:
            raise ValueError('Missing or duplicate source problem identifier.')
        by_id[row['id']] = row
    seen, summaries, files, assets = set(), [], {}, {}
    exam_ids = set()
    for exam in exams:
        if not isinstance(exam, dict) or not isinstance(exam.get('id'), str) or exam['id'] in exam_ids:
            raise ValueError('Missing or duplicate source exam identifier.')
        eid = exam['id']
        # safe_path rejects IDs trying to escape before opening any source file.
        expected_url = 'data/exams/' + eid + '.json'
        if exam.get('data_url') != expected_url:
            raise ValueError('Unexpected per-exam source location.')
        disk_rows = read_json(safe_path(source, expected_url), 20 * 1024 * 1024)
        if not isinstance(disk_rows, list) or not disk_rows or any(not isinstance(p, dict) for p in disk_rows):
            raise ValueError('Invalid per-exam source records.')
        ids = [p.get('id') for p in disk_rows]
        if ids != exam.get('problem_ids') or any(not isinstance(pid, str) for pid in ids):
            raise ValueError('Per-exam IDs differ from source catalog.')
        for row in disk_rows:
            pid = row['id']
            if pid in seen or by_id.get(pid) != row:
                raise ValueError('Full-bank and per-exam records are inconsistent.')
            seen.add(pid)
        summary, document = normalize_exam(exam, disk_rows)
        exam_ids.add(eid)
        summaries.append(summary)
        files['exams/' + eid + '.json'] = canonical_bytes(document)
        for row in document['problems']:
            for asset in row['assets']:
                relative, sha = asset['local_path'], asset['sha256']
                if relative in assets:
                    if assets[relative] != sha:
                        raise ValueError('Conflicting asset hashes.')
                    continue
                path = safe_path(source, relative)
                if path.stat().st_size > MAX_ASSET_BYTES:
                    raise ValueError('Image exceeds size limit.')
                body = path.read_bytes()
                if hashlib.sha256(body).hexdigest() != sha or ('bytes' in asset and asset['bytes'] != len(body)):
                    raise ValueError('Source image hash or size mismatch.')
                validate_image(body, relative)
                files[relative] = body
                assets[relative] = sha
    if seen != set(by_id):
        raise ValueError('Source catalog does not cover the full source bank.')
    summaries.sort(key=lambda e: (e['contest'], e['year'], e['season'], e['paper'] or '', e['id']))
    files['catalog.json'] = canonical_bytes({'mode': 'private', 'exams': summaries,
                                            'totalProblems': len(rows), 'errors': []})
    manifest = {'schemaVersion': 1, 'exams': summaries, 'assets': assets,
                'files': {name: hashlib.sha256(body).hexdigest() for name, body in sorted(files.items())}}
    body = canonical_bytes(manifest)
    version = hashlib.sha256(body).hexdigest()
    files['manifest.json'] = body
    return version, files, len(rows), len(summaries), len(assets)


def _write_new(path, body):
    no_symlinks(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    no_symlinks(path.parent)
    with path.open('xb') as stream:
        stream.write(body)
        stream.flush()
        os.fsync(stream.fileno())


def import_bank(source_root, destination=None, *, repository=REPOSITORY,
                acknowledge_rights=False, replace=False):
    if not acknowledge_rights:
        raise ValueError('Review content rights and explicitly pass --acknowledge-rights.')
    repository = no_symlinks(repository).resolve()
    destination = require_ignored(repository, destination or repository / 'local-data/contests')
    source = no_symlinks(source_root).resolve()
    if source == destination or source.is_relative_to(destination) or destination.is_relative_to(source / 'data'):
        raise ValueError('Source inputs and private destination must not overlap.')
    # No destination files are created until every source record and image passes.
    version, files, problem_count, exam_count, asset_count = prepare_payload(source)
    final = destination / 'versions' / version
    staging = destination / ('staging-' + uuid.uuid4().hex)
    pointer = destination / 'current.json'
    pointer_temp = destination / ('current-' + uuid.uuid4().hex + '.tmp')
    lock = destination / 'import.lock'
    require_ignored(repository, destination,
                    [pointer, pointer_temp, lock, final / 'manifest.json',
                     *[staging / p for p in files], *[final / p for p in files]])
    destination.mkdir(parents=True, exist_ok=True)
    no_symlinks(destination)
    acquired = False
    try:
        _write_new(lock, b'An import is in progress. Do not remove this lock while an importer runs.\n')
        acquired = True
        previous = None
        if pointer.exists():
            state = read_json(pointer, 4096)
            previous = state.get('version') if isinstance(state, dict) else None
            if not isinstance(previous, str) or not HASH_RE.fullmatch(previous):
                raise ValueError('Active pointer is invalid; repair explicitly before importing.')
        if previous == version:
            verify_version(final, version)
            return {'status': 'unchanged', 'version': version, 'problems': problem_count,
                    'exams': exam_count, 'assets': asset_count}
        if previous and not replace:
            raise ValueError('A different bank is active. Review it and use --replace explicitly.')
        if final.exists():
            verify_version(final, version)
        else:
            staging.mkdir()
            for name, body in files.items():
                _write_new(safe_path(staging, name, exists=False), body)
            verify_version(staging, version)
            final.parent.mkdir(parents=True, exist_ok=True)
            no_symlinks(final.parent)
            # Same-volume rename publishes a complete immutable version. Any
            # failure before the pointer swap leaves the old active bank intact.
            if not staging.resolve().is_relative_to(destination) or not final.resolve().is_relative_to(destination):
                raise ValueError('Version publication escaped the private directory.')
            os.rename(staging, final)
        _write_new(pointer_temp, canonical_bytes({'schemaVersion': 1, 'version': version}))
        no_symlinks(pointer)
        if pointer_temp.parent.resolve() != destination or pointer.parent.resolve() != destination:
            raise ValueError('Pointer update escaped the private directory.')
        os.replace(pointer_temp, pointer)
        return {'status': 'replaced' if previous else 'imported', 'version': version,
                'previousVersion': previous, 'problems': problem_count, 'exams': exam_count, 'assets': asset_count}
    finally:
        # Do not recursively delete a staging directory on error: preserve it for
        # diagnosis. It is ignored and never served. Only our own lock is removed.
        if acquired:
            checked_lock = no_symlinks(lock)
            if checked_lock.parent.resolve() != destination:
                raise ValueError('Unexpected import lock location.')
            checked_lock.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root', required=True, type=Path, help='Explicit root containing data/problems.json and data/exams/.')
    parser.add_argument('--private-dir', type=Path, default=REPOSITORY / 'local-data/contests',
                        help='Ignored contest-store directory inside this worktree, not the entire local-data root.')
    parser.add_argument('--acknowledge-rights', action='store_true', help='Confirm that you reviewed and may use these resources locally.')
    parser.add_argument('--replace', action='store_true', help='Opt in to switching the active version; old versions are retained.')
    args = parser.parse_args()
    try:
        result = import_bank(args.source_root, args.private_dir, acknowledge_rights=args.acknowledge_rights, replace=args.replace)
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        parser.exit(1, 'Contest import refused: ' + str(error) + '\n')
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
