"""Schema/security regression tests use original fixtures and generated images."""
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import struct
import tempfile
import unittest
import zlib

from shared.contest_bank import (ContestStore, decode_json, http_url, no_symlinks,
    normalize_exam, normalize_problem, safe_path, sanitize_html, validate_image)

REPOSITORY = Path(__file__).resolve().parent.parent


def fixture(contest='amc10'):
    return json.loads((REPOSITORY / 'apps/contests/examples' / (contest + '.json')).read_text(encoding='utf-8'))


def png():
    def chunk(kind, body):
        return struct.pack('>I', len(body)) + kind + body + struct.pack('>I', zlib.crc32(kind + body) & 0xffffffff)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(b'\0\xff\xff\xff')) + chunk(b'IEND', b''))


class ContestSchemaTests(unittest.TestCase):
    def test_original_examples_and_normalization_idempotence(self):
        store = ContestStore(REPOSITORY, REPOSITORY / 'private-data-not-used-in-tests')
        catalog = store.catalog('example')
        self.assertEqual(catalog['totalProblems'], 10)
        self.assertEqual({x['contest'] for x in catalog['exams']}, {'AMC10', 'AMC12', 'AIME', 'USAMO'})
        self.assertEqual(catalog['errors'], [])
        for summary in catalog['exams']:
            document = store.exam(summary['id'], 'example')
            self.assertEqual(normalize_exam(summary, document['problems'], 'example'), (summary, document))
            for row in document['problems']:
                self.assertEqual(normalize_problem(row), row)
                self.assertFalse(row['quality']['solutions_reviewed'])
                self.assertIn('非官方', summary['title'])

    def test_answer_boundaries_and_proofs(self):
        rows = fixture('aime')['problems']
        self.assertEqual(normalize_problem(rows[0])['answer']['display'], '000')
        self.assertEqual(normalize_problem(rows[1])['answer']['display'], '999')
        for bad in (-1, 1000, True, False, 1.5, '000', None, float('nan')):
            row = copy.deepcopy(rows[0]); row['answer']['value'] = bad
            with self.subTest(value=bad), self.assertRaises(ValueError):
                normalize_problem(row)
        choice = fixture()['problems'][1]
        self.assertEqual(normalize_problem(choice)['answer']['accepted'], ['B', 'D'])
        for accepted in ([], ['F'], ['B', 'B'], ['a'], [True], 'B'):
            row = copy.deepcopy(choice); row['answer']['accepted'] = accepted
            with self.subTest(value=accepted), self.assertRaises(ValueError):
                normalize_problem(row)
        proof = fixture('usamo')['problems'][0]
        proof['quality']['auto_gradable'] = True
        self.assertFalse(normalize_problem(proof)['quality']['auto_gradable'])
        proof['answer'] = {'type': 'integer', 'value': 1}
        with self.assertRaises(ValueError):
            normalize_problem(proof)

    def test_dispute_overrides_auto_grading(self):
        row = fixture()['problems'][0]
        for flag in ('answer_source_disagreement', 'statement_variant_disagreement', 'disputed_answer', 'source_conflict'):
            row['quality']['flags'] = [flag]
            out = normalize_problem(row)
            self.assertFalse(out['quality']['auto_gradable'])
            self.assertFalse(out['quality']['ready_for_practice'])
        row['quality']['flags'] = []
        row['quality']['structurally_complete'] = False
        self.assertFalse(normalize_problem(row)['quality']['auto_gradable'])

    def test_strip_personal_fields_at_every_level(self):
        row = fixture()['problems'][0]
        sentinel = 'PERSONAL_DO_NOT_COPY'
        row.update(student=sentinel, userSelectedAnswer='A', attempts=[sentinel], customMetadata={'name': sentinel})
        row['statement']['personal'] = sentinel
        row['choices'][0]['selectedByUser'] = sentinel
        row['answer']['studentAnswer'] = sentinel
        row['solutions'][0]['authorEmail'] = sentinel
        row['solutions'][0]['source']['user'] = sentinel
        row['provenance'][0]['attempts'] = [sentinel]
        row['quality']['userScore'] = sentinel
        output = normalize_problem(row)
        self.assertNotIn(sentinel, json.dumps(output))
        self.assertEqual(output['provenance'][0]['dataset'], 'original_synthetic_example')
        self.assertEqual(output['answer']['accepted'], ['C'])
        self.assertEqual(output['solutions'][0]['verification'], 'synthetic_example')

    def test_revision_covers_answer_solution_quality_and_source(self):
        data = fixture(); original = normalize_exam(data['exam'], data['problems'])[0]['revision']
        for key in ('answer', 'solution', 'quality', 'source', 'statement'):
            mutated = copy.deepcopy(data)
            row = mutated['problems'][0]
            if key == 'answer': row['answer']['accepted'] = ['A']
            if key == 'solution': row['solutions'][0]['text_latex'] += ' Additional explanation.'
            if key == 'quality': row['quality']['flags'].append('missing_solution')
            if key == 'source': row['provenance'][0]['url'] = 'https://example.org/source'
            if key == 'statement': row['statement']['text_latex'] += ' Additional text.'
            with self.subTest(key=key):
                self.assertNotEqual(normalize_exam(mutated['exam'], mutated['problems'])[0]['revision'], original)
        data['problems'][0]['userSelectedAnswer'] = 'E'
        self.assertEqual(normalize_exam(data['exam'], data['problems'])[0]['revision'], original)
        self.assertNotEqual(normalize_exam(data['exam'], data['problems'], 'example')[0]['revision'], original)

    def test_exam_identity_coverage_and_types(self):
        data = fixture()
        cases = [lambda d: d['problems'][0].update(number=True),
                 lambda d: d['problems'][0].update(id='../secret'),
                 lambda d: d['problems'][0].update(question_type='proof'),
                 lambda d: d['problems'][0]['choices'].pop(),
                 lambda d: d['exam'].update(problem_count=9),
                 lambda d: d['exam'].update(missing_numbers=[1]),
                 lambda d: d['exam'].update(year=2025),
                 lambda d: d['problems'][0].update(paper='P'),
                 lambda d: d['problems'].append(d['problems'][0])]
        for mutate in cases:
            item = copy.deepcopy(data); mutate(item)
            with self.assertRaises((ValueError, TypeError)):
                normalize_exam(item['exam'], item['problems'])
        with self.assertRaises(ValueError): decode_json(b'{"id":1,"id":2}')
        with self.assertRaises(ValueError): decode_json(b'{"value":NaN}')

    def test_html_allowlist_control_urls_and_inert_asymptote(self):
        markup = '''<div class="latex-text arbitrary" onclick="steal()"><script>STEAL_SECRET</script>
        <a href="jav&#x09;ascript:alert(1)">bad</a><a href="https://example.org/a">good</a>
        <img src="data:text/html,no" onerror="steal()"><svg><script>x</script></svg>
        <p style="background:url(https://evil.invalid)">Safe $x^2$</p>
        <pre class="asymptote-source"><code>draw((0,0)--(1,1));</code></pre></div>'''
        safe, images = sanitize_html(markup)
        self.assertNotIn('STEAL_SECRET', safe)
        for bad in ('onclick', 'onerror', 'javascript', '<svg', '<script', 'arbitrary', 'style=', '<img', 'evil.invalid'):
            self.assertNotIn(bad, safe)
        self.assertIn('href="https://example.org/a"', safe)
        self.assertIn('draw((0,0)--(1,1));', safe)
        self.assertIn('asymptote-source', safe)
        self.assertEqual(images, set())
        for url in ('\x00javascript:alert(1)', 'java\nscript:alert(1)', '//example.org', 'data:image/svg+xml,x', 'file:///tmp', 'https://user:pass@example.org', 'https://example.org\\evil'):
            self.assertEqual(http_url(url), '')
        self.assertEqual(http_url('\x00 https://example.org\n'), 'https://example.org')
        row = fixture()['problems'][0]
        row['source_url'] = 'jav\x0bascript:alert(1)'
        row['provenance'][0]['url'] = 'data:text/html,test'
        output = normalize_problem(row)
        self.assertEqual(output['source_url'], '')
        self.assertNotIn('url', output['provenance'][0])
        self.assertNotIn('\x00', sanitize_html('<p>a\x00b</p>')[0])

    def test_html_only_explicit_local_assets(self):
        row = fixture()['problems'][0]
        row['assets'] = [{'local_path': 'assets/test.svg', 'sha256': '0' * 64},
                         {'local_path': 'assets/unreferenced.svg', 'sha256': '1' * 64}]
        row['statement']['html'] += '<img src="assets/test.svg" alt="diagram" onload="alert(1)">'
        output = normalize_problem(row)
        self.assertIn('src="/contest-assets/assets/test.svg"', output['statement']['html'])
        self.assertEqual([x['local_path'] for x in output['assets']], ['assets/test.svg'])
        row['assets'] = []
        with self.assertRaises(ValueError): normalize_problem(row)
        for value in ('assets/../secret.svg', '../assets/test.svg', '/assets/test.svg', 'assets/a%2f.svg', 'assets/a.svg:secret', 'assets\\a.svg'):
            safe, _ = sanitize_html('<img src="' + value + '">', ['assets/test.svg'])
            self.assertEqual(safe, '')

    def test_image_validation_rejects_active_svg_and_corrupt_png(self):
        valid = b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><path id="x" d="M0 0L1 1"/></defs><use href="#x"/></svg>'
        self.assertEqual(validate_image(valid, 'assets/a.svg'), 'image/svg+xml')
        for attack in (
            b'<script>alert(1)</script>', b'<foreignObject/>', b'<a href="https://example.org"/>',
            b'<use href="https://example.org/image.svg#x"/>', b'<use href="data:image/svg+xml,x"/>',
            b'<path onclick="alert(1)"/>', b'<path style="fill:url(https://example.org)"/>',
            b'<path fill="url(https://example.org)"/>', b'<animate attributeName="href"/>'):
            with self.subTest(attack=attack), self.assertRaises(ValueError):
                validate_image(b'<svg xmlns="http://www.w3.org/2000/svg">' + attack + b'</svg>', 'assets/a.svg')
        with self.assertRaises(ValueError):
            validate_image(b'<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///secret">]>' + valid, 'assets/a.svg')
        self.assertEqual(validate_image(png(), 'assets/a.png'), 'image/png')
        for bad in (png()[:-1], png() + b'<script>x</script>', b'not png'):
            with self.assertRaises(ValueError): validate_image(bad, 'assets/a.png')
        with self.assertRaises(ValueError): validate_image(b'not jpeg', 'assets/a.jpg')

    @unittest.skipUnless(os.name == 'nt', 'Windows junction regression only.')
    def test_windows_junction_ancestor_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); target = root / 'outside'; target.mkdir()
            (target / 'secret.txt').write_text('not served')
            link = root / 'junction'
            result = subprocess.run(['cmd', '/c', 'mklink', '/J', str(link), str(target)],
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
            if result.returncode:
                self.skipTest('Creating Windows junctions is unavailable on this host.')
            try:
                with self.assertRaisesRegex(ValueError, 'links'):
                    safe_path(root, 'junction/secret.txt')
                with self.assertRaisesRegex(ValueError, 'links'):
                    no_symlinks(link / 'not-created-yet')
            finally:
                # Remove only the exact generated junction, never its target tree.
                self.assertEqual(link.absolute().parent, root.absolute())
                self.assertEqual(link.name, 'junction')
                os.rmdir(link)
            self.assertEqual((target / 'secret.txt').read_text(), 'not served')

    def test_path_boundaries_and_symlinks(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); (root / 'safe').mkdir(); (root / 'secret').write_text('secret')
            for value in ('../secret', '/secret', 'safe/../../secret', 'safe\\secret', 'C:/secret', 'safe/a:secret', 'safe//secret'):
                with self.subTest(path=value), self.assertRaises(ValueError): safe_path(root, value)
            link = root / 'safe/link'
            try:
                link.symlink_to(root / 'secret')
            except (OSError, NotImplementedError):
                self.skipTest('Creating filesystem symlinks is unavailable on this host.')
            with self.assertRaises(ValueError): safe_path(root, 'safe/link')
            folder = root / 'link-folder'; folder.symlink_to(root / 'safe', target_is_directory=True)
            with self.assertRaises(ValueError): no_symlinks(folder / 'missing')


if __name__ == '__main__':
    unittest.main()
