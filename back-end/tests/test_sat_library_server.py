"""Lazy SAT library routes use generated original questions, never local banks."""
import http.client
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
import _paths

from server.serve_platform import create_server, read_sat_library


SPEC = importlib.util.spec_from_file_location('library_fixture_converter', _paths.ROOT / 'back-end/tools/sat/convert_gengdu_sat.py')
CONVERTER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = CONVERTER
SPEC.loader.exec_module(CONVERTER)


def original_questions(full=False, section='Math'):
    questions = []
    for part in ('ReadingAndWriting', 'Math') if full else (section,):
        for module in (1, 2) if full else (3,):
            for number in range(1, (28 if part == 'ReadingAndWriting' else 23) if full else 2):
                questions.append({'question_id': str(1000 + len(questions)), 'part_type': part,
                                  'module_number': module, 'number': number, 'question_type': 'choice',
                                  'prompt_html': '<p>Original synthetic question?</p>',
                                  'choices': [{'label': label, 'html': 'Original ' + label} for label in 'ABCD'],
                                  'correct_answer': 'A'})
    return questions


class SatLibraryServerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.library = self.root / 'moved-private-library'
        self.library.mkdir()
        self.rows, self.folders = [], {}
        for category, renamed, identity, questions in (
                ('测试', '全真模考', 'synthetic-full', original_questions(full=True)),
                ('数学', '数学真题', 'synthetic-math', original_questions()),
                ('英语', '英语真题/阅读', 'synthetic-english', original_questions(section='ReadingAndWriting'))):
            folder = self.library / renamed / identity
            report = CONVERTER.convert_document({'title': identity, 'questions': questions}, folder,
                                                collection_id=identity, mode='bank')
            self.folders[identity] = folder
            self.rows.append({'collectionId': identity, 'title': identity, 'category': category,
                              'sourceFile': category + ('/阅读' if category == '英语' else '') + '/original.json',
                              'directory': category + '/' + identity, 'status': 'converted',
                              'fullSAT': report['fullSAT'], 'questionCount': report['questionCount']})
        self.save_catalog()
        self.server = create_server(self.root, 0, sat_library_root=self.library)
        self.worker = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.worker.start()
        self.addCleanup(self.cleanup)

    def save_catalog(self):
        (self.library / 'catalog.json').write_text(json.dumps({'schemaVersion': 'sat-offline-conversion-catalog/1',
                                                             'collections': self.rows}), encoding='utf-8')

    def cleanup(self):
        self.server.shutdown()
        self.server.server_close()
        self.worker.join()
        self.temporary.cleanup()

    def request(self, route, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        connection.request('GET', route, headers=headers or {})
        response = connection.getresponse()
        status, raw = response.status, response.read()
        connection.close()
        return status, json.loads(raw)

    def test_catalog_lists_metadata_from_renamed_folders_without_loading_question_payloads(self):
        status, data = self.request('/api/sat-library')
        self.assertEqual(status, 200)
        self.assertTrue(data['available'])
        self.assertEqual(data['errors'], [])
        self.assertEqual([category['id'] for category in data['categories']], ['full-length', 'reading-writing', 'math'])
        full, english, math = [category['collections'][0] for category in data['categories']]
        self.assertTrue(full['fullSAT'])
        self.assertEqual(full['sectionCounts'], {'reading-writing': 54, 'math': 44})
        self.assertEqual(english['subgroup'], '阅读')
        self.assertEqual(math['modules'], [{'section': 'math', 'moduleNumber': 3, 'questionCount': 1}])
        self.assertNotIn('Original synthetic question', json.dumps(data))
        self.assertNotIn(str(self.library), json.dumps(data))
        self.assertNotIn('items', full['modules'][0])

    def test_lazy_collection_preserves_revisions_modules_and_assessment_without_changing_active_config(self):
        active = self.root / 'local-data/sat-packs/active.json'
        active.parent.mkdir(parents=True)
        active.write_text('{"collectionId":"existing","root":"existing"}')
        before = active.read_bytes()
        status, data = self.request('/api/sat-library/collections/synthetic-full')
        self.assertEqual(status, 200)
        self.assertEqual(sum(pack['questionCount'] for pack in data['packs']), 98)
        self.assertEqual(data['assessment']['questionCount'], 98)
        self.assertEqual([len(module['items']) for module in data['modules']], [27, 27, 22, 22])
        self.assertEqual(data['modules'], data['assessment']['modules'])
        self.assertTrue(all(set(reference) == {'packId', 'packRevision', 'itemId', 'itemRevision'}
                            for module in data['modules'] for reference in module['items']))
        self.assertEqual(active.read_bytes(), before)
        status, partial = self.request('/api/sat-library/collections/synthetic-math')
        self.assertEqual(status, 200)
        self.assertIsNone(partial['assessment'])
        self.assertFalse(partial['fullSAT'])
        self.assertEqual(partial['modules'][0]['moduleNumber'], 3)

    def test_partial_collection_keeps_original_source_order_instead_of_sorting_question_numbers(self):
        questions = original_questions() + original_questions()
        questions[0]['number'] = 9
        questions[1].update({'question_id': '2000', 'number': 2})
        folder = self.folders['synthetic-math']
        report = CONVERTER.convert_document({'title': 'Original source order', 'questions': questions}, folder,
                                            collection_id='synthetic-math', mode='bank', replace=True)
        next(row for row in self.rows if row['collectionId'] == 'synthetic-math')['questionCount'] = 2
        self.save_catalog()
        status, data = self.request('/api/sat-library/collections/synthetic-math')
        self.assertEqual(status, 200)
        self.assertEqual([item['itemId'] for item in data['modules'][0]['items']],
                         [item['itemId'] for item in report['sourceOrder']])
        self.assertIsNone(data['assessment'])

    def test_unreadable_reports_do_not_hide_unaffected_collections(self):
        (self.folders['synthetic-math'] / 'conversion-report.json').write_text('invalid JSON')
        unrelated = self.library / 'unlisted-folder'
        unrelated.mkdir()
        (unrelated / 'conversion-report.json').write_text('also invalid JSON')
        status, data = self.request('/api/sat-library')
        self.assertEqual(status, 200)
        self.assertEqual([len(category['collections']) for category in data['categories']], [1, 1, 0])
        self.assertTrue(any(error['collectionId'] == 'synthetic-math' for error in data['errors']))
        self.assertNotIn(str(self.library), json.dumps(data))
        self.assertEqual(self.request('/api/sat-library/collections/synthetic-math')[0], 400)

    def test_assessment_revision_mismatch_is_rejected(self):
        path = self.folders['synthetic-full'] / 'assessment.json'
        assessment = json.loads(path.read_text())
        assessment['modules'][0]['items'][0]['itemRevision'] += 1
        path.write_text(json.dumps(assessment))
        self.assertEqual(self.request('/api/sat-library/collections/synthetic-full')[0], 400)

    def test_unconfigured_library_is_empty_and_environment_root_is_relative_to_project(self):
        self.assertFalse(read_sat_library(self.root / 'missing')['available'])
        with patch.dict('os.environ', {'SAT_LIBRARY_ROOT': 'moved-private-library'}):
            server = create_server(self.root, 0)
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            try:
                connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=5)
                connection.request('GET', '/api/sat-library')
                response = connection.getresponse()
                self.assertTrue(json.loads(response.read())['available'])
                connection.close()
            finally:
                server.shutdown()
                server.server_close()
                worker.join()

    def test_unknown_ids_traversal_symlinks_and_undeclared_files_are_not_served(self):
        (self.folders['synthetic-math'] / 'private-notes.json').write_text('Private note must stay on disk')
        status, selected = self.request('/api/sat-library/collections/synthetic-math')
        self.assertEqual(status, 200)
        self.assertNotIn('Private note must stay on disk', json.dumps(selected))
        self.assertEqual(self.request('/api/sat-library/collections/missing')[0], 404)
        for suffix in ('../catalog.json', '%2e%2e/catalog.json', 'synthetic-math/pack.json', 'synthetic-math%252f..'):
            with self.subTest(suffix=suffix):
                self.assertIn(self.request('/api/sat-library/collections/' + suffix)[0], {400, 404})
        self.assertEqual(self.request('/api/sat-library', {'Host': 'external.invalid'})[0], 403)
        math = self.folders['synthetic-math']
        moved = self.root / 'outside-library'
        math.rename(moved)
        math.symlink_to(moved, target_is_directory=True)
        status, catalog = self.request('/api/sat-library')
        self.assertEqual(status, 200)
        self.assertEqual(catalog['categories'][2]['collections'], [])
        self.assertEqual(self.request('/api/sat-library/collections/synthetic-math')[0], 400)

    def test_item_revision_mismatch_and_package_traversal_fail_selected_collection(self):
        folder = self.folders['synthetic-math']
        report_path = folder / 'conversion-report.json'
        report = json.loads(report_path.read_text())
        report['sourceOrder'][0]['itemRevision'] += 1
        report_path.write_text(json.dumps(report))
        self.assertEqual(self.request('/api/sat-library/collections/synthetic-math')[0], 400)
        report['sourceOrder'][0]['itemRevision'] -= 1
        report_path.write_text(json.dumps(report))
        manifest_path = folder / 'math-single-choice/pack.json'
        manifest = json.loads(manifest_path.read_text())
        manifest['files']['items'] = '../private-notes.json'
        manifest_path.write_text(json.dumps(manifest))
        self.assertEqual(self.request('/api/sat-library/collections/synthetic-math')[0], 400)


if __name__ == '__main__':
    unittest.main()
