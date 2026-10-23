"""AP v2 fixtures are original synthetic content, not released exam questions."""
from copy import deepcopy
import unittest

from shared.ap_schema import summarize_ap_set, validate_ap_set


def example_set(private=False):
    return {
        'schemaVersion': 2, 'exam': 'ap', 'subject': 'english-language',
        'id': 'ap:test-original', 'title': 'Original AP integration fixture',
        'section': 'English Language and Composition', 'year': 2026, 'form': 'Test',
        'kind': 'mcq', 'contentMode': 'private' if private else 'synthetic',
        'revision': 'a' * 64, 'defaultDurationSeconds': 60,
        'documents': [{'id': 'paper', 'role': 'questions', 'label': 'Original fixture',
                       'asset': 'question-assets/ap/' + 'b' * 64 + '.pdf', 'pageCount': 3}] if private else [],
        'questions': [{
            'id': 'ap:test-original:q001', 'type': 'mcq', 'number': 1,
            'prompt': 'Which sentence makes a testable claim?', 'passage': '',
            'options': ['The bus arrives at noon.', 'Noon is the finest time.'],
            'correctOption': 0, 'explanation': 'An arrival time can be observed.',
            'pages': [1] if private else [], 'reviewStatus': 'verified',
            'answerProvenance': 'Original fixture author',
            **({'sourceDocument': 'paper'} if private else {}),
        }], 'importWarnings': [],
    }


class APSchemaTests(unittest.TestCase):
    def test_original_private_and_summary(self):
        for private in (False, True):
            doc = example_set(private)
            before = deepcopy(doc)
            validate_ap_set(doc)
            self.assertEqual(doc, before)
            self.assertEqual(summarize_ap_set(doc)['questionCount'], 1)

    def test_essays_are_not_automatically_scored(self):
        doc = example_set(True)
        doc['kind'] = 'frq'
        q = doc['questions'][0]
        q.update(type='free-response', options=[], correctOption=None,
                 responseType='argument', reviewStatus='needs-review')
        validate_ap_set(doc)
        q['correctOption'] = 0
        with self.assertRaises(ValueError):
            validate_ap_set(doc)

    def test_unverified_answers_are_never_gradable(self):
        doc = example_set()
        q = doc['questions'][0]
        q['reviewStatus'] = 'needs-review'
        with self.assertRaises(ValueError):
            validate_ap_set(doc)
        q['correctOption'] = None
        validate_ap_set(doc)
        self.assertEqual(summarize_ap_set(doc)['reviewCount'], 1)
        q['reviewStatus'] = 'verified'
        with self.assertRaises(ValueError):
            validate_ap_set(doc)

    def test_document_only_has_zero_questions(self):
        doc = example_set(True)
        doc['questions'] = []
        doc['importWarnings'] = ['Scanned original: no structured questions.']
        validate_ap_set(doc)
        self.assertEqual(summarize_ap_set(doc)['questionCount'], 0)

    def test_unknown_personal_fields_rejected_at_every_level(self):
        for level in ('set', 'question', 'document'):
            doc = example_set(True)
            target = doc if level == 'set' else doc['questions' if level == 'question' else 'documents'][0]
            target['studentName'] = 'PRIVATE_SENTINEL'
            with self.subTest(level=level), self.assertRaises(ValueError):
                validate_ap_set(doc)

    def test_cross_exam_paths_and_duplicate_ids_rejected(self):
        changes = [
            lambda d: d.update(exam='sat'),
            lambda d: d.update(schemaVersion=1),
            lambda d: d.update(section='Other subject'),
            lambda d: d.update(id='sat:example'),
            lambda d: d.update(revision='no-version'),
            lambda d: d['documents'][0].update(asset='question-assets/ap/../sat/example.pdf'),
            lambda d: d['documents'][0].update(asset='https://example.com/example.pdf'),
            lambda d: d['documents'][0].update(asset='question-assets/ap/%2e%2e/example.pdf'),
            lambda d: d['questions'][0].update(sourceDocument='absent'),
            lambda d: d['questions'][0].update(pages=[4]),
            lambda d: d['questions'][0].update(pages=[2, 1]),
            lambda d: d['questions'][0].update(correctOption=True),
            lambda d: d['questions'][0].update(correctOption=5),
            lambda d: d['questions'][0].update(answerPage=1),
            lambda d: d['questions'].append(deepcopy(d['questions'][0])),
        ]
        for change in changes:
            doc = example_set(True)
            change(doc)
            with self.subTest(doc=doc), self.assertRaises(ValueError):
                validate_ap_set(doc)

    def test_answer_reference_bounds(self):
        doc = example_set(True)
        q = doc['questions'][0]
        q.update(answerDocument='paper', answerPage=3)
        validate_ap_set(doc)
        q['answerPage'] = 4
        with self.assertRaises(ValueError):
            validate_ap_set(doc)


if __name__ == '__main__':
    unittest.main()
