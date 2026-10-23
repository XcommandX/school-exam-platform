"""Conservative R&W pane boundaries for already extracted PDF question bodies.

This helper only partitions a single question's body events. It never handles
options, rewrites spans, or changes image geometry; ambiguous material stays
visible in the question pane and is flagged for review.
"""
import re


_DIRECT_QUESTION = re.compile(r'^(?:Which\b|What\b|As used\b)')
_SUPPORT_QUESTION = re.compile(
    r'^Information in (?:the|this) (?:text|passage) '
    r'(?:best|most strongly|most directly) supports which\b')
_POINT_QUESTION = re.compile(r'^The (?:text|passage) makes which (?:point|claim)\b')
_CONTEXT_QUESTION = re.compile(
    r'^(?:According to|Based on) (?:the|this) (?:texts?|passages?)\b')
_INTERROGATIVE = re.compile(r'\b(?:what|which|how|why|when|where|who)\b', re.I)
_TASK_INTRODUCTION = re.compile(r'^The (?:student|researcher)s? wants?\b')
_TASK_QUESTION = re.compile(r'\b(?:Which|What)\b')


def _text(event):
    if event.get('kind') != 'text' or not isinstance(event.get('text'), str):
        return ''
    return ' '.join(event['text'].split())


def _question_tail(events, start):
    """Read a few wrapped lines for recognition without modifying any event."""
    lines = []
    for event in events[start:start + 4]:
        text = _text(event)
        if not text:
            break
        lines.append(text)
    return ' '.join(lines)


def split_body(events):
    """Return (content events, prompt events, review warning strings).

    The final explicit question is preferred over narrative phrases such as
    "According to [a person]". A directly preceding, wrapped task introduction
    remains with its question. Each original event occurs exactly once, in its
    original order, and retains its object identity.
    """
    direct, contextual = [], []
    for index, event in enumerate(events):
        text = _text(event)
        if (_DIRECT_QUESTION.match(text) or _SUPPORT_QUESTION.match(text)
                or _POINT_QUESTION.match(text)):
            direct.append(index)
            continue
        if _TASK_INTRODUCTION.match(text):
            tail = _question_tail(events, index)
            # A PDF line can contain both the task and "Which choice...".
            # A later standalone question line will be recognized separately.
            if ('?' in tail and _TASK_QUESTION.search(tail)
                    and not any(_DIRECT_QUESTION.match(_text(child))
                                for child in events[index + 1:index + 4])):
                direct.append(index)
            continue
        prefix = _CONTEXT_QUESTION.match(text)
        if prefix:
            tail = _question_tail(events, index)[prefix.end():]
            if '?' in tail and _INTERROGATIVE.search(tail):
                contextual.append(index)
    candidates = direct or contextual
    if not candidates:
        return [], list(events), ['rw-prompt-boundary-unresolved']

    start = candidates[-1]
    warnings = ['rw-multiple-question-boundaries'] if len(candidates) > 1 else []
    # A task introduction can wrap across lines. Do not reach across an image,
    # another question candidate, or an unbounded stretch of source prose.
    for index in range(start - 1, max(-1, start - 7), -1):
        text = _text(events[index])
        if not text:
            break
        if _TASK_INTRODUCTION.match(text):
            start = index
            break
        if index in direct or index in contextual:
            break
    return list(events[:start]), list(events[start:]), warnings
