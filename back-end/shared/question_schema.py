"""Shared, privacy-filtered question sets and the existing SAT JSON adapter.

This module never loads a bank or browser records. Callers explicitly provide
question content; only the declared schema fields survive normalization.
"""
from __future__ import annotations

from copy import deepcopy
import hashlib
import json
import math
import re
from typing import Any

EXAMS = ('sat', 'ap', 'toefl', 'vocab')
SCHEMA_VERSION = 1
FORMAT_KINDS = ('underline', 'italic', 'bold')
# Source bibliography and module positions are content, never attempts.
SAFE_METADATA = {
    'sourceExamId': str,
    'sourceQuestionId': (str, int),
    'sourceModule': int,
    'sourceQuestionNumberInModule': int,
    'sourceQuestionNumber': int,
    'sourceQuestionType': str,
    'sourceSection': str,
    'sourceTableImageAsset': str,
}
SET_FIELDS = {
    'schemaVersion', 'exam', 'id', 'title', 'section', 'defaultDurationSeconds',
    'moduleQuestionCounts', 'moduleDurationsSeconds', 'questions',
}
QUESTION_FIELDS = {
    'id', 'section', 'passage', 'passageFormatting', 'passageStyle', 'prompt',
    'promptFormatting', 'options', 'optionsFormatting', 'correctOption',
    'questionType', 'explanation', 'aiExplanation', 'visualStimulus',
    'answerProvenance', 'agentSuggestedAnswer', 'customMetadata',
    'moduleIndex', 'questionNumberInModule',
}
VISUAL_FIELDS = {'type', 'position', 'title', 'columns', 'rows', 'note', 'src', 'alt', 'caption'}
ASSET_RE = re.compile(r'^question-assets/(?:[^/\\\x00-\x1f?#%:]+/)*[^/\\\x00-\x1f?#%:]+\.(?:png|jpe?g|webp|gif|svg)$', re.I)


def _text(value: Any, name: str, *, nonempty: bool = False) -> str:
    if not isinstance(value, str) or (nonempty and not value.strip()):
        raise ValueError(f'{name} must be {"non-empty " if nonempty else ""}text.')
    return value


def _number(value: Any, name: str, *, minimum: float = 1) -> float:
    if type(value) not in (int, float) or not math.isfinite(value) or value < minimum:
        raise ValueError(f'{name} must be a finite number of at least {minimum}.')
    return value


def _integer(value: Any, name: str, minimum: int = 0) -> int:
    if type(value) is not int or value < minimum:
        raise ValueError(f'{name} must be an integer of at least {minimum}.')
    return value


def _utf16_length(value: str) -> int:
    return len(value.encode('utf-16-le')) // 2


def _formatting(value: Any, text: str, name: str) -> list[dict]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError(f'{name} must be an array.')
    result = []
    for span in value:
        if (not isinstance(span, dict) or span.get('kind') not in FORMAT_KINDS
                or type(span.get('start')) is not int or type(span.get('end')) is not int
                or not 0 <= span['start'] < span['end'] <= _utf16_length(text)):
            raise ValueError(f'{name} has an invalid text range.')
        result.append({k: span[k] for k in ('start', 'end', 'kind')})
    return result


def _markdown(source: str) -> tuple[str, list[dict]]:
    """Match the SAT plain-text emphasis parser, including JS UTF-16 offsets."""
    source = re.sub(r'^[-+] ', '• ', source, flags=re.M)
    text, spans, stack, last = '', [], [], 0
    for match in re.finditer(r'(<u>|</u>|\*\*|\*)', source):
        text += source[last:match.start()]
        last = match.end()
        token = match.group()
        kind = 'underline' if 'u>' in token else 'bold' if token == '**' else 'italic'
        if stack and stack[-1]['kind'] == kind:
            opened = stack.pop()
            spans.append({'start': opened['start'], 'end': _utf16_length(text), 'kind': kind})
        elif token != '</u>':
            stack.append({'kind': kind, 'start': _utf16_length(text)})
    text += source[last:]
    if stack:
        raise ValueError('Unclosed passage Markdown emphasis.')
    return text, _formatting(spans, text, 'passageFormatting')


def valid_asset_path(value: Any) -> bool:
    return (isinstance(value, str) and bool(ASSET_RE.fullmatch(value))
            and not any(part in ('.', '..') for part in value.split('/')))


def _visual(value: Any) -> dict | None:
    if value is None:
        return None
    if not isinstance(value, dict) or value.get('type') not in ('table', 'image', 'chart'):
        raise ValueError('visualStimulus.type must be table, chart, or image.')
    result = {k: deepcopy(v) for k, v in value.items() if k in VISUAL_FIELDS}
    result.setdefault('position', 'before-passage')
    if result['position'] not in ('before-passage', 'after-passage'):
        raise ValueError('Invalid visualStimulus.position.')
    for key in ('title', 'note', 'alt', 'caption'):
        if key in result:
            _text(result[key], 'visualStimulus.' + key)
    if result['type'] == 'table':
        columns, rows = result.get('columns'), result.get('rows')
        if (not isinstance(columns, list) or not columns or any(not isinstance(c, str) for c in columns)
                or not isinstance(rows, list) or not rows
                or any(not isinstance(row, list) or len(row) != len(columns)
                       or any(not isinstance(c, str) for c in row) for row in rows)):
            raise ValueError('A table needs text columns and matching text rows.')
        return {k: v for k, v in result.items() if k not in ('src', 'alt', 'caption')}
    if not valid_asset_path(result.get('src')):
        raise ValueError('Image src must be a local path inside question-assets/.')
    _text(result.get('alt'), 'visualStimulus.alt', nonempty=True)
    return {k: v for k, v in result.items() if k not in ('columns', 'rows', 'note', 'title')}


def _metadata(value: Any) -> dict:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValueError('customMetadata must be an object.')
    result = {}
    for key, allowed_type in SAFE_METADATA.items():
        if key not in value:
            continue
        item = value[key]
        if isinstance(item, bool) or not isinstance(item, allowed_type):
            raise ValueError(f'Invalid customMetadata.{key}.')
        if key == 'sourceTableImageAsset' and not valid_asset_path(item):
            raise ValueError('Invalid sourceTableImageAsset path.')
        result[key] = item
    return result


def normalize_question_set(data: dict, exam: str = 'sat', source_key: str | None = None) -> dict:
    """Return schema v1 from legacy SAT or canonical JSON using an allowlist.

    `source_key` should be a stable relative filename or external source ID.
    Supplying it preserves set/question IDs across content corrections. Existing
    canonical IDs are retained only when they belong to the selected exam.
    Personal response fields and arbitrary nested metadata are never copied.
    """
    if exam not in EXAMS:
        raise ValueError('Unsupported exam.')
    if not isinstance(data, dict) or not isinstance(data.get('questions'), list) or not data['questions']:
        raise ValueError('A non-empty questions array is required.')
    if data.get('schemaVersion') is not None and (type(data['schemaVersion']) is not int or data['schemaVersion'] != SCHEMA_VERSION):
        raise ValueError('Unsupported schema version.')
    if data.get('exam', exam) != exam:
        raise ValueError('Question set belongs to another exam.')
    title = _text(data.get('title', 'Untitled question set'), 'title', nonempty=True)
    section = _text(data.get('section', 'Reading and Writing' if exam == 'sat' else ''), 'section')
    if exam == 'sat' and section != 'Reading and Writing':
        raise ValueError('The SAT engine currently supports Reading and Writing.')
    canonical_id = data.get('id') if data.get('schemaVersion') == SCHEMA_VERSION else data.get('sourceId')
    if canonical_id is not None and (not isinstance(canonical_id, str)
            or not re.fullmatch(re.escape(exam) + r':[a-zA-Z0-9._-]+', canonical_id)):
        raise ValueError('Source ID must use the selected exam namespace.')
    if isinstance(canonical_id, str) and re.fullmatch(re.escape(exam) + r':[a-zA-Z0-9._-]+', canonical_id):
        source_id = canonical_id
    else:
        if source_key is None:
            source_key = json.dumps({'title': title, 'section': section,
                                     'questions': [{k: q.get(k) for k in ('passage', 'passageMarkdown', 'prompt', 'options', 'answer', 'correctOption')}
                                                   if isinstance(q, dict) else None for q in data['questions']]},
                                    ensure_ascii=False, sort_keys=True)
        source_id = exam + ':' + hashlib.sha256(str(source_key).encode('utf-8')).hexdigest()[:12]
    duration = data.get('defaultDurationSeconds', data.get('durationSeconds'))
    if duration is None:
        duration = _number(data['durationMinutes'], 'durationMinutes') * 60 if 'durationMinutes' in data else 1920
    duration = round(_number(duration, 'defaultDurationSeconds'))
    result = {'schemaVersion': SCHEMA_VERSION, 'exam': exam, 'id': source_id,
              'title': title, 'section': section, 'defaultDurationSeconds': duration, 'questions': []}
    counts = data.get('moduleQuestionCounts')
    if counts is not None:
        if (not isinstance(counts, list) or not counts or any(type(n) is not int or n < 1 for n in counts)
                or sum(counts) != len(data['questions'])):
            raise ValueError('moduleQuestionCounts must add up to the question count.')
        result['moduleQuestionCounts'] = list(counts)
    durations = data.get('moduleDurationsSeconds')
    if durations is not None:
        if not isinstance(durations, list) or not durations:
            raise ValueError('moduleDurationsSeconds must be a non-empty array.')
        for value in durations:
            _number(value, 'moduleDurationsSeconds', minimum=60)
            if exam == 'sat' and value > 3840:
                raise ValueError('SAT module duration must not exceed 3840 seconds.')
        if counts and len(durations) != len(counts):
            raise ValueError('Module duration/count arrays must have the same length.')
        result['moduleDurationsSeconds'] = list(durations)
    question_ids = set()
    module, module_offset = 0, 0
    for index, raw in enumerate(data['questions']):
        if not isinstance(raw, dict):
            raise ValueError(f'Question {index + 1} must be an object.')
        prompt = _text(raw.get('prompt'), 'prompt', nonempty=True)
        options = raw.get('options')
        if not isinstance(options, list) or len(options) < 2 or (exam == 'sat' and len(options) != 4):
            raise ValueError('Options need four choices for SAT, at least two for other exams.')
        for option in options:
            _text(option, 'option', nonempty=True)
        answer = raw.get('correctOption', raw.get('answer'))
        if isinstance(answer, str) and re.fullmatch('[A-Z]', answer):
            answer = ord(answer) - ord('A')
        if type(answer) is not int or not 0 <= answer < len(options):
            raise ValueError('correctOption must identify one of the choices.')
        passage = _text(raw.get('passage', ''), 'passage')
        if 'passageMarkdown' in raw:
            passage, passage_formatting = _markdown(_text(raw['passageMarkdown'], 'passageMarkdown'))
        else:
            passage_formatting = _formatting(raw.get('passageFormatting'), passage, 'passageFormatting')
        style = raw.get('passageStyle', 'prose')
        if style not in ('prose', 'poetry', 'literary'):
            raise ValueError('Invalid passageStyle.')
        option_formatting = raw.get('optionsFormatting', [[] for _ in options])
        if not isinstance(option_formatting, list) or len(option_formatting) != len(options):
            raise ValueError('optionsFormatting must match the options count.')
        question_id = raw.get('id') if canonical_id is not None else None
        if (not isinstance(question_id, str)
                or not re.fullmatch(re.escape(source_id) + r':[a-zA-Z0-9._-]+', question_id)):
            question_id = f'{source_id}:q{index + 1:04d}'
        if question_id in question_ids:
            raise ValueError('Question IDs must be unique.')
        question_ids.add(question_id)
        question = {
            'id': question_id, 'section': _text(raw.get('section', section), 'question.section'),
            'passage': passage, 'passageFormatting': passage_formatting, 'passageStyle': style,
            'prompt': prompt, 'promptFormatting': _formatting(raw.get('promptFormatting'), prompt, 'promptFormatting'),
            'options': list(options), 'optionsFormatting': [_formatting(v, t, 'optionsFormatting') for v, t in zip(option_formatting, options)],
            'correctOption': answer, 'questionType': _text(raw.get('questionType', ''), 'questionType'),
            'explanation': _text(raw.get('explanation', ''), 'explanation'),
            'aiExplanation': _text(raw.get('aiExplanation', ''), 'aiExplanation'),
            'visualStimulus': _visual(raw.get('visualStimulus')),
            'customMetadata': _metadata(raw.get('customMetadata', raw.get('metadata'))),
        }
        for key in ('answerProvenance', 'agentSuggestedAnswer'):
            if key in raw:
                allowed = ('source', 'agent') if key == 'answerProvenance' else tuple('ABCD')
                if raw[key] not in allowed:
                    raise ValueError(f'Invalid {key}.')
                question[key] = raw[key]
        if counts:
            while index >= module_offset + counts[module]:
                module_offset += counts[module]
                module += 1
            question.update(moduleIndex=module, questionNumberInModule=index - module_offset + 1)
        elif 'moduleIndex' in raw:
            question['moduleIndex'] = _integer(raw['moduleIndex'], 'moduleIndex')
            if 'questionNumberInModule' in raw:
                question['questionNumberInModule'] = _integer(raw['questionNumberInModule'], 'questionNumberInModule', 1)
        result['questions'].append(question)
    return result


def validate_question_set(data: dict) -> None:
    """Reject malformed canonical sets, unknown fields, and unapproved metadata."""
    if not isinstance(data, dict) or set(data) - SET_FIELDS:
        raise ValueError('Unknown question-set fields.')
    if type(data.get('schemaVersion')) is not int or data['schemaVersion'] != SCHEMA_VERSION or data.get('exam') not in EXAMS:
        raise ValueError('Expected canonical question-set schema v1.')
    if not isinstance(data.get('id'), str) or not re.fullmatch(re.escape(data['exam']) + r':[a-zA-Z0-9._-]+', data['id']):
        raise ValueError('Question set ID must use its exam namespace.')
    if not isinstance(data.get('questions'), list) or not data['questions']:
        raise ValueError('A non-empty questions array is required.')
    for question in data['questions']:
        if not isinstance(question, dict) or set(question) - QUESTION_FIELDS:
            raise ValueError('Unknown question fields.')
        metadata = question.get('customMetadata', {})
        if not isinstance(metadata, dict) or set(metadata) - set(SAFE_METADATA):
            raise ValueError('Unapproved question metadata.')
        visual = question.get('visualStimulus')
        if isinstance(visual, dict) and set(visual) - VISUAL_FIELDS:
            raise ValueError('Unapproved visual fields.')
    normalized = normalize_question_set(data, data['exam'])
    if normalized != data:
        raise ValueError('Question set is incomplete or not in canonical form.')


def to_sat_legacy(data: dict) -> dict:
    """Adapt canonical SAT content for SATImporter, retaining stable source IDs."""
    validate_question_set(data)
    if data['exam'] != 'sat':
        raise ValueError('The SAT adapter accepts SAT question sets only.')
    result = {'id': data['id'], 'sourceId': data['id'], 'title': data['title'],
              'section': data['section'], 'durationSeconds': data['defaultDurationSeconds'], 'questions': []}
    for key in ('moduleQuestionCounts', 'moduleDurationsSeconds'):
        if key in data:
            result[key] = deepcopy(data[key])
    for question in data['questions']:
        legacy = deepcopy(question)
        legacy['answer'] = legacy.pop('correctOption')
        result['questions'].append(legacy)
    return result


def referenced_assets(data: dict) -> set[str]:
    """Get only image files explicitly referenced by normalized question content."""
    result = set()
    for question in data['questions']:
        visual = question.get('visualStimulus')
        if visual and visual.get('src'):
            result.add(visual['src'])
        value = question.get('customMetadata', {}).get('sourceTableImageAsset')
        if value:
            result.add(value)
    return result
