#!/usr/bin/env python3
"""Local, loopback-only entry point for the unified study workspace.

Question banks are local private files. No authentication or cloud storage is
implemented by this development server; it must not be exposed to a network.
"""
import argparse
import hashlib
import json
import mimetypes
import os
from pathlib import Path
import secrets
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit
import webbrowser

REPOSITORY = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPOSITORY))
from shared.question_schema import normalize_question_set, to_sat_legacy, validate_question_set

MAX_BYTES = 20 * 1024 * 1024
EXAMS = {'sat': 'SAT', 'ap': 'AP', 'toefl': 'TOEFL', 'vocab': 'Personal Vocab'}


def create_server(root=REPOSITORY, port=8888, private_root=None):
    root = Path(root).resolve()
    private = Path(private_root).resolve() if private_root else root / 'private-data'
    banks = private / 'question-banks'
    for exam in EXAMS:
        folder = banks / exam
        folder.mkdir(parents=True, exist_ok=True)
        if folder.is_symlink() or not folder.resolve().is_relative_to(private):
            raise ValueError('Question banks must be real folders inside private-data.')
    token = secrets.token_urlsafe(32)
    project = hashlib.sha256(str(root).encode()).hexdigest()
    lock = threading.Lock()

    def read_sets(exam):
        found, errors = [], []
        for path in sorted((banks / exam).glob('*.json')):
            if path.is_symlink() or not path.is_file():
                continue
            try:
                if path.stat().st_size > MAX_BYTES:
                    raise ValueError('Question set exceeds 20 MB.')
                document = json.loads(path.read_text(encoding='utf-8'))
                validate_question_set(document)
                if document['exam'] != exam:
                    raise ValueError('Question set belongs to a different exam.')
                found.append((path, document))
            except (OSError, ValueError, KeyError, TypeError) as error:
                errors.append({'file': path.name, 'error': str(error)})
        return found, errors

    def summary(document):
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
            self.end_headers()
            self.wfile.write(body)

        def valid_host(self):
            return self.headers.get('Host') == f'127.0.0.1:{self.server.server_port}'

        def redirect(self, location):
            self.send_response(302)
            self.send_header('Location', location)
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
            if route == '/api/auth/session':
                return self.reply(200, {'mode': 'guest', 'loginEnabled': False, 'user': None})
            if route == '/api/platform/catalog':
                exams, errors = [], []
                for exam, name in EXAMS.items():
                    rows, failures = read_sets(exam)
                    sources = [summary(document) for _, document in rows]
                    exams.append({'id': exam, 'name': name, 'available': exam == 'sat',
                                  'questionCount': sum(s['questionCount'] for s in sources),
                                  'sourceCount': len(sources), 'sources': sources,
                                  'sections': sorted({s['section'] for s in sources if s['section']})})
                    errors.extend({'exam': exam, **failure} for failure in failures)
                return self.reply(200, {'schemaVersion': 1, 'exams': exams, 'errors': errors,
                                        'auth': {'mode': 'guest', 'loginEnabled': False}})
            if route.startswith('/api/exams/'):
                parts = route.strip('/').split('/')
                if len(parts) not in {4, 5} or parts[2] not in EXAMS or parts[3] != 'sources':
                    return self.reply(404, {'error': 'Unknown exam interface.'})
                rows, errors = read_sets(parts[2])
                if len(parts) == 4:
                    return self.reply(200, {'schemaVersion': 1, 'exam': parts[2],
                                           'sources': [summary(d) for _, d in rows], 'errors': errors})
                document = next((d for _, d in rows if d['id'] == parts[4]), None)
                return self.reply(200, document) if document else self.reply(404, {'error': 'Source not found.'})
            if route == '/api/question-bank/status':
                return self.reply(200, {'service': 'sat-question-bank-v1', 'project': project,
                                       'name': 'SAT local question bank', 'token': token, 'writable': True})
            if route == '/api/question-bank':
                rows, failures = read_sets('sat')
                files = [{'name': p.name, 'text': json.dumps(to_sat_legacy(d), ensure_ascii=False),
                          'lastModified': round(p.stat().st_mtime * 1000)} for p, d in rows]
                return self.reply(200, {'files': files,
                                       'errors': [f"{e['file']}: {e['error']}" for e in failures]})
            if route in {'/sat', '/sat/'}:
                return self.redirect('/sat/html/index.html' + ('?' + parsed.query if parsed.query else ''))
            # Explicit application-only routes; repository metadata and private files
            # cannot be fetched as static content.
            if route in {'/', '/index.html'}:
                base, relative = root / 'apps/web', 'index.html'
            elif route.startswith('/web/'):
                base, relative = root / 'apps/web', route[len('/web/'):]
                if Path(relative).suffix not in {'.html', '.css', '.js', '.svg', '.png', '.ico'}:
                    return self.reply(404, {'error': 'Not found.'})
            elif route.startswith('/sat/question-assets/') or route.startswith('/question-assets/'):
                prefix = '/sat/question-assets/' if route.startswith('/sat/') else '/question-assets/'
                base, relative = private / 'question-assets', route[len(prefix):]
                if Path(relative).suffix.lower() not in {'.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'}:
                    return self.reply(404, {'error': 'Not found.'})
            elif route.startswith('/sat/'):
                base, relative = root / 'apps/sat', route[len('/sat/'):]
                if relative != 'html/index.html' and relative.split('/')[0] not in {'js', 'css', 'data'}:
                    return self.reply(404, {'error': 'Not found.'})
                if Path(relative).suffix not in {'.html', '.js', '.css', '.json'}:
                    return self.reply(404, {'error': 'Not found.'})
            else:
                return self.reply(404, {'error': 'Not found.'})
            path = (base / relative).resolve()
            if not path.is_relative_to(base.resolve()) or not path.is_file():
                return self.reply(404, {'error': 'Not found.'})
            try:
                body = path.read_bytes()
                if base == root / 'apps/sat' and relative == 'html/index.html':
                    # Bootstrap only the platform adapter. The SAT source HTML,
                    # scripts and styles remain byte-for-byte unchanged on disk.
                    body = body.replace(b'<head>', b'<head><script src="/web/sat-bridge.js"></script>', 1)
                content_type = mimetypes.guess_type(path.name)[0] or 'application/octet-stream'
                if content_type.startswith('text/') or content_type in {'application/javascript', 'application/json'}:
                    content_type += '; charset=utf-8'
                return self.send_bytes(200, body, content_type)
            except OSError:
                return self.reply(404, {'error': 'Not found.'})

        def do_POST(self):
            origin = f'http://127.0.0.1:{self.server.server_port}'
            if (not self.valid_host() or self.headers.get('Origin') != origin
                    or self.headers.get('X-SAT-Bank-Token') != token):
                return self.reply(403, {'error': 'Use the local workspace to import question files.'})
            if urlsplit(self.path).path != '/api/question-bank':
                return self.reply(404, {'error': 'Not found.'})
            if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
                return self.reply(400, {'error': 'Expected JSON.'})
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= MAX_BYTES:
                    return self.reply(413, {'error': 'Imports must be between 1 byte and 20 MB.'})
                request = json.loads(self.rfile.read(length))
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

    return ThreadingHTTPServer(('127.0.0.1', port), Handler)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=REPOSITORY)
    parser.add_argument('--port', type=int, default=8888)
    parser.add_argument('--open', action='store_true')
    args = parser.parse_args()
    try:
        server = create_server(args.root, args.port)
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
