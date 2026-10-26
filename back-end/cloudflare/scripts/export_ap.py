#!/usr/bin/env python3
"""Export only manifest-validated, tracked shared AP sets; never local-data banks."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import sys

CODE_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(CODE_ROOT / 'back-end'))
from shared.ap_shared import load_shared_ap
from shared.ap_schema import summarize_ap_set
from export_catalog import no_symlinks


def export_ap(repository, output, tracked_file):
    repository, output = Path(repository).absolute(), Path(output).absolute()
    if output != repository / 'local-data/builds/cloudflare/.catalog-stage':
        raise ValueError('AP staging is restricted to the dedicated catalog stage.')
    for target in (repository, output, Path(tracked_file).absolute()):
        no_symlinks(target)
    if not output.is_dir():
        raise ValueError('AP staging must already exist.')
    tracked = set(Path(tracked_file).read_text(encoding='utf-8').split('\0'))
    shared = load_shared_ap(repository, tracked=tracked)
    routes = {}

    def emit(route, name, value):
        relative = 'ap/' + name + '.json'
        target = output / relative
        no_symlinks(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('x', encoding='utf-8', newline='\n') as stream:
            json.dump(value, stream, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
            stream.write('\n')
        routes[route] = {'file': relative, 'asset': '/_catalog/' + relative,
                         'contentType': 'application/json; charset=utf-8'}

    sources = [summarize_ap_set(document) for document in shared['sets']]
    emit('/api/exams/ap/sources', 'sources', {'schemaVersion': 2, 'exam': 'ap', 'sources': sources, 'errors': []})
    for document in shared['sets']:
        emit('/api/exams/ap/sources/' + document['id'], hashlib.sha256(document['id'].encode()).hexdigest(), document)
    pdfs = [dict(entry, route='/question-assets/ap/' + Path(entry['path']).name)
            for entry in shared['files'] if entry['path'].startswith('assets/')]
    result = {'schemaVersion': 1, 'routes': routes, 'sources': sources, 'pdfs': pdfs,
              'files': shared['files'], 'counts': shared['counts']}
    with (output / 'ap-export-info.json').open('x', encoding='utf-8', newline='\n') as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write('\n')
    print('AP export:', json.dumps(result['counts'], ensure_ascii=True))
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('repository', 'output', 'tracked-file'):
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    export_ap(args.repository, args.output, args.tracked_file)
