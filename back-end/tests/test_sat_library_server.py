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
from urllib.parse import quote
import _paths

from server.serve_platform import create_server, read_sat_library, read_sat_library_question_index


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

    def test_question_index_lists_every_package_with_importer_ids_and_complete_search_text(self):
        folder = self.folders['synthetic-math'] / 'math-single-choice'
        item_path = folder / 'items.json'
        document = json.loads(item_path.read_text())
        search_text = 'Complete searchable material ' + ('original content ' * 1700) + ' tail-search-marker'
        document['items'][0]['content'] = [{'type': 'markdown', 'text': '<u>' + search_text + '</u>'}]
        document['items'][0]['classification']['skill'] = 'Original Algebra'
        item_path.write_text(json.dumps(document))
        status, index = self.request('/api/sat-library/question-index')
        self.assertEqual(status, 200)
        self.assertEqual(index['schemaVersion'], 1)
        self.assertTrue(index['available'])
        self.assertEqual(index['errors'], [])
        self.assertEqual(len(index['sources']), 4)
        self.assertEqual(len(index['questions']), 100)
        question = next(item for item in index['questions'] if item['libraryCollectionId'] == 'synthetic-math')
        manifest = json.loads((folder / 'pack.json').read_text())
        source_id = 'pack:' + quote(manifest['id'], safe="~()*!.'-") + '@' + str(manifest['revision'])
        self.assertEqual(question['id'], source_id + ':' + quote(document['items'][0]['id'], safe="~()*!.'-") + '@1')
        self.assertEqual(question['passage'], search_text)
        self.assertEqual(question['questionType'], 'Original Algebra')
        self.assertEqual(question['packSource'], document['items'][0]['source'])
        self.assertEqual(question['metadata'], {'sourceId': source_id, 'sourceFileName': 'math-single-choice/pack.json',
                                              'sourceQuestionIndex': 0, 'libraryCollectionId': 'synthetic-math',
                                              'sourceModuleNumber': 3, 'sourceQuestionNumber': 1, 'sourceOrderIndex': 0})
        self.assertTrue(question['indexOnly'])
        source = next(item for item in index['sources'] if item['id'] == source_id)
        self.assertEqual(source['packIdentity'], {key: manifest[key] for key in ('id', 'revision', 'section', 'responseType')})
        self.assertEqual(source['defaultDurationSeconds'], 2100)
        self.assertNotIn(str(self.library), json.dumps(index))

    def test_question_index_never_reads_solutions_images_or_full_collections(self):
        folder = self.folders['synthetic-math'] / 'math-single-choice'
        (folder / 'solutions.json').write_text('Private answer marker: deliberately invalid JSON')
        (folder / 'assets/private-image.png').write_bytes(b'Private image marker')
        manifest_path = folder / 'pack.json'
        manifest = json.loads(manifest_path.read_text())
        manifest['assets'].append({'id': 'original-image', 'path': 'assets/private-image.png', 'mediaType': 'image/png',
                                   'byteLength': 20, 'sha256': '0' * 64, 'source': {'kind': 'original-synthetic'}})
        manifest_path.write_text(json.dumps(manifest))
        original_read_text = Path.read_text

        def text_only(path, *args, **kwargs):
            self.assertNotEqual(path.name, 'solutions.json')
            self.assertNotIn('assets', path.parts)
            return original_read_text(path, *args, **kwargs)

        with patch.object(Path, 'read_text', text_only), patch.object(Path, 'read_bytes', side_effect=AssertionError('No binary reads')), \
                patch('server.serve_platform._read_sat_collection', side_effect=AssertionError('No full collection reads')):
            status, index = self.request('/api/sat-library/question-index')
        self.assertEqual(status, 200)
        self.assertEqual(len(index['questions']), 100)
        self.assertEqual(index['errors'], [])
        serialized = json.dumps(index)
        for private in ('Private answer marker', 'Private image marker', 'correctOption', 'answerRule', 'explanation', 'dataBase64', 'packAssets'):
            self.assertNotIn(private, serialized)

    def test_question_index_cache_skips_unchanged_items_and_invalidates_updates_and_directory_moves(self):
        status, first = self.request('/api/sat-library/question-index')
        self.assertEqual(status, 200)
        self.assertEqual(len(first['questions']), 100)
        original_read_text = Path.read_text

        def no_item_reload(path, *args, **kwargs):
            self.assertNotIn(path.name, {'pack.json', 'items.json'})
            return original_read_text(path, *args, **kwargs)

        with patch.object(Path, 'read_text', no_item_reload):
            self.assertEqual(self.request('/api/sat-library/question-index')[1], first)
        item_path = self.folders['synthetic-math'] / 'math-single-choice/items.json'
        document = json.loads(item_path.read_text())
        document['items'][0]['prompt'] = [{'type': 'markdown', 'text': 'Updated original cache marker?'}]
        item_path.write_text(json.dumps(document))
        status, updated = self.request('/api/sat-library/question-index')
        self.assertEqual(status, 200)
        self.assertEqual(next(item['prompt'] for item in updated['questions'] if item['libraryCollectionId'] == 'synthetic-math'),
                         'Updated original cache marker?')
        self.folders['synthetic-math'].rename(self.library / 'relocated-original')
        self.assertEqual(self.request('/api/sat-library/question-index')[1], updated)

    def test_question_index_isolates_damaged_items_source_revisions_and_removed_collections(self):
        self.assertEqual(len(self.request('/api/sat-library/question-index')[1]['questions']), 100)
        item_path = self.folders['synthetic-math'] / 'math-single-choice/items.json'
        original = item_path.read_text()
        item_path.write_text('invalid JSON')
        status, damaged = self.request('/api/sat-library/question-index')
        self.assertEqual(status, 200)
        self.assertEqual(len(damaged['questions']), 99)
        self.assertEqual([error['collectionId'] for error in damaged['errors']], ['synthetic-math'])
        item_path.write_text(original)
        self.assertEqual(len(self.request('/api/sat-library/question-index')[1]['questions']), 100)
        report_path = self.folders['synthetic-math'] / 'conversion-report.json'
        report = json.loads(report_path.read_text())
        report['sourceOrder'][0]['itemRevision'] += 1
        report_path.write_text(json.dumps(report))
        self.assertEqual(len(self.request('/api/sat-library/question-index')[1]['questions']), 99)
        self.rows = [row for row in self.rows if row['collectionId'] != 'synthetic-english']
        self.save_catalog()
        status, removed = self.request('/api/sat-library/question-index')
        self.assertEqual(status, 200)
        self.assertEqual(len(removed['questions']), 98)

    def test_question_index_rejects_unsafe_items_paths_and_symlinks_without_exposing_private_paths(self):
        folder = self.folders['synthetic-math'] / 'math-single-choice'
        manifest_path = folder / 'pack.json'
        manifest = json.loads(manifest_path.read_text())
        manifest['files']['items'] = '../private-items.json'
        manifest_path.write_text(json.dumps(manifest))
        status, unsafe = self.request('/api/sat-library/question-index')
        self.assertEqual(status, 200)
        self.assertEqual(len(unsafe['questions']), 99)
        self.assertEqual(unsafe['errors'][0]['collectionId'], 'synthetic-math')
        self.assertNotIn(str(self.root), json.dumps(unsafe))
        manifest['files']['items'] = 'items.json'
        manifest_path.write_text(json.dumps(manifest))
        item_path = folder / 'items.json'
        outside = self.root / 'private-outside.json'
        item_path.rename(outside)
        item_path.symlink_to(outside)
        self.assertEqual(len(self.request('/api/sat-library/question-index')[1]['questions']), 99)

    def test_question_index_supports_spr_and_keeps_package_order_and_source_numbers(self):
        questions = original_questions() + original_questions() + original_questions()
        questions[0]['number'] = 9
        questions[1].update({'question_id': '2000', 'number': 2})
        questions[2].update({'question_id': '3000', 'number': 4, 'question_type': 'response', 'correct_answer': '7'})
        questions[2].pop('choices')
        report = CONVERTER.convert_document({'title': 'Original mixed response order', 'questions': questions},
                                            self.folders['synthetic-math'], collection_id='synthetic-math', mode='bank', replace=True)
        next(row for row in self.rows if row['collectionId'] == 'synthetic-math')['questionCount'] = 3
        self.save_catalog()
        status, index = self.request('/api/sat-library/question-index')
        self.assertEqual(status, 200)
        self.assertEqual(index['errors'], [])
        selected = [item for item in index['questions'] if item['libraryCollectionId'] == 'synthetic-math']
        self.assertEqual([item['itemId'] for item in selected], [item['itemId'] for item in report['sourceOrder']])
        self.assertEqual([item['metadata']['sourceQuestionIndex'] for item in selected], [0, 1, 0])
        self.assertEqual([item['metadata']['sourceQuestionNumber'] for item in selected], [9, 2, 4])
        self.assertEqual(selected[-1]['responseType'], 'student-produced-response')
        self.assertEqual(selected[-1]['options'], [])
        self.assertNotIn('answer', selected[-1])

    def test_question_index_missing_library_is_an_available_empty_contract(self):
        self.assertEqual(read_sat_library_question_index(self.root / 'missing'),
                         {'schemaVersion': 1, 'available': False, 'sources': [], 'questions': [], 'errors': []})


if __name__ == '__main__':
    unittest.main()
