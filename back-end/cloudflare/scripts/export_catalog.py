#!/usr/bin/env python3
"""Export only the two reviewed shared SAT libraries; never open local-data banks.

Uses the local server's canonical readers, preserving pack text, binary assets,
source order, module metadata and catalog/index errors. Oversized JSON is left
whole in a private build staging directory; build.mjs emits bounded byte chunks.
"""
from __future__ import annotations

import argparse
from functools import lru_cache
import json
import os
from pathlib import Path
import re
import stat
import sys

CODE_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(CODE_ROOT / 'back-end'))
from server import serve_platform as server

SHARED_ROOTS = ('back-end/question-banks/sat-packs/gengdu-offline',
                'back-end/question-banks/sat-packs/pdf-official')
CONTENT_TYPE = 'application/json; charset=utf-8'


def no_symlinks(path):
    for candidate in [path, *path.parents]:
        try:
            entry = candidate.lstat()
        except FileNotFoundError:
            continue
        if (stat.S_ISLNK(entry.st_mode)
                or getattr(entry, 'st_file_attributes', 0) & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0)):
            raise ValueError('Symbolic source/output paths are forbidden.')


def validate_shared_tree(repository, root, tracked):
    no_symlinks(root)
    if not root.is_dir():
        raise ValueError('A required shared SAT library is missing.')
    for folder, directories, files in os.walk(root, followlinks=False):
        for name in directories + files:
            target = Path(folder) / name
            no_symlinks(target)
            if target.is_file() and (target.suffix.lower() in {
                    '.json', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'}):
                if target.relative_to(repository).as_posix() not in tracked:
                    raise ValueError('An untracked file is present in a shared SAT source tree.')


def export_catalog(repository, output, tracked_file):
    repository = Path(repository).absolute()
    output = Path(output).absolute()
    expected = repository / 'local-data/builds/cloudflare/.catalog-stage'
    if output != expected:
        raise ValueError('Catalog staging is restricted to local-data/builds/cloudflare/.catalog-stage.')
    no_symlinks(repository)
    no_symlinks(output)
    no_symlinks(Path(tracked_file).absolute())
    if not output.is_dir():
        raise ValueError('The dedicated catalog staging directory must already exist.')
    tracked = set(Path(tracked_file).read_text(encoding='utf-8').split('\0'))
    libraries = tuple(repository / relative for relative in SHARED_ROOTS)
    for library in libraries:
        validate_shared_tree(repository, library, tracked)

    # All canonical readers re-scan catalog metadata. Cache that immutable build
    # snapshot in this process only; return fresh error lists because the index
    # reader appends per-collection validation failures. No server behavior or
    # shared resource file changes, and no local-data/server/auth initialization.
    original_index = server._sat_library_index
    original_safe_path = server._safe_local_path
    cached_index = lru_cache(maxsize=None)(original_index)

    def build_index(root):
        available, indexed, errors = cached_index(root)
        return available, indexed, list(errors)

    def tracked_shared_path(base, relative):
        target = original_safe_path(base, relative)
        # A manifest may name an items file without a .json suffix. Check every
        # selected file, not just the extensions discovered by the preflight.
        if (not any(target.is_relative_to(library) for library in libraries)
                or target.is_file() and target.relative_to(repository).as_posix() not in tracked):
            raise ValueError('A declared SAT source file is outside the tracked shared boundary.')
        return target

    server._sat_library_index = build_index
    server._safe_local_path = tracked_shared_path
    try:
        catalog = server.read_sat_library(libraries)
        question_index = server.read_sat_library_question_index(libraries)
        routes = {}

        def emit(route, relative, value, status=200):
            if not re.fullmatch(r'[A-Za-z0-9_./-]+', relative) or '..' in relative.split('/'):
                raise ValueError('Unsafe generated catalog asset path.')
            target = output / relative
            no_symlinks(target)
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open('x', encoding='utf-8', newline='\n') as stream:
                json.dump(value, stream, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
                stream.write('\n')
            routes[route] = {'file': relative, 'asset': '/_catalog/' + relative,
                             'contentType': CONTENT_TYPE, 'status': status}

        emit('/api/sat-library', 'sat-library.json', catalog)
        emit('/api/sat-library/question-index', 'sat-question-index.json', question_index)
        rows = [row for category in catalog['categories'] for row in category['collections']]
        for row in rows:
            identity = row['collectionId']
            if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,99}', identity):
                raise ValueError('Invalid collection identity.')
            # Fail the build on a formerly usable collection becoming unreadable;
            # never silently deploy an incomplete shared pack or truncated data.
            value = server.read_sat_library(libraries, identity)
            emit('/api/sat-library/collections/' + identity, 'collections/' + identity + '.json', value)
        exported = {row['collectionId'] for row in rows}
        for error in catalog['errors']:
            identity = error.get('collectionId')
            if (isinstance(identity, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,99}', identity)
                    and identity not in exported):
                emit('/api/sat-library/collections/' + identity, 'unavailable/' + identity + '.json',
                     {'error': 'The selected SAT collection is unavailable; check the library catalog.'}, 400)
                exported.add(identity)
        result = {'schemaVersion': 1, 'routes': routes, 'counts': {
            'collections': len(rows), 'questions': sum(row['questionCount'] for row in rows),
            'indexQuestions': len(question_index['questions']), 'indexSources': len(question_index['sources']),
            'catalogErrors': len(catalog['errors']), 'indexErrors': len(question_index['errors'])},
            'errors': {'catalog': catalog['errors'], 'questionIndex': question_index['errors']}}
        with (output / 'export-info.json').open('x', encoding='utf-8', newline='\n') as stream:
            json.dump(result, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.write('\n')
        print('SAT export:', json.dumps(result['counts'], ensure_ascii=True))
        return result
    finally:
        server._sat_library_index = original_index
        server._safe_local_path = original_safe_path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repository', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--tracked-file', required=True)
    args = parser.parse_args()
    export_catalog(args.repository, args.output, args.tracked_file)


if __name__ == '__main__':
    main()
