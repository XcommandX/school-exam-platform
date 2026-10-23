import _paths
"""Anonymous fixtures exercise content preservation and the privacy boundary."""
import copy
import unittest

from shared.question_schema import normalize_question_set, referenced_assets, to_sat_legacy, validate_question_set


class QuestionSchemaTests(unittest.TestCase):
    def sample(self):
        return {'title': 'Synthetic set', 'section': 'Reading and Writing', 'durationSeconds': 120,
                'moduleQuestionCounts': [1, 1], 'moduleDurationsSeconds': [60, 60],
                'studentName': 'PRIVATE PERSON', 'attempts': [{'score': 3}], 'questions': [
                    {'prompt': 'Select the letter A.', 'passageMarkdown': '**A** and *B*.',
                     'options': ['A', 'B', 'C', 'D'], 'answer': 'A',
                     'explanation': 'A is requested.', 'aiExplanation': 'Synthetic explanation.',
                     'userSelectedAnswer': 'B', 'customMetadata': {
                         'sourceModule': 1, 'sourceQuestionId': 27,
                         'userSelectedAnswer': 'B', 'studentName': 'PRIVATE PERSON',
                         'repairAudit': {'userAnswer': 'C'}}},
                    {'prompt': 'Select the letter B.', 'options': ['A', 'B', 'C', 'D'], 'answer': 1}]}

    def test_explicit_privacy_filter_and_stable_ids(self):
        raw = self.sample()
        before = copy.deepcopy(raw)
        data = normalize_question_set(raw, source_key='fixture.json')
        validate_question_set(data)
        self.assertEqual(raw, before)
        self.assertNotIn('studentName', str(data))
        self.assertNotIn('userSelectedAnswer', str(data))
        self.assertNotIn('PRIVATE PERSON', str(data))
        self.assertEqual(data['questions'][0]['customMetadata'], {'sourceModule': 1, 'sourceQuestionId': 27})
        self.assertEqual(data['questions'][0]['moduleIndex'], 0)
        self.assertEqual(data['questions'][1]['moduleIndex'], 1)
        raw['questions'][0]['explanation'] = 'Corrected explanation.'
        changed = normalize_question_set(raw, source_key='fixture.json')
        self.assertEqual(changed['id'], data['id'])
        self.assertEqual(changed['questions'][0]['id'], data['questions'][0]['id'])

    def test_round_trip_retains_content_timing_and_identifiers(self):
        data = normalize_question_set(self.sample(), source_key='fixture.json')
        legacy = to_sat_legacy(data)
        self.assertEqual(legacy['sourceId'], data['id'])
        self.assertEqual(legacy['questions'][0]['id'], data['questions'][0]['id'])
        self.assertEqual(legacy['questions'][0]['answer'], 0)
        self.assertEqual(legacy['questions'][0]['passage'], 'A and B.')
        self.assertEqual(legacy['durationSeconds'], 120)
        self.assertEqual(legacy['moduleDurationsSeconds'], [60, 60])
        # Browser bank saves return legacy JSON. Reimporting it must not create
        # a different source/question identity or duplicate canonical payload.
        self.assertEqual(normalize_question_set(legacy), data)
        self.assertEqual(normalize_question_set(legacy, source_key='renamed.json'), data)
        legacy['sourceId'] = 'toefl:other'
        with self.assertRaises(ValueError):
            normalize_question_set(legacy)

    def test_utf16_offsets_match_browser(self):
        raw = self.sample()
        raw['questions'][0]['passageMarkdown'] = '😀 **A**'
        question = normalize_question_set(raw)['questions'][0]
        self.assertEqual(question['passageFormatting'], [{'start': 3, 'end': 4, 'kind': 'bold'}])

    def test_rejects_unknown_canonical_fields_and_cross_exam_ids(self):
        data = normalize_question_set(self.sample())
        data['attempts'] = []
        with self.assertRaises(ValueError):
            validate_question_set(data)
        del data['attempts']
        data['questions'][0]['customMetadata']['userSelectedAnswer'] = 'A'
        with self.assertRaises(ValueError):
            validate_question_set(data)
        data = normalize_question_set(self.sample())
        data['exam'] = 'toefl'
        with self.assertRaises(ValueError):
            validate_question_set(data)

    def test_visual_paths_tables_and_invalid_module_counts(self):
        raw = self.sample()
        raw['questions'][0]['visualStimulus'] = {'type': 'image', 'src': 'question-assets/sat/fixture.png', 'alt': 'Synthetic diagram'}
        data = normalize_question_set(raw)
        self.assertEqual(referenced_assets(data), {'question-assets/sat/fixture.png'})
        raw['questions'][0]['visualStimulus']['src'] = 'question-assets/../secret.png'
        with self.assertRaises(ValueError):
            normalize_question_set(raw)
        raw = self.sample()
        raw['moduleQuestionCounts'] = [1]
        with self.assertRaises(ValueError):
            normalize_question_set(raw)

    def test_other_exam_sources_are_isolated(self):
        raw = self.sample()
        raw.pop('section')
        for exam in ('ap', 'toefl', 'vocab'):
            data = normalize_question_set(raw, exam=exam, source_key='same.json')
            self.assertTrue(data['id'].startswith(exam + ':'))
            validate_question_set(data)
            with self.assertRaises(ValueError):
                to_sat_legacy(data)


if __name__ == '__main__':
    unittest.main()
