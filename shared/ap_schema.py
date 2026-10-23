"""Strict AP Language v2 document sets; SAT's v1 contract is unchanged.

Only question content, source-document references and editorial provenance are
accepted. Personal answers belong exclusively to the new browser namespace.
"""
from __future__ import annotations

import re

AP_SET_FIELDS = {
    'schemaVersion', 'exam', 'subject', 'id', 'title', 'section', 'year', 'form',
    'kind', 'contentMode', 'revision', 'defaultDurationSeconds', 'documents',
    'questions', 'importWarnings',
}
AP_DOCUMENT_FIELDS = {'id', 'role', 'label', 'asset', 'pageCount'}
AP_QUESTION_REQUIRED = {
    'id', 'type', 'number', 'prompt', 'passage', 'options', 'correctOption',
    'explanation', 'pages', 'reviewStatus', 'answerProvenance',
}
AP_QUESTION_OPTIONAL = {'responseType', 'sourceDocument', 'answerDocument', 'answerPage'}
AP_ASSET_RE = re.compile(r'^question-assets/ap/[a-f0-9]{64}\.pdf$')
ID_RE = re.compile(r'^ap:[a-z0-9][a-z0-9-]{0,119}$')


def _text(value, name, *, nonempty=False, limit=500_000):
    if not isinstance(value, str) or len(value) > limit or (nonempty and not value.strip()):
        raise ValueError(f'{name} must be {"non-empty " if nonempty else ""}text of at most {limit} characters.')


def _integer(value, name, minimum=0, maximum=100_000):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(f'{name} must be an integer from {minimum} to {maximum}.')


def _fields(value, required, optional, name):
    if not isinstance(value, dict) or not required <= value.keys() or value.keys() - required - optional:
        raise ValueError(f'{name} has missing or unknown fields.')


def validate_ap_set(document):
    """Validate without mutation; reject unknown or personal-data fields."""
    _fields(document, AP_SET_FIELDS, set(), 'AP set')
    if type(document['schemaVersion']) is not int or document['schemaVersion'] != 2:
        raise ValueError('AP Language requires schemaVersion 2.')
    if document['exam'] != 'ap' or document['subject'] != 'english-language':
        raise ValueError('AP set belongs to a different exam or subject.')
    if not isinstance(document['id'], str) or not ID_RE.fullmatch(document['id']):
        raise ValueError('AP set id must use the ap: namespace.')
    for key in ('title', 'section'):
        _text(document[key], key, nonempty=True, limit=500)
    if document['section'] != 'English Language and Composition':
        raise ValueError('AP section must be English Language and Composition.')
    _text(document['form'], 'form', limit=100)
    if document['year'] is not None:
        _integer(document['year'], 'year', 1900, 2200)
    if document['kind'] not in ('mcq', 'frq', 'reference'):
        raise ValueError('Invalid AP set kind.')
    if document['contentMode'] not in ('private', 'synthetic'):
        raise ValueError('Invalid AP contentMode.')
    if not isinstance(document['revision'], str) or not re.fullmatch(r'[a-f0-9]{64}', document['revision']):
        raise ValueError('revision must be a SHA-256 digest.')
    _integer(document['defaultDurationSeconds'], 'defaultDurationSeconds', 0, 86400)
    if not isinstance(document['documents'], list) or len(document['documents']) > 100:
        raise ValueError('documents must be an array of at most 100 documents.')
    documents = {}
    for source in document['documents']:
        _fields(source, AP_DOCUMENT_FIELDS, set(), 'AP source document')
        if not isinstance(source['id'], str) or not re.fullmatch(r'[a-z][a-z0-9-]{0,79}', source['id']) or source['id'] in documents:
            raise ValueError('Document ids must be unique safe names.')
        if source['role'] not in ('questions', 'scoring', 'sample', 'reference'):
            raise ValueError('Invalid source document role.')
        _text(source['label'], 'document.label', nonempty=True, limit=500)
        if not isinstance(source['asset'], str) or not AP_ASSET_RE.fullmatch(source['asset']):
            raise ValueError('AP PDFs must use content-addressed private AP asset paths.')
        _integer(source['pageCount'], 'document.pageCount', 1, 10000)
        documents[source['id']] = source
    if document['contentMode'] == 'private' and not documents:
        raise ValueError('Private AP sets require an original source document.')
    if not isinstance(document['questions'], list) or len(document['questions']) > 1000:
        raise ValueError('questions must be an array of at most 1000 questions.')
    if document['kind'] == 'reference' and document['questions']:
        raise ValueError('Reference material cannot claim a question count.')
    ids, numbers = set(), set()
    for question in document['questions']:
        _fields(question, AP_QUESTION_REQUIRED, AP_QUESTION_OPTIONAL, 'AP question')
        ident = question['id']
        if (not isinstance(ident, str) or not re.fullmatch(re.escape(document['id']) + r':q[0-9]{3,4}', ident)
                or ident in ids):
            raise ValueError('Question ids must be unique and belong to their AP set.')
        ids.add(ident)
        _integer(question['number'], 'question.number', 1, 1000)
        if question['number'] in numbers:
            raise ValueError('Question numbers must be unique.')
        numbers.add(question['number'])
        if question['type'] not in ('mcq', 'free-response'):
            raise ValueError('Invalid AP question type.')
        for key in ('prompt', 'passage', 'explanation', 'answerProvenance'):
            _text(question[key], f'question.{key}', nonempty=(key == 'prompt'))
        if question['reviewStatus'] not in ('verified', 'needs-review', 'document-only'):
            raise ValueError('Invalid editorial review status.')
        options, answer = question['options'], question['correctOption']
        if not isinstance(options, list):
            raise ValueError('options must be an array.')
        if question['type'] == 'mcq':
            if not 2 <= len(options) <= 5 or 'responseType' in question:
                raise ValueError('MCQs require two to five options and no essay responseType.')
            for option in options:
                _text(option, 'option', nonempty=True, limit=10000)
            if answer is not None:
                _integer(answer, 'correctOption', 0, len(options) - 1)
                if question['reviewStatus'] != 'verified' or not question['answerProvenance'].strip():
                    raise ValueError('Only verified, attributed MCQ answers may be graded.')
            elif question['reviewStatus'] == 'verified':
                raise ValueError('An MCQ without an answer key cannot be verified.')
        else:
            if options or answer is not None:
                raise ValueError('Essays cannot have options or automatic correct answers.')
            if question.get('responseType') not in ('synthesis', 'rhetorical-analysis', 'argument', 'essay'):
                raise ValueError('FRQs require a responseType.')
        pages = question['pages']
        if not isinstance(pages, list) or len(pages) > 100:
            raise ValueError('pages must be an array of at most 100 page numbers.')
        for page in pages:
            _integer(page, 'page', 1, 10000)
        if sorted(set(pages)) != pages:
            raise ValueError('Source pages must be unique and ascending.')
        source_id = question.get('sourceDocument')
        if source_id is not None:
            if not isinstance(source_id, str) or source_id not in documents or not pages:
                raise ValueError('Source document reference or pages are missing.')
            source = documents[source_id]
            if source['role'] != 'questions' or pages[-1] > source['pageCount']:
                raise ValueError('Question pages must belong to an original question document.')
        elif document['contentMode'] == 'private' or pages:
            raise ValueError('Private questions require source document pages.')
        answer_id = question.get('answerDocument')
        if answer_id is not None:
            if not isinstance(answer_id, str) or answer_id not in documents:
                raise ValueError('Invalid answer document reference.')
            if documents[answer_id]['role'] not in ('questions', 'scoring'):
                raise ValueError('Answers must reference a question paper or scoring guide.')
        if 'answerPage' in question:
            if answer_id is None:
                raise ValueError('answerPage requires answerDocument.')
            _integer(question['answerPage'], 'answerPage', 1, documents[answer_id]['pageCount'])
    if not isinstance(document['importWarnings'], list) or len(document['importWarnings']) > 1000:
        raise ValueError('importWarnings must be an array.')
    for warning in document['importWarnings']:
        _text(warning, 'import warning', nonempty=True, limit=2000)
    return document


def summarize_ap_set(document):
    return {
        'id': document['id'], 'title': document['title'], 'section': document['section'],
        'questionCount': len(document['questions']),
        'defaultDurationSeconds': document['defaultDurationSeconds'],
        'year': document['year'], 'form': document['form'], 'kind': document['kind'],
        'contentMode': document['contentMode'], 'documentCount': len(document['documents']),
        'reviewCount': sum(q['reviewStatus'] != 'verified' for q in document['questions']),
    }
