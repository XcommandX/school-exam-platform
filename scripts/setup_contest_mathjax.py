#!/usr/bin/env python3
"""Install pinned MathJax 3.2.2 browser files privately, using only the stdlib.

Use --archive for an offline npm tarball, otherwise download the one pinned HTTPS
artifact once. Its SHA512 is compiled into this script's shared constants; no npm
commands, package install hooks or downloaded code are executed. The server never
runs this installer automatically. No source-bank copy or question data is read.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import sys
import tarfile
import urllib.request
import uuid

REPOSITORY = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPOSITORY))
from shared.contest_bank import (MATHJAX_INTEGRITY, MATHJAX_VERSION, canonical_bytes,
                                 no_symlinks, read_json, safe_path)
from scripts.import_contest_bank import require_ignored, _write_new

TARBALL = 'https://registry.npmjs.org/mathjax/-/mathjax-3.2.2.tgz'
MAX_ARCHIVE_BYTES = 20 * 1024 * 1024
MAX_BROWSER_BYTES = 64 * 1024 * 1024


def browser_payload(archive):
    if len(archive) > MAX_ARCHIVE_BYTES:
        raise ValueError('MathJax tarball exceeds limit.')
    actual = 'sha512-' + base64.b64encode(hashlib.sha512(archive).digest()).decode('ascii')
    if actual != MATHJAX_INTEGRITY:
        raise ValueError('MathJax tarball does not match the pinned SHA512.')
    files, total = {}, 0
    with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as bundle:
        for member in bundle:
            name = member.name
            parts = PurePosixPath(name).parts
            if not parts or PurePosixPath(name).is_absolute() or any(p in {'.', '..'} for p in parts) or '\\' in name:
                raise ValueError('Unsafe tar path.')
            if member.issym() or member.islnk() or member.isdev():
                raise ValueError('Tar links and devices are not permitted.')
            if not member.isfile():
                continue
            if name != 'package/LICENSE' and not (name.startswith('package/es5/') and name.endswith('.js')):
                continue
            relative = name[len('package/'):]
            if relative in files or member.size > MAX_BROWSER_BYTES:
                raise ValueError('Duplicate or oversized browser artifact.')
            stream = bundle.extractfile(member)
            body = stream.read(MAX_BROWSER_BYTES + 1)
            total += len(body)
            if len(body) != member.size or total > MAX_BROWSER_BYTES:
                raise ValueError('Browser artifact size exceeded.')
            files[relative] = body
    if not {'LICENSE', 'es5/tex-svg.js', 'es5/ui/safe.js'} <= files.keys():
        raise ValueError('MathJax tarball lacks required browser files or license.')
    files['manifest.json'] = canonical_bytes({'version': MATHJAX_VERSION, 'integrity': MATHJAX_INTEGRITY,
        'tarball': TARBALL, 'files': {name: hashlib.sha256(body).hexdigest() for name, body in sorted(files.items())}})
    return files


def installed(destination):
    try:
        manifest = read_json(safe_path(destination, 'manifest.json'), 200000)
        if manifest.get('version') != MATHJAX_VERSION or manifest.get('integrity') != MATHJAX_INTEGRITY:
            return False
        names = manifest.get('files', {})
        if not {'LICENSE', 'es5/tex-svg.js', 'es5/ui/safe.js'} <= names.keys():
            return False
        return all(hashlib.sha256(safe_path(destination, name).read_bytes()).hexdigest() == sha for name, sha in names.items())
    except (OSError, ValueError, TypeError, KeyError):
        return False


def setup_mathjax(archive=None, destination=None, *, repository=REPOSITORY, replace=False):
    repository = no_symlinks(repository).resolve()
    destination = no_symlinks(destination or repository / 'private-data/contest-vendor/mathjax').resolve()
    require_ignored(repository, destination)
    if installed(destination):
        return {'status': 'unchanged', 'version': MATHJAX_VERSION}
    if destination.exists() and not replace:
        raise ValueError('Existing MathJax directory is not verified; use --replace after review.')
    if archive is None:
        request = urllib.request.Request(TARBALL, headers={'User-Agent': 'SchoolExamPlatform-MathJax-Setup/1'})
        with urllib.request.urlopen(request, timeout=60) as response:
            if response.geturl() != TARBALL:
                raise ValueError('Unexpected MathJax download redirect.')
            body = response.read(MAX_ARCHIVE_BYTES + 1)
    else:
        path = no_symlinks(archive)
        if not path.is_file() or path.stat().st_size > MAX_ARCHIVE_BYTES:
            raise ValueError('Invalid offline MathJax archive.')
        body = path.read_bytes()
    files = browser_payload(body)
    base = destination.parent
    staging = base / ('staging-mathjax-' + uuid.uuid4().hex)
    backup = base / ('previous-mathjax-' + uuid.uuid4().hex)
    require_ignored(repository, base, [*[staging / p for p in files], *[destination / p for p in files], backup])
    staging.mkdir(parents=True)
    for name, data in files.items():
        _write_new(safe_path(staging, name, exists=False), data)
    if not installed(staging):
        raise ValueError('Staged MathJax files failed integrity validation.')
    # Before every move, verify exact resolved parent and reject symbolic links.
    for target in (destination, staging, backup):
        no_symlinks(target)
        if target.parent.resolve() != base.resolve():
            raise ValueError('Unexpected MathJax publication path.')
    moved_old = False
    if destination.exists():
        os.rename(destination, backup)
        moved_old = True
    try:
        os.rename(staging, destination)
    except OSError:
        if moved_old and not destination.exists():
            no_symlinks(backup)
            os.rename(backup, destination)
        raise
    return {'status': 'replaced' if moved_old else 'installed', 'version': MATHJAX_VERSION,
            'files': len(files), 'bytes': sum(map(len, files.values())), 'integrity': MATHJAX_INTEGRITY}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path, help='Offline original mathjax-3.2.2.tgz with pinned SHA512.')
    parser.add_argument('--private-dir', type=Path, default=REPOSITORY / 'private-data/contest-vendor/mathjax')
    parser.add_argument('--replace', action='store_true', help='Replace an unverified existing installation, preserving a backup.')
    args = parser.parse_args()
    try:
        result = setup_mathjax(args.archive, args.private_dir, replace=args.replace)
    except (OSError, ValueError, tarfile.TarError) as error:
        parser.exit(1, 'MathJax setup refused: ' + str(error) + '\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
