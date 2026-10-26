#!/usr/bin/env python3
"""Local, loopback-only entry point for the unified study workspace.

Unified accounts and per-user records use a private SQLite database.
This development server remains loopback-only; public deployment requires HTTPS
and a production serving and backup configuration.
"""
import argparse
import base64
import hashlib
import json
import mimetypes
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import quote, unquote, urlsplit
import webbrowser
import xml.etree.ElementTree as ET

REPOSITORY = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPOSITORY / 'back-end'))
from shared.question_schema import normalize_question_set, to_sat_legacy, validate_question_set
from shared.ap_schema import AP_ASSET_RE, summarize_ap_set, validate_ap_set
from server.platform_auth import make_auth_handler

AP_PUBLIC_FILES = frozenset({'index.html', 'styles.css', 'ap-model.js', 'app.js'})
MAX_BYTES = 20 * 1024 * 1024
MAX_PACK_BYTES = 128 * 1024 * 1024
MAX_BACKUP_BYTES = 256 * 1024 * 1024
EXAMS = {'sat': 'SAT', 'ap': 'AP', 'toefl': 'TOEFL', 'vocab': 'Personal Vocab'}
SAT_LIBRARY_CATEGORIES = (
    ('full-length', 'Full-Length Tests', {'测试', '全真模考'}),
    ('reading-writing', 'Reading & Writing', {'英语', '英语真题'}),
    ('math', 'Math', {'数学', '数学真题'}),
)
TOEFL_FRONTEND_FILES = frozenset({'index.html', 'four.css', 'four-data.js', 'four-logic.js', 'four-learning.js', 'four-app.js', 'favicon.svg'})
TOEFL_PUBLIC_FILES = frozenset({
    'index.html', 'four.css', 'four-data.js', 'four-logic.js', 'four-learning.js',
    'four-app.js', 'favicon.svg', 'audio/fixture-tone.wav', 'images/fixture-scene.svg',
})


def _json_object_pairs(pairs):
    value = {}
    for key, child in pairs:
        if key in value:
            raise ValueError(f'Duplicate JSON key: {key}')
        value[key] = child
    return value


def _safe_local_path(base, relative):
    if (not isinstance(relative, str) or not relative or re.search(r'[\\\x00-\x1f:%?#]', relative)
            or any(part in {'', '.', '..'} for part in relative.split('/'))):
        raise ValueError('Use a safe package-relative path.')
    path = base
    if path.is_symlink():
        raise ValueError('Symbolic package paths are unsupported.')
    for part in relative.split('/'):
        path = path / part
        if path.is_symlink():
            raise ValueError('Symbolic package paths are unsupported.')
    if not path.resolve().is_relative_to(base.resolve()):
        raise ValueError('Package path escapes its collection.')
    return path


def _read_local_json(path):
    if not path.is_file() or path.stat().st_size > MAX_BYTES:
        raise ValueError('Package JSON is missing or exceeds 20 MB.')
    return json.loads(path.read_text(encoding='utf-8'), object_pairs_hook=_json_object_pairs)


def _validate_static_image(data, media_type):
    if media_type == 'image/svg+xml':
        raw = data.decode('utf-8')
        if re.search(r'<!|<\?', raw):
            raise ValueError('SVG declarations, entities, and processing instructions are unsupported.')
        tree = ET.fromstring(raw)
        tags = {'svg', 'g', 'path', 'rect', 'line', 'polyline', 'polygon', 'circle', 'ellipse',
                'text', 'tspan', 'title', 'desc', 'defs', 'clipPath', 'mask', 'linearGradient', 'radialGradient', 'stop'}
        attributes = {'viewBox', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r',
                      'rx', 'ry', 'd', 'points', 'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width',
                      'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset',
                      'opacity', 'transform', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor',
                      'dominant-baseline', 'dx', 'dy', 'id', 'clip-path', 'clip-rule', 'mask', 'gradientUnits',
                      'gradientTransform', 'offset', 'stop-color', 'stop-opacity', 'preserveAspectRatio', 'vector-effect'}
        if tree.tag != '{http://www.w3.org/2000/svg}svg':
            raise ValueError('Expected a static SVG root.')
        for element in tree.iter():
            if not element.tag.startswith('{http://www.w3.org/2000/svg}') or element.tag.split('}', 1)[-1] not in tags:
                raise ValueError('SVG element is outside the supported static subset.')
            for key, value in element.attrib.items():
                if (key not in attributes or re.search(r'\\|(?:javascript|data|https?|file):|@import|expression\s*\(', value, re.I)
                        or re.search(r'url\s*\(', value, re.I) and not re.fullmatch(r'url\(#[A-Za-z][A-Za-z0-9_.:-]*\)', value)):
                    raise ValueError('SVG contains an unsafe attribute or external resource.')
        return
    valid = (media_type == 'image/png' and data.startswith(b'\x89PNG\r\n\x1a\n')
             or media_type == 'image/jpeg' and data.startswith(b'\xff\xd8\xff')
             or media_type == 'image/gif' and data[:6] in {b'GIF87a', b'GIF89a'}
             or media_type == 'image/webp' and data[:4] == b'RIFF' and data[8:12] == b'WEBP')
    if not valid:
        raise ValueError('Image bytes do not match their declared MIME type.')


def read_sat_pack_collection(private):
    """Expose only an explicitly active SAT collection and its declared files."""
    base = Path(private) / 'sat-packs'
    active = _safe_local_path(base, 'active.json')
    if not active.exists():
        return {'collectionId': None, 'packs': [], 'assessment': None}
    config = _read_local_json(active)
    if (not isinstance(config, dict) or set(config) != {'collectionId', 'root'}
            or not isinstance(config['collectionId'], str)
            or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,99}', config['collectionId'])):
        raise ValueError('Invalid active SAT collection identity.')
    collection = _safe_local_path(base, config['root'])
    if not collection.is_dir():
        raise ValueError('The active SAT collection folder is missing.')
    return _read_sat_collection(collection, config['collectionId'])


def _read_sat_collection(collection, collection_id):
    """Read one local collection through the same declared-file boundary."""
    manifests = sorted(collection.rglob('pack.json'))
    if not manifests or len(manifests) > 64:
        raise ValueError('An active SAT collection needs between 1 and 64 packs.')
    packs, total_bytes, identities = [], 0, set()
    image_types = {'.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
                   '.gif': 'image/gif', '.webp': 'image/webp'}
    for manifest_path in manifests:
        relative = manifest_path.relative_to(collection).as_posix()
        manifest_path = _safe_local_path(collection, relative)
        manifest = _read_local_json(manifest_path)
        if (not isinstance(manifest, dict) or manifest.get('schemaVersion') != 'sat-question-pack/0.1-draft'
                or manifest.get('documentType') != 'sat-question-pack' or manifest.get('exam') != 'sat'
                or manifest.get('section') not in {'math', 'reading-writing'}
                or manifest.get('responseType') not in {'single-choice', 'student-produced-response'}
                or manifest.get('section') == 'reading-writing' and manifest.get('responseType') != 'single-choice'
                or not isinstance(manifest.get('files'), dict) or set(manifest['files']) != {'items', 'solutions'}
                or not isinstance(manifest.get('assets'), list)):
            raise ValueError('Unsupported SAT package manifest.')
        identity = (manifest.get('id'), manifest.get('revision'))
        if (not isinstance(identity[0], str) or not re.fullmatch(r'sat:pack:[A-Za-z0-9][A-Za-z0-9._:-]*', identity[0])
                or type(identity[1]) is not int or identity[1] < 1 or identity in identities):
            raise ValueError('Invalid or duplicate SAT package identity.')
        identities.add(identity)
        folder = manifest_path.parent
        files = []
        declared = [('pack.json', 'application/json'), (manifest['files']['items'], 'application/json'),
                    (manifest['files']['solutions'], 'application/json')]
        asset_paths = set()
        for asset in manifest['assets']:
            if not isinstance(asset, dict) or not isinstance(asset.get('path'), str) or not asset['path'].startswith('assets/'):
                raise ValueError('SAT asset paths must be under assets/.')
            asset_path = _safe_local_path(folder, asset['path'])
            if asset['path'] in asset_paths or image_types.get(asset_path.suffix.lower()) != asset.get('mediaType'):
                raise ValueError('Duplicate or unsupported SAT asset MIME type.')
            asset_paths.add(asset['path'])
            if not asset_path.is_file() or asset_path.stat().st_size > MAX_BYTES:
                raise ValueError('SAT asset is missing or exceeds 20 MB.')
            data = asset_path.read_bytes()
            if (type(asset.get('byteLength')) is not int or asset['byteLength'] != len(data) or not data
                    or not isinstance(asset.get('sha256'), str) or hashlib.sha256(data).hexdigest() != asset['sha256']):
                raise ValueError('SAT asset byteLength or sha256 mismatch.')
            _validate_static_image(data, asset['mediaType'])
            declared.append((asset['path'], asset['mediaType']))
        if len({name for name, _ in declared}) != len(declared):
            raise ValueError('Package files must have distinct local paths.')
        for name, media_type in declared:
            path = _safe_local_path(folder, name)
            if not path.is_file() or path.stat().st_size > MAX_BYTES:
                raise ValueError('Declared SAT package file is missing or exceeds 20 MB.')
            data = path.read_bytes()
            total_bytes += len(data)
            if total_bytes > MAX_PACK_BYTES:
                raise ValueError('SAT collection exceeds the 128 MB transfer limit.')
            entry = {'path': path.relative_to(collection).as_posix(), 'mediaType': media_type}
            if media_type == 'application/json':
                _read_local_json(path)
                entry['text'] = data.decode('utf-8')
            else:
                entry['dataBase64'] = base64.b64encode(data).decode('ascii')
            files.append(entry)
        item_document = _read_local_json(_safe_local_path(folder, manifest['files']['items']))
        if not isinstance(item_document, dict) or not isinstance(item_document.get('items'), list):
            raise ValueError('SAT items document is invalid.')
        packs.append({'files': files, 'id': manifest['id'], 'revision': manifest['revision'], 'title': manifest['title'],
                      'section': manifest['section'], 'responseType': manifest['responseType'],
                      'questionCount': len(item_document['items'])})
    assessment_path = _safe_local_path(collection, 'assessment.json')
    assessment = _read_local_json(assessment_path) if assessment_path.is_file() else None
    return {'collectionId': collection_id, 'packs': packs, 'assessment': assessment}


def _sat_library_index(library_root):
    """Match stable catalog identities to real folders, including renamed folders."""
    if isinstance(library_root, (tuple, list)):
        # Default libraries remain independently authored catalogs. Merge only
        # their checked metadata; never rewrite either catalog or its IDs.
        available, indexed, errors, duplicates = False, {}, [], set()
        for root in library_root:
            try:
                found, entries, failures = _sat_library_index(root)
            except (OSError, ValueError, TypeError, KeyError):
                errors.append({'collectionId': None, 'error': 'A configured SAT library catalog could not be read safely.'})
                continue
            available = available or found
            errors.extend(failures)
            for identity, entry in entries.items():
                if identity in indexed or identity in duplicates:
                    duplicates.add(identity)
                    indexed.pop(identity, None)
                else:
                    indexed[identity] = entry
        errors.extend({'collectionId': identity, 'error': 'Multiple SAT libraries claim this collection identity.'}
                      for identity in sorted(duplicates))
        return available, indexed, errors
    library_root = Path(library_root)
    catalog_path = _safe_local_path(library_root, 'catalog.json')
    if not catalog_path.exists():
        return False, {}, []
    catalog = _read_local_json(catalog_path)
    if (not isinstance(catalog, dict) or catalog.get('schemaVersion') != 'sat-offline-conversion-catalog/1'
            or not isinstance(catalog.get('collections'), list)):
        raise ValueError('Unsupported SAT library catalog.')
    rows = {}
    for row in catalog['collections']:
        if not isinstance(row, dict) or row.get('status') != 'converted':
            continue
        identity = row.get('collectionId')
        if (not isinstance(identity, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,99}', identity)
                or identity in rows):
            raise ValueError('Invalid or duplicate SAT library collection identity.')
        if not isinstance(row.get('title'), str) or not row['title'].strip():
            raise ValueError('SAT library collection title is missing.')
        rows[identity] = row
    reports, errors, duplicates = {}, [], set()
    # Catalog directory strings are historical hints. Never use them as an
    # authorization path: the user may rename or move category folders.
    for folder, directories, files in os.walk(library_root, followlinks=False):
        directories[:] = [name for name in directories if not (Path(folder) / name).is_symlink()]
        if 'conversion-report.json' not in files:
            continue
        try:
            path = _safe_local_path(library_root, (Path(folder) / 'conversion-report.json').relative_to(library_root).as_posix())
            report = _read_local_json(path)
        except (OSError, ValueError, TypeError):
            # One damaged or unlisted report must not hide every usable set.
            # Do not expose the configured private filesystem path in errors.
            errors.append({'collectionId': None, 'error': 'A local conversion report could not be read safely.'})
            continue
        identity = report.get('collectionId') if isinstance(report, dict) else None
        if not isinstance(identity, str) or identity not in rows:
            continue
        if identity in reports:
            duplicates.add(identity)
        reports[identity] = (path.parent, report)
    indexed = {}
    for identity, row in rows.items():
        try:
            if identity in duplicates:
                raise ValueError('Multiple local folders claim this collection identity.')
            if identity not in reports:
                raise ValueError('The local collection folder is missing.')
            folder, report = reports[identity]
            category = next((key for key, _, names in SAT_LIBRARY_CATEGORIES if row.get('category') in names), None)
            if category is None:
                raise ValueError('Unsupported SAT library category.')
            if (type(report.get('questionCount')) is not int or report['questionCount'] < 1
                    or type(row.get('questionCount')) is not int or row['questionCount'] != report['questionCount']
                    or not isinstance(report.get('modules'), list) or type(report.get('fullSAT')) is not bool
                    or type(row.get('fullSAT')) is not bool or row['fullSAT'] != report['fullSAT']):
                raise ValueError('SAT library counts or assessment metadata disagree.')
            modules, section_counts, module_keys = [], {}, set()
            for module in report['modules']:
                if (not isinstance(module, dict) or module.get('section') not in {'math', 'reading-writing'}
                        or type(module.get('moduleNumber')) is not int or module['moduleNumber'] < 1
                        or type(module.get('questionCount')) is not int or module['questionCount'] < 1
                        or 'durationSeconds' in module and (type(module['durationSeconds']) is not int or module['durationSeconds'] < 1)):
                    raise ValueError('Invalid SAT library module metadata.')
                module_key = module['section'], module['moduleNumber']
                if module_key in module_keys:
                    raise ValueError('Duplicate SAT library module metadata.')
                module_keys.add(module_key)
                modules.append({key: module[key] for key in ('section', 'moduleNumber', 'questionCount', 'durationSeconds') if key in module})
                section_counts[module['section']] = section_counts.get(module['section'], 0) + module['questionCount']
            if sum(section_counts.values()) != report['questionCount']:
                raise ValueError('SAT library module counts disagree.')
            if report['fullSAT'] and [(module['section'], module['moduleNumber'], module['questionCount'],
                                       module.get('durationSeconds')) for module in modules] != [
                    ('reading-writing', 1, 27, 1920), ('reading-writing', 2, 27, 1920),
                    ('math', 1, 22, 2100), ('math', 2, 22, 2100)]:
                raise ValueError('A full SAT assessment needs its four complete timed modules.')
            source_parts = row.get('sourceFile', '').split('/') if isinstance(row.get('sourceFile'), str) else []
            metadata = {'collectionId': identity, 'title': row['title'], 'category': category,
                        'questionCount': report['questionCount'], 'fullSAT': report['fullSAT'],
                        'sectionCounts': section_counts, 'modules': modules,
                        'sourceCategory': row['category'], 'subgroup': source_parts[1] if len(source_parts) > 2 else ''}
            indexed[identity] = (folder, report, metadata)
        except (ValueError, TypeError, KeyError) as error:
            errors.append({'collectionId': identity, 'error': str(error)})
    return True, indexed, errors


def read_sat_library(library_root, collection_id=None):
    """List metadata, or lazily load one explicitly cataloged collection."""
    if collection_id is not None and (not isinstance(collection_id, str)
            or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,99}', collection_id)):
        raise ValueError('Invalid SAT library collection identity.')
    available, indexed, errors = _sat_library_index(library_root)
    if collection_id is None:
        categories = [{'id': key, 'title': title,
                       'collections': sorted((entry[2] for entry in indexed.values() if entry[2]['category'] == key),
                                             key=lambda entry: (entry['title'].casefold(), entry['collectionId']))}
                      for key, title, _ in SAT_LIBRARY_CATEGORIES]
        return {'schemaVersion': 1, 'available': available, 'categories': categories, 'errors': errors}
    if collection_id not in indexed:
        if any(error['collectionId'] == collection_id for error in errors):
            raise ValueError('The selected SAT collection is unavailable; check the library catalog.')
        raise FileNotFoundError('SAT library collection not found.')
    folder, report, metadata = indexed[collection_id]
    result = _read_sat_collection(folder, collection_id)
    references = {}
    for pack in result['packs']:
        manifest_file = next(entry for entry in pack['files'] if entry['path'].endswith('/pack.json') or entry['path'] == 'pack.json')
        manifest = json.loads(manifest_file['text'])
        prefix = manifest_file['path'][:-len('pack.json')]
        items_file = next(entry for entry in pack['files'] if entry['path'] == prefix + manifest['files']['items'])
        for item in json.loads(items_file['text'])['items']:
            identity = (pack['id'], pack['revision'], item['id'], item['revision'])
            if identity in references:
                raise ValueError('Duplicate SAT library item reference.')
            references[identity] = pack['section']
    if not isinstance(report.get('sourceOrder'), list) or len(report['sourceOrder']) != metadata['questionCount']:
        raise ValueError('SAT library source order is missing or incomplete.')
    groups, seen = {}, set()
    for reference in report['sourceOrder']:
        if (not isinstance(reference, dict) or reference.get('section') not in {'reading-writing', 'math'}
                or type(reference.get('moduleNumber')) is not int or reference['moduleNumber'] < 1
                or type(reference.get('number')) is not int or reference['number'] < 1):
            raise ValueError('Invalid SAT library source position.')
        identity = tuple(reference.get(key) for key in ('packId', 'packRevision', 'itemId', 'itemRevision'))
        if (not isinstance(identity[0], str) or type(identity[1]) is not int
                or not isinstance(identity[2], str) or type(identity[3]) is not int
                or identity in seen or references.get(identity) != reference['section']):
            raise ValueError('SAT library source reference does not match its package revision.')
        seen.add(identity)
        groups.setdefault((reference['section'], reference['moduleNumber']), []).append(reference)
    if len(references) != len(seen):
        raise ValueError('SAT library source order does not include every item.')
    modules, canonical_modules = [], []
    for module in metadata['modules']:
        source = groups.pop((module['section'], module['moduleNumber']), [])
        if len(source) != module['questionCount']:
            raise ValueError('SAT library module source count disagrees.')
        items = [{key: reference[key] for key in ('packId', 'packRevision', 'itemId', 'itemRevision')}
                 for reference in source]
        modules.append({**module, 'items': items})
        canonical_modules.append({**module, 'items': [
            {key: reference[key] for key in ('packId', 'packRevision', 'itemId', 'itemRevision')}
            for reference in sorted(source, key=lambda entry: entry['number'])]})
    if groups or (result['assessment'] is not None) != metadata['fullSAT']:
        raise ValueError('SAT library assessment availability disagrees.')
    assessment = result['assessment']
    if assessment is not None and (not isinstance(assessment, dict)
            or assessment.get('schemaVersion') != 'sat-assessment/0.1-draft'
            or assessment.get('fullSAT') is not True or assessment.get('questionCount') != metadata['questionCount']
            or assessment.get('breakDurationSeconds') != 600 or assessment.get('modules') != canonical_modules):
        raise ValueError('SAT library assessment does not match its source modules or package revisions.')
    return {**result, **metadata, 'modules': modules}


def _sat_index_signature(folder, paths):
    """Stat only the declared text dependencies; never open image resources."""
    signature = []
    for relative in paths:
        path = _safe_local_path(folder, relative)
        if not path.is_file():
            raise ValueError('A SAT question index dependency is missing.')
        stat = path.stat()
        if stat.st_size > MAX_BYTES:
            raise ValueError('A SAT question index dependency exceeds 20 MB.')
        signature.append((relative, stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns))
    return tuple(signature)


def _sat_index_text(blocks):
    # Match SATPack.plainText so search sees exactly the same text after import.
    if not isinstance(blocks, list):
        raise ValueError('Invalid SAT index content blocks.')
    values = []
    for block in blocks:
        if not isinstance(block, dict):
            raise ValueError('Invalid SAT index content block.')
        if block.get('type') == 'markdown' and isinstance(block.get('text'), str):
            values.append(re.sub(r'</?u>', '', block['text']))
        elif block.get('type') == 'image' and isinstance(block.get('alt', ''), str):
            values.append(block.get('alt', ''))
        else:
            raise ValueError('Unsupported SAT index content block.')
    return '\n\n'.join(values)


def _read_sat_question_index_collection(folder, report, metadata):
    """Read only manifests and items, with no solutions or binary assets."""
    declared = report.get('packs')
    if not isinstance(declared, dict) or not 1 <= len(declared) <= 64:
        raise ValueError('SAT library package declarations are missing.')
    collection_id = metadata['collectionId']
    paths, sources, questions, references, pack_ids = ['conversion-report.json'], [], [], {}, set()
    stamps = list(_sat_index_signature(folder, paths))
    if _read_local_json(_safe_local_path(folder, paths[0])) != report:
        raise ValueError('SAT library metadata changed while reading the question index.')
    encode = lambda value: quote(value, safe="~()*!.'-")  # JavaScript encodeURIComponent
    for directory, summary in declared.items():
        if (not isinstance(summary, dict) or type(summary.get('questionCount')) is not int
                or summary['questionCount'] < 1):
            raise ValueError('Invalid SAT library package count.')
        manifest_relative = directory + '/pack.json' if isinstance(directory, str) else ''
        manifest_path = _safe_local_path(folder, manifest_relative)
        stamps.extend(_sat_index_signature(folder, [manifest_relative]))
        manifest = _read_local_json(manifest_path)
        if (not isinstance(manifest, dict) or manifest.get('schemaVersion') != 'sat-question-pack/0.1-draft'
                or manifest.get('documentType') != 'sat-question-pack' or manifest.get('exam') != 'sat'
                or manifest.get('contentFormat') != 'markdown-latex/0.1-draft'
                or manifest.get('section') not in {'math', 'reading-writing'}
                or manifest.get('responseType') not in {'single-choice', 'student-produced-response'}
                or manifest['section'] == 'reading-writing' and manifest['responseType'] != 'single-choice'
                or not isinstance(manifest.get('title'), str) or not manifest['title'].strip()
                or not isinstance(manifest.get('files'), dict) or set(manifest['files']) != {'items', 'solutions'}
                or not isinstance(manifest.get('assets'), list)):
            raise ValueError('Unsupported SAT question index package.')
        pack_id, revision = manifest.get('id'), manifest.get('revision')
        if (not isinstance(pack_id, str) or not re.fullmatch(r'sat:pack:[A-Za-z0-9][A-Za-z0-9._:-]*', pack_id)
                or type(revision) is not int or not 1 <= revision <= 9007199254740991 or pack_id in pack_ids):
            raise ValueError('Invalid or duplicate SAT question index package identity.')
        pack_ids.add(pack_id)
        item_path = _safe_local_path(manifest_path.parent, manifest['files']['items'])
        solution_path = _safe_local_path(manifest_path.parent, manifest['files']['solutions'])
        if len({manifest_path, item_path, solution_path}) != 3:
            raise ValueError('SAT package files must have distinct paths.')
        asset_paths = set()
        for asset in manifest['assets']:
            if (not isinstance(asset, dict) or not isinstance(asset.get('path'), str)
                    or not asset['path'].startswith('assets/') or asset['path'] in asset_paths):
                raise ValueError('Invalid SAT question index asset path.')
            _safe_local_path(manifest_path.parent, asset['path'])
            asset_paths.add(asset['path'])
        item_relative = item_path.relative_to(folder).as_posix()
        paths.extend((manifest_relative, item_relative))
        stamps.extend(_sat_index_signature(folder, [item_relative]))
        document = _read_local_json(item_path)
        if (not isinstance(document, dict) or set(document) != {'items'} or not isinstance(document['items'], list)
                or len(document['items']) != summary['questionCount']):
            raise ValueError('SAT question index items disagree with package counts.')
        section = 'Math' if manifest['section'] == 'math' else 'Reading and Writing'
        source_id = 'pack:' + encode(pack_id) + '@' + str(revision)
        sources.append({'id': source_id, 'fileName': manifest_relative, 'displayName': manifest['title'],
                        'section': section, 'questionCount': len(document['items']),
                        'defaultDurationSeconds': 2100 if manifest['section'] == 'math' else 1920,
                        'responseType': manifest['responseType'],
                        'packIdentity': {key: manifest[key] for key in ('id', 'revision', 'section', 'responseType')},
                        'collectionId': collection_id, 'libraryCollectionId': collection_id})
        seen_items = set()
        for position, item in enumerate(document['items']):
            spr = manifest['responseType'] == 'student-produced-response'
            expected = {'id', 'revision', 'classification', 'content', 'prompt', 'source'} | (set() if spr else {'options'})
            if (not isinstance(item, dict) or set(item) != expected or not isinstance(item.get('id'), str)
                    or not re.fullmatch(r'sat:item:[A-Za-z0-9][A-Za-z0-9._:-]*', item['id'])
                    or type(item.get('revision')) is not int or not 1 <= item['revision'] <= 9007199254740991
                    or item['id'] in seen_items or not isinstance(item.get('classification'), dict)
                    or set(item['classification']) != {'skill'} or not isinstance(item['classification']['skill'], str)
                    or not item['classification']['skill'].strip() or not isinstance(item.get('source'), dict)
                    or 'kind' not in item['source'] or set(item['source']) - {'kind', 'url', 'sourceSetId', 'sourceQuestionId'}
                    or any(not isinstance(value, str) or not value.strip() for value in item['source'].values())):
                raise ValueError('Invalid or duplicate SAT question index item identity.')
            seen_items.add(item['id'])
            options = item.get('options', [])
            if (not isinstance(options, list) or not spr and len(options) != 4
                    or any(not isinstance(option, dict) or set(option) != {'id', 'content'} for option in options)):
                raise ValueError('Invalid SAT question index options.')
            question = {'id': source_id + ':' + encode(item['id']) + '@' + str(item['revision']),
                        'passage': _sat_index_text(item['content']), 'prompt': _sat_index_text(item['prompt']),
                        'options': [_sat_index_text(option['content']) for option in options],
                        'questionType': item['classification']['skill'], 'section': section,
                        'responseType': manifest['responseType'], 'packId': pack_id, 'packRevision': revision,
                        'itemId': item['id'], 'itemRevision': item['revision'], 'packSource': dict(item['source']),
                        'libraryCollectionId': collection_id,
                        'metadata': {'sourceId': source_id, 'sourceFileName': manifest_relative,
                                     'sourceQuestionIndex': position, 'libraryCollectionId': collection_id},
                        'indexOnly': True}
            questions.append(question)
            references[(pack_id, revision, item['id'], item['revision'])] = (manifest['section'], question)
    order = report.get('sourceOrder')
    if not isinstance(order, list) or len(order) != metadata['questionCount'] or len(references) != len(order):
        raise ValueError('SAT question index source order is missing or incomplete.')
    seen, counts = set(), {}
    for position, reference in enumerate(order):
        if (not isinstance(reference, dict) or reference.get('section') not in {'math', 'reading-writing'}
                or type(reference.get('moduleNumber')) is not int or reference['moduleNumber'] < 1
                or type(reference.get('number')) is not int or reference['number'] < 1):
            raise ValueError('Invalid SAT question index source position.')
        identity = tuple(reference.get(key) for key in ('packId', 'packRevision', 'itemId', 'itemRevision'))
        if (not isinstance(identity[0], str) or type(identity[1]) is not int or not isinstance(identity[2], str)
                or type(identity[3]) is not int or identity in seen or identity not in references
                or references[identity][0] != reference['section']):
            raise ValueError('SAT question index source reference does not match its package revision.')
        seen.add(identity)
        key = reference['section'], reference['moduleNumber']
        counts[key] = counts.get(key, 0) + 1
        references[identity][1]['metadata'].update({'sourceModuleNumber': reference['moduleNumber'],
                                                 'sourceQuestionNumber': reference['number'], 'sourceOrderIndex': position})
    if counts != {(module['section'], module['moduleNumber']): module['questionCount'] for module in metadata['modules']}:
        raise ValueError('SAT question index source module counts disagree.')
    signature = _sat_index_signature(folder, paths)
    if signature != tuple(stamps):
        raise ValueError('SAT library files changed while reading the question index.')
    return {'sources': sources, 'questions': questions}, paths, signature


def read_sat_library_question_index(library_root, cache=None):
    """Search all cataloged questions without importing full packs into storage."""
    available, indexed, errors = _sat_library_index(library_root)
    sources, questions, source_ids = [], [], set()
    cache = {} if cache is None else cache
    for collection_id in list(cache):
        if collection_id not in indexed:
            del cache[collection_id]
    for collection_id, (folder, report, metadata) in indexed.items():
        try:
            previous = cache.get(collection_id)
            if (previous is not None and previous['folder'] == folder
                    and previous['signature'] == _sat_index_signature(folder, previous['paths'])):
                result = previous['result']
            else:
                # A changed dependency invalidates this collection only.
                result, paths, signature = _read_sat_question_index_collection(folder, report, metadata)
                cache[collection_id] = {'folder': folder, 'paths': paths, 'signature': signature, 'result': result}
            ids = {source['id'] for source in result['sources']}
            if source_ids & ids:
                raise ValueError('Multiple SAT collections claim the same package revision.')
            source_ids.update(ids)
            sources.extend(result['sources'])
            questions.extend(result['questions'])
        except (OSError, ValueError, TypeError, KeyError):
            cache.pop(collection_id, None)
            errors.append({'collectionId': collection_id, 'error': 'The collection question index could not be read safely.'})
    return {'schemaVersion': 1, 'available': available, 'sources': sources, 'questions': questions, 'errors': errors}


def prepare_toefl_preview(root):
    """Build authenticated shared content when present; never start its cloud worker."""
    root = Path(root).resolve()
    script = root / 'back-end/toefl/scripts/build.mjs'
    if not script.is_file():
        return
    node = shutil.which('node')
    if not node:
        print('TOEFL preview needs Node.js 22.13+; install Node and restart, or build back-end/toefl first.', flush=True)
        return
    try:
        arguments = [node, str(script)]
        if any((root / 'back-end/question-banks/toefl' / name).exists() for name in ('bank.json', 'RESOURCE_MANIFEST.json')):
            arguments.append('--shared-bank')
        subprocess.run(arguments, cwd=script.parent.parent, check=True, timeout=300)
    except (OSError, subprocess.SubprocessError) as error:
        print(f'TOEFL content could not be built: {error}. SAT remains available.', flush=True)


def _toefl_asset_configuration(root):
    """Select a verified build without exposing source directories or a manifest."""
    root = Path(root)
    resource = root / 'back-end/question-banks/toefl'
    if any((resource / name).exists() for name in ('bank.json', 'RESOURCE_MANIFEST.json')):
        build = root / 'local-data/builds/toefl-shared'
        preview = build / 'preview'
        try:
            manifest_path = _safe_local_path(root, 'back-end/question-banks/toefl/RESOURCE_MANIFEST.json')
            manifest_bytes = manifest_path.read_bytes()
            manifest = json.loads(manifest_bytes)
            info = json.loads((build / 'build-info.json').read_text(encoding='utf-8'))
            if (not isinstance(manifest, dict) or not isinstance(info, dict) or not isinstance(manifest.get('counts'), dict)
                    or manifest.get('schema_version') != 1 or manifest.get('kind') != 'toefl-shared-bank'
                    or manifest.get('bank') != 'bank.json' or not isinstance(manifest.get('files'), list)
                    or info.get('mode') != 'local-shared-bank' or info.get('productionCredentials') is not False
                    or info.get('productionData') is not True or info.get('deployable') is not False
                    or info.get('manifestSha256') != hashlib.sha256(manifest_bytes).hexdigest()
                    or any(type(info.get(k)) is not int or info[k] != manifest.get('counts', {}).get(k) for k in ('records', 'questions', 'audio', 'images'))):
                raise ValueError('Shared resource build does not match its reviewed manifest.')
            files, media = set(), set()
            for entry in manifest['files']:
                name = entry['path']
                if name in files or type(entry.get('bytes')) is not int or entry['bytes'] < 0:
                    raise ValueError('Invalid resource entry.')
                files.add(name)
                source = _safe_local_path(root, 'back-end/question-banks/toefl/' + name)
                if not source.is_file() or source.stat().st_size != entry['bytes']:
                    raise ValueError('Resource file has changed.')
                if name == 'bank.json':
                    if hashlib.sha256(source.read_bytes()).hexdigest() != entry['sha256']:
                        raise ValueError('Resource bank has changed.')
                    continue
                if (not name.startswith(('audio/', 'images/'))
                        or Path(name).suffix.lower() not in {'.mp3', '.wav', '.m4a', '.ogg', '.webm', '.opus', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'}):
                    raise ValueError('Invalid resource media path.')
                target = _safe_local_path(root, 'local-data/builds/toefl-shared/preview/' + name)
                if not target.is_file() or target.stat().st_size != entry['bytes']:
                    raise ValueError('Built resource media is incomplete.')
                media.add(name)
            if 'bank.json' not in files or not all(_safe_local_path(root, 'local-data/builds/toefl-shared/preview/' + name).is_file() for name in TOEFL_FRONTEND_FILES):
                raise ValueError('Shared build is incomplete.')
            return ({'available': True, 'contentMode': 'shared-bank', 'recordCount': info['records'],
                     'questionCount': info['questions'], 'practiceUrl': '/toefl/'}, preview, TOEFL_FRONTEND_FILES | media)
        except (OSError, ValueError, TypeError, KeyError):
            return ({'available': False, 'contentMode': 'shared-bank-not-built', 'recordCount': 0,
                     'questionCount': 0, 'practiceUrl': '/toefl/'}, preview, frozenset())
    # The independent anonymous build remains the fallback only when no shared
    # bank is configured. An invalid shared build must not serve stale content.
    return (toefl_preview_status(root, anonymous_only=True), root / 'local-data/builds/toefl/preview', TOEFL_PUBLIC_FILES)


def toefl_preview_status(root, *, anonymous_only=False):
    if not anonymous_only:
        return _toefl_asset_configuration(root)[0]
    """Only explicitly anonymous build output is eligible for fallback routing."""
    module = Path(root) / 'back-end/toefl'
    build = Path(root) / 'local-data/builds/toefl'
    preview = build / 'preview'
    try:
        info = json.loads((build / 'build-info.json').read_text(encoding='utf-8'))
        fixture = json.loads((module / 'fixtures/anonymous-bank.json').read_text(encoding='utf-8'))
        if (preview.is_symlink() or not preview.resolve().is_relative_to(build.resolve())
                or info.get('mode') != 'local-anonymous-intake'
                or info.get('productionCredentials') is not False
                or info.get('productionData') is not False or info.get('deployable') is not False
                or fixture.get('fixture') is not True
                or not fixture.get('records')
                or any(r.get('source') != 'ANONYMOUS_FIXTURE' for r in fixture['records'])
                or not all((preview / name).is_file() for name in TOEFL_PUBLIC_FILES)):
            raise ValueError('Not an anonymous preview.')
        return {'available': True, 'contentMode': 'anonymous-fixture', 'recordCount': len(fixture['records']),
                'questionCount': sum(len(r.get('items', [])) for r in fixture['records']),
                'practiceUrl': '/toefl/'}
    except (OSError, ValueError, TypeError, KeyError):
        return {'available': False, 'contentMode': 'not-built', 'recordCount': 0,
                'questionCount': 0, 'practiceUrl': '/toefl/'}


def create_server(root=REPOSITORY, port=8888, private_root=None, sat_library_root=None):
    root = Path(root).resolve()
    private = Path(private_root).resolve() if private_root else root / 'local-data'
    configured_library = sat_library_root or os.environ.get('SAT_LIBRARY_ROOT')
    if configured_library:
        library = Path(configured_library).expanduser()
        if not library.is_absolute():
            library = root / library
    else:
        library_base = root / 'back-end/question-banks/sat-packs'
        library = (library_base / 'gengdu-offline', library_base / 'pdf-official')
    banks = private / 'question-banks'
    for exam in EXAMS:
        folder = banks / exam
        folder.mkdir(parents=True, exist_ok=True)
        if folder.is_symlink() or not folder.resolve().is_relative_to(private):
            raise ValueError('Question banks must be real folders inside local-data.')
    token = secrets.token_urlsafe(32)
    project = hashlib.sha256(str(root).encode()).hexdigest()
    lock = threading.Lock()
    question_index_lock, question_index_cache = threading.Lock(), {}
    toefl_preview, toefl_preview_root, toefl_files = _toefl_asset_configuration(root)
    auth = make_auth_handler(private)

    # Parse large AP text sets once per changed bank, not for every PDF request.
    bank_cache = {}
    bank_lock = threading.Lock()

    def read_sets(exam):
        folder = banks / exam
        if folder.is_symlink() or not folder.resolve().is_relative_to(private):
            return [], [{'file': exam, 'error': 'Invalid private bank directory.'}]
        paths = sorted(folder.glob('*.json'))
        try:
            signature = tuple((p.name, p.stat().st_mtime_ns, p.stat().st_size, p.is_symlink()) for p in paths)
        except OSError:
            signature = None
        with bank_lock:
            if exam == 'ap' and signature is not None and bank_cache.get(exam, (None,))[0] == signature:
                return bank_cache[exam][1]
            found, errors, seen = [], [], set()
            for path in paths:
                if path.is_symlink() or not path.is_file():
                    continue
                try:
                    if path.stat().st_size > MAX_BYTES:
                        raise ValueError('Question set exceeds 20 MB.')
                    document = json.loads(path.read_text(encoding='utf-8'))
                    (validate_ap_set if exam == 'ap' else validate_question_set)(document)
                    if document['exam'] != exam:
                        raise ValueError('Question set belongs to a different exam.')
                    # AP sources are revision-addressed and must be unambiguous.
                    # Keep v1/SAT's existing multi-file import semantics unchanged.
                    if exam == 'ap':
                        if document['id'] in seen:
                            raise ValueError('Duplicate question set id.')
                        seen.add(document['id'])
                    found.append((path, document))
                except (OSError, ValueError, KeyError, TypeError) as error:
                    errors.append({'file': path.name, 'error': str(error)})
            if exam == 'ap' and signature is not None:
                bank_cache[exam] = (signature, (found, errors))
            return found, errors

    def summary(document):
        if document.get('exam') == 'ap':
            return summarize_ap_set(document)
        return {'id': document['id'], 'title': document['title'],
                'questionCount': len(document['questions']),
                'section': document.get('section', ''),
                'defaultDurationSeconds': document.get('defaultDurationSeconds', 1920),
                'moduleCount': len(document.get('moduleQuestionCounts') or [len(document['questions'])])}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def reply(self, status, value):
            self.send_bytes(status, json.dumps(value, ensure_ascii=False).encode('utf-8'),
                            'application/json; charset=utf-8', cache='no-store')

        def send_bytes(self, status, body, content_type, cache='no-cache'):
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', cache)
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Referrer-Policy', 'same-origin')
            self.send_header('X-Frame-Options', 'DENY')
            self.end_headers()
            self.wfile.write(body)

        def send_ap_pdf(self, asset, *, head=False):
            # Authentication is required; only valid manifest-referenced PDFs may be served.
            rows, _ = read_sets('ap')
            if not AP_ASSET_RE.fullmatch(asset) or not any(
                    source['asset'] == asset for _, doc in rows for source in doc['documents']):
                return self.reply(404, {'error': 'Document not found.'})
            path = private / asset
            if (not path.is_file() or path.is_symlink()
                    or any(p.is_symlink() for p in path.parents if p != private.parent)
                    or not path.resolve().is_relative_to(private.resolve())):
                return self.reply(404, {'error': 'Document not found.'})
            try:
                with path.open('rb') as stream:
                    if stream.read(5) != b'%PDF-':
                        return self.reply(404, {'error': 'Invalid PDF document.'})
                    size = os.fstat(stream.fileno()).st_size
                    start, end, status = 0, size - 1, 200
                    value = self.headers.get('Range')
                    if value and not head:
                        match = re.fullmatch(r'bytes=(\d{0,20})-(\d{0,20})', value)
                        valid = bool(match and any(match.groups()))
                        if valid:
                            left, right = match.groups()
                            if left:
                                start, end = int(left), min(int(right), size - 1) if right else size - 1
                            else:
                                length = int(right)
                                start = max(0, size - length)
                                valid = length > 0
                            valid = valid and 0 <= start <= end < size
                        if not valid:
                            self.send_response(416)
                            self.send_header('Content-Range', f'bytes */{size}')
                            self.send_header('Content-Length', '0')
                            self.end_headers()
                            return
                        status = 206
                    self.send_response(status)
                    self.send_header('Content-Type', 'application/pdf')
                    self.send_header('Content-Length', str(end - start + 1))
                    self.send_header('Accept-Ranges', 'bytes')
                    self.send_header('Content-Disposition', 'inline; filename="ap-source.pdf"')
                    self.send_header('Cache-Control', 'private, no-store')
                    self.send_header('X-Content-Type-Options', 'nosniff')
                    self.send_header('Referrer-Policy', 'same-origin')
                    if status == 206:
                        self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
                    self.end_headers()
                    if not head:
                        stream.seek(start)
                        remaining = end - start + 1
                        while remaining:
                            chunk = stream.read(min(65536, remaining))
                            if not chunk:
                                break
                            self.wfile.write(chunk)
                            remaining -= len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass
            except OSError:
                # A resource removed during access must not expose a filesystem path.
                self.close_connection = True

        def do_HEAD(self):
            route = unquote(urlsplit(self.path).path)
            if (self.valid_host() and auth.authenticate(self.headers.get('Cookie', ''))
                    and route.startswith('/question-assets/ap/')):
                return self.send_ap_pdf(route[1:], head=True)
            self.send_response(404)
            self.send_header('Content-Length', '0')
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()

        def send_toefl_media(self, path):
            """Only reached after authentication and the TOEFL manifest allowlist."""
            size = path.stat().st_size
            start, end, status = 0, size - 1, 200
            requested = self.headers.get('Range')
            if requested:
                match = re.fullmatch(r'bytes=(\d{0,20})-(\d{0,20})', requested)
                if match and (match[1] or match[2]):
                    if match[1]:
                        start = int(match[1])
                        end = min(int(match[2]), size - 1) if match[2] else size - 1
                    elif int(match[2]) > 0:
                        start = max(0, size - int(match[2]))
                    else:
                        start = size
                else:
                    start = size
                if start >= size or start > end:
                    self.send_response(416)
                    self.send_header('Content-Range', f'bytes */{size}')
                    self.send_header('Content-Length', '0')
                    self.send_header('Cache-Control', 'no-store')
                    self.end_headers()
                    return
                status = 206
            self.send_response(status)
            self.send_header('Content-Type', mimetypes.guess_type(path.name)[0] or 'application/octet-stream')
            self.send_header('Content-Length', str(max(0, end - start + 1)))
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            if status == 206:
                self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
            self.end_headers()
            with path.open('rb') as stream:
                stream.seek(start)
                remaining = end - start + 1
                while remaining > 0:
                    chunk = stream.read(min(remaining, 128 * 1024))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)

        def valid_host(self):
            return self.headers.get('Host') == f'127.0.0.1:{self.server.server_port}'

        def redirect(self, location):
            self.send_response(302)
            self.send_header('Location', location)
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', '0')
            self.end_headers()

        def do_GET(self):
            if not self.valid_host():
                return self.reply(403, {'error': 'Open this workspace through its 127.0.0.1 URL.'})
            parsed = urlsplit(self.path)
            route = unquote(parsed.path)
            if '\x00' in route or '\\' in route or any(part in {'.', '..'} for part in route.split('/')):
                return self.reply(404, {'error': 'Not found.'})
            if route == '/api/platform/status':
                return self.reply(200, {'service': 'school-exam-platform-v1', 'project': project})
            if auth.handle(self, route):
                return
            session = auth.authenticate(self.headers.get('Cookie', ''))
            user = session['user'] if session else None
            public = (route in {'/login', '/login/', '/web/login.html'}
                      or route.startswith('/web/') and Path(route).suffix in {'.css', '.js', '.svg', '.png', '.ico'})
            if not user and not public:
                if route.startswith('/api/'):
                    return self.reply(401, {'error': '请先登录。'})
                if route in {'/', '/index.html', '/account', '/accounts', '/sat', '/sat/', '/toefl', '/toefl/', '/ap', '/ap/'} or route.endswith('.html'):
                    return self.redirect('/login?next=' + quote(self.path, safe=''))
                return self.reply(404, {'error': 'Not found.'})
            if route in {'/login', '/login/'} and user:
                return self.redirect('/')
            if route.startswith('/question-assets/ap/'):
                return self.send_ap_pdf(route[1:])
            if route == '/api/ap/example':
                try:
                    example = root / 'front-end/ap/examples/synthetic-practice.json'
                    if example.is_symlink() or not example.resolve().is_relative_to((root / 'front-end/ap').resolve()):
                        raise ValueError('Invalid example path.')
                    document = json.loads(example.read_text(encoding='utf-8'))
                    validate_ap_set(document)
                    if document['contentMode'] != 'synthetic' or document['documents']:
                        raise ValueError('Only original self-contained examples may be served here.')
                    return self.reply(200, document)
                except (OSError, ValueError, TypeError, KeyError):
                    return self.reply(503, {'error': 'AP 原创示例尚未就绪。'})
            if route == '/api/toefl/status':
                return self.reply(200, toefl_preview)
            if route == '/api/sat-packs':
                try:
                    return self.reply(200, read_sat_pack_collection(private))
                except (OSError, ValueError, TypeError, KeyError, ET.ParseError) as error:
                    return self.reply(400, {'error': str(error)})
            if route == '/api/sat-library/question-index':
                try:
                    with question_index_lock:
                        return self.reply(200, read_sat_library_question_index(library, question_index_cache))
                except OSError:
                    return self.reply(400, {'error': 'The local SAT library could not be read.'})
                except (ValueError, TypeError, KeyError):
                    return self.reply(400, {'error': 'The local SAT question index is unavailable.'})
            if route == '/api/sat-library' or route.startswith('/api/sat-library/collections/'):
                identity = None if route == '/api/sat-library' else route[len('/api/sat-library/collections/'):]
                try:
                    return self.reply(200, read_sat_library(library, identity))
                except FileNotFoundError:
                    return self.reply(404, {'error': 'SAT library collection not found.'})
                except OSError:
                    return self.reply(400, {'error': 'The local SAT library could not be read.'})
                except (ValueError, TypeError, KeyError, StopIteration, ET.ParseError) as error:
                    return self.reply(400, {'error': str(error)})
            if route == '/api/platform/catalog':
                exams, errors = [], []
                for exam, name in EXAMS.items():
                    rows, failures = read_sets(exam)
                    sources = [summary(document) for _, document in rows]
                    if exam == 'sat':
                        try:
                            collection = read_sat_pack_collection(private)
                            if collection['collectionId']:
                                sources = [{'id': p['id'], 'title': p['title'], 'questionCount': p['questionCount'],
                                            'section': 'Math' if p['section'] == 'math' else 'Reading and Writing',
                                            'defaultDurationSeconds': 2100 if p['section'] == 'math' else 1920,
                                            'moduleCount': 1, 'packRevision': p['revision'],
                                            'collectionId': collection['collectionId']} for p in collection['packs']]
                        except (OSError, ValueError, TypeError, KeyError, ET.ParseError) as error:
                            failures.append({'file': 'active SAT packages', 'error': str(error)})
                    shared_toefl = exam == 'toefl' and toefl_preview['available'] and toefl_preview['contentMode'] == 'shared-bank'
                    exams.append({'id': exam, 'name': name, 'available': exam == 'sat' or exam == 'ap' and (root / 'front-end/ap/index.html').is_file() or exam == 'toefl' and toefl_preview['available'],
                                  'questionCount': toefl_preview['questionCount'] if shared_toefl else sum(s['questionCount'] for s in sources),
                                  'sourceCount': toefl_preview['recordCount'] if shared_toefl else len(sources), 'sources': sources,
                                  'sections': sorted({s['section'] for s in sources if s['section']}),
                                  **({'preview': toefl_preview} if exam == 'toefl' else {})})
                    errors.extend({'exam': exam, **failure} for failure in failures)
                return self.reply(200, {'schemaVersion': 1, 'exams': exams, 'errors': errors,
                                        'auth': {'mode': 'session', 'loginEnabled': True, 'authenticated': True}})
            if route.startswith('/api/exams/'):
                parts = route.strip('/').split('/')
                if len(parts) not in {4, 5} or parts[2] not in EXAMS or parts[3] != 'sources':
                    return self.reply(404, {'error': 'Unknown exam interface.'})
                rows, errors = read_sets(parts[2])
                if len(parts) == 4:
                    return self.reply(200, {'schemaVersion': 2 if parts[2] == 'ap' else 1, 'exam': parts[2],
                                           'sources': [summary(d) for _, d in rows], 'errors': errors})
                document = next((d for _, d in rows if d['id'] == parts[4]), None)
                return self.reply(200, document) if document else self.reply(404, {'error': 'Source not found.'})
            if route == '/api/question-bank/status':
                return self.reply(200, {'service': 'sat-question-bank-v1', 'project': project,
                                       'name': 'SAT local question bank', 'token': token, 'writable': user['role'] == 'admin'})
            if route == '/api/question-bank':
                rows, failures = read_sets('sat')
                files = [{'name': p.name, 'text': json.dumps(to_sat_legacy(d), ensure_ascii=False),
                          'lastModified': round(p.stat().st_mtime * 1000)} for p, d in rows]
                return self.reply(200, {'files': files,
                                       'errors': [f"{e['file']}: {e['error']}" for e in failures]})
            if route in {'/sat', '/sat/'}:
                return self.redirect('/sat/html/index.html' + ('?' + parsed.query if parsed.query else ''))
            if route in {'/toefl', '/ap'}:
                return self.redirect(route + '/' + ('?' + parsed.query if parsed.query else ''))
            # Explicit application-only routes; repository metadata and private files
            # cannot be fetched as static content.
            if route in {'/', '/index.html'}:
                base, relative = root / 'front-end/web', 'index.html'
            elif route in {'/login', '/login/'}:
                base, relative = root / 'front-end/web', 'login.html'
            elif route in {'/account', '/accounts'}:
                base, relative = root / 'front-end/web', 'account.html'
            elif route == '/web/toefl-cloud.js':
                base, relative = root / 'front-end/toefl/clients', 'cloud-client.js'
            elif route.startswith('/web/'):
                base, relative = root / 'front-end/web', route[len('/web/'):]
                if Path(relative).suffix not in {'.html', '.css', '.js', '.svg', '.png', '.ico'}:
                    return self.reply(404, {'error': 'Not found.'})
            elif route.startswith('/ap/'):
                base, relative = root / 'front-end/ap', route[len('/ap/'):] or 'index.html'
                if relative not in AP_PUBLIC_FILES:
                    return self.reply(404, {'error': 'Not found.'})
            elif route.startswith('/toefl/'):
                if not toefl_preview['available']:
                    return self.reply(503, {'error': 'TOEFL 题库尚未准备完成，请重新启动平台以构建并校验资源。'})
                base = toefl_preview_root
                relative = route[len('/toefl/'):] or 'index.html'
                if relative not in toefl_files:
                    return self.reply(404, {'error': 'Not found.'})
            elif route.startswith('/sat/question-assets/') or route.startswith('/question-assets/'):
                prefix = '/sat/question-assets/' if route.startswith('/sat/') else '/question-assets/'
                base, relative = private / 'question-assets', route[len(prefix):]
                if Path(relative).suffix.lower() not in {'.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'}:
                    return self.reply(404, {'error': 'Not found.'})
            elif route.startswith('/sat/'):
                base, relative = root / 'front-end/sat', route[len('/sat/'):]
                namespace = relative.split('/')[0]
                if relative != 'html/index.html' and namespace not in {'js', 'css', 'data', 'vendor'}:
                    return self.reply(404, {'error': 'Not found.'})
                suffixes = {'.js', '.css', '.woff', '.woff2', '.ttf', '.otf'} if namespace == 'vendor' else {'.html', '.js', '.css', '.json'}
                if Path(relative).suffix.lower() not in suffixes:
                    return self.reply(404, {'error': 'Not found.'})
            else:
                return self.reply(404, {'error': 'Not found.'})
            if base == toefl_preview_root:
                try:
                    _safe_local_path(root, (base.relative_to(root) / relative).as_posix())
                except ValueError:
                    return self.reply(404, {'error': 'Not found.'})
            path = (base / relative).resolve()
            if not path.is_relative_to(base.resolve()) or not path.is_file():
                return self.reply(404, {'error': 'Not found.'})
            try:
                if base == toefl_preview_root and relative.startswith(('audio/', 'images/')):
                    return self.send_toefl_media(path)
                body = path.read_bytes()
                if path.suffix == '.html' and user and relative != 'login.html':
                    # HTML parses closing script tags before JavaScript parses JSON.
                    encoded = json.dumps({'authenticated': True, 'loginEnabled': True, 'user': user}, ensure_ascii=True).replace('<', '\\u003c')
                    bootstrap = ('<head><script>window.PlatformSession=' + encoded + ';</script>'
                                 '<script src="/web/platform-auth.js"></script>').encode()
                    body = body.replace(b'<head>', bootstrap, 1)
                if base == root / 'front-end/sat' and relative == 'html/index.html':
                    # Bootstrap only the platform adapter. The SAT source HTML,
                    # scripts and styles remain byte-for-byte unchanged on disk.
                    body = body.replace(b'</head>', b'<script src="/web/sat-bridge.js"></script><script src="/web/sat-account-sync.js"></script></head>', 1)
                elif base == toefl_preview_root and relative == 'index.html':
                    body = re.sub(rb'<script\b[^>]*\bsrc=[\"\'](?:\./)?four-(?:data|logic|learning|app)\.js(?:\?[^\"\']*)?[\"\'][^>]*>\s*</script>', b'', body)
                    body = body.replace(b'</head>', b'<script type="module" src="/web/toefl-bridge.js"></script></head>', 1)
                content_type = mimetypes.guess_type(path.name)[0] or 'application/octet-stream'
                if content_type.startswith('text/') or content_type in {'application/javascript', 'application/json'}:
                    content_type += '; charset=utf-8'
                return self.send_bytes(200, body, content_type, cache='no-store' if path.suffix == '.html' else 'no-cache')
            except OSError:
                return self.reply(404, {'error': 'Not found.'})

        def do_PUT(self):
            self.auth_mutation()

        def do_PATCH(self):
            self.auth_mutation()

        def auth_mutation(self):
            if not self.valid_host():
                return self.reply(403, {'error': 'Use the local workspace URL.'})
            if not auth.handle(self, urlsplit(self.path).path):
                self.reply(404, {'error': 'Not found.'})

        def do_POST(self):
            if not self.valid_host():
                return self.reply(403, {'error': 'Use the local workspace URL.'})
            if auth.handle(self, urlsplit(self.path).path):
                return
            session = auth.authenticate(self.headers.get('Cookie', ''))
            if not session:
                return self.reply(401, {'error': '请先登录。'})
            if urlsplit(self.path).path == '/api/question-bank' and session['user']['role'] != 'admin':
                return self.reply(403, {'error': '只有管理员可以修改共享题库。'})
            if self.headers.get('X-Account-ID') != session['user']['id']:
                return self.reply(409, {'error': '登录账号已变化，请重新打开页面。'})
            origin = f'http://127.0.0.1:{self.server.server_port}'
            if (not self.valid_host() or self.headers.get('Origin') != origin
                    or self.headers.get('X-SAT-Bank-Token') != token):
                return self.reply(403, {'error': 'Use the local workspace to import question files.'})
            route = urlsplit(self.path).path
            if route not in {'/api/question-bank', '/api/sat-library-backup'}:
                return self.reply(404, {'error': 'Not found.'})
            if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
                return self.reply(400, {'error': 'Expected JSON.'})
            try:
                length = int(self.headers.get('Content-Length', '0'))
                maximum = MAX_BACKUP_BYTES if route == '/api/sat-library-backup' else MAX_BYTES
                if not 0 < length <= maximum:
                    return self.reply(413, {'error': f'Request must be between 1 byte and {maximum // 1024 // 1024} MB.'})
                request = json.loads(self.rfile.read(length))
                if route == '/api/sat-library-backup':
                    if not isinstance(request, dict) or set(request) != {'collectionId', 'snapshot'}:
                        raise ValueError('A collection ID and browser snapshot are required.')
                    collection_id, snapshot = request['collectionId'], request['snapshot']
                    if (not isinstance(collection_id, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,99}', collection_id)
                            or not isinstance(snapshot, dict) or snapshot.get('schemaVersion') != 'sat-library-backup/1'
                            or snapshot.get('targetCollectionId') != collection_id
                            or any(not isinstance(snapshot.get(key), list) for key in ('sources', 'questions', 'attempts', 'wrongBook'))
                            or 'runtimeSnapshot' not in snapshot):
                        raise ValueError('Invalid browser library backup.')
                    active = _read_local_json(_safe_local_path(private / 'sat-packs', 'active.json'))
                    if active.get('collectionId') != collection_id:
                        raise ValueError('The active collection changed; retry the library backup.')
                    payload = (json.dumps(snapshot, ensure_ascii=False, sort_keys=True, separators=(',', ':')) + '\n').encode('utf-8')
                    digest = hashlib.sha256(payload).hexdigest()
                    owner = session['user']['id']
                    folder = _safe_local_path(private, f'backups/accounts/{owner}/{collection_id}')
                    folder.mkdir(parents=True, exist_ok=True)
                    target = _safe_local_path(private, f'backups/accounts/{owner}/{collection_id}/browser-{digest}.json')
                    with lock:
                        if not target.exists():
                            temporary = None
                            try:
                                with tempfile.NamedTemporaryFile(dir=folder, prefix='.browser-', suffix='.tmp', delete=False) as stream:
                                    temporary = stream.name
                                    stream.write(payload)
                                    stream.flush()
                                    os.fsync(stream.fileno())
                                os.link(temporary, target)
                            finally:
                                if temporary:
                                    os.unlink(temporary)
                    return self.reply(201, {'saved': True, 'collectionId': collection_id, 'name': target.name, 'sha256': digest})
                name, text = request['name'], request['text']
                if not isinstance(name, str) or not name.lower().endswith('.json') or any(c in name for c in '/\\\x00') or any(ord(c) < 32 for c in name):
                    raise ValueError('Use a plain JSON filename.')
                if not isinstance(text, str):
                    raise ValueError('Question content must be JSON text.')
                document = normalize_question_set(json.loads(text), exam='sat')
                validate_question_set(document)
                payload = (json.dumps(document, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
                digest = hashlib.sha256(payload).hexdigest()[:20]
                target = banks / 'sat' / f'sat-{digest}.json'
                with lock:
                    if target.is_symlink():
                        raise ValueError('Cannot import over a symbolic link.')
                    if not target.exists():
                        temporary = None
                        try:
                            with tempfile.NamedTemporaryFile(dir=target.parent, prefix='.import-', suffix='.tmp', delete=False) as stream:
                                temporary = stream.name
                                stream.write(payload)
                                stream.flush()
                                os.fsync(stream.fileno())
                            os.link(temporary, target)
                        finally:
                            if temporary:
                                os.unlink(temporary)
                return self.reply(201, {'name': target.name, 'lastModified': round(target.stat().st_mtime * 1000),
                                       'text': json.dumps(to_sat_legacy(document), ensure_ascii=False)})
            except (ValueError, KeyError, TypeError, OSError) as error:
                return self.reply(400, {'error': str(error)})

    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    server.auth = auth
    return server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=REPOSITORY)
    parser.add_argument('--port', type=int, default=8888)
    parser.add_argument('--sat-library-root', type=Path, help='Use only this SAT catalog folder; otherwise SAT_LIBRARY_ROOT or both repository gengdu-offline and pdf-official catalogs.')
    parser.add_argument('--open', action='store_true')
    args = parser.parse_args()
    prepare_toefl_preview(args.root)
    try:
        server = create_server(args.root, args.port, sat_library_root=args.sat_library_root)
    except OSError as error:
        # Double-clicking the launcher again opens only this same project.
        from urllib.request import urlopen
        expected = hashlib.sha256(str(args.root.resolve()).encode()).hexdigest()
        try:
            with urlopen(f'http://127.0.0.1:{args.port}/api/platform/status', timeout=2) as response:
                status = json.load(response)
            if status.get('service') != 'school-exam-platform-v1' or status.get('project') != expected:
                raise ValueError('Port is used by another project.')
        except (OSError, ValueError):
            raise SystemExit(f'Cannot start study workspace: {error}. Try a different --port.')
        if args.open:
            webbrowser.open(f'http://127.0.0.1:{args.port}/')
        return
    url = f'http://127.0.0.1:{server.server_port}/'
    print(f'Study workspace: {url}', flush=True)
    print('Keep this window open. Press Control-C to stop.', flush=True)
    if args.open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
