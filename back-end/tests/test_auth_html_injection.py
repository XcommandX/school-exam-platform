"""Render account names through the real HTML route using temporary fixtures."""
import _paths
from _auth_fixture import authenticated_headers
from html.parser import HTMLParser
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest

from server.serve_platform import create_server, TOEFL_PUBLIC_FILES


class ScriptCollector(HTMLParser):
    def __init__(self):
        super().__init__()
        self.scripts = []
        self.current = None

    def handle_starttag(self, tag, attrs):
        if tag == 'script':
            self.current = {'attributes': dict(attrs), 'text': ''}
            self.scripts.append(self.current)

    def handle_data(self, data):
        if self.current is not None:
            self.current['text'] += data

    def handle_endtag(self, tag):
        if tag == 'script':
            self.current = None


class AuthHTMLTests(unittest.TestCase):
    def test_display_name_cannot_terminate_session_bootstrap(self):
        display_name = '</script><script>window.fixtureInjected=true</script>'
        html = '<html><head></head><body>Anonymous fixture</body></html>'
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for path in ['front-end/web/index.html', 'front-end/web/account.html',
                         'front-end/sat/html/index.html']:
                target = root / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(html, encoding='utf-8')
            build = root / 'local-data/builds/toefl'
            for name in TOEFL_PUBLIC_FILES:
                target = build / 'preview' / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(html if name == 'index.html' else 'fixture', encoding='utf-8')
            fixtures = root / 'back-end/toefl/fixtures'
            fixtures.mkdir(parents=True)
            (fixtures / 'anonymous-bank.json').write_text(json.dumps({
                'fixture': True, 'records': [{'source': 'ANONYMOUS_FIXTURE', 'items': []}]}))
            (build / 'build-info.json').write_text(json.dumps({
                'mode': 'local-anonymous-intake', 'productionCredentials': False,
                'productionData': False, 'deployable': False}))
            server = create_server(root, 0)
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            try:
                headers = authenticated_headers(server)
                identity = headers['X-Account-ID']
                server.auth.store.update_user(identity, {'displayName': display_name}, identity, own_profile=True)
                for route in ['/', '/account', '/sat/html/index.html', '/toefl/']:
                    with self.subTest(route=route):
                        connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=5)
                        connection.request('GET', route, headers=headers)
                        response = connection.getresponse()
                        rendered = response.read().decode('utf-8')
                        connection.close()
                        self.assertEqual(response.status, 200)
                        parser = ScriptCollector()
                        parser.feed(rendered)
                        inline = [script['text'] for script in parser.scripts if not script['attributes'].get('src')]
                        self.assertEqual(len(inline), 1, 'The display name created an additional script element.')
                        prefix = 'window.PlatformSession='
                        self.assertTrue(inline[0].startswith(prefix))
                        session = json.loads(inline[0][len(prefix):].removesuffix(';'))
                        self.assertEqual(session['user']['displayName'], display_name)
                        self.assertNotIn('<', inline[0])
            finally:
                server.shutdown()
                server.server_close()
                worker.join()


if __name__ == '__main__':
    unittest.main()
