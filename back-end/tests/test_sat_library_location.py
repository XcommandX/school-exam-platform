"""SAT library location checks use temporary roots and original generated items."""
import http.client
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

import _paths
from _auth_fixture import authenticated_headers
from server.serve_platform import create_server


SPEC = importlib.util.spec_from_file_location(
    'location_fixture_converter', _paths.ROOT / 'back-end/tools/sat/convert_gengdu_sat.py')
CONVERTER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = CONVERTER
SPEC.loader.exec_module(CONVERTER)

DEFAULT_LIBRARY = Path('back-end/question-banks/sat-packs/gengdu-offline')
PDF_LIBRARY = Path('back-end/question-banks/sat-packs/pdf-official')


class SatLibraryLocationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        environment = patch.dict(os.environ, {'SAT_LIBRARY_ROOT': ''})
        environment.start()
        self.addCleanup(environment.stop)

    def make_library(self, library, identity, category='数学', title=None):
        """Generate a one-question catalog without opening any existing bank."""
        folder = library / '数学真题' / identity
        question = {
            'question_id': '1001', 'part_type': 'Math', 'module_number': 3,
            'number': 1, 'question_type': 'choice',
            'prompt_html': '<p>Original location fixture: what is 2 + 3?</p>',
            'choices': [{'label': label, 'html': str(value)}
                        for label, value in zip('ABCD', (4, 5, 6, 7))],
            'correct_answer': 'B',
        }
        report = CONVERTER.convert_document(
            {'title': identity, 'questions': [question]}, folder,
            collection_id=identity, mode='bank')
        catalog = {
            'schemaVersion': 'sat-offline-conversion-catalog/1',
            'collections': [{
                'collectionId': identity, 'title': title or identity, 'category': category,
                'sourceFile': '数学/original-location-fixture.json',
                'directory': '数学真题/' + identity, 'status': 'converted',
                'fullSAT': report['fullSAT'], 'questionCount': report['questionCount'],
            }],
        }
        (library / 'catalog.json').write_text(json.dumps(catalog), encoding='utf-8')

    def start_server(self, **options):
        server = create_server(self.root, 0, **options)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()

        def close():
            server.shutdown()
            server.server_close()
            worker.join()

        self.addCleanup(close)
        return server

    def request(self, server, route, method='GET', body=None, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=5)
        try:
            connection.request(method, route, body=body, headers={**authenticated_headers(server), **(headers or {})})
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def assert_library(self, server, identity):
        status, catalog = self.request(server, '/api/sat-library')
        self.assertEqual(status, 200)
        self.assertTrue(catalog['available'])
        self.assertEqual(catalog['errors'], [])
        collections = [item for category in catalog['categories']
                       for item in category['collections']]
        self.assertEqual([item['collectionId'] for item in collections], [identity])
        self.assertEqual(collections[0]['questionCount'], 1)

        status, collection = self.request(server, '/api/sat-library/collections/' + identity)
        self.assertEqual(status, 200)
        self.assertEqual(collection['collectionId'], identity)
        self.assertEqual(sum(pack['questionCount'] for pack in collection['packs']), 1)
        self.assertEqual(collection['modules'][0]['moduleNumber'], 3)
        self.assertEqual(len(collection['modules'][0]['items']), 1)

        status, index = self.request(server, '/api/sat-library/question-index')
        self.assertEqual(status, 200)
        self.assertEqual(index['errors'], [])
        self.assertEqual({item['libraryCollectionId'] for item in index['questions']}, {identity})

    def test_default_reads_repository_question_folder(self):
        self.make_library(self.root / DEFAULT_LIBRARY, 'synthetic-default')
        self.make_library(self.root / 'local-data/sat-packs/gengdu-offline', 'synthetic-old')
        self.assert_library(self.start_server(), 'synthetic-default')

    def test_default_combines_parallel_pdf_catalog_without_changing_source_files(self):
        original = self.root / DEFAULT_LIBRARY
        pdf = self.root / PDF_LIBRARY
        self.make_library(original, 'synthetic-original')
        self.make_library(pdf, 'synthetic-pdf', category='测试', title='2026年10月 PDF original fixture')
        before = {path: path.read_bytes() for library in (original, pdf)
                  for path in library.rglob('*') if path.is_file()}
        server = self.start_server()
        status, catalog = self.request(server, '/api/sat-library')
        self.assertEqual(status, 200)
        self.assertEqual(catalog['errors'], [])
        full_length = catalog['categories'][0]['collections']
        self.assertEqual([item['collectionId'] for item in full_length], ['synthetic-pdf'])
        self.assertEqual(full_length[0]['title'], '2026年10月 PDF original fixture')
        self.assertFalse(full_length[0]['fullSAT'])
        self.assertEqual(full_length[0]['modules'], [{'section': 'math', 'moduleNumber': 3, 'questionCount': 1}])
        self.assertNotIn('Original location fixture', json.dumps(catalog))
        self.assertNotIn(str(self.root), json.dumps(catalog))
        for identity in ('synthetic-original', 'synthetic-pdf'):
            status, collection = self.request(server, '/api/sat-library/collections/' + identity)
            self.assertEqual(status, 200)
            self.assertEqual(collection['collectionId'], identity)
            self.assertEqual(collection['modules'][0]['moduleNumber'], 3)
            self.assertIsNone(collection['assessment'])
        status, index = self.request(server, '/api/sat-library/question-index')
        self.assertEqual(status, 200)
        self.assertEqual(index['errors'], [])
        self.assertEqual({item['libraryCollectionId'] for item in index['questions']},
                         {'synthetic-original', 'synthetic-pdf'})
        self.assertEqual(len(index['questions']), 2)
        self.assertEqual(before, {path: path.read_bytes() for path in before})

    def test_duplicate_collection_ids_across_libraries_are_rejected_without_overwriting(self):
        for location in (DEFAULT_LIBRARY, PDF_LIBRARY):
            self.make_library(self.root / location, 'synthetic-duplicate')
        server = self.start_server()
        for route in ('/api/sat-library', '/api/sat-library/question-index'):
            status, document = self.request(server, route)
            self.assertEqual(status, 200)
            self.assertEqual([error['collectionId'] for error in document['errors']], ['synthetic-duplicate'])
            self.assertEqual(document.get('questions', []), [])
            self.assertEqual([item for category in document.get('categories', [])
                              for item in category['collections']], [])
        self.assertEqual(self.request(server, '/api/sat-library/collections/synthetic-duplicate')[0], 400)

    def test_broken_parallel_catalog_does_not_hide_the_other_library(self):
        self.make_library(self.root / DEFAULT_LIBRARY, 'synthetic-original')
        pdf = self.root / PDF_LIBRARY
        pdf.mkdir(parents=True)
        (pdf / 'catalog.json').write_text('invalid JSON', encoding='utf-8')
        server = self.start_server()
        for route in ('/api/sat-library', '/api/sat-library/question-index'):
            status, document = self.request(server, route)
            self.assertEqual(status, 200)
            self.assertTrue(document['available'])
            self.assertEqual(len(document['errors']), 1)
            self.assertNotIn(str(pdf), json.dumps(document))
        self.assertEqual(self.request(server, '/api/sat-library/collections/synthetic-original')[0], 200)

    def test_private_root_controls_import_writes_without_relocating_library(self):
        self.make_library(self.root / DEFAULT_LIBRARY, 'synthetic-default')
        private = self.root / 'custom-private-data'
        self.make_library(private / 'sat-packs/gengdu-offline', 'synthetic-private-decoy')
        server = self.start_server(private_root=private)
        self.assert_library(server, 'synthetic-default')

        status, info = self.request(server, '/api/question-bank/status')
        self.assertEqual(status, 200)
        raw = {'title': 'Original import fixture', 'questions': [{
            'prompt': 'Which number is equal to 2 + 3?',
            'options': ['4', '5', '6', '7'], 'answer': 'B',
        }]}
        payload = json.dumps({'name': 'original-import.json', 'text': json.dumps(raw)})
        status, result = self.request(server, '/api/question-bank', 'POST', payload, {
            'Content-Type': 'application/json',
            'Origin': f'http://127.0.0.1:{server.server_port}',
            'X-SAT-Bank-Token': info['token'],
        })
        self.assertEqual(status, 201)
        self.assertTrue((private / 'question-banks/sat' / result['name']).is_file())
        self.assertFalse((self.root / 'local-data/question-banks').exists())
        self.assert_library(server, 'synthetic-default')

    def test_environment_override_accepts_absolute_and_project_relative_roots(self):
        self.make_library(self.root / DEFAULT_LIBRARY, 'synthetic-default-decoy')
        self.make_library(self.root / PDF_LIBRARY, 'synthetic-pdf-decoy', category='测试')
        override = self.root / 'configured-library'
        self.make_library(override, 'synthetic-environment')
        for value in (str(override), 'configured-library'):
            with self.subTest(root=value), patch.dict(os.environ, {'SAT_LIBRARY_ROOT': value}):
                server = self.start_server()
                self.assert_library(server, 'synthetic-environment')
                self.assertEqual(self.request(server, '/api/sat-library/collections/synthetic-pdf-decoy')[0], 404)

    def test_explicit_root_overrides_environment_for_absolute_and_relative_paths(self):
        self.make_library(self.root / DEFAULT_LIBRARY, 'synthetic-default-decoy')
        self.make_library(self.root / PDF_LIBRARY, 'synthetic-pdf-decoy', category='测试')
        environment = self.root / 'environment-library'
        self.make_library(environment, 'synthetic-environment-decoy')
        explicit = self.root / 'explicit-library'
        self.make_library(explicit, 'synthetic-explicit')
        with patch.dict(os.environ, {'SAT_LIBRARY_ROOT': str(environment)}):
            for value in (explicit, Path('explicit-library')):
                with self.subTest(root=str(value)):
                    server = self.start_server(sat_library_root=value)
                    self.assert_library(server, 'synthetic-explicit')
                    self.assertEqual(self.request(server, '/api/sat-library/collections/synthetic-pdf-decoy')[0], 404)


if __name__ == '__main__':
    unittest.main()
