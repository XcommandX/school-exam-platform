"""Original synthetic fixtures for conservative PDF-to-pack conversion."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'back-end/tools/sat'))
from convert_pdf_sat import build_answer, marker, question_fingerprint, remove_label, source_regions
import convert_pdf_sat as converter


def event(text, *, bold=False, x=90, page=1, baseline=100, size=11):
    span={'text':text,'flags':16 if bold else 0,'size':size,
          'font':'Synthetic-Bold' if bold else 'Synthetic','origin':[x,baseline],
          'bbox':[x,baseline-9,x+len(text)*5,baseline+3]}
    return {'kind':'text','text':text,'bbox':span['bbox'],'pageNumber':page,'spans':[span]}


class PdfConversionTests(unittest.TestCase):
    def test_question_anchor_requires_bold_and_left_alignment(self):
        self.assertEqual(marker(event('1.',bold=True)),('question',1))
        self.assertIsNone(marker(event('81.')))
        self.assertIsNone(marker(event('1.',bold=True,x=250)))

    def test_option_label_removed_without_discarding_content(self):
        value=remove_label(event('A. 3/5',bold=True),'A')
        self.assertEqual(value['text'],'3/5')
        self.assertGreater(value['bbox'][0],90)

    def test_fraction_whitespace_and_thousands(self):
        for raw,expected in [('52 / 53','52/53'),('1,500','1500')]:
            q={'answerText':raw,'warnings':[]}
            answer=build_answer(q,'student-produced-response')
            self.assertEqual(answer['acceptedRationals'],[expected])
            self.assertEqual(answer['status'],'needs-review')

    def test_numeric_choice_key_is_not_invented(self):
        q={'answerText':'168','warnings':[]}
        self.assertEqual(build_answer(q,'single-choice'),{'status':'missing','type':'single-choice'})
        self.assertEqual(q['warnings'],['unparsed-choice-answer'])

    def test_missing_prose_answer_does_not_become_a_number(self):
        q={'answerText':'about 3 or 4','warnings':[]}
        self.assertEqual(build_answer(q,'student-produced-response')['status'],'missing')

    def test_pairing_checks_images_and_visual_evidence(self):
        q={'body':[event('x2')],'options':{},'vectorSignature':[]}
        r={'body':[event('x2')],'options':{},'vectorSignature':[]}
        self.assertEqual(question_fingerprint(q),question_fingerprint(r))
        r['body'][0]['spans'][0]['flags']=1
        self.assertNotEqual(question_fingerprint(q),question_fingerprint(r))
        r={'body':[event('x2')],'options':{},'vectorSignature':[[10,1,'s']]}
        self.assertNotEqual(question_fingerprint(q),question_fingerprint(r))
        for question,sha in ((q,'a'),(r,'b')):
            question['body'].append({'kind':'image','sourceImageDigest':sha})
        self.assertNotEqual(question_fingerprint(q),question_fingerprint(r))

    def test_regions_keep_cross_page_evidence(self):
        regions=source_regions([event('one',page=1),event('two',page=2)])
        self.assertEqual([r['pageNumber'] for r in regions],[1,2])

    def test_conversion_inventory_uses_source_catalog_and_drops_public_or_removed_identities(self):
        for has_source_catalog in (True, False):
            with self.subTest(has_source_catalog=has_source_catalog), tempfile.TemporaryDirectory() as temporary:
                base=Path(temporary);source=base/'source';output=base/'staging';work=base/'work'
                source.mkdir();output.mkdir()
                (source/'synthetic.pdf').write_bytes(b'synthetic original source; PDF decoding mocked')
                entry={'collectionId':'pdf-known','sourceFile':'synthetic.pdf',
                       'sourceSha256':converter.digest((source/'synthetic.pdf').read_bytes())}
                original={**entry,'title':'Original','directory':'pdf-known','status':'converted','questionCount':1}
                stale={'collectionId':'combined-old','title':'Old public combination','questionCount':2}
                converter.write_json(output/'pdf-source-manifest.json',{'files':[entry]})
                converter.write_json(output/'catalog.json',{'schemaVersion':'sat-offline-conversion-catalog/1','collections':[stale]})
                if has_source_catalog:
                    converter.write_json(output/'source-catalog.json',{'schemaVersion':'sat-offline-conversion-catalog/1',
                        'collections':[original,dict(original,collectionId='pdf-removed',sourceFile='removed.pdf')]})
                class Pool:
                    def __init__(self, **_):pass
                    def __enter__(self):return self
                    def __exit__(self,*_):return False
                    def map(self,worker,args):
                        tasks=list(args)
                        self_entry=tasks[0][3]
                        assert self_entry['collectionId']=='pdf-known'
                        return [(original,None)]
                argv=['convert_pdf_sat.py','--source-root',str(source),'--output',str(output),'--work-dir',str(work)]
                with patch.object(sys,'argv',argv),patch.object(converter,'ProcessPoolExecutor',Pool),patch('builtins.print'):
                    self.assertEqual(converter.main(),0)
                for name in ('catalog.json','source-catalog.json'):
                    rows=json.loads((output/name).read_text())['collections']
                    self.assertEqual([row['collectionId'] for row in rows],['pdf-known'])

    def test_converter_refuses_to_rebuild_a_completed_assembly_in_place(self):
        with tempfile.TemporaryDirectory() as temporary:
            base=Path(temporary);base.joinpath('assembly-summary.json').write_text('{}')
            argv=['convert_pdf_sat.py','--source-root',str(base/'source'),'--output',str(base),'--work-dir',str(base/'work')]
            with patch.object(sys,'argv',argv),patch('sys.stderr'):
                with self.assertRaises(SystemExit) as stopped:converter.main()
            self.assertEqual(stopped.exception.code,2)
            self.assertFalse((base/'work').exists())


if __name__=='__main__':unittest.main()
