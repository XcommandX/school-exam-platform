"""Loopback-only SAT frontend; runtime data stays under local-data. Standard library only."""
import argparse
import hashlib
import json
import mimetypes
import os
from pathlib import Path
import secrets
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit
import webbrowser

MAX_BYTES = 20 * 1024 * 1024
REPOSITORY = Path(__file__).resolve().parents[3]
FRONTEND_ROOT = REPOSITORY / 'front-end/sat'
DATA_ROOT = REPOSITORY / 'local-data/standalone-sat'


def create_server(root=None, port=8876, data_root=None):
    root = Path(root or FRONTEND_ROOT).resolve()
    data_root = Path(os.path.abspath(data_root or DATA_ROOT))
    if any(path.is_symlink() for path in (data_root, *data_root.parents)):
        raise ValueError('Runtime data folders must not be symbolic links.')
    if data_root.resolve().is_relative_to(root):
        raise ValueError('Runtime data must remain outside the static frontend directory.')
    data_root.mkdir(parents=True, exist_ok=True)
    bank = data_root / 'question-bank'
    assets = data_root / 'question-assets'
    bank.mkdir(exist_ok=True)
    if bank.is_symlink():
        raise ValueError('question-bank must be a real project folder, not a symbolic link.')
    token = secrets.token_urlsafe(32)
    project = hashlib.sha256((str(root) + '\0' + str(data_root)).encode()).hexdigest()
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def reply(self, status, value):
            body = json.dumps(value, ensure_ascii=False).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(body)

        def valid_host(self):
            return self.headers.get('Host') == f'127.0.0.1:{self.server.server_port}'

        def do_GET(self):
            if not self.valid_host():
                return self.reply(403, {'error': 'Invalid host.'})
            route = urlsplit(self.path).path
            if route == '/api/question-bank/status':
                return self.reply(200, {'service': 'sat-question-bank-v1', 'project': project, 'name': 'question-bank', 'token': token})
            if route == '/api/question-bank':
                files, errors = [], []
                for p in sorted(bank.iterdir()):
                    if p.suffix.lower() != '.json' or not p.is_file() or p.is_symlink():
                        continue
                    try:
                        if p.stat().st_size > MAX_BYTES:
                            raise ValueError('File exceeds 20 MB.')
                        files.append({'name': p.name, 'text': p.read_text(encoding='utf-8'), 'lastModified': round(p.stat().st_mtime * 1000)})
                    except (OSError, UnicodeError, ValueError) as exc:
                        errors.append(f'{p.name}: {exc}')
                return self.reply(200, {'files': files, 'errors': errors})
            # Serve only application resources, never unrelated project files.
            relative = unquote(route).lstrip('/') or 'html/index.html'
            namespace = relative.split('/')[0]
            static_root = assets if namespace == 'question-assets' else root
            resource = relative[len('question-assets/'):] if namespace == 'question-assets' else relative
            p = (static_root / resource).resolve()
            allowed = relative == 'html/index.html' or namespace in {'js', 'css', 'data', 'vendor', 'question-assets'}
            if (not allowed or not p.is_relative_to(static_root.resolve()) or not p.is_file()
                    or static_root.is_symlink() or any(path.is_symlink() for path in (static_root / resource, *(static_root / resource).parents) if path.is_relative_to(data_root))):
                return self.reply(404, {'error': 'Not found.'})
            body = p.read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', mimetypes.guess_type(p.name)[0] or 'application/octet-stream')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-cache')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            origin = f'http://127.0.0.1:{self.server.server_port}'
            if (not self.valid_host() or self.headers.get('Origin') != origin
                    or self.headers.get('X-SAT-Bank-Token') != token):
                return self.reply(403, {'error': 'Use the local SAT Practice page to save files.'})
            route = urlsplit(self.path).path
            if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
                return self.reply(403, {'error': 'Expected JSON.'})
            if route != '/api/question-bank':
                return self.reply(404, {'error': 'Not found.'})
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= MAX_BYTES:
                    return self.reply(413, {'error': 'Request must be between 1 byte and 20 MB.'})
                request = json.loads(self.rfile.read(length))
                name, text = request['name'], request['text']
                if not isinstance(name, str) or not name.lower().endswith('.json') or name in {'.', '..'} or any(c in name for c in '/\\\x00') or any(ord(c) < 32 for c in name):
                    raise ValueError('Use a plain JSON filename.')
                if not isinstance(text, str):
                    raise ValueError('File content must be text.')
                data = json.loads(text)
                if not isinstance(data, dict) or not isinstance(data.get('questions'), list) or not data['questions']:
                    raise ValueError('A non-empty questions array is required.')
                for q in data['questions']:
                    answer = q.get('answer') if isinstance(q, dict) else None
                    if (not isinstance(q, dict) or not isinstance(q.get('prompt'), str) or not q['prompt'].strip()
                            or not isinstance(q.get('options'), list) or len(q['options']) != 4
                            or any(not isinstance(o, str) or not o.strip() for o in q['options'])
                            or not ((isinstance(answer, str) and answer in ['A', 'B', 'C', 'D']) or (type(answer) is int and 0 <= answer <= 3))):
                        raise ValueError('Invalid question, choices, or answer.')
                payload = text.encode('utf-8')
                # Publish a complete file atomically without replacing any existing name.
                with lock:
                    candidate = bank / name
                    counter = 1
                    while candidate.exists() or candidate.is_symlink():
                        if not candidate.is_symlink() and candidate.is_file() and candidate.read_bytes() == payload:
                            return self.reply(200, {'name': candidate.name, 'lastModified': round(candidate.stat().st_mtime * 1000)})
                        counter += 1
                        candidate = bank / f'{Path(name).stem}-{counter}.json'
                    temporary = None
                    try:
                        with tempfile.NamedTemporaryFile(dir=bank, prefix='.import-', suffix='.tmp', delete=False) as f:
                            temporary = f.name
                            f.write(payload)
                            f.flush()
                            os.fsync(f.fileno())
                        os.link(temporary, candidate)
                    finally:
                        if temporary:
                            os.unlink(temporary)
                return self.reply(201, {'name': candidate.name, 'lastModified': round(candidate.stat().st_mtime * 1000)})
            except (ValueError, KeyError, TypeError, OSError) as exc:
                return self.reply(400, {'error': str(exc)})

    return ThreadingHTTPServer(('127.0.0.1', port), Handler)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', default=str(FRONTEND_ROOT), help='Static SAT frontend directory.')
    parser.add_argument('--data-root', default=str(DATA_ROOT), help='Local runtime storage directory; separate from static source.')
    parser.add_argument('--port', type=int, default=8876)
    parser.add_argument('--open', action='store_true')
    args = parser.parse_args()
    url = f'http://127.0.0.1:{args.port}/html/index.html'
    try:
        server = create_server(args.root, args.port, args.data_root)
    except OSError:
        from urllib.request import urlopen
        expected = hashlib.sha256((str(Path(args.root).resolve()) + '\0' + os.path.abspath(args.data_root)).encode()).hexdigest()
        try:
            with urlopen(f'http://127.0.0.1:{args.port}/api/question-bank/status', timeout=2) as response:
                status = json.load(response)
            if status.get('service') != 'sat-question-bank-v1' or status.get('project') != expected:
                raise ValueError('Port is used by another application or project.')
            if args.open:
                webbrowser.open(url)
            raise SystemExit(0)
        except (OSError, ValueError) as exc:
            raise SystemExit(f'Could not start SAT Practice: {exc}')
    print(f'SAT Practice: http://127.0.0.1:{server.server_port}/html/index.html', flush=True)
    print('Keep this window open while using the app. Press Control-C to stop.', flush=True)
    if args.open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
