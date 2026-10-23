"""Private per-account SAT records; content stays in one selected attempt.

The stored grading/counts are client practice results, not official SAT scores.
Snapshots are inert JSON and are never published through static file routes.
"""
import base64
import hashlib
import json
import math
from pathlib import Path
import re

MAX_ENTITY_BYTES = 64 * 1024 * 1024
MAX_SETTINGS_BYTES = 256 * 1024
MAX_ACCOUNT_BYTES = 512 * 1024 * 1024
MAX_ACCOUNT_ENTITIES = 20_000
PAGE_SIZE = 500
MUTATIONS_PER_ENTITY = 16
SETTINGS_KEYS = frozenset({'appConfig', 'practiceDurationPreferences', 'customPracticeDurationSeconds', 'timingTargets', 'questionTimer'})
KINDS = frozenset({'attempts', 'wrong-book', 'settings'})
SUMMARY_FIELDS = ('id', 'practiceName', 'status', 'completedAt', 'savedAt', 'startedAt', 'totalQuestions',
                  'correctCount', 'incorrectCount', 'unansweredCount', 'ungradedCount', 'elapsedMs',
                  'durationSeconds', 'fullSAT', 'resumable', 'libraryCollectionId', 'section')
ATTEMPT_FIELDS = frozenset(SUMMARY_FIELDS) | {'standardTiming', 'questionSnapshots', 'untimed', 'allowOvertime',
    'modules', 'moduleResults', 'finishReason', 'questionIds', 'sourceIds', 'remainingTimeMs',
    'runtimeSnapshot', 'answers', 'archivedForCollectionId'}


class SATStateError(Exception):
    def __init__(self, status, message, code='invalid_sat_data', **extra):
        super().__init__(message)
        self.status, self.code, self.extra = status, code, extra


def fail(message, status=400, code='invalid_sat_data', **extra):
    raise SATStateError(status, message, code, **extra)


def encoded(value):
    try:
        text = json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
        text.encode('utf-8')
        return text
    except (ValueError, TypeError, RecursionError, UnicodeEncodeError):
        fail('SAT 记录不是有效的 JSON。')


def entity_id(value):
    if (not isinstance(value, str) or not 1 <= len(value) <= 512
            or any(ord(c) < 32 or ord(c) == 127 or 0xD800 <= ord(c) <= 0xDFFF or c in '/\\?#' for c in value)
            or value in {'.', '..', '__proto__', 'constructor', 'prototype'}):
        fail('SAT 记录编号无效。')
    return value


def integer(value, low=0, high=2**53 - 1):
    return type(value) is int and low <= value <= high


def one_of(value, choices):
    return isinstance(value, str) and value in choices


def validate_attempt(identity, value):
    if not isinstance(value, dict) or set(value) - ATTEMPT_FIELDS or value.get('id') != identity:
        fail('练习记录字段或编号无效。')
    if not one_of(value.get('status'), {'completed', 'incomplete'}):
        fail('练习状态无效。')
    ids, snapshots, answers = value.get('questionIds'), value.get('questionSnapshots'), value.get('answers')
    if not isinstance(ids, list) or not 1 <= len(ids) <= 10_000:
        fail('练习需要 1–10000 个题目编号。')
    for question in ids:
        entity_id(question)
    if len(set(ids)) != len(ids) or not integer(value.get('totalQuestions'), 1) or value['totalQuestions'] != len(ids):
        fail('练习题目编号重复或题数不一致。')
    if (not isinstance(snapshots, list) or len(snapshots) != len(ids)
            or any(not isinstance(q, dict) or q.get('id') != identity for q, identity in zip(snapshots, ids))):
        fail('练习需保存与题目顺序一致的当场快照。')
    if (not isinstance(answers, dict) or set(answers) != set(ids)
            or any(not isinstance(answer, dict) for answer in answers.values())):
        fail('作答记录需与本次题目对应。')
    counts = [value.get(key) for key in ('correctCount', 'incorrectCount', 'unansweredCount', 'ungradedCount')]
    if not all(integer(count, high=len(ids)) for count in counts) or sum(counts) != len(ids):
        fail('练习统计与题数不一致。')
    # Validate submitted practice counts without claiming authoritative grading.
    counted = [0, 0, 0, 0]
    for answer in answers.values():
        correctness = answer.get('correctness')
        if type(answer.get('answered')) is not bool or correctness is not None and type(correctness) is not bool:
            fail('作答状态无效。')
        bucket = 2 if not answer['answered'] else 3 if correctness is None else 0 if correctness else 1
        counted[bucket] += 1
    if counted != counts:
        fail('练习统计与提交作答不一致。')
    if not isinstance(value.get('practiceName'), str) or not 1 <= len(value['practiceName']) <= 500:
        fail('练习名称需为 1–500 个字符。')
    for name in ('libraryCollectionId', 'archivedForCollectionId'):
        if value.get(name) is not None:
            entity_id(value[name])
    for name in ('section', 'finishReason'):
        if name in value and (not isinstance(value[name], str) or len(value[name]) > 80):
            fail('练习科目或结束原因无效。')
    for name in ('startedAt', 'completedAt', 'savedAt'):
        if name in value and not integer(value[name], 1):
            fail('练习时间无效。')
    for name in ('elapsedMs', 'remainingTimeMs', 'durationSeconds'):
        if name in value and (type(value[name]) not in (int, float) or not math.isfinite(value[name]) or value[name] < 0 or value[name] > 2**53 - 1):
            fail('练习计时无效。')
    for name in ('fullSAT', 'standardTiming', 'untimed', 'allowOvertime', 'resumable'):
        if name in value and type(value[name]) is not bool:
            fail('练习选项无效。')
    if value['status'] == 'completed' and (value.get('resumable') or value.get('runtimeSnapshot') is not None):
        fail('已完成的练习不能保留继续考试状态。')
    if value['status'] == 'completed' and not integer(value.get('completedAt'), 1):
        fail('已完成练习缺少完成时间。')
    if value['status'] == 'incomplete' and value.get('resumable'):
        runtime = value.get('runtimeSnapshot')
        if (not isinstance(runtime, dict) or not isinstance(runtime.get('activePractice'), dict)
                or runtime['activePractice'].get('id') != identity
                or runtime['activePractice'].get('questionIds') != ids
                or not isinstance(runtime.get('questionStates'), list) or len(runtime['questionStates']) != len(ids)
                or any(not isinstance(state, dict) for state in runtime['questionStates'])
                or 'currentQuestion' in runtime and not integer(runtime['currentQuestion'], 0, len(ids) - 1)):
            fail('可继续的练习缺少完整的运行快照。')
    if 'sourceIds' in value and (not isinstance(value['sourceIds'], list) or len(value['sourceIds']) > 10_000):
        fail('练习来源无效。')
    for source in value.get('sourceIds', []):
        entity_id(source)
    summary = {key: value[key] for key in SUMMARY_FIELDS if key in value}
    # Section summaries are derived from snapshots, never from large answers.
    sections = {q.get('section') for q in snapshots if isinstance(q.get('section'), str) and len(q['section']) <= 80}
    if len(sections) == 1:
        summary['section'] = next(iter(sections))
    return summary


def validate_wrong(identity, value):
    if (not isinstance(value, dict) or set(value) - {'questionId', 'addedAt', 'reason', 'sourceAttemptId', 'questionSnapshot', 'sourceSnapshot'}
            or value.get('questionId') != identity or not integer(value.get('addedAt'), 1)
            or not one_of(value.get('reason'), {'manual', 'incorrect'})):
        fail('错题本记录字段无效。')
    question = value.get('questionSnapshot')
    if not isinstance(question, dict) or question.get('id') != identity:
        fail('错题本记录需包含对应题目快照。')
    if value.get('sourceSnapshot') is not None and not isinstance(value['sourceSnapshot'], dict):
        fail('错题来源快照无效。')
    if value.get('sourceAttemptId') is not None:
        entity_id(value['sourceAttemptId'])
    return {}


def validate_setting(key, value):
    if key not in SETTINGS_KEYS:
        fail('此 SAT 设置不能按账号同步。')
    if len(encoded(value).encode('utf-8')) > MAX_SETTINGS_BYTES:
        fail('SAT 设置内容过大。', 413, 'sat_storage_limit')
    if key == 'customPracticeDurationSeconds':
        valid = integer(value, 60, 3840)
    elif key == 'appConfig':
        valid = (isinstance(value, dict) and not set(value) - {'moduleQuestionLimit', 'examTimerWarning'}
                 and integer(value.get('moduleQuestionLimit'), 1, 100)
                 and one_of(value.get('examTimerWarning'), {'fixed', 'proportional'}))
    elif key == 'questionTimer':
        valid = (isinstance(value, dict) and set(value) == {'enabled', 'mode'}
                 and type(value['enabled']) is bool and one_of(value['mode'], {'up', 'down'}))
    elif key == 'practiceDurationPreferences':
        valid = isinstance(value, dict) and len(value) <= 5000
        if valid:
            for identity, duration in value.items():
                entity_id(identity)
                valid = valid and integer(duration, 60, 3840)
    else:
        path = Path(__file__).resolve().parents[2] / 'front-end/sat/data/question-categories.json'
        categories = {row['id'] for row in json.loads(path.read_text(encoding='utf-8'))['categories']} | {'__uncategorized__'}
        valid = isinstance(value, dict) and not set(value) - categories and all(integer(v, 0, 300) for v in value.values())
    if not valid:
        fail('SAT 设置值超出允许范围。')
    return {}


class SATAccountStore:
    def __init__(self, accounts):
        self.accounts = accounts

    @staticmethod
    def metadata(row):
        return {'id': row['entity_id'], 'revision': row['revision'], 'deleted': bool(row['deleted']), 'updatedAt': row['updated_at']}

    def get(self, user_id, kind, identity):
        entity_id(identity)
        if kind not in KINDS or kind == 'settings' and identity not in SETTINGS_KEYS:
            fail('SAT 数据类型不存在。', 404)
        with self.accounts._connection() as db:
            self.accounts._actor(db, user_id)
            row = db.execute('SELECT * FROM sat_account_entities WHERE user_id=? AND kind=? AND entity_id=?', (user_id, kind, identity)).fetchone()
        if not row:
            return {'id': identity, 'value': None, 'revision': 0, 'deleted': False, 'updatedAt': None}
        return dict(self.metadata(row), value=json.loads(row['value_json']) if row['value_json'] else None)

    def bootstrap(self, user_id, cursor=None):
        after = ('', '')
        if cursor:
            try:
                if not isinstance(cursor, str) or len(cursor) > 4096:
                    raise ValueError()
                after = json.loads(base64.urlsafe_b64decode(cursor.encode('ascii')).decode('utf-8'))
                if not isinstance(after, list) or len(after) != 2 or after[0] not in {'attempts', 'wrong-book'}:
                    raise ValueError()
                entity_id(after[1])
            except (ValueError, TypeError, UnicodeError):
                fail('SAT 同步分页位置无效。')
        with self.accounts._connection() as db:
            self.accounts._actor(db, user_id)
            rows = db.execute("SELECT entity_id,kind,revision,deleted,updated_at FROM sat_account_entities WHERE user_id=? AND kind!='settings' AND (kind>? OR (kind=? AND entity_id>?)) ORDER BY kind,entity_id LIMIT ?",
                              (user_id, after[0], after[0], after[1], PAGE_SIZE + 1)).fetchall()
            settings = db.execute("SELECT * FROM sat_account_entities WHERE user_id=? AND kind='settings' ORDER BY entity_id", (user_id,)).fetchall()
        page = rows[:PAGE_SIZE]
        next_cursor = base64.urlsafe_b64encode(encoded([page[-1]['kind'], page[-1]['entity_id']]).encode('utf-8')).decode('ascii') if len(rows) > PAGE_SIZE else None
        return {'attempts': [self.metadata(row) for row in page if row['kind'] == 'attempts'],
                'wrongBook': [self.metadata(row) for row in page if row['kind'] == 'wrong-book'],
                'settings': [{'key': row['entity_id'], 'value': json.loads(row['value_json']), 'revision': row['revision']} for row in settings],
                'nextCursor': next_cursor}

    def summary(self, user_id):
        with self.accounts._connection() as db:
            self.accounts._actor(db, user_id)
            rows = db.execute("SELECT summary_json FROM sat_account_entities WHERE user_id=? AND kind='attempts' AND deleted=0 ORDER BY updated_at DESC", (user_id,)).fetchall()
        return {'attempts': [json.loads(row['summary_json']) for row in rows]}

    def put(self, user_id, kind, identity, body):
        entity_id(identity)
        if kind not in KINDS or kind == 'settings' and identity not in SETTINGS_KEYS:
            fail('SAT 数据类型不存在。', 404)
        if (not isinstance(body, dict) or set(body) - {'value', 'revision', 'deleted', 'restore', 'mutationId'}
                or not integer(body.get('revision')) or not isinstance(body.get('mutationId'), str)
                or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,100}', body['mutationId'])):
            fail('SAT 同步需要有效的版本和操作编号。')
        deleted, restore = body.get('deleted', False), body.get('restore', False)
        if type(deleted) is not bool or type(restore) is not bool or deleted and restore:
            fail('SAT 同步操作无效。')
        if kind == 'settings' and (deleted or restore):
            fail('设置不支持删除或恢复操作。')
        if deleted and body.get('value') is not None:
            fail('删除操作不能包含题目或作答内容。')
        value = body.get('value')
        value_json = encoded(value) if not deleted else None
        size = len(value_json.encode('utf-8')) if value_json else 0
        if size > MAX_ENTITY_BYTES:
            fail('单条 SAT 记录超过 64 MiB，请保留本机副本。', 413, 'sat_storage_limit')
        summary = {} if deleted else validate_attempt(identity, value) if kind == 'attempts' else validate_wrong(identity, value) if kind == 'wrong-book' else validate_setting(identity, value)
        summary_json = encoded(summary)
        # The request digest binds retries to the exact operation without storing a second snapshot.
        request_hash = hashlib.sha256(json.dumps(body, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')).hexdigest()
        with self.accounts._connection(True) as db:
            self.accounts._actor(db, user_id)
            replay = db.execute('SELECT request_hash,result_json FROM sat_account_mutations WHERE user_id=? AND kind=? AND entity_id=? AND mutation_id=?',
                                (user_id, kind, identity, body['mutationId'])).fetchone()
            if replay:
                if replay['request_hash'] != request_hash:
                    fail('同一操作编号不能用于不同内容。', 409, 'mutation_reused')
                return json.loads(replay['result_json'])
            row = db.execute('SELECT * FROM sat_account_entities WHERE user_id=? AND kind=? AND entity_id=?', (user_id, kind, identity)).fetchone()
            current = row['revision'] if row else 0
            is_deleted = bool(row['deleted']) if row else False
            if current != body['revision']:
                fail('记录已在其他页面更新，请刷新后处理冲突。', 409, 'revision_conflict', revision=current, deleted=is_deleted)
            if row and is_deleted and not deleted:
                if kind == 'attempts' or not restore:
                    fail('记录已删除，不能由旧页面恢复。', 409, 'entity_deleted', revision=current, deleted=True)
            if restore and (kind != 'wrong-book' or not is_deleted):
                fail('只有已删除的错题记录可以显式重新加入。')
            if row and not is_deleted and kind == 'attempts' and not deleted:
                previous = json.loads(row['summary_json'])
                if previous.get('status') == 'completed':
                    if row['value_json'] == value_json or json.loads(row['value_json']) == value:
                        result = self.metadata(row)
                    else:
                        fail('已完成的练习不能覆盖或改回未完成。', 409, 'attempt_completed', revision=current, deleted=False)
                else:
                    result = None
            else:
                result = None
            if result is None:
                quota = db.execute('SELECT COUNT(*),COALESCE(SUM(payload_bytes),0) FROM sat_account_entities WHERE user_id=?', (user_id,)).fetchone()
                if (not row and quota[0] >= MAX_ACCOUNT_ENTITIES
                        or quota[1] - (row['payload_bytes'] if row else 0) + size > MAX_ACCOUNT_BYTES):
                    fail('SAT 账号同步空间已满，请先导出并整理记录。', 413, 'sat_storage_limit')
                updated = self.accounts.clock() * 1000
                result = {'id': identity, 'revision': current + 1, 'deleted': deleted, 'updatedAt': updated}
                db.execute('INSERT INTO sat_account_entities VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,kind,entity_id) DO UPDATE SET value_json=excluded.value_json,summary_json=excluded.summary_json,revision=excluded.revision,deleted=excluded.deleted,payload_bytes=excluded.payload_bytes,updated_at=excluded.updated_at',
                           (user_id, kind, identity, value_json, summary_json, current + 1, int(deleted), size, updated))
            db.execute('INSERT INTO sat_account_mutations(user_id,kind,entity_id,mutation_id,request_hash,result_json) VALUES (?,?,?,?,?,?)',
                       (user_id, kind, identity, body['mutationId'], request_hash, encoded(result)))
            db.execute('DELETE FROM sat_account_mutations WHERE sequence IN (SELECT sequence FROM sat_account_mutations WHERE user_id=? AND kind=? AND entity_id=? ORDER BY sequence DESC LIMIT -1 OFFSET ?)',
                       (user_id, kind, identity, MUTATIONS_PER_ENTITY))
            return result
