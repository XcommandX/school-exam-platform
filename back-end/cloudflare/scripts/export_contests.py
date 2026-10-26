#!/usr/bin/env python3
"""Export original examples and the explicitly authorized manifest-checked shared bank.
Never enumerate local-data: only fixed shared resources listed in the manifest.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'back-end'))
from shared.contest_bank import EXAMPLE_FILES, no_symlinks, normalize_exam, read_json, safe_path, validate_image
from shared.contest_shared import validate_shared


def export_contests(repository, output, tracked_file):
    repository, output = Path(repository).absolute(), Path(output).absolute()
    if output != repository / 'local-data/builds/cloudflare/.catalog-stage':
        raise ValueError('Contest staging must use the dedicated Cloudflare build directory.')
    no_symlinks(repository)
    no_symlinks(output)
    no_symlinks(Path(tracked_file).absolute())
    tracked = set(Path(tracked_file).read_text(encoding='utf-8').split('\0'))
    routes, summaries = {}, []

    def emit(route, name, value):
        with (output / name).open('x', encoding='utf-8', newline='\n') as stream:
            json.dump(value, stream, ensure_ascii=False, allow_nan=False)
            stream.write('\n')
        routes[route] = {'file': name, 'asset': '/_catalog/contests/' + name}

    for name in EXAMPLE_FILES:
        relative = 'front-end/contests/examples/' + name
        if relative not in tracked:
            raise ValueError('Contest example must be Git-tracked: ' + relative)
        raw = read_json(no_symlinks(repository / relative), 2 * 1024 * 1024)
        if not isinstance(raw, dict) or raw.get('example') is not True:
            raise ValueError('Only explicitly original contest examples may be exported.')
        summary, document = normalize_exam(raw['exam'], raw['problems'], 'example')
        if any(problem['assets'] for problem in document['problems']):
            raise ValueError('Cloud contest examples must not reference external/private assets.')
        if any(existing['id'] == summary['id'] for existing in summaries):
            raise ValueError('Duplicate contest example ID.')
        summaries.append(summary)
        emit('/api/contests/exams/' + document['id'] + '?mode=example', 'exam-' + name, document)
    empty = {'mode': 'private', 'exams': [], 'totalProblems': 0, 'errors': [], 'mathjaxAvailable': False}
    shared_root = repository / 'back-end/question-banks/contests'
    shared, bank, media = None, None, []
    manifest_name = 'back-end/question-banks/contests/RESOURCE_MANIFEST.json'
    if no_symlinks(shared_root / 'RESOURCE_MANIFEST.json').exists():
        if manifest_name not in tracked:
            raise ValueError('Shared contest manifest must be Git-tracked.')
        shared, bank = validate_shared(shared_root, tracked)
        for summary in bank['exams']:
            document = read_json(safe_path(shared_root, 'exams/' + summary['id'] + '.json'))
            emit('/api/contests/exams/' + summary['id'], 'shared-' + summary['id'] + '.json', document)
        for entry in shared['files']:
            name = entry['path']
            if name.startswith('assets/'):
                mime = validate_image(safe_path(shared_root, name).read_bytes(), name)
                media.append({**entry, 'route': '/contest-assets/' + name, 'contentType': mime})
            elif name.startswith('vendor/mathjax/') and name.endswith('.js'):
                media.append({**entry, 'route': '/contest-vendor/mathjax/' + name[len('vendor/mathjax/'):], 'contentType': 'application/javascript; charset=utf-8'})
            elif name == 'vendor/mathjax/LICENSE':
                media.append({**entry, 'route': '/contest-vendor/mathjax/LICENSE', 'contentType': 'text/plain; charset=utf-8'})
        empty['mathjaxAvailable'] = any(e['path'] == 'vendor/mathjax/es5/tex-svg.js' for e in media)
    emit('/api/contests/catalog', 'catalog.json', {**empty, 'exams': bank['exams'] if bank else [],
        'totalProblems': sum(e['problem_count'] for e in bank['exams']) if bank else 0})
    emit('/api/contests/catalog?mode=example', 'examples.json', {
        **empty, 'mode': 'example', 'exams': summaries,
        'totalProblems': sum(item['problem_count'] for item in summaries)})
    result = {'schemaVersion': 1, 'routes': routes,
              'counts': {'exampleExams': len(summaries), 'exampleProblems': sum(item['problem_count'] for item in summaries),
                         'privateProblems': sum(e['problem_count'] for e in bank['exams']) if bank else 0,
                         'privateExams': len(bank['exams']) if bank else 0,
                         'assets': len(bank['assets']) if bank else 0,
                         'mathjaxAvailable': empty['mathjaxAvailable']},
              'media': media, 'files': shared['files'] if shared else []}
    with (output / 'contest-export-info.json').open('x', encoding='utf-8', newline='\n') as stream:
        json.dump(result, stream, ensure_ascii=False, allow_nan=False)
        stream.write('\n')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('repository', 'output', 'tracked-file'):
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    export_contests(args.repository, args.output, args.tracked_file)
