/* AP-only data model. No DOM, network, global storage or other exam state. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.APModel = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function storageKeys(accountId) {
    if (typeof accountId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(accountId)) throw new TypeError('AP 存储需要有效的已登录账号。');
    const prefix = 'school-exam-platform:account:' + accountId + ':ap:';
    return Object.freeze({ history: prefix + 'history:v1', drafts: prefix + 'drafts:v1', wrong: prefix + 'wrong:v1' });
  }
  const SOURCE_ID = /^ap:[a-z0-9][a-z0-9-]{0,119}$/;
  const REVISION = /^[a-f0-9]{64}$/;
  const ASSET = /^question-assets\/ap\/[a-f0-9]{64}\.pdf$/;
  const KINDS = ['mcq', 'frq', 'reference'];
  const MODES = ['private', 'synthetic'];
  const ROLES = ['questions', 'scoring', 'sample', 'reference'];
  const REVIEWS = ['verified', 'needs-review', 'document-only'];
  const RESPONSE_TYPES = ['synthesis', 'rhetorical-analysis', 'argument', 'essay'];
  const MAX_TEXT = 200000;
  const MAX_CONTENT_TEXT = 500000;
  const MAX_QUESTIONS = 1000;
  const LIMITS = Object.freeze({ history: 100, drafts: 30, wrong: 2000 });
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
  const text = (value, max = MAX_TEXT) => typeof value === 'string' && value.length <= max;
  const questionId = (value, sourceId) => typeof value === 'string' && value.startsWith(sourceId + ':') && /^q[0-9]{3,4}$/.test(value.slice(sourceId.length + 1));
  const timestamp = value => integer(value, 1, 8640000000000000);
  function check(condition, message) { if (!condition) throw new TypeError(message || '题集格式不可用，请重新载入或检查本机题库。'); }
  function identity(value) {
    return object(value) && SOURCE_ID.test(value.sourceId) && REVISION.test(value.revision) && MODES.includes(value.contentMode);
  }
  function sourceIdentity(source, value) {
    return identity(value) && source.id === value.sourceId && source.revision === value.revision && source.contentMode === value.contentMode;
  }
  function pdfHref(document, page = 1) {
    if (!object(document) || !ASSET.test(document.asset) || !integer(document.pageCount, 1, 10000) || !integer(page, 1, document.pageCount)) return null;
    return '/' + document.asset + '#page=' + page;
  }
  function validateSource(raw) {
    check(object(raw) && raw.schemaVersion === 2 && raw.exam === 'ap' && raw.subject === 'english-language');
    check(SOURCE_ID.test(raw.id) && REVISION.test(raw.revision));
    check(text(raw.title, 1000) && raw.title.trim() && raw.section === 'English Language and Composition');
    check(raw.year === null || integer(raw.year, 1900, 2200));
    check(text(raw.form, 500) && KINDS.includes(raw.kind) && MODES.includes(raw.contentMode));
    check(integer(raw.defaultDurationSeconds, 0, 86400));
    check(Array.isArray(raw.documents) && raw.documents.length <= 100);
    const docIds = new Set();
    const documents = raw.documents.map(doc => {
      check(object(doc) && /^[a-z][a-z0-9-]{0,79}$/.test(doc.id) && !docIds.has(doc.id));
      check(ROLES.includes(doc.role) && text(doc.label, 1000) && doc.label.trim() && pdfHref(doc));
      docIds.add(doc.id);
      return { id: doc.id, role: doc.role, label: doc.label, asset: doc.asset, pageCount: doc.pageCount };
    });
    const docs = new Map(documents.map(doc => [doc.id, doc]));
    check(raw.contentMode !== 'private' || documents.length > 0);
    check(Array.isArray(raw.questions) && raw.questions.length <= MAX_QUESTIONS);
    check(raw.kind !== 'reference' || raw.questions.length === 0);
    const ids = new Set();
    const numbers = new Set();
    const questions = raw.questions.map(q => {
      check(object(q) && questionId(q.id, raw.id) && !ids.has(q.id));
      ids.add(q.id);
      check(['mcq', 'free-response'].includes(q.type) && integer(q.number, 1, MAX_QUESTIONS) && !numbers.has(q.number));
      numbers.add(q.number);
      check(text(q.prompt, MAX_CONTENT_TEXT) && q.prompt.trim() && text(q.passage, MAX_CONTENT_TEXT) && text(q.explanation, MAX_CONTENT_TEXT) && text(q.answerProvenance, MAX_CONTENT_TEXT));
      check(REVIEWS.includes(q.reviewStatus) && Array.isArray(q.options));
      if (q.type === 'mcq') {
        check(q.options.length >= 2 && q.options.length <= 5 && q.options.every(option => text(option, 10000) && option.trim()) && q.responseType === undefined);
        check(q.correctOption === null || integer(q.correctOption, 0, q.options.length - 1));
        check(q.correctOption === null ? q.reviewStatus !== 'verified' : q.reviewStatus === 'verified' && q.answerProvenance.trim());
      } else {
        check(q.options.length === 0 && q.correctOption === null && RESPONSE_TYPES.includes(q.responseType));
      }
      check(Array.isArray(q.pages) && q.pages.length <= 100 && q.pages.every((page, index) => integer(page, 1, 10000) && (!index || page > q.pages[index - 1])));
      if (q.sourceDocument !== undefined) {
        check(docs.has(q.sourceDocument) && docs.get(q.sourceDocument).role === 'questions' && q.pages.length > 0);
        check(q.pages.every(page => page <= docs.get(q.sourceDocument).pageCount));
      } else check(raw.contentMode === 'synthetic' && q.pages.length === 0);
      if (q.answerDocument !== undefined) check(docs.has(q.answerDocument) && ['questions', 'scoring'].includes(docs.get(q.answerDocument).role));
      if (q.answerPage !== undefined) check(q.answerDocument !== undefined && integer(q.answerPage, 1, docs.get(q.answerDocument).pageCount));
      const result = {
        id: q.id, type: q.type, number: q.number, prompt: q.prompt, passage: q.passage,
        options: q.options.slice(), correctOption: q.correctOption, explanation: q.explanation,
        pages: q.pages.slice(), reviewStatus: q.reviewStatus, answerProvenance: q.answerProvenance
      };
      if (q.type === 'free-response') result.responseType = q.responseType;
      for (const key of ['sourceDocument', 'answerDocument', 'answerPage']) if (q[key] !== undefined) result[key] = q[key];
      return result;
    });
    check(Array.isArray(raw.importWarnings) && raw.importWarnings.length <= 2000 && raw.importWarnings.every(warning => text(warning, 10000)));
    return {
      schemaVersion: 2, exam: 'ap', subject: 'english-language', id: raw.id, title: raw.title,
      section: raw.section, year: raw.year, form: raw.form, kind: raw.kind, contentMode: raw.contentMode,
      revision: raw.revision, defaultDurationSeconds: raw.defaultDurationSeconds,
      documents, questions, importWarnings: raw.importWarnings.slice()
    };
  }
  function normalizeSummary(raw) {
    if (!object(raw) || !SOURCE_ID.test(raw.id) || !text(raw.title, 1000) || !raw.title.trim() || raw.section !== 'English Language and Composition') return null;
    if (!(raw.year === null || integer(raw.year, 1900, 2200)) || !text(raw.form, 500) || !KINDS.includes(raw.kind) || !MODES.includes(raw.contentMode)) return null;
    if (!integer(raw.questionCount, 0, MAX_QUESTIONS) || !integer(raw.documentCount, 0, 1000) || !integer(raw.reviewCount, 0, MAX_QUESTIONS) || !integer(raw.defaultDurationSeconds, 0, 604800)) return null;
    return { id: raw.id, title: raw.title, section: raw.section, questionCount: raw.questionCount,
      defaultDurationSeconds: raw.defaultDurationSeconds, year: raw.year, form: raw.form, kind: raw.kind,
      contentMode: raw.contentMode, documentCount: raw.documentCount, reviewCount: raw.reviewCount };
  }
  function validateCatalog(raw) {
    check(object(raw) && raw.exam === 'ap' && raw.schemaVersion === 2 && Array.isArray(raw.sources) && Array.isArray(raw.errors), '题库目录暂不可用，请重试。');
    check(raw.sources.length <= 10000, '题库目录过大，无法载入。');
    const ids = new Set();
    let invalidCount = 0;
    const sources = [];
    for (const value of raw.sources) {
      const summary = normalizeSummary(value);
      if (!summary || ids.has(summary.id)) { invalidCount++; continue; }
      ids.add(summary.id);
      sources.push(summary);
    }
    return { sources, errorCount: raw.errors.length + invalidCount };
  }
  function filterSources(sources, filters = {}) {
    const search = typeof filters.search === 'string' ? filters.search.trim().toLocaleLowerCase() : '';
    return sources.filter(source => (!filters.year || String(source.year) === String(filters.year)) &&
      (!filters.kind || source.kind === filters.kind) && (!filters.contentMode || source.contentMode === filters.contentMode) &&
      (!search || [source.title, source.year === null ? '' : source.year, source.form, source.kind].join(' ').toLocaleLowerCase().includes(search)));
  }
  function countWords(value) {
    return typeof value === 'string' ? (value.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu) || []).length : 0;
  }
  function formatTime(seconds) {
    const s = integer(seconds, 0) ? seconds : 0;
    const hours = Math.floor(s / 3600);
    const minutes = Math.floor(s / 60) % 60;
    return (hours ? String(hours) + ':' : '') + String(minutes).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }
  // Current section limits, not a claim about the length/completeness of historical papers.
  function timingProfile(source) {
    const questions = source.questions;
    if (!questions.length) return { durationSeconds: 0, readingSeconds: 0, label: '文档阅读' };
    if (questions.every(q => q.type === 'mcq')) return { durationSeconds: 3600, readingSeconds: 0, label: 'MCQ · 60 分钟' };
    if (questions.every(q => q.type === 'free-response')) return { durationSeconds: 8100, readingSeconds: 900, label: 'FRQ · 135 分钟（含 15 分钟阅读）' };
    return { durationSeconds: source.defaultDurationSeconds || 3600, readingSeconds: 0, label: '混合题组 · 练习限时（非官方整卷）' };
  }
  function advanceTiming(draft, now) {
    const timing = draft.timing;
    if (!timing || timing.paused || !timestamp(now) || now <= timing.anchorAt) return draft;
    const seconds = Math.floor((now - timing.anchorAt) / 1000);
    draft.elapsedSeconds = Math.min(31536000, draft.elapsedSeconds + seconds);
    timing.anchorAt += seconds * 1000;
    return draft;
  }
  function timerStatus(draft) {
    const timing = draft.timing;
    const duration = timing ? timing.durationSeconds : 0;
    const remaining = Math.max(0, duration - draft.elapsedSeconds);
    const expired = draft.timerEnabled && duration > 0 && remaining === 0;
    return { remaining, expired, paused: Boolean(timing && timing.paused),
      phase: !draft.timerEnabled ? '自由练习' : expired ? '时间已到' : timing && timing.readingSeconds > draft.elapsedSeconds ? '阅读阶段' : timing && timing.readingSeconds ? '写作阶段' : '限时练习' };
  }
  function validAnswer(q, answer) {
    return q.type === 'mcq' ? integer(answer, 0, q.options.length - 1) : text(answer);
  }
  function answered(q, answer) {
    return validAnswer(q, answer) && (q.type === 'mcq' || answer.trim().length > 0);
  }
  function results(source, answers) {
    const safe = object(answers) ? answers : {};
    return source.questions.map(q => {
      const response = own(safe, q.id) ? safe[q.id] : undefined;
      const isAnswered = answered(q, response);
      const canGrade = q.type === 'mcq' && q.reviewStatus === 'verified' && integer(q.correctOption, 0, q.options.length - 1);
      const graded = isAnswered && canGrade;
      return { id: q.id, answered: isAnswered, graded, correct: graded ? response === q.correctOption : null,
        status: !isAnswered ? 'unanswered' : !graded ? 'ungraded' : response === q.correctOption ? 'correct' : 'incorrect' };
    });
  }
  function totals(source, answers) {
    const items = results(source, answers);
    return { questionCount: items.length, answeredCount: items.filter(item => item.answered).length,
      gradedCount: items.filter(item => item.graded).length, correctCount: items.filter(item => item.correct === true).length };
  }
  function cleanAnswers(raw, sourceId) {
    if (!object(raw) || Object.keys(raw).length > MAX_QUESTIONS) return null;
    const answers = {};
    for (const [id, value] of Object.entries(raw)) {
      if (!questionId(id, sourceId) || !(integer(value, 0, 19) || text(value))) return null;
      Object.defineProperty(answers, id, { value, enumerable: true, writable: true, configurable: true });
    }
    return answers;
  }
  function normalizeAttempt(raw) {
    if (!identity(raw) || !text(raw.id, 200) || !/^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(raw.id) || !text(raw.title, 1000)) return null;
    if (!timestamp(raw.started) || !timestamp(raw.updated) || raw.updated < raw.started || !integer(raw.elapsedSeconds, 0, 31536000) || !integer(raw.cursor, 0, MAX_QUESTIONS) || typeof raw.timerEnabled !== 'boolean') return null;
    const answers = cleanAnswers(raw.answers, raw.sourceId);
    if (!answers) return null;
    let timing;
    if (raw.timing !== undefined) {
      const t = raw.timing;
      if (!object(t) || !integer(t.durationSeconds, 0, 86400) || !integer(t.readingSeconds, 0, t.durationSeconds) ||
          typeof t.paused !== 'boolean' || !timestamp(t.anchorAt) || t.anchorAt < raw.started ||
          (raw.timerEnabled && !t.durationSeconds)) return null;
      timing = { durationSeconds: t.durationSeconds, readingSeconds: t.readingSeconds, paused: t.paused, anchorAt: t.anchorAt };
    }
    return { id: raw.id, sourceId: raw.sourceId, revision: raw.revision, contentMode: raw.contentMode,
      title: raw.title, started: raw.started, updated: raw.updated, elapsedSeconds: raw.elapsedSeconds,
      cursor: raw.cursor, timerEnabled: raw.timerEnabled, answers, ...(timing ? { timing } : {}) };
  }
  function normalizeDraft(raw) {
    const base = normalizeAttempt(raw);
    return base && raw.status === 'in-progress' ? Object.assign(base, { status: 'in-progress' }) : null;
  }
  function normalizeRecord(raw) {
    const base = normalizeAttempt(raw);
    if (!base || raw.status !== 'completed' || !timestamp(raw.finished) || raw.finished < raw.started) return null;
    if (!integer(raw.questionCount, 0, MAX_QUESTIONS) || !integer(raw.answeredCount, 0, raw.questionCount) || !integer(raw.gradedCount, 0, raw.answeredCount) || !integer(raw.correctCount, 0, raw.gradedCount)) return null;
    return Object.assign(base, { status: 'completed', finished: raw.finished, questionCount: raw.questionCount,
      answeredCount: raw.answeredCount, gradedCount: raw.gradedCount, correctCount: raw.correctCount });
  }
  function normalizeWrong(raw) {
    if (!identity(raw) || !questionId(raw.questionId, raw.sourceId) || !text(raw.title, 1000) || !integer(raw.number, 1, 100000) || !timestamp(raw.updated)) return null;
    if (!integer(raw.selectedOption, 0, 19) || !integer(raw.correctOption, 0, 19) || raw.selectedOption === raw.correctOption) return null;
    return { sourceId: raw.sourceId, revision: raw.revision, contentMode: raw.contentMode, questionId: raw.questionId,
      title: raw.title, number: raw.number, selectedOption: raw.selectedOption, correctOption: raw.correctOption, updated: raw.updated };
  }
  const wrongKey = value => [value.sourceId, value.revision, value.questionId].join('|');
  const NORMALIZERS = { history: normalizeRecord, drafts: normalizeDraft, wrong: normalizeWrong };
  function normalizeList(name, raw) {
    check(own(LIMITS, name), '不允许访问其他考试的存储。');
    if (!Array.isArray(raw)) return { items: [], invalidCount: 1 };
    const seen = new Set();
    let invalidCount = 0;
    const items = [];
    for (const item of raw) {
      const clean = NORMALIZERS[name](item);
      if (!clean) { invalidCount++; continue; }
      const key = name === 'wrong' ? wrongKey(clean) : clean.id;
      if (seen.has(key)) { invalidCount++; continue; }
      seen.add(key);
      items.push(clean);
    }
    items.sort((a, b) => (b.finished || b.updated) - (a.finished || a.updated));
    return { items: items.slice(0, LIMITS[name]), invalidCount };
  }
  function createDraft(source, now, id, timed = false) {
    const profile = timingProfile(source);
    const draft = normalizeDraft({ id, sourceId: source.id, revision: source.revision, contentMode: source.contentMode,
      title: source.title, status: 'in-progress', started: now, updated: now, elapsedSeconds: 0, cursor: 0, timerEnabled: Boolean(timed && profile.durationSeconds), answers: {},
      timing: { durationSeconds: profile.durationSeconds, readingSeconds: profile.readingSeconds, paused: false, anchorAt: now } });
    check(draft, '无法开始练习。');
    return draft;
  }
  function restoreDraft(source, raw) {
    const draft = normalizeDraft(raw);
    if (!draft || !sourceIdentity(source, draft) || draft.cursor >= Math.max(1, source.questions.length)) return null;
    const questions = new Map(source.questions.map(q => [q.id, q]));
    for (const [id, answer] of Object.entries(draft.answers)) if (!questions.has(id) || !validAnswer(questions.get(id), answer)) return null;
    return draft;
  }
  function finish(source, draft, now) {
    const restored = restoreDraft(source, draft);
    check(restored && timestamp(now) && now >= restored.started, '草稿与题集版本不匹配，未提交。');
    return Object.assign({}, restored, totals(source, restored.answers), { status: 'completed', updated: now, finished: now });
  }
  function updateWrongBook(previous, source, record) {
    check(sourceIdentity(source, record), '题集版本不匹配，未更新错题。');
    const map = new Map(normalizeList('wrong', previous).items.map(item => [wrongKey(item), item]));
    const outcomes = results(source, record.answers);
    source.questions.forEach((q, index) => {
      const outcome = outcomes[index];
      const key = wrongKey({ sourceId: source.id, revision: source.revision, questionId: q.id });
      if (outcome.correct === true) map.delete(key);
      if (outcome.correct === false) map.set(key, {
        sourceId: source.id, revision: source.revision, contentMode: source.contentMode, questionId: q.id,
        title: source.title, number: q.number, selectedOption: record.answers[q.id], correctOption: q.correctOption, updated: record.finished
      });
    });
    return normalizeList('wrong', Array.from(map.values())).items;
  }
  /* Explicitly injected storage: never enumerates or reads any other key. Memory keeps work usable after quota/security failures. */
  function createStorage(storage, onIssue = function () {}, accountId, isActive = () => true) {
    const KEYS = storageKeys(accountId);
    const cache = new Map();
    const failedWrites = new Set();
    const issue = (reason, name) => onIssue({ reason, name, key: KEYS[name] });
    return {
      read(name) {
        if (!isActive()) { cache.clear(); failedWrites.clear(); return []; }
        check(own(LIMITS, name), '不允许访问其他考试的存储。');
        if (failedWrites.has(name)) return normalizeList(name, cache.get(name) || []).items;
        try {
          if (!storage) throw new Error('unavailable');
          const serialized = storage.getItem(KEYS[name]);
          const normalized = normalizeList(name, serialized === null ? [] : JSON.parse(serialized));
          if (normalized.invalidCount) issue('corrupt', name);
          cache.set(name, normalized.items);
          return normalized.items;
        } catch (error) {
          issue(error instanceof SyntaxError ? 'corrupt' : 'unavailable', name);
          return normalizeList(name, cache.get(name) || []).items;
        }
      },
      write(name, value) {
        if (!isActive()) { cache.clear(); failedWrites.clear(); return false; }
        check(own(LIMITS, name), '不允许访问其他考试的存储。');
        const normalized = normalizeList(name, value);
        if (normalized.invalidCount) { issue('invalid-write', name); return false; }
        cache.set(name, normalized.items);
        try {
          if (!storage) throw new Error('unavailable');
          storage.setItem(KEYS[name], JSON.stringify(normalized.items));
          failedWrites.delete(name);
          return true;
        } catch (_) { failedWrites.add(name); issue('unavailable', name); return false; }
      }
    };
  }
  const AI_VERSION = 'ap-lang-rubric-2019-v1';
  function validateAssessment(value, expected) {
    const short = value => text(value, 12000);
    const list = value => Array.isArray(value) && value.length <= 30 && value.every(short);
    check(object(value) && object(expected), 'AI 返回格式不可用。');
    check(value.version === AI_VERSION && ['scored', 'limited'].includes(value.status), 'AI 评分版本不兼容。');
    for (const key of ['sourceId', 'revision', 'questionId', 'responseHash']) check(value[key] === expected[key], 'AI 结果与当前作答不匹配。');
    check(REVISION.test(value.responseHash) && RESPONSE_TYPES.includes(value.questionType), 'AI 结果标识不可用。');
    check(value.questionType === expected.questionType, 'AI 题型不匹配。');
    check(short(value.feedback) && list(value.strengths) && list(value.improvements) && list(value.limitations), 'AI 反馈格式不可用。');
    check(text(value.createdAt, 40) && Number.isFinite(Date.parse(value.createdAt)), 'AI 结果时间不可用。');
    if (value.status === 'limited') check(value.rows === null && value.total === null, '材料不足时不能显示分数。');
    else {
      check(object(value.rows), 'AI 评分维度不完整。');
      let total = 0;
      for (const [key, maximum] of [['thesis', 1], ['evidenceCommentary', 4], ['sophistication', 1]]) {
        const row = value.rows[key];
        check(object(row) && integer(row.score, 0, maximum) && short(row.reason) && list(row.evidence), 'AI 评分维度无效。');
        total += row.score;
      }
      check(integer(value.total, 0, 6) && value.total === total, 'AI 总分与维度分不一致。');
    }
    const clean = {};
    for (const key of ['version', 'status', 'sourceId', 'revision', 'questionId', 'responseHash', 'questionType', 'total', 'feedback', 'createdAt']) clean[key] = value[key];
    for (const key of ['strengths', 'improvements', 'limitations']) clean[key] = [...value[key]];
    clean.rows = value.rows === null ? null : Object.fromEntries(['thesis', 'evidenceCommentary', 'sophistication'].map(key => [key, { score: value.rows[key].score, reason: value.rows[key].reason, evidence: [...value.rows[key].evidence] }]));
    return clean;
  }
  return Object.freeze({ AI_VERSION, validateAssessment, storageKeys, LIMITS, MAX_TEXT, validateSource, validateCatalog, normalizeSummary,
    filterSources, pdfHref, countWords, formatTime, timingProfile, advanceTiming, timerStatus, answered, results, totals, sourceIdentity,
    createDraft, restoreDraft, finish, normalizeDraft, normalizeRecord, normalizeWrong, normalizeList,
    updateWrongBook, wrongKey, createStorage });
}));
