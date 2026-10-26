#!/usr/bin/env python3
"""Export only four Git-tracked original contest examples, never a private bank.

Cloud builds deliberately omit optional local MathJax and all local-data contest
content. Use the same canonical normalization/revisions as the Python service.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'back-end'))
from shared.contest_bank import EXAMPLE_FILES, no_symlinks, normalize_exam, read_json


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
    emit('/api/contests/catalog', 'catalog.json', empty)
    emit('/api/contests/catalog?mode=example', 'examples.json', {
        **empty, 'mode': 'example', 'exams': summaries,
        'totalProblems': sum(item['problem_count'] for item in summaries)})
    result = {'schemaVersion': 1, 'routes': routes,
              'counts': {'exampleExams': len(summaries), 'exampleProblems': sum(item['problem_count'] for item in summaries),
                         'privateProblems': 0, 'mathjaxAvailable': False}}
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
