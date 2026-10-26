"""Synthetic, anonymous tests; no real exam text or files are committed."""
from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import unittest
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from unittest.mock import patch
import zipfile

from tools.ap import import_ap_language as imp


def mcq_lines():
    passage = 'A synthetic writer describes a small community garden and the care of its trees. '
    return [(1, 'Questions 1-2. Read the following passage.'), (1, passage * 3),
            (2, '1. What does the synthetic writer describe?'),
            (2, '(A) A garden'), (2, '(B) A river'), (2, '(C) A mountain'), (2, '(D) A road'), (2, '(E) A clock'),
            (3, '2. Which object grows in this synthetic garden?'),
            (3, '(A) A car'), (3, '(B) A tree'), (3, '(C) A train'), (3, '(D) A ship'), (3, '(E) A plane'),
            (3, 'END OF SECTION I')]


def frq_lines():
    return [(2, 'Question 1'), (2, 'Write an essay that synthesizes at least three sources about an imaginary garden. ' * 3),
            (3, 'Source A'), (3, 'This is the complete synthetic source A, including its final sentence. ' * 3),
            (4, 'Question 2'), (4, 'Write an essay analyzing the rhetorical choices in the following synthetic speech. ' * 3),
            (4, 'Synthetic speech with a beginning, a middle, and its final words.'),
            (5, 'Question 3'), (5, 'Write an essay that develops your position on imaginary town planning. ' * 3),
            (5, 'END OF EXAM'), (6, 'Acknowledgments, not part of a prompt.')]


def fake_pdf(path, key, **kwargs):
    payload = path.read_bytes()
    return imp.PDF(path, key, imp.sha256(payload), 4, [''] * 3 + ['Multiple-Choice Answer Key\n1 A    2 B'],
                   2030, 'Standard', 'mcq', lines=mcq_lines())


class APParserTests(unittest.TestCase):
    def test_classification_prefers_filename_year_and_form(self):
        self.assertEqual(imp.classify('1999-2030/ap24-frq-english-language-set-2.pdf', [], 10),
                         (2024, 'Set 2', 'frq'))
        self.assertEqual(imp.classify('1999-2030/ap11_english_language_form_b_scoring_guidelines.pdf', [], 8),
                         (2011, 'Form B', 'scoring'))
        self.assertEqual(imp.classify('2025/SG-2025-English-FRQ-set1.pdf', [], 8), (2025, 'Set 1', 'scoring'))
        self.assertEqual(imp.classify('2019/ap-english-language-2018-frq1-samples-2020-rubrics.pdf', [], 9)[2], 'reference')
        self.assertEqual(imp.classify('2030/compiled.pdf', [], 583)[2], 'reference')
        self.assertEqual(imp.classify('2024/ap24-apc-english-language-q1-set-1.pdf', [], 12)[2], 'sample')
        self.assertEqual(imp.classify('2013/Scoring/ap13_english_language_qa.pdf',
                                      ['Student Performance Q&A: 2013 AP English Language Free-Response Questions'], 8)[2], 'reference')

    def test_mcq_key_complete_structure_and_physical_pages(self):
        lines = mcq_lines()
        before = copy.deepcopy(lines)
        questions, warnings = imp.parse_mcq(lines, ['', '', '', 'Multiple-Choice Answer Key\n1 A    2 B'])
        self.assertEqual(lines, before)
        self.assertEqual(len(questions), 2)
        self.assertEqual([q['correctOption'] for q in questions], [0, 1])
        self.assertEqual(questions[0]['pages'], [1, 2])
        self.assertEqual(questions[1]['pages'], [1, 3])
        self.assertEqual(questions[1]['answerPage'], 4)
        self.assertIn('not human review', questions[0]['answerProvenance'])
        self.assertEqual(questions[0]['options'][-1], 'A clock')
        self.assertEqual(questions[1]['options'][-1], 'A plane')
        self.assertTrue(warnings)

    def test_unknown_withdrawn_conflicting_and_unofficial_keys_are_not_guessed(self):
        questions, _ = imp.parse_mcq(mcq_lines(), ['1. ANS: A\n2. ANS: B'])
        self.assertTrue(all(q['correctOption'] is None and q['reviewStatus'] == 'needs-review' for q in questions))
        key, withdrawn, _ = imp.extract_answer_key(['Answer Key for synthetic paper\nQuestion 1: A   Question 2*: —\nQuestion 3: B'])
        self.assertEqual(withdrawn, {2})
        self.assertEqual(key, {1: (0, 1), 3: (1, 1)})
        key, _, warnings = imp.extract_answer_key(['Multiple-Choice Answer Key\n1 A\n2 B',
                                                   'Multiple-Choice Answer Key\n1 C\n2 B'])
        self.assertNotIn(1, key)
        self.assertTrue(any('Conflicting' in warning for warning in warnings))

    def test_partial_options_and_wrong_key_numbering_fall_back_safely(self):
        lines = [line for line in mcq_lines() if line[1] != '(C) A mountain']
        questions, warnings = imp.parse_mcq(lines, [])
        self.assertEqual(questions, [])
        self.assertIn('five-option', warnings[0])
        questions, _ = imp.parse_mcq(mcq_lines(), ['Answer Key for different paper\n1 A\n3 B'])
        self.assertTrue(all(q['correctOption'] is None for q in questions))

    def test_frq_preserves_all_source_text_without_automatic_scoring(self):
        questions, warnings = imp.parse_frq(frq_lines(), year=2024)
        self.assertEqual(len(questions), 3)
        self.assertEqual(questions[0]['pages'], [2, 3])
        self.assertIn('including its final sentence', questions[0]['passage'])
        self.assertEqual([q['responseType'] for q in questions], ['synthesis', 'rhetorical-analysis', 'argument'])
        self.assertNotIn('Acknowledgments', questions[-1]['passage'])
        self.assertTrue(all(q['correctOption'] is None and q['reviewStatus'] == 'needs-review' for q in questions))
        self.assertTrue(warnings)

    def test_2025_numbered_frq_and_missing_copyright_passage(self):
        lines = [(page, text.replace('Question ', '').rstrip() + '. Synthetic prompt' if text.startswith('Question ') else text)
                 for page, text in frq_lines()]
        questions, _ = imp.parse_frq(lines, year=2025)
        self.assertEqual(len(questions), 3)
        lines = frq_lines()
        lines.insert(6, (4, 'The author denied permission to reprint this passage online.'))
        questions, warnings = imp.parse_frq(lines, year=1999)
        self.assertEqual([q['number'] for q in questions], [1, 3])
        self.assertTrue(any('withholds' in w for w in warnings))

    def test_bbox_orders_columns_without_interleaving_options(self):
        rows = []
        for i in range(4):
            for x, label in ((330, f'R{i}'), (40, f'L{i}')):
                rows.append(f'<line xMin="{x}" xMax="{x+80}" yMin="{100+i*20}" yMax="{112+i*20}"><word xMin="{x}">{label}</word></line>')
        xml = ('<html xmlns="http://www.w3.org/1999/xhtml"><body><doc><page width="612" height="792">'
               + ''.join(rows) + '</page></doc></body></html>').encode()
        self.assertEqual([text for _, text in imp.bbox_lines(xml)], ['L0', 'L1', 'L2', 'L3', 'R0', 'R1', 'R2', 'R3'])

    def test_repeated_frq_page_headers_do_not_extend_previous_question_pages(self):
        lines = frq_lines()
        lines.insert(4, (4, 'AP ® English Language and Composition 2030 Free-Response Questions'))
        lines.insert(8, (5, 'AP ENGLISH LANGUAGE AND COMPOSITION 2030 n FREE-RESPONSE QUESTIONS'))
        questions, _ = imp.parse_frq(imp.clean_lines(lines), year=2030)
        self.assertEqual(questions[0]['pages'], [2, 3])
        self.assertEqual(questions[1]['pages'], [4])
        self.assertTrue(all('FREE-RESPONSE QUESTIONS' not in q['passage'] for q in questions))

    def test_bbox_xml_control_glyphs_do_not_discard_visible_words(self):
        xml = b'<doc><page width="600"><line xMin="40" xMax="100" yMin="20"><word xMin="40">Read\x08</word><word xMin="60">this</word></line></page></doc>'
        self.assertEqual(imp.bbox_lines(xml), [(1, 'Read this')])

    def test_binary_stream_is_not_mistaken_for_active_pdf_dictionary(self):
        payload = b'%PDF-1.4\n1 0 obj << /Length 19 >> stream\n/JS /Ink /V (dummy)\nendstream\nendobj'
        self.assertIsNone(imp.privacy_reason('scan.pdf', '', payload, 'mcq'))
        self.assertIsNotNone(imp.privacy_reason('scan.pdf', '', payload + b'\n2 0 obj <</Type/EmbeddedFile>> endobj', 'mcq'))

    def test_successful_poppler_stderr_is_reported_without_raw_metadata(self):
        result = subprocess.CompletedProcess(['pdftotext'], 0, b'fixture', b'Warning private metadata C:/student/secret')
        warnings = []
        with patch.object(imp.subprocess, 'run', return_value=result):
            self.assertEqual(imp.run_tool(['pdftotext', 'fixture.pdf'], warnings=warnings), b'fixture')
        self.assertEqual(len(warnings), 1)
        self.assertNotIn('secret', warnings[0])
        self.assertIn('warnings', warnings[0])

    def test_reference_pairing_does_not_cross_form_or_ambiguous_papers(self):
        paper = imp.PDF(Path('unused'), 'ap30-frq-set-1.pdf', 'a' * 64, 6, [], 2030, 'Set 1', 'frq')
        correct = imp.PDF(Path('unused'), 'ap30-sg-set-1.pdf', 'b' * 64, 3, ['Question 1', 'Question 2', 'Question 3'], 2030, 'Set 1', 'scoring')
        wrong = imp.PDF(Path('unused'), 'ap30-sg-set-2.pdf', 'c' * 64, 3, [], 2030, 'Set 2', 'scoring')
        questions, warnings = imp.parse_frq(frq_lines(), year=2030)
        data = imp.make_set(paper, 'frq', questions, warnings)
        paired = imp.pair_references([(paper, data)], [correct, wrong])
        self.assertEqual(paired, {'b' * 64})
        self.assertEqual(len(data['documents']), 2)
        self.assertEqual(data['questions'][1]['answerPage'], 2)
        self.assertEqual(imp.pair_references([(paper, data), (paper, copy.deepcopy(data))], [correct]), set())

    def test_ids_stable_and_full_contract_is_valid(self):
        paper = imp.PDF(Path('unused'), '2030/paper.pdf', 'a' * 64, 4, [], 2030, 'Standard', 'mcq')
        questions, warnings = imp.parse_mcq(mcq_lines(), ['Multiple-Choice Answer Key\n1 A\n2 B'])
        data = imp.make_set(paper, 'mcq', questions, warnings)
        imp._validate(data)
        paper.digest = 'b' * 64
        changed = imp.make_set(paper, 'mcq', copy.deepcopy(questions), warnings)
        self.assertEqual(changed['id'], data['id'])
        self.assertNotEqual(changed['documents'][0]['asset'], data['documents'][0]['asset'])

    def test_personal_records_are_skipped_but_anonymous_samples_allowed(self):
        for key, text, payload in [('my-answers.pdf', '', b'%PDF-1.4'),
                                   ('paper.pdf', 'Name: PRIVATE PERSON', b'%PDF-1.4'),
                                   ('paper.pdf', 'userSelectedAnswer: B', b'%PDF-1.4'),
                                   ('paper.pdf', '', b'%PDF-1.4 /Subtype /Ink'),
                                   ('paper.pdf', '', b'%PDF-1.4 /FT /Tx /V (PRIVATE PERSON) endobj')]:
            self.assertIsNotNone(imp.privacy_reason(key, text, payload, 'mcq'))
        self.assertIsNone(imp.privacy_reason('ap30-apc-q1.pdf', 'Score: 1-4-1\nSample A', b'%PDF-1.4', 'sample'))
        self.assertIsNone(imp.privacy_reason('paper.pdf', 'Name: __________ Class: ______', b'%PDF-1.4 /FT /Tx /V () endobj', 'mcq'))


@unittest.skipUnless(shutil.which('git'), 'Git needed to verify ignored private output')
class APImportSecurityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / 'repo'
        self.repo.mkdir()
        subprocess.run(['git', 'init', '--quiet', str(self.repo)], check=True)
        (self.repo / '.gitignore').write_text('local-data/\n', encoding='utf-8')
        self.source = self.root / 'source'
        self.source.mkdir()
        self.pdf = self.source / 'paper.pdf'
        self.pdf.write_bytes(b'%PDF-1.4\nsynthetic fixture, never a real paper\n%%EOF')
        self.private = self.repo / 'local-data'

    def run_import(self, **kwargs):
        with patch.object(imp, 'inspect_pdf', side_effect=fake_pdf), patch.object(imp.shutil, 'which', return_value='synthetic-tool'):
            return imp.import_directory(self.source, repository=self.repo, **kwargs)

    def test_real_output_contract_duplicate_idempotence_and_source_unchanged(self):
        (self.source / 'copy.pdf').write_bytes(self.pdf.read_bytes())
        original = {p.name: p.read_bytes() for p in self.source.iterdir()}
        first = self.run_import()
        self.assertEqual(first['duplicatePdfCount'], 1)
        self.assertEqual(first['importedSetCount'], 1)
        banks = list((self.private / 'question-banks' / 'ap').glob('*.json'))
        before = {p: (p.read_bytes(), p.stat().st_mtime_ns) for p in banks}
        second = self.run_import()
        self.assertEqual(second['writtenSetCount'], 0)
        self.assertEqual(second['unchangedSetCount'], 1)
        for path, snapshot in before.items():
            self.assertEqual((path.read_bytes(), path.stat().st_mtime_ns), snapshot)
            imp._validate(json.loads(path.read_text('utf-8')))
        self.assertEqual({p.name: p.read_bytes() for p in self.source.iterdir()}, original)
        manifest = (self.private / 'ap-import-manifest.json').read_text('utf-8')
        self.assertNotIn(str(self.source), manifest)
        self.assertNotIn('paper.pdf', manifest)

    def test_manifest_changes_require_replace_and_ids_survive_content_revision(self):
        self.run_import()
        manifest = json.loads((self.private / 'ap-import-manifest.json').read_text('utf-8'))
        original_id = manifest['sets'][0]['id']
        self.pdf.write_bytes(self.pdf.read_bytes() + b'\nupdated synthetic fixture')
        with self.assertRaisesRegex(ValueError, 'manifest changed'):
            self.run_import()
        self.assertEqual(json.loads((self.private / 'ap-import-manifest.json').read_text('utf-8')), manifest)
        report = self.run_import(replace=True)
        self.assertEqual(report['sets'][0]['id'], original_id)
        self.assertEqual(report['writtenSetCount'], 1)

    def test_modified_bank_not_overwritten_without_explicit_replace(self):
        self.run_import()
        bank = next((self.private / 'question-banks' / 'ap').glob('*.json'))
        bank.write_text('{"manual":true}', 'utf-8')
        with self.assertRaisesRegex(ValueError, 'existing AP set differs'):
            self.run_import()
        self.assertEqual(bank.read_text('utf-8'), '{"manual":true}')

    def test_git_ignore_and_tracked_output_required(self):
        (self.repo / '.gitignore').write_text('', 'utf-8')
        with self.assertRaisesRegex(ValueError, 'ignored'):
            self.run_import()
        (self.repo / '.gitignore').write_text('local-data/\n', 'utf-8')
        self.private.mkdir()
        tracked = self.private / 'tracked.txt'
        tracked.write_text('anonymous fixture', 'utf-8')
        subprocess.run(['git', 'add', '-f', 'local-data/tracked.txt'], cwd=self.repo, check=True)
        with self.assertRaisesRegex(ValueError, 'tracked'):
            self.run_import()

    def test_archive_rejects_traversal_symlinks_and_size_limits(self):
        for index, name in enumerate(('../escape.pdf', 'C:/escape.pdf', '/escape.pdf', 'folder/../../escape.pdf', 'folder\\..\\escape.pdf')):
            archive = self.root / f'unsafe-{index}.zip'
            with zipfile.ZipFile(archive, 'w') as z:
                z.writestr(name, b'%PDF-1.4')
            with self.assertRaisesRegex(ValueError, 'Unsafe ZIP'):
                with imp.archive_source(archive, self.private):
                    self.fail('Unsafe archive yielded a path')
        archive = self.root / 'link.zip'
        info = zipfile.ZipInfo('linked.pdf')
        info.create_system = 3
        info.external_attr = (stat.S_IFLNK | 0o777) << 16
        with zipfile.ZipFile(archive, 'w') as z:
            z.writestr(info, '../secret.pdf')
        with self.assertRaisesRegex(ValueError, 'links'):
            with imp.archive_source(archive, self.private):
                pass
        archive = self.root / 'large.zip'
        with zipfile.ZipFile(archive, 'w') as z:
            z.writestr('large.pdf', b'12345')
        with patch.object(imp, 'MAX_PDF_BYTES', 4), self.assertRaisesRegex(ValueError, 'size limit'):
            with imp.archive_source(archive, self.private):
                pass

    def test_archive_copies_only_pdfs_and_cleans_temp_directory(self):
        archive = self.root / 'safe.zip'
        with zipfile.ZipFile(archive, 'w') as z:
            z.writestr('folder/paper.pdf', self.pdf.read_bytes())
            z.writestr('folder/answers.json', '{"private":"not imported"}')
            z.writestr('folder/photo.jpg', b'not a PDF')
        with imp.archive_source(archive, self.private) as root:
            extracted = root
            self.assertTrue((root / 'folder' / 'paper.pdf').is_file())
            self.assertFalse((root / 'folder' / 'answers.json').exists())
            self.assertFalse((root / 'folder' / 'photo.jpg').exists())
        self.assertFalse(extracted.exists())
        self.assertTrue(archive.exists())

    def test_removed_source_only_deletes_unchanged_manifest_owned_set(self):
        self.run_import()
        bank = next((self.private / 'question-banks' / 'ap').glob('*.json'))
        data = json.loads(bank.read_text('utf-8'))
        data['title'] = 'Manual edit without changing revision field'
        bank.write_text(json.dumps(data), 'utf-8')
        self.pdf.rename(self.source / 'renamed.pdf')
        before = (self.private / 'ap-import-manifest.json').read_bytes()
        with self.assertRaisesRegex(ValueError, 'manually changed'):
            self.run_import(replace=True)
        self.assertTrue(bank.exists())
        self.assertEqual((self.private / 'ap-import-manifest.json').read_bytes(), before)

    def test_output_exception_rules_are_checked_for_actual_asset_names(self):
        digest = imp.sha256(self.pdf.read_bytes())
        (self.repo / '.gitignore').write_text(
            'local-data/*\n!local-data/question-assets/\nlocal-data/question-assets/*\n'
            '!local-data/question-assets/ap/\nlocal-data/question-assets/ap/*\n'
            '!local-data/question-assets/ap/' + digest + '.pdf\n', 'utf-8')
        with self.assertRaisesRegex(ValueError, 'Every output'):
            self.run_import()
        self.assertFalse((self.private / 'ap-import-manifest.json').exists())

    def test_symlink_detection_without_os_privileges(self):
        with patch.object(Path, 'is_symlink', return_value=True), self.assertRaisesRegex(ValueError, 'links'):
            imp._plain_path(self.pdf)

    def test_symlink_source_and_output_rejected_if_supported(self):
        link = self.source / 'linked.pdf'
        try:
            link.symlink_to(self.pdf)
        except OSError:
            self.skipTest('OS account cannot create symlinks')
        with self.assertRaisesRegex(ValueError, 'links'):
            imp.discover_pdfs(self.source)
        link.unlink()
        self.private.mkdir()
        outside = self.root / 'outside'
        outside.mkdir()
        (self.private / 'question-banks').symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'links'):
            self.run_import()
        self.assertFalse(list(outside.iterdir()))


if __name__ == '__main__':
    unittest.main()
