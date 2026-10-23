"""Original synthetic examples for PDF R&W passage/question boundaries."""
from copy import deepcopy
import unittest

import _paths
from tools.sat.pdf_sat_rw import split_body


def text(value):
    return {'kind': 'text', 'text': value, 'pageNumber': 1,
            'bbox': [90, 100, 500, 115], 'spans': [{'text': value}]}


class PDFSATReadingWritingTests(unittest.TestCase):
    def assert_partition(self, events, expected_start, expected_warnings=()):
        before = deepcopy(events)
        content, prompt, warnings = split_body(events)
        self.assertEqual(content, events[:expected_start])
        self.assertEqual(prompt, events[expected_start:])
        self.assertEqual(warnings, list(expected_warnings))
        self.assertEqual(events, before)
        self.assertEqual([id(event) for event in content + prompt],
                         [id(event) for event in events])
        return content, prompt

    def test_according_to_person_belongs_to_material_not_prompt(self):
        self.assert_partition([
            text('According to botanist Mira Lee, some trees grow slowly.'),
            text('The original study examined several tree species.'),
            text('Which choice completes the text with the most precise word?'),
        ], 2)

    def test_information_support_question_can_wrap_across_events(self):
        self.assert_partition([
            text('Researchers recorded three different growth rates.'),
            text('Information in the text best supports which statement about'),
            text('the researchers’ findings?'),
        ], 1)

    def test_text_makes_which_point_is_a_question(self):
        self.assert_partition([
            text('The account describes how a new measurement was developed.'),
            text('The text makes which point about the measurement?'),
        ], 1)

    def test_wrapped_student_goal_stays_with_its_question(self):
        self.assert_partition([
            text('• The first experiment used warm water.'),
            text('• The second experiment used cold water.'),
            text('The student wants to emphasize a difference between the two'),
            text('experiments while introducing their common purpose.'),
            text('Which choice most effectively uses the notes to do this?'),
        ], 2)

    def test_student_goal_and_question_can_share_a_pdf_line(self):
        self.assert_partition([
            text('• The new instrument uses less power than its predecessor.'),
            text('The student wants to explain this change. Which choice best'),
            text('uses relevant information from the notes to do so?'),
        ], 1)

    def test_image_and_original_spans_are_retained_on_their_side(self):
        image = {'kind': 'image', 'pageNumber': 2, 'bbox': [100, 60, 400, 240],
                 'sourceImageDigest': 'original-synthetic-image'}
        events = [text('The table shows the observations.'), image,
                  text('As used in the text, what does “consistent” mean?')]
        content, prompt = self.assert_partition(events, 2)
        self.assertIs(content[1], image)
        self.assertIs(prompt[0]['spans'], events[2]['spans'])

    def test_unrecognized_boundary_preserves_everything_and_warns(self):
        self.assert_partition([
            text('According to the observer, the new reading was stable.'),
            text('Select the best summary.'),
        ], 0, ['rw-prompt-boundary-unresolved'])

    def test_according_to_text_needs_an_actual_question(self):
        self.assert_partition([
            text('The author reports that the measured volume doubled.'),
            text('According to the text, which value was measured'),
            text('during the second experiment?'),
        ], 1)
        self.assert_partition([
            text('According to the passage, the result was surprising.'),
            text('It was nevertheless reproducible.'),
        ], 0, ['rw-prompt-boundary-unresolved'])

    def test_last_explicit_question_wins_over_a_narrative_question(self):
        self.assert_partition([
            text('What caused the sudden change? The researcher was uncertain.'),
            text('A later study identified a likely explanation.'),
            text('Which choice best states the main idea of the text?'),
        ], 2, ['rw-multiple-question-boundaries'])


if __name__ == '__main__':
    unittest.main()
