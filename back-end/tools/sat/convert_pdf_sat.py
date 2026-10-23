#!/usr/bin/env python3
"""Convert editable, single-column SAT PDF sources without inventing missing content.

Requires PyMuPDF 1.26.7 for this offline maintenance command only. Website runtime
remains stdlib-only. Extraction evidence and review outputs belong in local-data.
"""
from __future__ import annotations
import argparse
from collections import Counter, defaultdict
from concurrent.futures import ProcessPoolExecutor
from fractions import Fraction
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import sys
import tempfile
import uuid
import unicodedata
from pdf_sat_latex import render_line
from pdf_sat_rw import split_body

ROOT = Path(__file__).resolve().parents[3]
PACK_NAMES = ('rw-single-choice', 'math-single-choice', 'math-spr')
PROFILE = {'id':'sat-spr-input/0.1-draft','status':'requires-rule-review',
           'maxNonnegativeCharacters':5,'maxNegativeCharacters':6,
           'allowedForms':['integer','decimal','fraction'],'allowMixedNumber':False}
VERSION = 3


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode='w',encoding='utf-8',dir=path.parent,
                                     prefix='.'+path.name,suffix='.tmp',delete=False) as stream:
        temporary = Path(stream.name)
        json.dump(value,stream,ensure_ascii=False,indent=2)
        stream.write('\n')
    temporary.replace(path)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8'))


def load_fitz():
    try:
        import pymupdf
        return pymupdf
    except ImportError as exc:
        raise RuntimeError('Install PyMuPDF==1.26.7 in a maintenance environment before conversion.') from exc


def events_for_page(page, page_number):
    fitz = load_fitz()
    events = []
    for block in page.get_text('dict', flags=fitz.TEXTFLAGS_DICT & ~fitz.TEXT_PRESERVE_IMAGES)['blocks']:
        for line in block.get('lines', []):
            spans = line['spans']
            value = ''.join(s['text'] for s in spans).strip()
            if not value or value == '留学考试资料库':
                continue
            events.append({'kind':'text','text':value,'bbox':list(line['bbox']),
                           'pageNumber':page_number,'spans':spans})
    for info in page.get_image_info(hashes=True):
        events.append({'kind':'image','bbox':list(info['bbox']),'pageNumber':page_number,
                       'sourceImageDigest':info['digest'].hex()})
    # A source PDF can paint several overlapping glyph runs (math / degree symbols).
    # Preserve their geometry; the renderer uses a raster fallback for overlap.
    # STIX mathematical glyphs have oversized ascender boxes. Sort text by its
    # painted baseline, not bbox top (which can precede the preceding question).
    events.sort(key=lambda e:(round(min(s['origin'][1] for s in e['spans'])-9,1)
                              if e['kind']=='text' else round(e['bbox'][1],1),e['bbox'][0]))
    return events


def marker(event):
    if event['kind'] != 'text':
        return None
    text = event['text']
    match = re.fullmatch(r'Module\s*([123])(?:\s*[-–:(].*)?', text, re.I)
    if match:
        return ('module', int(match[1]))
    if '【答案】' in text:
        return ('answer', text.split('【答案】',1)[1].strip())
    if '【解析】' in text:
        return ('explanation', text.split('【解析】',1)[1].strip())
    if event['bbox'][0] <= 115:
        match = re.fullmatch(r'(\d{1,3})\.', text)
        if match and any(s['flags'] & 16 for s in event['spans']):
            return ('question', int(match[1]))
        match = re.match(r'^([ABCD])[.．](?:\s|$)', text)
        if match and any(s['flags'] & 16 for s in event['spans'][:1]):
            return ('option', match[1])
    return None


def source_regions(events):
    groups = defaultdict(list)
    for event in events:
        groups[event['pageNumber']].append(event['bbox'])
    return [{'pageNumber':page,'bbox':[min(b[0] for b in boxes),min(b[1] for b in boxes),
                                     max(b[2] for b in boxes),max(b[3] for b in boxes)]}
            for page,boxes in sorted(groups.items())]


def remove_label(event, label):
    event = dict(event)
    spans = [dict(s) for s in event['spans']]
    text = ''.join(s['text'] for s in spans)
    match = re.match(r'\s*'+re.escape(label)+r'[.．]\s*', text)
    if not match:
        return event
    remaining = match.end()
    for span in spans:
        n = len(span['text'])
        removed = min(remaining,n)
        if removed:
            # Labels are separate bold spans in this source family. Retain a
            # conservative glyph-width offset for a combined label/content span.
            box = list(span['bbox'])
            box[0] += (box[2]-box[0])*removed/max(1,n)
            span['bbox'] = box
            span['text'] = span['text'][removed:]
            remaining -= removed
    spans = [s for s in spans if s['text'].strip()]
    event['spans'] = spans
    event['text'] = ''.join(s['text'] for s in spans).strip()
    if spans:
        event['bbox'] = [min(s['bbox'][0] for s in spans),min(s['bbox'][1] for s in spans),
                         max(s['bbox'][2] for s in spans),max(s['bbox'][3] for s in spans)]
    return event


def extract_pdf(source, relative, collection_id):
    fitz = load_fitz()
    doc = fitz.open(source)
    section = 'math' if relative.split('/')[0] == '数学' else 'reading-writing'
    module = 1
    filename_module = re.search(r'(?:M|Module\s*)([12])(?:\D|$)', Path(relative).stem, re.I)
    if filename_module:
        module = int(filename_module[1])
    questions, notes, module_markers = [], [], []
    vector_objects = {}
    current = None
    field = 'body'
    option = None
    for page_index, page in enumerate(doc):
        vector_objects[page_index+1] = page.get_drawings()
        for event in events_for_page(page, page_index+1):
            control = marker(event)
            if control and control[0] == 'module':
                module = control[1]
                module_markers.append({'moduleNumber':module,'pageNumber':page_index+1})
                current = None
                field = 'body'
                continue
            if control and control[0] == 'question':
                number = control[1]
                # Explanation list numbers and wrapped years are not questions.
                if number < 1 or number > 150 or current and number <= current['questionNumber']:
                    control = None
                else:
                    current = {'sourceQuestionId':f'm{module}-q{number}', 'section':section,
                               'moduleNumber':module,'questionNumber':number,'body':[],
                               'options':{},'answerEvents':[],'explanation':[],
                               'marker':event,'warnings':[]}
                    questions.append(current)
                    field, option = 'body', None
                    continue
            if current is None:
                continue
            if control and control[0] == 'answer':
                field = 'answerEvents'
                current['answerMarker'] = event
                tail = dict(event, text=control[1], spans=[])
                if tail['text']:
                    current[field].append(tail)
                continue
            if control and control[0] == 'explanation':
                field = 'explanation'
                current['explanationMarker'] = event
                if control[1]:
                    current[field].append(dict(event,text=control[1],spans=[]))
                continue
            if control and control[0] == 'option' and field not in ('answerEvents','explanation'):
                option = control[1]
                if option in current['options']:
                    current['warnings'].append('duplicate-option-label')
                current['options'].setdefault(option,[])
                field = 'options'
                event = remove_label(event,option)
                if event['text']:
                    current['options'][option].append(event)
                continue
            if field == 'options':
                current['options'][option].append(event)
            else:
                current[field].append(event)
    page_count = len(doc)
    doc.close()
    for q in questions:
        q['answerText'] = ' '.join(e.get('text','') for e in q['answerEvents']).strip()
        nonempty = {key:events for key,events in q['options'].items()
                    if any(e['kind']=='image' or e.get('text','').strip() for e in events)}
        if section == 'math' and not nonempty:
            q['responseType'] = 'student-produced-response'
            if q['options']:
                q['warnings'].append('empty-source-option-placeholders-omitted')
            q['options'] = {}
            if 'duplicate-option-label' in q['warnings']:
                q['warnings'] = [x for x in q['warnings'] if x!='duplicate-option-label']
                q['warnings'].append('repeated-empty-source-option-placeholders-omitted')
        else:
            q['responseType'] = 'single-choice'
            if sorted(nonempty) != list('ABCD'):
                q['warnings'].append('incomplete-choice-options')
        q['regions'] = source_regions([q['marker']] + q['body'])
        q['vectorSignature'] = []
        for region in source_regions(q['body'] + [e for v in q['options'].values() for e in v]):
            x0,y0,x1,y1 = region['bbox']
            for drawing in vector_objects[region['pageNumber']]:
                rect = drawing['rect']
                if rect.y0>=y0-1 and rect.y1<=y1+1 and rect.x0>=x0-1 and rect.x1<=x1+1:
                    # Translation-independent shape, size and stroke evidence.
                    q['vectorSignature'].append([round(rect.width,2),round(rect.height,2),
                        drawing.get('type'),drawing.get('width'),drawing.get('color'),drawing.get('fill'),
                        len(drawing.get('items',[]))])
        if not q['body']:
            q['warnings'].append('empty-question-body')
    return {'schemaVersion':'sat-pdf-extraction/1','converterVersion':VERSION,
            'collectionId':collection_id,'sourceFile':relative,'sourceSha256':digest(source.read_bytes()),
            'pageCount':page_count, 'section':section,'moduleMarkers':module_markers,
            'questions':questions,'warnings':notes}


def escape_md(text):
    text = text.replace('\xa0',' ')
    text = text.replace('&','&amp;').replace('<','&lt;').replace('>','&gt;')
    return re.sub(r'([\\`*_{}\[\]$])', r'\\\1', text)


def markdown_line(event):
    if not event.get('spans'):
        return escape_md(event.get('text',''))
    parts = []
    for span in event['spans']:
        text = escape_md(span['text'])
        if not text.strip():
            parts.append(text)
            continue
        leading = text[:len(text)-len(text.lstrip())]
        trailing = text[len(text.rstrip()):]
        text = text.strip()
        if span['flags'] & 2:
            text = '*'+text+'*'
        if span['flags'] & 16:
            text = '**'+text+'**'
        parts.append(leading+text+trailing)
    return ''.join(parts).strip()


class Renderer:
    def __init__(self, source, collection_id):
        self.doc = load_fitz().open(source)
        self.collection_id = collection_id
        self.drawings = {}
        self.raster_count = 0
        self.formula_count = 0
        self.warnings = []

    def asset(self, builder, page_number, bbox, question_id):
        fitz = load_fitz()
        page = self.doc[page_number-1]
        box = fitz.Rect(bbox)
        box = fitz.Rect(max(0,box.x0-1),max(55,box.y0-1),min(page.rect.width,box.x1+1),min(page.rect.height,box.y1+1))
        image = page.get_pixmap(matrix=fitz.Matrix(1.5,1.5),clip=box,alpha=False)
        data = image.tobytes('png')
        sha = digest(data)
        identity = 'asset-'+sha
        builder['bytes'][identity] = data
        if not any(a['id']==identity for a in builder['pack']['assets']):
            builder['pack']['assets'].append({'id':identity,'path':'assets/'+sha+'.png','mediaType':'image/png',
                'sha256':sha,'byteLength':len(data),'source':{'kind':'pdf-source-region',
                'sourceSetId':self.collection_id,'sourceQuestionId':question_id}})
        return {'type':'image','assetId':identity,'role':'illustration','alt':'Source question content.'}

    def blocks(self, events, builder, question_id, *, section, explanation=False):
        if not events:
            return []
        # Formulas use LaTeX, never formula screenshots. Source ambiguities are
        # review warnings, not an invitation to infer missing math notation.
        risky = False
        for page_number in set(e['pageNumber'] for e in events):
            if page_number not in self.drawings:
                self.drawings[page_number] = self.doc[page_number-1].get_drawings()
        # Underlines and other vector objects are significant in R&W. Preserve
        # exact affected regions as images instead of dropping their meaning.
        for region in source_regions(events):
            x0,y0,x1,y1 = region['bbox']
            if section != 'math' and any(d['rect'].y0 >= y0-1 and d['rect'].y1 <= y1+1 and d['rect'].x1>x0 and d['rect'].x0<x1
                   for d in self.drawings[region['pageNumber']]):
                risky = True
        rendered = {}
        for index,event in enumerate(events):
            if event['kind']=='text':
                text,warnings,count = render_line(event,section=section)
                self.formula_count += count
                self.warnings.extend({'sourceQuestionId':question_id,'issue':w,'pageNumber':event['pageNumber']}
                                     for w in warnings)
                rendered[index] = text if count or section=='math' else markdown_line(event)
                if count:
                    risky = False
        if risky:
            self.raster_count += 1
            return [self.asset(builder,r['pageNumber'],r['bbox'],question_id) for r in source_regions(events)]
        blocks, pending = [], []
        def flush():
            if pending:
                text = '\n'.join(pending).strip()
                if text:
                    blocks.append({'type':'markdown','text':text})
                pending.clear()
        previous = None
        for index,event in enumerate(events):
            if event['kind']=='image':
                flush()
                blocks.append(self.asset(builder,event['pageNumber'],event['bbox'],question_id))
            else:
                if previous and (event['pageNumber'] != previous['pageNumber'] or event['bbox'][1]-previous['bbox'][3] > 7):
                    pending.append('')
                pending.append(rendered[index])
            previous = event
        flush()
        return blocks


def build_answer(question, response):
    raw = question['answerText'].strip()
    base = {'status':'missing','type':response}
    if not raw:
        return base
    if response == 'single-choice':
        if re.fullmatch(r'[ABCD][.。]?',raw):
            return {'status':'needs-review','type':response,'optionId':'choice-'+raw[0].lower()}
        question['warnings'].append('unparsed-choice-answer')
        return base
    # Unambiguous numeric alternatives only. Never infer a value from a prose
    # explanation, malformed formula, range, or approximate annotation.
    raw = raw.replace('−','-').replace('–','-').replace('，',',').replace('；',';')
    raw = re.sub(r'(?<=\d)\s*/\s*(?=\d)','/',raw)
    if re.fullmatch(r'-?\d{1,3}(?:,\d{3})+(?:\.\d+)?',raw):
        raw = raw.replace(',','')
    values = re.split(r'\s*(?:;|,|\bor\b|或)\s*',raw)
    values = [v.strip().rstrip('。') for v in values]
    if all(re.fullmatch(r'-?(?:\d+(?:\.\d+)?|\.\d+|\d+/\d+)',v) for v in values):
        try:
            numbers = [Fraction(v) for v in values]
            rationals = [str(x) for x in numbers]
            # Current protocol permits exact values whose equivalent input fits.
            return {'status':'needs-review','type':response,'comparison':'exact-rational-or-listed-decimal',
                    'acceptedRationals':list(dict.fromkeys(rationals)), 'acceptedDecimalSpellings':[]}
        except (ZeroDivisionError,ValueError):
            pass
    question['warnings'].append('unparsed-spr-answer')
    return base


def new_builder(collection_id, title, name):
    response = 'student-produced-response' if name=='math-spr' else 'single-choice'
    pack = {'schemaVersion':'sat-question-pack/0.1-draft','documentType':'sat-question-pack','status':'draft',
        'exam':'sat','id':f'sat:pack:{collection_id}-{name}','revision':1,'title':title+' · '+name,
        'section':'reading-writing' if name.startswith('rw') else 'math','responseType':response,
        'contentFormat':'markdown-latex/0.1-draft','files':{'items':'items.json','solutions':'solutions.json'},'assets':[]}
    if name=='math-spr':
        pack['inputProfile'] = PROFILE.copy()
    return {'pack':pack,'items':[],'solutions':[],'bytes':{}}


def question_fingerprint(question):
    """Compare paired PDFs using text AND actual drawn image content."""
    groups = [question['body']] + [question['options'][k] for k in sorted(question['options'])]
    parts = []
    for events in groups:
        text = ''.join(e.get('text','') for e in events)
        text = re.sub(r'\s+', '', unicodedata.normalize('NFKC',text))
        images = [e.get('sourceImageDigest') for e in events if e['kind']=='image']
        styles = []
        for event in events:
            spans = event.get('spans',[])
            baselines = Counter()
            for span in spans:
                baselines[round(span['origin'][1],1)] += len(span['text'].strip())
            baseline = baselines.most_common(1)[0][0] if baselines else 0
            for span in spans:
                offset = span['origin'][1]-baseline
                # PDF page translations change sub-point float rounding. Only
                # meaningful raised/lowered baselines enter the identity check.
                shift = -1 if offset < -1.4 else 1 if offset > 1.4 else 0
                style = (span['flags'] & 3,round(span['size'],1),shift)
                for char in unicodedata.normalize('NFKC',span['text']):
                    if not char.isspace():styles.append((char,style))
        parts.append((text,images,styles))
    parts.append(sorted(question.get('vectorSignature',[]),key=str))
    return digest(json.dumps(parts,ensure_ascii=False).encode())


def get_extraction(source_root, evidence_root, entry):
    path = evidence_root/(entry['collectionId']+'.json')
    extracted = read_json(path) if path.exists() else {}
    if extracted.get('sourceSha256')!=entry['sourceSha256'] or extracted.get('converterVersion')!=VERSION:
        extracted = extract_pdf(source_root/entry['sourceFile'],entry['sourceFile'],entry['collectionId'])
        write_json(path,extracted)
    return extracted


def create_collection(source_root, output_root, evidence_root, entry):
    source = source_root/entry['sourceFile']
    extraction_path = evidence_root/(entry['collectionId']+'.json')
    extracted = get_extraction(source_root,evidence_root,entry)
    collection_id = entry['collectionId']
    questions = extracted['questions']
    write_json(extraction_path,extracted)
    if not questions:
        raise ValueError('No questions found')
    positions = [(q['moduleNumber'],q['questionNumber']) for q in questions]
    if len(set(positions))!=len(positions):
        raise ValueError('Duplicate source positions')
    invalid = [q['sourceQuestionId'] for q in questions if any(x in q['warnings'] for x in ('incomplete-choice-options','empty-question-body','duplicate-option-label'))]
    if invalid:
        raise ValueError('Question boundaries/options need review: '+','.join(invalid))
    builders = {}
    renderer = Renderer(source,collection_id)
    paired_renderer = None
    paired_questions = {}
    if entry.get('answerSource'):
        paired = get_extraction(source_root,evidence_root,entry['answerSource'])
        paired_questions = {q['sourceQuestionId']:q for q in paired['questions']}
        paired_renderer = Renderer(source_root/entry['answerSource']['sourceFile'],paired['collectionId'])
    title = Path(entry['sourceFile']).stem
    report = {'collectionId':collection_id,'sourceFile':entry['sourceFile'],'sourceSha256':entry['sourceSha256'],
              'sourceUnmodified':True,'questionCount':len(questions),'fullSAT':False,'assessmentFile':None,
              'conversionMode':'pdf','sourceOrder':[],'modules':[],'packs':{},'reviewNotes':[],
              'answerStatus':{},'explanationsMissing':0}
    counts = Counter()
    for q in questions:
        q['warnings'] = [w for w in q['warnings'] if not w.startswith(('rw-','unparsed-','paired-pdf-'))]
        q.pop('pairedAnswerSource',None)
        name = 'rw-single-choice' if q['section']=='reading-writing' else ('math-single-choice' if q['responseType']=='single-choice' else 'math-spr')
        builder = builders.setdefault(name,new_builder(collection_id,title,name))
        identity = f"sat:item:{collection_id}-{q['sourceQuestionId']}"
        provenance = {'kind':'editable-pdf-source','sourceSetId':collection_id,'sourceQuestionId':q['sourceQuestionId']}
        content, prompt = [], None
        # R&W uses separate material/question panes. Keep every source event.
        if q['section']=='reading-writing':
            material,question_body,boundary_warnings = split_body(q['body'])
            q['warnings'].extend(boundary_warnings)
            content = renderer.blocks(material,builder,q['sourceQuestionId'],section=q['section'])
            prompt = renderer.blocks(question_body,builder,q['sourceQuestionId'],section=q['section'])
        if prompt is None:
            prompt = renderer.blocks(q['body'],builder,q['sourceQuestionId'],section=q['section'])
        item = {'id':identity,'revision':1,'classification':{'skill':'Unclassified'},'content':content,'prompt':prompt,'source':provenance}
        if q['responseType']=='single-choice':
            item['options'] = [{'id':'choice-'+label.lower(),'content':renderer.blocks(q['options'][label],builder,q['sourceQuestionId'],section=q['section'])} for label in 'ABCD']
        solution_question = q
        solution_renderer = renderer
        solution_provenance = dict(provenance,kind='pdf-source-standard-answer')
        counterpart = paired_questions.get(q['sourceQuestionId'])
        if counterpart and question_fingerprint(q)==question_fingerprint(counterpart):
            solution_question = dict(q,answerText=counterpart['answerText'],explanation=counterpart['explanation'])
            solution_renderer = paired_renderer
            solution_provenance['sourceSetId'] = entry['answerSource']['collectionId']
            q['pairedAnswerSource'] = {'collectionId':entry['answerSource']['collectionId'],
                'sourceQuestionId':q['sourceQuestionId'],'contentFingerprint':question_fingerprint(q)}
        elif paired_renderer:
            q['warnings'].append('paired-pdf-content-mismatch-answer-not-transferred')
        answer = build_answer(solution_question,q['responseType'])
        explanation = solution_renderer.blocks(solution_question['explanation'],builder,q['sourceQuestionId'],section=q['section'],explanation=True)
        solution = {'itemId':identity,'itemRevision':1,'answer':answer,
                    'explanation':{'status':'needs-review' if explanation else 'missing','content':explanation},
                    'provenance':solution_provenance}
        builder['items'].append(item)
        builder['solutions'].append(solution)
        counts[q['section'],q['moduleNumber']] += 1
        report['sourceOrder'].append({'sourceQuestionId':q['sourceQuestionId'],'section':q['section'],
            'moduleNumber':q['moduleNumber'],'number':q['questionNumber'],'packId':builder['pack']['id'],
            'packRevision':1,'itemId':identity,'itemRevision':1})
        for warning in q['warnings']:
            note = {'sourceQuestionId':q['sourceQuestionId'],'issue':warning}
            if warning.startswith('unparsed-'):
                note['sourceAnswer'] = solution_question['answerText']
            report['reviewNotes'].append(note)
    for (section,module),count in counts.items():
        report['modules'].append({'section':section,'moduleNumber':module,'questionCount':count})
    report['rasterFallbackRegions'] = renderer.raster_count
    report['latexFragments'] = renderer.formula_count + (paired_renderer.formula_count if paired_renderer else 0)
    report['reviewNotes'].extend(renderer.warnings)
    if paired_renderer:
        report['reviewNotes'].extend(paired_renderer.warnings)
    report['reviewNotes'].append({'issue':'source-content-and-answers-not-independently-verified',
        'policy':'preserve-source-pdf-formulas-and-original-numbering-no-invented-corrections'})
    renderer.doc.close()
    if paired_renderer:
        paired_renderer.doc.close()
    output = output_root/collection_id
    staging = Path(tempfile.mkdtemp(prefix='.pdf-stage-',dir=output_root))
    try:
        for name,builder in builders.items():
            folder = staging/name
            folder.mkdir()
            for asset in builder['pack']['assets']:
                file = folder/asset['path'];file.parent.mkdir(exist_ok=True)
                file.write_bytes(builder['bytes'][asset['id']])
            write_json(folder/'pack.json',builder['pack'])
            write_json(folder/'items.json',{'items':builder['items']})
            write_json(folder/'solutions.json',{'visibility':'authoring-only','solutions':builder['solutions']})
            report['packs'][name] = {'questionCount':len(builder['items']),'assetCount':len(builder['pack']['assets'])}
        report['answerStatus'] = dict(Counter(s['answer']['status'] for b in builders.values() for s in b['solutions']))
        report['explanationsMissing'] = sum(s['explanation']['status']=='missing' for b in builders.values() for s in b['solutions'])
        write_json(staging/'conversion-report.json',report)
        validator_path = ROOT/'docs/drafts/sat-question-packs/validate_examples.py'
        spec = importlib.util.spec_from_file_location('pdf_pack_validator',validator_path)
        validator = importlib.util.module_from_spec(spec);spec.loader.exec_module(validator)
        validator.validate_packs([staging/name for name in builders])
        if output.exists():
            shutil.rmtree(output)
        staging.rename(output)
    finally:
        if staging.exists():shutil.rmtree(staging)
    write_json(extraction_path,extracted)
    return {'collectionId':collection_id,'title':title,'category':'测试','sourceFile':entry['sourceFile'],
            'sourceSha256':entry['sourceSha256'],'directory':collection_id,'status':'converted','fullSAT':False,
            'questionCount':len(questions),'modules':report['modules']}


def worker(args):
    source_root, output_root, evidence_root, entry = args
    try:
        return create_collection(source_root,output_root,evidence_root,entry),None
    except Exception as exc:
        return None,{'collectionId':entry['collectionId'],'sourceFile':entry['sourceFile'],'error':str(exc)}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--work-dir',type=Path,required=True)
    parser.add_argument('--workers',type=int,default=4)
    parser.add_argument('--limit',type=int)
    parser.add_argument('--retry-errors',action='store_true')
    args=parser.parse_args()
    if (args.output/'assembly-summary.json').exists():
        parser.error('This is an assembled library. Rebuild and review in a separate staging folder.')
    args.output.mkdir(parents=True,exist_ok=True)
    args.work_dir.mkdir(parents=True,exist_ok=True)
    manifest_path = args.output/'pdf-source-manifest.json'
    old = read_json(manifest_path) if manifest_path.exists() else {'files':[]}
    registry = {x['sourceFile']:x for x in old['files']}
    files = sorted(args.source_root.rglob('*.pdf'))
    entries = []
    for source in files:
        relative=source.relative_to(args.source_root).as_posix()
        sha=digest(source.read_bytes())
        entry=registry.get(relative,{'collectionId':'pdf-'+uuid.uuid4().hex})
        if entry.get('sourceSha256') and entry['sourceSha256']!=sha:
            raise ValueError('Source changed; explicit revision migration required: '+relative)
        entries.append(dict(entry,sourceFile=relative,sourceSha256=sha))
    answer_sources = {re.sub(r'\s+','',e['sourceFile']):e for e in entries if '纯题目' not in e['sourceFile']}
    for entry in entries:
        if '纯题目' in entry['sourceFile']:
            counterpart = re.sub(r'[（(]纯题目[）)]','',entry['sourceFile'])
            other = answer_sources.get(re.sub(r'\s+','',counterpart))
            if other:
                entry['answerSource'] = {k:other[k] for k in ('collectionId','sourceFile','sourceSha256')}
    write_json(manifest_path,{'schemaVersion':'sat-pdf-source-manifest/1','files':entries})
    selected=entries[:args.limit] if args.limit else entries
    if args.retry_errors:
        errors=read_json(args.work_dir/'conversion-errors.json')
        identities={x['collectionId'] for x in errors}
        selected=[x for x in selected if x['collectionId'] in identities]
    catalog_path=args.output/'catalog.json'
    source_catalog_path=args.output/'source-catalog.json'
    existing_catalog=source_catalog_path if source_catalog_path.exists() else catalog_path
    catalog=read_json(existing_catalog) if existing_catalog.exists() else {'schemaVersion':'sat-offline-conversion-catalog/1','collections':[]}
    current_ids={entry['collectionId'] for entry in entries}
    # A copied public index can contain assembled collections; only current PDF
    # identities belong in the conversion inventory, including partial retries.
    rows={x['collectionId']:x for x in catalog['collections'] if x.get('collectionId') in current_ids}
    errors=[]
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        for i,(row,error) in enumerate(pool.map(worker,[(args.source_root,args.output,args.work_dir/'extracted',e) for e in selected]),1):
            if row:rows[row['collectionId']]=row
            if error:
                errors.append(error)
                rows.pop(error['collectionId'],None)
            if i%20==0:print(json.dumps({'processed':i,'selected':len(selected),'errors':len(errors)}),flush=True)
    catalog['collections']=sorted(rows.values(),key=lambda x:x['sourceFile'])
    write_json(catalog_path,catalog)
    write_json(source_catalog_path,catalog)
    write_json(args.work_dir/'conversion-errors.json',errors)
    print(json.dumps({'pdfCount':len(entries),'converted':len(rows),'questions':sum(x['questionCount'] for x in rows.values()),'errors':len(errors)}),flush=True)
    return 1 if errors else 0


if __name__=='__main__':
    sys.exit(main())
