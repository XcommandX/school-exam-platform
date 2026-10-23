#!/usr/bin/env python3
"""Import explicitly supplied AP Language PDFs into ignored local storage.

Standard library + Poppler's pdfinfo/pdftotext (no OCR, models, network, or pip).
PDFs remain the fidelity source. Automatic text/key checks are not human review.
The importer never reads browser records and never writes into the source tree.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from dataclasses import dataclass, field
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import unicodedata
import xml.etree.ElementTree as ET
import zipfile
import zlib

REPOSITORY = Path(__file__).resolve().parent.parent
VERSION = 1
MAX_PDF_BYTES = 512 * 1024 * 1024
MAX_ARCHIVE_BYTES = 3 * 1024 * 1024 * 1024
MAX_TEXT_BYTES = 40 * 1024 * 1024
SECTION = 'English Language and Composition'
FRQ_RE = re.compile(r'^\s*Question\s+([123])(?:\s*[:(].*)?\s*$', re.I)
Q_RE = re.compile(r'^\s*(?:_{2,}\s*)?(\d{1,3})\.\s+(\S.*)$')
OPT_RE = re.compile(r'^\s*(?:\(([A-E])\)|([a-e])\.)(?:\s+(\S.*))?$')
RANGE_RE = re.compile(r'Questions?\s+(\d{1,3})\s*[-–—]\s*(\d{1,3})\.', re.I)
PERSONAL_PATH = re.compile(r'(?:answer[-_ ]?records?|attempts?|student[-_ ]?records?|my[-_ ]?answers?|错题|答题记录|个人作答|已作答|我的答案)', re.I)
BOILERPLATE = re.compile(
    r'^(?:AP[®\s]*(?:ENGLISH|English).*?(?:FREE.RESPONSE|Free.Response|SCORING).*|'
    r'\d{4}\s+(?:AP[®\s]*)?ENGLISH LANGUAGE.*|©\s*\d{4}.*|'
    r'Copyright\s+©.*|Visit (?:the )?College Board.*|'
    r'Unauthorized copying or reuse of|any part of this page is illegal\.|'
    r'GO ON TO THE NEXT PAGE\.?|PLEASE TURN OVER\.?|'
    r'Commercial use may lead to legal actions.*|Unauthorized commercial use prohibited.*|'
    r'(?:Name:\s*_+.*)?\s*ID:\s*[A-Z]|Name:\s*_+.*|'
    r'-?\s*\d{1,3}\s*-?|\(CONTINUED\))$', re.I)


@dataclass
class PDF:
    path: Path
    key: str
    digest: str
    page_count: int
    pages: list[str]
    year: int | None
    form: str
    role: str
    warnings: list[str] = field(default_factory=list)
    lines: list[tuple[int, str]] | None = None


def canonical_bytes(value) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + '\n').encode('utf-8')


def sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _plain_path(path: Path, *, directory: bool = False, exists: bool = True) -> Path:
    """Reject links/junctions in every component, including nonexistent outputs."""
    path = Path(os.path.abspath(path))
    for component in (path, *path.parents):
        if component.is_symlink():
            raise ValueError('Symbolic links are not allowed.')
        if component.exists():
            attrs = getattr(component.lstat(), 'st_file_attributes', 0)
            if attrs & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0x400):
                raise ValueError('Junctions/reparse points are not allowed.')
    if exists and not (path.is_dir() if directory else path.is_file()):
        raise ValueError('Expected an existing real ' + ('directory.' if directory else 'file.'))
    return path


def private_destination(repository: Path) -> Path:
    repository = _plain_path(repository, directory=True)
    private = _plain_path(repository / 'private-data', exists=False)
    # Check each intended class, not merely a single ignored ancestor. Tracked
    # files are rejected even if a subsequently added ignore rule covers them.
    probes = ['question-banks/ap/probe.json', 'question-assets/ap/probe.pdf',
              'ap-import-manifest.json', 'ap-import-report.json', 'ap-import-temp/probe']
    for name in probes:
        result = subprocess.run(['git', 'check-ignore', '--quiet', '--',
                                 str(private / name)], cwd=repository, check=False)
        if result.returncode:
            raise ValueError('private-data must be ignored by Git before importing.')
    tracked = subprocess.run(['git', 'ls-files', '-z', '--', 'private-data'], cwd=repository,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if tracked.returncode or tracked.stdout:
        raise ValueError('Cannot import while private-data contains tracked files.')
    return private


def _safe_output(private: Path, path: Path) -> Path:
    path = _plain_path(path, exists=False)
    if not path.is_relative_to(private):
        raise ValueError('Output escapes private-data.')
    return path


def _atomic_write(private: Path, path: Path, payload: bytes, *, replace: bool) -> bool:
    path = _safe_output(private, path)
    if path.exists():
        if path.read_bytes() == payload:
            return False
        if not replace:
            raise ValueError('Existing import differs; review it and use --replace.')
    path.parent.mkdir(parents=True, exist_ok=True)
    _safe_output(private, path)
    fd, temporary = tempfile.mkstemp(prefix='.ap-import-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(payload)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return True


def discover_pdfs(source_root: Path) -> tuple[Path, list[Path]]:
    root = _plain_path(source_root, directory=True)
    result = []
    for folder, folders, files in os.walk(root, followlinks=False):
        for name in folders + files:
            entry = Path(folder) / name
            _plain_path(entry, directory=entry.is_dir())
        result.extend(Path(folder) / name for name in files if name.lower().endswith('.pdf'))
    result.sort(key=lambda p: (unicodedata.normalize('NFC', p.relative_to(root).as_posix()).casefold(),
                               p.relative_to(root).as_posix()))
    if not result:
        raise ValueError('The explicit source directory contains no PDFs.')
    return root, result


@contextmanager
def archive_source(archive: Path, private: Path):
    """Extract PDF members only; reject traversal, links and archive bombs."""
    archive = _plain_path(archive)
    temp_root = _safe_output(private, private / 'ap-import-temp')
    temp_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='archive-', dir=temp_root) as temporary:
        destination = Path(temporary)
        with zipfile.ZipFile(archive) as packed:
            seen, size = set(), 0
            if len(packed.infolist()) > 10000:
                raise ValueError('Too many ZIP entries.')
            for info in packed.infolist():
                key = info.filename.replace('\\', '/')
                parts = PurePosixPath(key).parts
                if (not parts or key.startswith('/') or re.match(r'^[A-Za-z]:', key)
                        or any(p in ('..', '.', '') or ':' in p or p.rstrip(' .') != p
                               or re.match(r'^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)', p, re.I)
                               for p in parts)):
                    raise ValueError('Unsafe ZIP member path.')
                mode = info.external_attr >> 16
                if stat.S_ISLNK(mode) or stat.S_IFMT(mode) not in (0, stat.S_IFDIR, stat.S_IFREG):
                    raise ValueError('ZIP links and special files are not allowed.')
                folded = unicodedata.normalize('NFC', key).casefold()
                if folded in seen:
                    raise ValueError('Ambiguous duplicate ZIP member.')
                seen.add(folded)
                if info.is_dir() or not key.lower().endswith('.pdf'):
                    continue
                size += info.file_size
                if info.file_size > MAX_PDF_BYTES or size > MAX_ARCHIVE_BYTES:
                    raise ValueError('ZIP exceeds the private import size limit.')
                target = _safe_output(private, destination.joinpath(*parts))
                target.parent.mkdir(parents=True, exist_ok=True)
                with packed.open(info) as incoming, target.open('xb') as output:
                    copied = 0
                    while chunk := incoming.read(1024 * 1024):
                        copied += len(chunk)
                        if copied > info.file_size or copied > MAX_PDF_BYTES:
                            raise ValueError('Invalid ZIP member size.')
                        output.write(chunk)
        yield destination


def classify(key: str, pages: list[str], page_count: int) -> tuple[int | None, str, str]:
    name = PurePosixPath(key).name.lower()
    lower = key.lower()
    cover = '\n'.join(pages[:2])
    # Prefer the document's name, then nearest unambiguous parent; range folders
    # such as 1999-2025 are not an exam year. Never select an incidental year in a passage.
    years = re.findall(r'(?<!\d)((?:19|20)\d{2})(?!\d)', name)
    match = re.search(r'^ap[-_]?((?:19|20)\d{2}|\d{2})(?=[-_])', name)
    year = int(match.group(1)) if match else (int(years[0]) if len(set(years)) == 1 else None)
    if year is not None and year < 100:
        year += 1900 if year >= 80 else 2000
    if year is None and len(set(years)) <= 1:
        for parent in reversed(PurePosixPath(key).parts[:-1]):
            candidates = re.findall(r'(?<!\d)((?:19|20)\d{2})(?!\d)', parent)
            if len(set(candidates)) == 1:
                year = int(candidates[0])
                break
    if year is None and not years:
        match = re.search(r'\b((?:19|20)\d{2})\s+(?:Free.Response|AP[®\s]*English)', cover, re.I)
        if match:
            year = int(match.group(1))
    form_match = re.search(r'set[-_ ]*([12])', name) or re.search(r'\bSet\s+([12])\b', cover, re.I)
    form = 'Set ' + form_match.group(1) if form_match else 'Standard'
    if re.search(r'form[-_ ]*b(?=[-_. /]|$)|formb(?=[-_. /]|$)', lower):
        form = 'Form B'
    if page_count > 200 or '完整版' in lower or len(set(years)) > 1:
        return None if len(set(years)) != 1 else year, 'Compilation / revised rubric', 'reference'
    if ('sample' in lower or 'commentary' in lower or re.search(r'[-_]apc[-_]', name)
            or re.search(r'[-_]q[123](?:\.|[-_])', name)):
        return year, form, 'sample'
    if (re.search(r'(?:^sg[-_]|[-_]sg(?:[-_.])|scoring[-_ ]*guidelines)', name)):
        return year, form, 'scoring'
    if (re.search(r'(?:report|statistics|distribution|scoring[-_]global|rubric|[-_]qa(?:[._-]|$)|student[-_]performance)', name)
            or re.search(r'Student Performance\s+Q\s*&\s*A|Chief Reader Report', cover, re.I)):
        return year, form, 'reference'
    if re.search(r'(?:frq|free.response|^qp[-_]|eng_lang_\d{2})', name):
        return year, form, 'frq'
    if '选择题' in lower or re.search(r'(?:Multiple.Choice|Multiple Choice)', cover, re.I):
        return year, 'Practice Exam' if re.search(r'Practice Exam', cover, re.I) else form, 'mcq'
    if re.search(r'Free.Response Questions', cover, re.I):
        return year, form, 'frq'
    return year, form, 'reference'


def privacy_reason(key: str, text: str, payload: bytes, role: str) -> str | None:
    if PERSONAL_PATH.search(key):
        return 'personal-record-path'
    if re.search(r'(?i)(?:selectedAnswer|userSelectedAnswer|my answers?\s*:|your answer\s*:|姓名\s*[:：]\s*[^_\s])', text):
        return 'personal-answer-content'
    for match in re.finditer(r'(?im)^\s*(?:student\s+)?name\s*:\s*([^\r\n]+)', text):
        value = match.group(1).split('Class:')[0].split('ID:')[0].strip()
        if value and not re.fullmatch(r'[_ .\-]+', value):
            return 'filled-name-field'
    # Official anonymized samples contain essays/scores, not this user's history.
    # They are permitted references, not question sets or grading keys.
    # Compressed/encrypted stream bytes are not PDF tokens. Searching them for
    # /JS or /Ink produces accidental matches, especially in image-heavy scans.
    chunks = [re.sub(rb'stream\r?\n.*?endstream', b'', payload, flags=re.S)]
    for obj in re.finditer(rb'\d+\s+\d+\s+obj\b(.*?)endobj', payload, re.S):
        body = obj.group(1)
        if b'/ObjStm' not in body or b'/FlateDecode' not in body:
            continue
        stream = re.search(rb'stream\r?\n(.*?)\r?\n?endstream', body, re.S)
        if stream:
            try:
                decoded = zlib.decompressobj().decompress(stream.group(1), 4 * 1024 * 1024)
                chunks.append(decoded)
            except zlib.error:
                # Encrypted PDFs may expose text through Poppler while raw object
                # streams remain encrypted. Do not call this a personal record;
                # the importer separately records that privacy was not fully audited.
                continue
    for body in chunks:
        if re.search(rb'/(?:JavaScript|JS|EmbeddedFile)\b', body):
            return 'active-or-embedded-pdf-content'
        if re.search(rb'/Subtype\s*/(?:Ink|FreeText|Text|Stamp|Highlight|StrikeOut|Squiggly)\b', body):
            return 'pdf-annotation-needs-privacy-review'
        if re.search(rb'/FT\s*/Sig\b', body):
            return 'signed-pdf'
        for match in re.finditer(rb'/FT\s*/(?:Tx|Ch|Btn)\b(.{0,3000}?)(?:endobj|$)', body, re.S):
            value = re.search(rb'/V\s*(\([^)]*\)|/[A-Za-z]+|<[^>]*>)', match.group(1))
            if value and value.group(1).strip() not in (b'()', b'( )', b'/Off', b'<>'):
                return 'filled-pdf-form'
    return None


def run_tool(command: list[str], *, max_output: int = MAX_TEXT_BYTES,
             warnings: list[str] | None = None) -> bytes:
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=120, check=False)
    if result.returncode:
        # Do not put source text, paths, PDF metadata or personal values into reports.
        raise ValueError(Path(command[0]).name + ' failed to read the PDF.')
    if len(result.stdout) > max_output:
        raise ValueError('PDF extraction exceeds text size limit.')
    if result.stderr.strip() and warnings is not None:
        warnings.append(Path(command[0]).name + ' reported PDF repair/syntax/font warnings; inspect the original PDF. Raw diagnostics are omitted to avoid leaking source paths or metadata.')
    return result.stdout


def inspect_pdf(path: Path, key: str, *, pdftotext: str, pdfinfo: str) -> PDF:
    _plain_path(path)
    if path.stat().st_size > MAX_PDF_BYTES:
        raise ValueError('PDF exceeds size limit.')
    payload = path.read_bytes()
    if not payload.startswith(b'%PDF-'):
        raise ValueError('Not a PDF file.')
    warnings = []
    info = run_tool([pdfinfo, str(path)], max_output=1024 * 1024, warnings=warnings).decode('utf-8', errors='replace')
    found = re.search(r'^Pages:\s*(\d+)\s*$', info, re.M)
    if not found or not 1 <= int(found.group(1)) <= 10000:
        raise ValueError('Missing or invalid PDF page count.')
    count = int(found.group(1))
    text = run_tool([pdftotext, '-layout', '-enc', 'UTF-8', str(path), '-'], warnings=warnings).decode('utf-8', errors='replace')
    pages = text.split('\f')
    if pages and not pages[-1].strip():
        pages.pop()
    if len(pages) != count:
        raise ValueError('pdfinfo/pdftotext page-count disagreement.')
    year, form, role = classify(key, pages, count)
    reason = privacy_reason(key, text, payload, role)
    if reason:
        raise ValueError('privacy:' + reason)
    warnings.append('Automated privacy checks cover paths, extracted text and inspectable PDF objects only. Handwriting, encrypted objects and all pages have not been fully visually audited; verify the original PDF before sharing.')
    if re.search(r'^Encrypted:\s*yes', info, re.M):
        warnings.append('The PDF is encrypted but readable without a supplied password; encrypted object streams were not decrypted by the privacy inspector.')
    if len(re.sub(r'\s', '', text)) < 80:
        warnings.append('No usable text layer: original-document only; no OCR was performed. Scanned handwriting/personal records have not been fully visually audited.')
    elif any(len(re.sub(r'\s', '', page)) < 40 for page in pages):
        warnings.append('Some PDF pages contain little or no extractable text; blank pages, diagrams and scans cannot be distinguished automatically. No OCR was performed; consult the original PDF.')
    if role == 'sample':
        warnings.append('Published sample responses and commentary are rubric references, not personal practice records or model-generated answers.')
    return PDF(path, key, sha256(payload), count, pages, year, form, role, warnings)


def bbox_lines(payload: bytes) -> list[tuple[int, str]]:
    """Read coordinates, not Poppler flow order (flows can interleave columns).

    Full-width lines divide horizontal bands. Within a two-column band all left
    lines precede all right lines. No source words are summarized or generated.
    """
    # Poppler can emit document control glyphs (notably backspace) literally,
    # although XML 1.0 forbids them. Removing only forbidden controls preserves
    # all visible words and makes those otherwise valid bbox files parseable.
    xml = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]', '', payload.decode('utf-8'))
    root = ET.fromstring(xml)
    output = []
    for page_number, page in enumerate(root.findall('.//{*}page'), 1):
        width = float(page.attrib['width'])
        rows = []
        for line in page.findall('.//{*}line'):
            words = line.findall('{*}word')
            if not words:
                continue
            text = ' '.join(''.join(word.itertext()) for word in sorted(words, key=lambda w: float(w.attrib['xMin'])))
            rows.append((float(line.attrib['xMin']), float(line.attrib['yMin']),
                         float(line.attrib['xMax']), text))
        middle = width / 2
        left = [r for r in rows if r[0] < middle - 30 and r[2] <= middle + 8]
        right = [r for r in rows if r[0] >= middle - 8]
        dual = len(left) >= 4 and len(right) >= 4
        if not dual:
            output.extend((page_number, r[3]) for r in sorted(rows, key=lambda r: (round(r[1], 1), r[0])))
            continue
        spans = sorted([r for r in rows if r[0] < middle - 8 and r[2] > middle + 8], key=lambda r: r[1])
        remaining = [r for r in rows if r not in spans]
        for span in spans + [(0, float('inf'), 0, '')]:
            band = [r for r in remaining if r[1] < span[1] - 1]
            remaining = [r for r in remaining if r not in band]
            band.sort(key=lambda r: (int(r[0] >= middle - 8), round(r[1], 1), r[0]))
            output.extend((page_number, r[3]) for r in band)
            if span[3]:
                output.append((page_number, span[3]))
    return output


def clean_lines(lines: list[tuple[int, str]]) -> list[tuple[int, str]]:
    result = []
    for page, raw in lines:
        text = raw.replace('\x08', '').replace('\x00', '').strip()
        if text and not BOILERPLATE.fullmatch(text) and not re.fullmatch(r'_+', text):
            result.append((page, text))
    return result


def get_lines(pdf: PDF, pdftotext: str) -> list[tuple[int, str]]:
    if pdf.lines is None:
        raw = run_tool([pdftotext, '-bbox-layout', '-enc', 'UTF-8', str(pdf.path), '-'], warnings=pdf.warnings)
        pdf.lines = clean_lines(bbox_lines(raw))
        if pdf.lines and max(page for page, _ in pdf.lines) > pdf.page_count:
            raise ValueError('Bounding boxes exceed PDF page count.')
    return pdf.lines


def _question(number: int, kind: str, prompt: str, passage: str, pages: list[int]) -> dict:
    return {'id': '', 'type': kind, 'number': number, 'prompt': prompt, 'passage': passage,
            'options': [], 'correctOption': None, 'explanation': '', 'sourceDocument': 'paper',
            'pages': sorted(set(pages)), 'reviewStatus': 'needs-review', 'answerProvenance': ''}


def parse_frq(lines: list[tuple[int, str]], *, year: int | None,
              combined: bool = False) -> tuple[list[dict], list[str]]:
    starts = []
    for index, (page, text) in enumerate(lines):
        match = FRQ_RE.fullmatch(text)
        if not match and year is not None and year >= 2025:
            match = re.match(r'^([123])\.\s+\S', text)
        if match:
            starts.append((index, int(match.group(1))))
    # A mixed exam includes a second set of headings in its scoring appendix.
    if combined:
        for index in range(len(starts) - 2):
            if [number for _, number in starts[index:index + 3]] == [1, 2, 3]:
                starts = starts[index:index + 3]
                break
    if [number for _, number in starts] != [1, 2, 3]:
        return [], ['FRQ headings could not be unambiguously split into questions 1–3; original-document only.']
    questions, warnings = [], []
    for position, (start, number) in enumerate(starts):
        stop = starts[position + 1][0] if position + 1 < len(starts) else len(lines)
        segment = lines[start:stop]
        for i, (_, text) in enumerate(segment[1:], 1):
            if re.search(r'^(?:STOP\b|END OF (?:EXAM|SECTION)|Multiple.Choice Answer Key|Answer Key for|Free.Response Scoring Guidelines|Acknowledgments)', text, re.I):
                segment = segment[:i]
                break
        content = '\n'.join(text for _, text in segment)
        if re.search(r'what\s+was\s+the\s+intent\s+of\s+this\s+question', content[:300], re.I):
            return [], ['Student performance commentary is a reference, not a question paper.']
        if len(content) < 120 or not re.search(r'\b(?:essay|write|writing)\b', content, re.I):
            warnings.append(f'Question {number}: incomplete extracted text; use original PDF, no structured question created.')
            continue
        if re.search(r'(?:denied permission|permission to reprint|passage.{0,45}(?:omitted|not reproduced|not available))', content, re.I):
            warnings.append(f'Question {number}: the source withholds passage text; no structured question created.')
            continue
        first_page, last_page = segment[0][0], segment[-1][0]
        if last_page - first_page >= 100:
            warnings.append(f'Question {number}: uncertain page boundaries; original-document only.')
            continue
        header = segment[0][1]
        question = _question(number, 'free-response', header, content, list(range(first_page, last_page + 1)))
        lower = content.lower()
        if 'synthesi' in lower and 'source' in lower:
            response = 'synthesis'
        elif re.search(r'(?:analy[sz]e|analysis).{0,100}(?:rhetoric|strateg|style)|rhetorical (?:choices|strategies)', lower, re.S):
            response = 'rhetorical-analysis'
        elif re.search(r'(?:develop.{0,50}(?:position|argument)|support.{0,20}(?:challenge|qualify)|argue|argument)', lower, re.S):
            response = 'argument'
        else:
            response = 'essay'
        question['responseType'] = response
        question['answerProvenance'] = 'Free response; no automatic score or invented model answer. Consult the original PDF and any attached rubric.'
        questions.append(question)
    if questions:
        warnings.append('FRQ text is an automatic transcription, not human-verified. All extracted source passages are retained; diagrams, cartoons, typography and missing scan text require the original PDF pages.')
    return questions, warnings


def extract_answer_key(pages: list[str]) -> tuple[dict[int, tuple[int, int]], set[int], list[str]]:
    """Only explicitly titled, separately extracted answer-key pages are trusted.

    ExamView ANS/answer strips are NOT official keys; observed editorial conflicts
    make those needs-review even when a regex can read their letters.
    """
    found: dict[int, tuple[int, int]] = {}
    withdrawn, conflicts = set(), set()
    for page, text in enumerate(pages, 1):
        if not re.search(r'Answer Key (?:for|to)|Multiple.Choice Answer Key', text, re.I):
            continue
        pairs = []
        for line in text.splitlines():
            explicit = list(re.finditer(r'Question\s+(\d{1,3})(\*)?\s*:\s*([A-E]|[—–-])', line))
            if explicit:
                for match in explicit:
                    number = int(match.group(1))
                    if match.group(2) or match.group(3) not in 'ABCDE':
                        withdrawn.add(number)
                    else:
                        pairs.append((number, ord(match.group(3)) - ord('A')))
            elif re.fullmatch(r'\s*(?:\d{1,3}\s+[A-E]\s*)+', line):
                pairs.extend((int(m.group(1)), ord(m.group(2)) - ord('A'))
                             for m in re.finditer(r'(\d{1,3})\s+([A-E])', line))
            elif re.match(r'\s*Multiple.Choice Questions\s+\d', line):
                pairs.extend((int(m.group(1)), ord(m.group(2)) - ord('A'))
                             for m in re.finditer(r'(\d{1,3})\s+([A-E])', line))
        if len(pairs) < 2:
            continue
        for number, answer in pairs:
            if number in found and found[number][0] != answer:
                conflicts.add(number)
            else:
                found[number] = answer, page
    for number in withdrawn | conflicts:
        found.pop(number, None)
    warnings = []
    if conflicts:
        warnings.append('Conflicting answer keys were found; conflicted answers remain null.')
    if withdrawn:
        warnings.append('Withdrawn/starred key entries remain ungraded: ' + ', '.join(map(str, sorted(withdrawn))) + '.')
    if not found:
        warnings.append('No trustworthy separate answer-key table was extracted. Answers are null and require review; ANS/answer strips are not treated as verified keys.')
    return found, withdrawn, warnings


def parse_mcq(lines: list[tuple[int, str]], pages: list[str]) -> tuple[list[dict], list[str]]:
    ranges = [(index, int(m.group(1)), int(m.group(2)))
              for index, (_, text) in enumerate(lines) if (m := RANGE_RE.search(text))]
    if not ranges or ranges[0][1] != 1:
        return [], ['No complete MCQ passage/question ranges found; original-document only.']
    end = len(lines)
    for index in range(ranges[0][0] + 1, len(lines)):
        text = lines[index][1]
        if re.search(r'^(?:END OF SECTION I\b|STOP\b|Answer Section|Answer Key for|Multiple.Choice Answer Key|SECTION II\b)', text, re.I):
            end = index
            break
    ranges = [r for r in ranges if r[0] < end]
    expected = list(range(1, ranges[-1][2] + 1))
    covered = [n for _, start, stop in ranges for n in range(start, stop + 1)]
    if covered != expected or len(expected) > 100:
        return [], ['Ambiguous or repeated MCQ passage ranges; original-document only.']
    questions = []
    for pos, (start, first, last) in enumerate(ranges):
        stop = ranges[pos + 1][0] if pos + 1 < len(ranges) else end
        segment = lines[start:stop]
        anchors = [(i, int(m.group(1))) for i, (_, text) in enumerate(segment)
                   if (m := Q_RE.match(text)) and first <= int(m.group(1)) <= last]
        if [n for _, n in anchors] != list(range(first, last + 1)):
            return [], [f'MCQ range {first}–{last}: numbering/column order is incomplete; original-document only.']
        passage_lines = segment[:anchors[0][0]]
        passage = '\n'.join(text for _, text in passage_lines)
        if len(passage) < 100:
            return [], [f'MCQ range {first}–{last}: source passage missing; original-document only.']
        for j, (begin, number) in enumerate(anchors):
            finish = anchors[j + 1][0] if j + 1 < len(anchors) else len(segment)
            body = segment[begin:finish]
            # Reprinted passages between question pages are not part of option E.
            for k, (_, text) in enumerate(body[1:], 1):
                if re.search(r'^The passage is reprinted|^END OF SECTION|^STOP\b', text, re.I):
                    body = body[:k]
                    break
            option_starts = [(i, (m.group(1) or m.group(2)).upper(), m.group(3))
                             for i, (_, text) in enumerate(body) if (m := OPT_RE.match(text))]
            if [label for _, label, _ in option_starts] != list('ABCDE'):
                return [], [f'MCQ {number}: incomplete or ambiguous five-option extraction; original-document only.']
            options = []
            for k, (i, label, text) in enumerate(option_starts):
                until = option_starts[k + 1][0] if k + 1 < len(option_starts) else len(body)
                option = '\n'.join(([text] if text else []) + [t for _, t in body[i + 1:until]]).strip()
                if not option or len(option) > 1800:
                    return [], [f'MCQ {number}: uncertain option boundaries; original-document only.']
                options.append(option)
            prompt_lines = [text for _, text in body[:option_starts[0][0]]]
            prompt_lines[0] = Q_RE.sub(lambda m: m.group(2), prompt_lines[0], count=1)
            prompt = '\n'.join(prompt_lines)
            if len(prompt) < 10 or len(set(options)) != 5:
                return [], [f'MCQ {number}: invalid prompt/options; original-document only.']
            question = _question(number, 'mcq', prompt, passage,
                                 [p for p, _ in passage_lines + body])
            question['options'] = options
            questions.append(question)
    key, withdrawn, warnings = extract_answer_key(pages)
    if set(key) - set(expected):
        key = {}
        warnings.append('Answer-key numbering does not belong to this complete question range; no answers verified.')
    for question in questions:
        number = question['number']
        if number in key:
            answer, page = key[number]
            question.update(correctOption=answer, reviewStatus='verified', answerDocument='paper', answerPage=page,
                            answerProvenance=f'Separate titled answer-key table in paper, PDF page {page}, question {number}; five options and numbering checked automatically (not human review).')
        else:
            question['answerProvenance'] = ('Source key marks this question as withdrawn/starred; no answer assigned.'
                                            if number in withdrawn else
                                            'No reliable separate answer-key entry; answer intentionally left unknown.')
    if questions:
        warnings.append('MCQ columns were ordered from PDF bounding boxes and every question has five complete options. Verification refers to key/structure checks, not a human transcription audit; consult original PDF for typography.')
    return questions, warnings


def make_set(pdf: PDF, kind: str, questions: list[dict], warnings: list[str], *, suffix: str = '') -> dict:
    key_hash = sha256(unicodedata.normalize('NFC', pdf.key).encode('utf-8'))[:20]
    form_slug = re.sub(r'[^a-z0-9]+', '-', pdf.form.lower()).strip('-')[:35]
    slug = f'english-language-{pdf.year or "undated"}-{form_slug}-{kind}-{key_hash}' + suffix
    title = f'AP English Language {pdf.year or "Undated"} · {pdf.form} · ' + {
        'mcq': 'Multiple Choice', 'frq': 'Free Response', 'reference': 'Reference'}[kind]
    role = 'questions' if kind != 'reference' else pdf.role if pdf.role in ('scoring', 'sample') else 'reference'
    document = {'schemaVersion': 2, 'exam': 'ap', 'subject': 'english-language', 'id': 'ap:' + slug,
                'title': title, 'section': SECTION, 'year': pdf.year, 'form': pdf.form, 'kind': kind,
                'contentMode': 'private', 'revision': '0' * 64,
                'defaultDurationSeconds': 3600 if kind == 'mcq' else (8100 if kind == 'frq' and (pdf.year or 2007) >= 2007 else 7200 if kind == 'frq' else 0),
                'documents': [{'id': 'paper', 'role': role, 'label': 'Original ' + {'questions': 'question paper', 'scoring': 'scoring guidelines', 'sample': 'sample responses/commentary', 'reference': 'reference document'}[role],
                               'asset': f'question-assets/ap/{pdf.digest}.pdf', 'pageCount': pdf.page_count}],
                'questions': questions, 'importWarnings': list(dict.fromkeys(pdf.warnings + warnings))}
    for question in questions:
        question['id'] = document['id'] + f':q{question["number"]:03d}'
    return document


def pair_references(sets: list[tuple[PDF, dict]], resources: list[PDF]) -> set[str]:
    paired = set()
    candidates = {}
    for pdf, data in sets:
        if data['kind'] == 'frq' and pdf.role == 'frq' and pdf.year is not None:
            candidates.setdefault((pdf.year, pdf.form), []).append((pdf, data))
    for resource in resources:
        targets = candidates.get((resource.year, resource.form), [])
        if resource.role not in ('scoring', 'sample') or len(targets) != 1:
            continue
        pdf, data = targets[0]
        ident = resource.role + '-' + resource.digest[:16]
        data['documents'].append({'id': ident, 'role': resource.role,
                                  'label': 'Scoring guidelines' if resource.role == 'scoring' else 'Published sample responses and commentary',
                                  'asset': f'question-assets/ap/{resource.digest}.pdf', 'pageCount': resource.page_count})
        paired.add(resource.digest)
        data['importWarnings'] = list(dict.fromkeys(data['importWarnings'] + resource.warnings))
        if resource.role == 'scoring':
            for question in data['questions']:
                if 'answerDocument' in question:
                    continue
                pattern = re.compile(r'\bQuestion\s+' + str(question['number']) + r'\b', re.I)
                matches = [i for i, text in enumerate(resource.pages, 1) if pattern.search(text)]
                question['answerDocument'] = ident
                if matches:
                    question['answerPage'] = matches[0]
                question['answerProvenance'] = 'Scoring guidelines paired by unambiguous exam year/form; essays require rubric-based self/teacher review, not automatic scoring.'
    return paired


def _validate(data: dict) -> None:
    if str(REPOSITORY) not in sys.path:
        sys.path.insert(0, str(REPOSITORY))
    from shared.ap_schema import validate_ap_set
    validate_ap_set(data)


def import_directory(source_root: Path, *, repository: Path = REPOSITORY, replace: bool = False,
                     pdftotext: str = 'pdftotext', pdfinfo: str = 'pdfinfo') -> dict:
    private = private_destination(repository)
    root, paths = discover_pdfs(source_root)
    output_roots = (private / 'question-banks' / 'ap', private / 'question-assets' / 'ap')
    if private.is_relative_to(root) or any(root.is_relative_to(output) or output.is_relative_to(root) for output in output_roots):
        raise ValueError('Source must not overlap the destination private-data tree.')
    for name in (pdftotext, pdfinfo):
        if not shutil.which(name):
            raise ValueError('Install Poppler pdfinfo/pdftotext on PATH; no OCR is used.')
    manifest_path = private / 'ap-import-manifest.json'
    _safe_output(private, manifest_path)
    previous = json.loads(manifest_path.read_text(encoding='utf-8')) if manifest_path.exists() else None
    entries, unique, duplicates, skipped, seen_digests = [], {}, [], [], set()
    for path in paths:
        key = unicodedata.normalize('NFC', path.relative_to(root).as_posix())
        source_id = sha256(key.encode('utf-8'))
        digest = sha256(path.read_bytes()) if path.stat().st_size <= MAX_PDF_BYTES else None
        entries.append({'sourceKeyHash': source_id, 'sha256': digest})
        if digest is not None and digest in seen_digests:
            duplicates.append({'sourceKeyHash': source_id, 'sha256': digest})
            continue
        if digest is not None:
            seen_digests.add(digest)
        try:
            pdf = inspect_pdf(path, key, pdftotext=pdftotext, pdfinfo=pdfinfo)
        except (ValueError, OSError, subprocess.TimeoutExpired, ET.ParseError) as exc:
            reason = str(exc) if isinstance(exc, ValueError) else type(exc).__name__
            year, form, role = classify(key, [], 0)
            skipped.append({'sourceKeyHash': source_id, 'year': year, 'form': form, 'kind': role, 'reason': reason})
            continue
        unique[pdf.digest] = pdf
    source_manifest = {'version': VERSION, 'sources': entries}
    if previous and previous.get('sourceManifest') != source_manifest and not replace:
        raise ValueError('Source manifest changed; review it and use --replace. No files were overwritten.')
    sets, resources = [], []
    # Public FRQs win deduplication over repeated questions inside practice exams.
    for pdf in sorted(unique.values(), key=lambda p: (p.role != 'frq', p.key)):
        if pdf.role not in ('frq', 'mcq'):
            resources.append(pdf)
            continue
        warnings, questions = [], []
        if sum(len(p.strip()) for p in pdf.pages) >= 80:
            try:
                lines = get_lines(pdf, pdftotext)
                if pdf.role == 'frq':
                    questions, warnings = parse_frq(lines, year=pdf.year)
                else:
                    questions, warnings = parse_mcq(lines, pdf.pages)
            except (ValueError, OSError, subprocess.TimeoutExpired, ET.ParseError):
                warnings = ['Text layout could not be safely parsed; original-document only.']
        if not questions:
            warnings.append('Document-only entry: 0 structured questions. Read the preserved original PDF; this is not an automatically graded question set.')
        sets.append((pdf, make_set(pdf, pdf.role, questions, warnings)))
        # Embedded FRQ papers remain accessible in the preserved mixed PDF, but
        # are not re-created as duplicate public questions or incorrectly paired
        # with a different public form's scoring guidelines.
        if pdf.role == 'mcq':
            sets[-1][1]['importWarnings'].append('Any embedded free-response/scoring appendix remains in the original PDF; only the MCQ section is structured here.')
    paired = pair_references(sets, resources)
    for resource in resources:
        if resource.digest not in paired:
            sets.append((resource, make_set(resource, 'reference', [],
                        ['Standalone reference; no structured questions.'])))
    asset_sources, bank_payloads = {}, {}
    for pdf, data in sets:
        data['revision'] = sha256(canonical_bytes({k: v for k, v in data.items() if k != 'revision'}))
        _validate(data)
        bank_payloads[data['id'].split(':', 1)[1] + '.json'] = canonical_bytes(data)
        for document in data['documents']:
            digest = Path(document['asset']).stem
            asset_sources[digest] = unique[digest]
    manifest = {'importerVersion': VERSION, 'sourceManifest': source_manifest,
                'sets': [{'id': data['id'], 'revision': data['revision']} for _, data in sets],
                'assets': sorted(asset_sources)}
    manifest_payload = canonical_bytes(manifest)
    if manifest_path.exists() and manifest_path.read_bytes() != manifest_payload and not replace:
        raise ValueError('Import output manifest differs; review parser/source changes and use --replace.')
    pending = [(private / 'question-banks' / 'ap' / name, payload) for name, payload in bank_payloads.items()]
    pending.append((manifest_path, manifest_payload))
    for path, payload in pending:
        _safe_output(private, path)
        if path.exists() and path.read_bytes() != payload and not replace:
            raise ValueError('An existing AP set differs; review it and use --replace.')
    for digest, pdf in asset_sources.items():
        path = _safe_output(private, private / 'question-assets' / 'ap' / (digest + '.pdf'))
        if path.exists() and sha256(path.read_bytes()) != digest:
            raise ValueError('Content-addressed asset is corrupt; refusing to overwrite it.')
        if sha256(pdf.path.read_bytes()) != digest:
            raise ValueError('Source PDF changed during import; rerun from a stable source directory.')
    # Validate stale cleanup BEFORE touching any destinations. Compare the full
    # revision fingerprint, not only the editable revision field.
    stale = []
    if replace and previous:
        current_ids = {data['id'] for _, data in sets}
        for old in previous.get('sets', []):
            ident = old.get('id', '')
            if ident in current_ids:
                continue
            if not re.fullmatch(r'ap:[a-z0-9][a-z0-9-]{0,119}', ident):
                raise ValueError('Unsafe id in old manifest; refusing cleanup.')
            target = _safe_output(private, private / 'question-banks' / 'ap' / (ident[3:] + '.json'))
            if target.exists():
                old_data = json.loads(target.read_text(encoding='utf-8'))
                fingerprint = sha256(canonical_bytes({k: v for k, v in old_data.items() if k != 'revision'}))
                if old_data.get('revision') != old.get('revision') or fingerprint != old.get('revision'):
                    raise ValueError('Stale set was manually changed; refusing to remove it.')
                stale.append(target)
    report_path = _safe_output(private, private / 'ap-import-report.json')
    intended = [path.relative_to(repository).as_posix() for path, _ in pending]
    intended += [(private / 'question-assets' / 'ap' / (digest + '.pdf')).relative_to(repository).as_posix()
                 for digest in asset_sources]
    intended.append(report_path.relative_to(repository).as_posix())
    ignored = subprocess.run(['git', 'check-ignore', '-z', '--stdin'], cwd=repository,
                             input=('\0'.join(intended) + '\0').encode('utf-8'),
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if ignored.returncode or set(ignored.stdout.decode('utf-8').rstrip('\0').split('\0')) != set(intended):
        raise ValueError('Every output file must be ignored by Git, including exception rules.')
    # No destination is changed until every source, manifest, set and asset has
    # passed validation/conflict checks.
    written, unchanged = 0, 0
    for digest, pdf in asset_sources.items():
        _atomic_write(private, private / 'question-assets' / 'ap' / (digest + '.pdf'), pdf.path.read_bytes(), replace=False)
    for path, payload in pending:
        changed = _atomic_write(private, path, payload, replace=replace)
        if path.suffix == '.json' and path.parent.name == 'ap':
            written += int(changed)
            unchanged += int(not changed)
    # Remove only stale JSON sets named in this importer's previous manifest,
    # never unrelated private files, and only with explicit --replace.
    removed = 0
    for target in stale:
        _safe_output(private, target).unlink()
        removed += 1
    questions = [q for _, data in sets for q in data['questions']]
    report = {'importerVersion': VERSION, 'sourcePdfCount': len(paths), 'uniquePdfCount': len(seen_digests),
              'importedSetCount': len(sets), 'importedAssetCount': len(asset_sources),
              'structuredQuestionCount': len(questions), 'mcqCount': sum(q['type'] == 'mcq' for q in questions),
              'frqCount': sum(q['type'] == 'free-response' for q in questions),
              'verifiedQuestionCount': sum(q['reviewStatus'] == 'verified' for q in questions),
              'reviewQuestionCount': sum(q['reviewStatus'] != 'verified' for q in questions),
              'documentOnlySetCount': sum(not data['questions'] and data['kind'] != 'reference' for _, data in sets),
              'referenceSetCount': sum(data['kind'] == 'reference' for _, data in sets),
              'pairedReferenceCount': len(paired), 'duplicatePdfCount': len(duplicates), 'skippedPdfCount': len(skipped),
              'writtenSetCount': written, 'unchangedSetCount': unchanged, 'removedStaleSetCount': removed,
              'duplicates': duplicates, 'skipped': skipped,
              'sets': [{'id': data['id'], 'year': data['year'], 'form': data['form'], 'kind': data['kind'],
                        'questionCount': len(data['questions']), 'reviewCount': sum(q['reviewStatus'] != 'verified' for q in data['questions']),
                        'warnings': data['importWarnings']} for _, data in sets]}
    _atomic_write(private, private / 'ap-import-report.json', canonical_bytes(report), replace=True)
    return report


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument('--source-root', type=Path, help='Explicit directory of authorized AP Language PDFs (never modified).')
    source.add_argument('--archive', type=Path, help='Optional ZIP; only safe PDF members are extracted into ignored temporary storage.')
    parser.add_argument('--replace', action='store_true', help='Explicitly replace changed import manifests/sets after review.')
    parser.add_argument('--pdftotext', default='pdftotext', help='Poppler executable (default: PATH).')
    parser.add_argument('--pdfinfo', default='pdfinfo', help='Poppler executable (default: PATH).')
    args = parser.parse_args(argv)
    try:
        if args.archive:
            private = private_destination(REPOSITORY)
            with archive_source(args.archive, private) as root:
                report = import_directory(root, replace=args.replace, pdftotext=args.pdftotext, pdfinfo=args.pdfinfo)
        else:
            report = import_directory(args.source_root, replace=args.replace, pdftotext=args.pdftotext, pdfinfo=args.pdfinfo)
    except (ValueError, OSError, zipfile.BadZipFile, subprocess.TimeoutExpired) as exc:
        print(f'AP import stopped: {exc}', file=sys.stderr)
        return 1
    print(json.dumps({k: v for k, v in report.items() if k not in ('sets', 'duplicates', 'skipped')}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
