"""Math-contest schema, inert markup and private read-only store (stdlib only).

This is deliberately separate from the SAT single-choice schema. Only explicitly
selected source fields survive normalization; no student or arbitrary metadata is
copied. A revision covers the entire normalized exam, including answers, solutions,
quality, provenance and resource hashes, not merely its statements.
"""
from __future__ import annotations

import hashlib
import html
from html.parser import HTMLParser
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import struct
from urllib.parse import urlsplit
import xml.etree.ElementTree as ET
import zlib

CONTESTS = ('AMC10', 'AMC12', 'AIME', 'USAMO')
EXAMPLE_FILES = ('amc10.json', 'amc12.json', 'aime.json', 'usamo.json')
ID_RE = re.compile(r'[a-z0-9][a-z0-9-]{0,127}\Z')
HASH_RE = re.compile(r'[0-9a-f]{64}\Z')
MAX_JSON_BYTES = 160 * 1024 * 1024
MAX_ASSET_BYTES = 16 * 1024 * 1024
MATHJAX_VERSION = '3.2.2'
MATHJAX_INTEGRITY = 'sha512-Bt+SSVU8eBG27zChVewOicYs7Xsdt40qm4+UpHyX7k0/O9NliPc+x77k1/FEsPsjKPZGJvtRZM1vO+geW0OhGw=='


def canonical_bytes(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'),
                       allow_nan=False) + '\n').encode('utf-8')


def digest(value):
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate JSON field.')
        result[key] = value
    return result


def decode_json(body):
    return json.loads(body, object_pairs_hook=_pairs,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError('Non-finite JSON value.')))


def no_symlinks(path):
    """Reject symlinks/junctions in every existing ancestor, not just the leaf."""
    path = Path(path).absolute()
    for part in (path, *path.parents):
        try:
            info = part.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise ValueError('Symbolic links and junctions are not permitted.')
    return path


def relative_path(value):
    if (not isinstance(value, str) or not value or len(value) > 500
            or not re.fullmatch(r'[A-Za-z0-9_./-]+', value)
            or any(p in {'', '.', '..'} for p in value.split('/'))
            or PurePosixPath(value).is_absolute()):
        raise ValueError('Unsafe relative resource path.')
    return value


def safe_path(root, relative, *, exists=True):
    relative_path(relative)
    root = no_symlinks(root).resolve()
    path = no_symlinks(root / relative)
    if not path.resolve().is_relative_to(root):
        raise ValueError('Resource is outside its boundary.')
    if exists and not path.is_file():
        raise ValueError('Resource is missing or not a regular file.')
    return path


def read_json(path, limit=MAX_JSON_BYTES):
    path = no_symlinks(path)
    if not path.is_file() or path.stat().st_size > limit:
        raise ValueError('Missing or oversized JSON input.')
    return decode_json(path.read_bytes())


def _text(value, field, *, limit=2_000_000, empty=True):
    if not isinstance(value, str) or len(value) > limit:
        raise ValueError('Invalid text field: ' + field)
    # Keep meaningful newline/tab formatting but no hidden control characters.
    value = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', '', value)
    if not empty and not value.strip():
        raise ValueError('Empty text field: ' + field)
    return value


def _identifier(value):
    if not isinstance(value, str) or not ID_RE.fullmatch(value):
        raise ValueError('Invalid contest identifier.')
    return value


def _integer(value, low, high, field):
    if type(value) is not int or not low <= value <= high:
        raise ValueError('Invalid integer field: ' + field)
    return value


def http_url(value):
    if not isinstance(value, str) or len(value) > 4096:
        return ''
    # HTMLParser already decodes entities. Remove browser-ignored controls before
    # scheme checks, so a newline-prefixed javascript: never survives.
    value = re.sub(r'[\x00-\x20\x7f]', '', value)
    if '\\' in value:
        return ''
    try:
        parts = urlsplit(value)
        if (parts.scheme.lower() not in {'http', 'https'} or not parts.hostname
                or parts.username is not None or parts.password is not None):
            return ''
        _ = parts.port
    except ValueError:
        return ''
    return value


def source_object(value):
    if value is None or value == {}:
        return {}
    if not isinstance(value, dict):
        raise ValueError('Invalid source object.')
    out = {}
    if isinstance(value.get('dataset'), str):
        out['dataset'] = _text(value['dataset'], 'dataset', limit=200)
    if http_url(value.get('url')):
        out['url'] = http_url(value['url'])
    # record_id is source identity, never an arbitrary nested metadata object.
    if isinstance(value.get('record_id'), (str, int)) and not isinstance(value['record_id'], bool):
        out['record_id'] = _text(str(value['record_id']), 'record_id', limit=4096)
    out['official_live_verified'] = False
    return out


def _flags(value):
    if not isinstance(value, list) or len(value) > 100:
        raise ValueError('Invalid quality flags.')
    if any(not isinstance(x, str) or not re.fullmatch(r'[a-zA-Z0-9_:-]{1,120}', x) for x in value):
        raise ValueError('Invalid quality flag.')
    return sorted(set(value))


class _Sanitizer(HTMLParser):
    TAGS = frozenset('p div span br strong b em i u s sub sup pre code blockquote ul ol li table thead tbody tfoot tr td th figure figcaption a img hr'.split())
    DROP = frozenset('script style iframe object embed form input button textarea select option svg math template noscript'.split())
    VOID = frozenset({'br', 'img', 'hr'})
    CLASSES = frozenset({'latex-text', 'math-inline', 'math-display', 'asymptote-source', 'aime-statement'})

    def __init__(self, assets):
        super().__init__(convert_charrefs=True)
        self.assets, self.images, self.output, self.stack, self.dropped = set(assets), set(), [], [], []

    def handle_starttag(self, tag, attrs):
        if self.dropped:
            if tag in self.DROP and tag not in {'input', 'embed'}:
                self.dropped.append(tag)
            return
        if tag in self.DROP:
            if tag not in {'input', 'embed'}:
                self.dropped.append(tag)
            return
        if tag not in self.TAGS:
            return
        attributes = dict(attrs)
        safe = {}
        if tag == 'img':
            src = attributes.get('src', '') or ''
            if src.startswith('/contest-assets/'):
                src = src[len('/contest-assets/'):]
            try:
                asset_path(src)
            except ValueError:
                return  # remote, data:, script URLs and malformed paths are inert
            if src not in self.assets:
                raise ValueError('HTML image lacks explicit asset metadata.')
            self.images.add(src)
            safe['src'] = '/contest-assets/' + src
            safe['alt'] = _text(attributes.get('alt') or '', 'alt', limit=2000)
        elif tag == 'a':
            href = http_url(attributes.get('href'))
            if href:
                safe.update(href=href, rel='noopener noreferrer', target='_blank')
        if 'class' in attributes:
            classes = sorted(self.CLASSES.intersection((attributes['class'] or '').split()))
            if classes:
                safe['class'] = ' '.join(classes)
        for key in ('colspan', 'rowspan') if tag in {'td', 'th'} else ():
            if re.fullmatch(r'[1-9][0-9]?', attributes.get(key) or ''):
                safe[key] = attributes[key]
        self.output.append('<' + tag + ''.join(' ' + k + '="' + html.escape(v, quote=True) + '"' for k, v in safe.items()) + '>')
        if tag not in self.VOID:
            self.stack.append(tag)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if self.dropped:
            if tag == self.dropped[-1]:
                self.dropped.pop()
            return
        if tag in self.stack:
            while self.stack:
                closing = self.stack.pop()
                self.output.append('</' + closing + '>')
                if closing == tag:
                    break

    def handle_data(self, data):
        if not self.dropped:
            self.output.append(html.escape(_text(data, 'html'), quote=False))

    def finish(self):
        self.close()
        while self.stack:
            self.output.append('</' + self.stack.pop() + '>')
        return ''.join(self.output), self.images


def sanitize_html(value, assets=()):
    parser = _Sanitizer(assets)
    parser.feed(_text(value, 'html'))
    return parser.finish()


def asset_path(value):
    relative_path(value)
    if not value.startswith('assets/') or Path(value).suffix.lower() not in {'.svg', '.png', '.jpg', '.jpeg'}:
        raise ValueError('Only local SVG, PNG and JPEG contest assets are supported.')
    return value


def _asset_records(values):
    if not isinstance(values, list) or len(values) > 200:
        raise ValueError('Invalid asset list.')
    output = {}
    for item in values:
        if not isinstance(item, dict):
            raise ValueError('Invalid asset metadata.')
        path = item.get('local_path')
        if path is None:
            continue
        asset_path(path)
        sha = item.get('sha256')
        if not isinstance(sha, str) or not HASH_RE.fullmatch(sha):
            raise ValueError('Local images require SHA256.')
        record = {'local_path': path, 'sha256': sha}
        if 'bytes' in item:
            record['bytes'] = _integer(item['bytes'], 1, MAX_ASSET_BYTES, 'asset.bytes')
        url = http_url(item.get('url'))
        if url:
            record['url'] = url
        if item.get('status') in {'downloaded', 'derived_rendering'}:
            record['status'] = item['status']
        if path in output and output[path] != record:
            raise ValueError('Conflicting image metadata.')
        output[path] = record
    return output


def normalize_problem(raw):
    if not isinstance(raw, dict):
        raise ValueError('Each problem must be an object.')
    contest = raw.get('contest')
    if contest not in CONTESTS:
        raise ValueError('Unsupported contest.')
    kind = {'AMC10': 'multiple_choice', 'AMC12': 'multiple_choice', 'AIME': 'integer', 'USAMO': 'proof'}[contest]
    if raw.get('question_type') != kind:
        raise ValueError('Question type does not match contest.')
    eid, pid = _identifier(raw.get('exam_id')), _identifier(raw.get('id'))
    number = _integer(raw.get('number'), 1, 100, 'number')
    if pid != f'{eid}-{number:02d}':
        raise ValueError('Problem identity does not match its exam and number.')
    year = _integer(raw.get('year'), 1900, 2200, 'year')
    if raw.get('season') not in {'regular', 'spring', 'fall'} or raw.get('paper') not in {None, 'A', 'B', 'I', 'II', 'P'}:
        raise ValueError('Invalid season or paper.')
    if type(raw.get('special_paper')) is not bool or raw['special_paper'] != (raw.get('paper') == 'P'):
        raise ValueError('Invalid special-paper marker.')
    out = {key: raw[key] for key in ('id', 'exam_id', 'contest', 'year', 'season', 'paper', 'number', 'question_type', 'special_paper')}
    assets = _asset_records(raw.get('assets', []))
    used = set()

    def section(value, require_text=False):
        if not isinstance(value, dict):
            raise ValueError('Invalid content section.')
        text = _text(value.get('text_latex'), 'text_latex', empty=not require_text)
        rendered, references = sanitize_html(value.get('html'), assets)
        used.update(references)
        if not rendered.strip():
            rendered = '<div class="latex-text">' + html.escape(text) + '</div>'
        return {'text_latex': text, 'html': rendered}

    statement = raw.get('statement')
    out['statement'] = section(statement, True)
    out['statement']['html_includes_choices'] = statement.get('html_includes_choices') is True
    if 'source' in statement:
        out['statement']['source'] = source_object(statement['source'])
    choices = raw.get('choices')
    if not isinstance(choices, list) or len(choices) > 5:
        raise ValueError('Invalid choices.')
    if kind == 'multiple_choice' and [c.get('label') for c in choices if isinstance(c, dict)] != list('ABCDE'):
        raise ValueError('AMC problems require exactly A through E.')
    if kind != 'multiple_choice' and choices:
        raise ValueError('Non-choice problems cannot have choices.')
    out['choices'] = [dict(label=c['label'], **section(c)) for c in choices]
    answer = raw.get('answer')
    if kind == 'proof':
        if answer is not None:
            raise ValueError('Proof problems cannot carry scalar grading answers.')
        out['answer'] = None
    elif not isinstance(answer, dict):
        raise ValueError('An objective answer is required.')
    elif kind == 'multiple_choice':
        accepted = answer.get('accepted')
        if (answer.get('type') != 'choice' or not isinstance(accepted, list) or not accepted
                or any(type(x) is not str or x not in list('ABCDE') for x in accepted)
                or len(set(accepted)) != len(accepted)):
            raise ValueError('Invalid accepted choice answers.')
        accepted = sorted(accepted)
        out['answer'] = {'type': 'choice', 'accepted': accepted, 'display': ' or '.join(accepted)}
    else:
        if answer.get('type') != 'integer':
            raise ValueError('Invalid integer answer type.')
        value = _integer(answer.get('value'), 0, 999, 'answer.value')
        out['answer'] = {'type': 'integer', 'value': value, 'display': f'{value:03d}'}
    if out['answer'] is not None:
        if 'source' in answer:
            out['answer']['source'] = source_object(answer['source'])
        verification = answer.get('verification')
        out['answer']['verification'] = verification if verification in {'synthetic_example', 'cross_source_agreement', 'single_source_or_disputed', 'unreviewed_mirror'} else 'unreviewed_mirror'
    solutions = raw.get('solutions', [])
    if not isinstance(solutions, list) or len(solutions) > 100:
        raise ValueError('Invalid solution list.')
    out['solutions'] = []
    for solution in solutions:
        item = section(solution)
        item.update(title=_text(solution.get('title', 'Reference solution'), 'title', limit=300),
                    verification='synthetic_example' if solution.get('verification') == 'synthetic_example' else 'unreviewed_mirror',
                    quality_flags=_flags(solution.get('quality_flags', [])),
                    source=source_object(solution.get('source')))
        out['solutions'].append(item)
    quality = raw.get('quality')
    if not isinstance(quality, dict):
        raise ValueError('Quality metadata is required.')
    flags = _flags(quality.get('flags', []))
    disputed = any(any(word in f.lower() for word in ('disagree', 'dispute', 'conflict')) for f in flags)
    structural = quality.get('structurally_complete') is True
    ready = structural and quality.get('ready_for_practice') is True and not disputed
    out['quality'] = {'flags': flags, 'structurally_complete': structural,
                      'ready_for_practice': ready, 'auto_gradable': bool(ready and out['answer'] is not None and quality.get('auto_gradable') is True),
                      'solutions_reviewed': False}
    out['source_url'] = http_url(raw.get('source_url'))
    provenance = raw.get('provenance', [])
    if not isinstance(provenance, list) or len(provenance) > 100:
        raise ValueError('Invalid provenance.')
    out['provenance'] = [source_object(x) for x in provenance]
    out['assets'] = [assets[name] for name in sorted(used)]
    return out


def normalize_exam(raw, problems, mode='private'):
    if mode not in {'private', 'example'} or not isinstance(raw, dict):
        raise ValueError('Invalid exam mode or metadata.')
    eid = _identifier(raw.get('id'))
    if not isinstance(problems, list) or not 1 <= len(problems) <= 100:
        raise ValueError('An exam needs between 1 and 100 problems.')
    rows = sorted([normalize_problem(p) for p in problems], key=lambda p: p['number'])
    numbers = [p['number'] for p in rows]
    if len(set(numbers)) != len(numbers):
        raise ValueError('Duplicate problem number.')
    fields = ('contest', 'year', 'season', 'paper', 'special_paper')
    for p in rows:
        if p['exam_id'] != eid or any(p[k] != raw.get(k) for k in fields):
            raise ValueError('Exam and problem metadata differ.')
    expected = _integer(raw.get('expected_problem_count'), 1, 100, 'expected_problem_count')
    if numbers[-1] > expected:
        raise ValueError('Problem number exceeds expected count.')
    missing = sorted(set(range(1, expected + 1)) - set(numbers))
    if raw.get('problem_count') != len(rows) or raw.get('missing_numbers') != missing:
        raise ValueError('Exam coverage metadata does not match records.')
    summary = {'id': eid, **{k: rows[0][k] for k in fields}, 'problem_count': len(rows),
               'expected_problem_count': expected, 'missing_numbers': missing}
    season = {'spring': 'Spring', 'fall': 'Fall', 'regular': ''}[summary['season']]
    title = ' '.join(str(v) for v in (summary['contest'], summary['year'], season, summary['paper']) if v)
    summary['title'] = ('原创示例（非官方） · ' if mode == 'example' else '') + title
    document = {'id': eid, 'mode': mode, 'problems': rows}
    revision = digest({'exam': summary, **document})
    summary['revision'] = document['revision'] = revision
    return summary, document


SVG_NS = 'http://www.w3.org/2000/svg'
SVG_TAGS = frozenset('svg g defs path use circle ellipse line polyline polygon rect text tspan title desc clipPath mask linearGradient radialGradient stop'.split())
SVG_ATTRS = frozenset('id d transform fill stroke stroke-width stroke-linecap stroke-linejoin stroke-miterlimit x y x1 x2 y1 y2 cx cy r rx ry width height viewBox version stroke-dasharray stroke-dashoffset opacity fill-opacity stroke-opacity clip-path clip-rule fill-rule points offset stop-color stop-opacity gradientUnits gradientTransform fx fy role aria-label text-anchor dominant-baseline font-family font-size font-weight preserveAspectRatio'.split())


def validate_image(body, path):
    asset_path(path)
    if not 0 < len(body) <= MAX_ASSET_BYTES:
        raise ValueError('Invalid image size.')
    suffix = Path(path).suffix.lower()
    if suffix == '.svg':
        try:
            xml_text = body.decode('utf-8-sig')
        except UnicodeDecodeError as error:
            raise ValueError('SVG must use UTF-8 encoding.') from error
        if '\x00' in xml_text:
            raise ValueError('SVG contains forbidden controls or a non-UTF8 encoding.')
        if re.search(br'<!\s*(?:DOCTYPE|ENTITY)|<\?', body, re.I):
            # An ordinary XML declaration is harmless; no other PI or DTD.
            without_decl = re.sub(br'^\s*<\?xml\s+[^?]*\?>', b'', body, count=1)
            if re.search(br'<!\s*(?:DOCTYPE|ENTITY)|<\?', without_decl, re.I):
                raise ValueError('SVG declarations/entities are not allowed.')
        try:
            tree = ET.fromstring(body)
        except ET.ParseError as error:
            raise ValueError('Invalid SVG XML.') from error
        if tree.tag != '{' + SVG_NS + '}svg':
            raise ValueError('Expected an SVG document.')
        for node in tree.iter():
            if not isinstance(node.tag, str) or not node.tag.startswith('{' + SVG_NS + '}') or node.tag.split('}', 1)[1] not in SVG_TAGS:
                raise ValueError('Unsafe SVG element.')
            for name, value in node.attrib.items():
                if name in {'href', '{http://www.w3.org/1999/xlink}href'}:
                    if not re.fullmatch(r'#[A-Za-z_][A-Za-z0-9_.:-]*', value):
                        raise ValueError('SVG external references are forbidden.')
                elif name not in SVG_ATTRS and name != '{http://www.w3.org/XML/1998/namespace}space':
                    raise ValueError('Unsafe SVG attribute.')
                if re.search(r'url\s*\(', value, re.I) and not re.fullmatch(r'url\(#[A-Za-z_][A-Za-z0-9_.:-]*\)', value):
                    raise ValueError('SVG external CSS resources are forbidden.')
                if re.search(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]|javascript:|data:|expression\s*\(', value, re.I):
                    raise ValueError('Unsafe SVG attribute value.')
        return 'image/svg+xml'
    if suffix == '.png':
        if not body.startswith(b'\x89PNG\r\n\x1a\n'):
            raise ValueError('Invalid PNG signature.')
        pos, chunks = 8, []
        while pos + 12 <= len(body):
            length = int.from_bytes(body[pos:pos + 4], 'big')
            kind = body[pos + 4:pos + 8]
            end = pos + 12 + length
            if end > len(body) or zlib.crc32(body[pos + 4:end - 4]) & 0xffffffff != int.from_bytes(body[end - 4:end], 'big'):
                raise ValueError('PNG chunk integrity failure.')
            chunks.append(kind)
            if kind == b'IHDR':
                if length != 13 or not all(0 < n <= 40000 for n in struct.unpack('>II', body[pos + 8:pos + 16])):
                    raise ValueError('Invalid PNG dimensions.')
            pos = end
            if kind == b'IEND':
                break
        if pos != len(body) or not chunks or chunks[0] != b'IHDR' or chunks[-1] != b'IEND' or b'IDAT' not in chunks:
            raise ValueError('Invalid PNG chunks.')
        return 'image/png'
    if not (body.startswith(b'\xff\xd8\xff') and body.endswith(b'\xff\xd9')):
        raise ValueError('Invalid JPEG signature.')
    return 'image/jpeg'


def verify_version(folder, revision):
    """Validate every immutable payload and its manifest before activation."""
    folder = no_symlinks(folder)
    manifest_path = safe_path(folder, 'manifest.json')
    body = manifest_path.read_bytes()
    if hashlib.sha256(body).hexdigest() != revision:
        raise ValueError('Version manifest hash mismatch.')
    manifest = decode_json(body)
    if manifest.get('schemaVersion') != 1 or not isinstance(manifest.get('files'), dict):
        raise ValueError('Unsupported contest store format.')
    for relative, sha in manifest['files'].items():
        if not isinstance(sha, str) or not HASH_RE.fullmatch(sha):
            raise ValueError('Invalid payload hash.')
        payload = safe_path(folder, relative).read_bytes()
        if hashlib.sha256(payload).hexdigest() != sha:
            raise ValueError('Contest payload hash mismatch.')
        if relative.startswith('assets/'):
            validate_image(payload, relative)
    return manifest


class ContestStore:
    """Only active, hashed payloads are readable; examples are opt-in and isolated."""
    def __init__(self, repository, private_root):
        self.repository = Path(repository).absolute()
        self.private = Path(private_root).absolute()

    def _active(self):
        base = no_symlinks(self.private / 'contests')
        pointer = no_symlinks(base / 'current.json')
        if not pointer.exists():
            return None, None
        state = read_json(pointer, 4096)
        version = state.get('version') if isinstance(state, dict) else None
        if not isinstance(version, str) or not HASH_RE.fullmatch(version):
            raise ValueError('Invalid active contest version.')
        folder = safe_path(base, 'versions/' + version + '/manifest.json').parent
        body = safe_path(folder, 'manifest.json').read_bytes()
        if hashlib.sha256(body).hexdigest() != version:
            raise ValueError('Contest manifest failed integrity verification.')
        info = decode_json(body)
        if info.get('schemaVersion') != 1 or not isinstance(info.get('exams'), list) or not isinstance(info.get('files'), dict) or not isinstance(info.get('assets'), dict):
            raise ValueError('Invalid contest manifest.')
        return folder, info

    def _examples(self):
        result = []
        base = self.repository / 'apps/contests/examples'
        for name in EXAMPLE_FILES:
            path = no_symlinks(base / name)
            if not path.exists():
                continue
            item = read_json(path, 2 * 1024 * 1024)
            if not isinstance(item, dict) or item.get('example') is not True:
                raise ValueError('Invalid original example marker.')
            result.append(normalize_exam(item['exam'], item['problems'], 'example'))
        return result

    def catalog(self, mode='private'):
        if mode not in {'private', 'example'}:
            raise ValueError('Unknown contest mode.')
        result = {'mode': mode, 'exams': [], 'totalProblems': 0, 'errors': [],
                  'mathjaxAvailable': self.mathjax_available()}
        try:
            if mode == 'example':
                result['exams'] = [summary for summary, _ in self._examples()]
            else:
                _, manifest = self._active()
                if manifest:
                    # Do not spread arbitrary manifest metadata into the response.
                    fields = ('id', 'contest', 'year', 'season', 'paper', 'special_paper', 'problem_count',
                              'expected_problem_count', 'missing_numbers', 'revision', 'title')
                    result['exams'] = [{k: item[k] for k in fields} for item in manifest['exams']]
            result['totalProblems'] = sum(e['problem_count'] for e in result['exams'])
        except (OSError, ValueError, TypeError, KeyError):
            result['exams'] = []
            result['errors'] = ['Contest data failed validation; re-import a verified bank.']
        return result

    def exam(self, eid, mode='private'):
        _identifier(eid)
        if mode == 'example':
            return next((doc for _, doc in self._examples() if doc['id'] == eid), None)
        if mode != 'private':
            raise ValueError('Unknown contest mode.')
        folder, manifest = self._active()
        if not manifest:
            return None
        summary = next((s for s in manifest['exams'] if s['id'] == eid), None)
        if summary is None:
            return None
        name = 'exams/' + eid + '.json'
        body = safe_path(folder, name).read_bytes()
        if hashlib.sha256(body).hexdigest() != manifest['files'].get(name):
            raise ValueError('Exam failed integrity verification.')
        raw = decode_json(body)
        checked_summary, document = normalize_exam(summary, raw['problems'])
        if checked_summary != summary or document != raw:
            raise ValueError('Exam normalization or revision mismatch.')
        return document

    def asset(self, relative):
        asset_path(relative)
        folder, manifest = self._active()
        if not manifest or relative not in manifest['assets']:
            return None
        body = safe_path(folder, relative).read_bytes()
        if hashlib.sha256(body).hexdigest() != manifest['assets'][relative] or manifest['files'].get(relative) != manifest['assets'][relative]:
            raise ValueError('Asset integrity failure.')
        return body, validate_image(body, relative)

    def vendor(self, relative):
        relative_path(relative)
        if not relative.startswith('es5/') or not relative.endswith('.js'):
            return None
        base = self.private / 'contest-vendor/mathjax'
        manifest = read_json(safe_path(base, 'manifest.json'), 200000)
        if manifest.get('version') != MATHJAX_VERSION or manifest.get('integrity') != MATHJAX_INTEGRITY:
            raise ValueError('MathJax installation is not pinned.')
        sha = manifest.get('files', {}).get(relative)
        if not isinstance(sha, str) or not HASH_RE.fullmatch(sha):
            return None
        body = safe_path(base, relative).read_bytes()
        if hashlib.sha256(body).hexdigest() != sha:
            raise ValueError('MathJax file integrity failure.')
        return body, 'application/javascript; charset=utf-8'

    def mathjax_available(self):
        try:
            return bool(self.vendor('es5/tex-svg.js') and self.vendor('es5/ui/safe.js'))
        except (OSError, ValueError, KeyError, TypeError):
            return False
