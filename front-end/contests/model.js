/* Pure contest practice state. No imports from legacy student storage. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ContestModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const STORAGE_KEY = 'school-exam-platform:contests:practice:v1';
  const CONTESTS = ['AMC10', 'AMC12', 'AIME', 'USAMO'];
  const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value);
  const validRevision = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const empty = () => ({version: 1, sessions: {}, bookmarks: {}});
  const sessionKey = (mode, id, revision) => `${mode}:${id}:${revision}`;
  const bookmarkKey = (mode, id) => `${mode}:${id}`;
  function load(raw) {
    const clean = empty();
    try {
      const input = JSON.parse(raw);
      if (input?.version !== 1) return clean;
      for (const value of Object.values(input.sessions || {})) {
        if (!value || !['example', 'private'].includes(value.mode) || !safeId(value.examId) || !validRevision(value.revision) || !CONTESTS.includes(value.contest)) continue;
        const record = {mode: value.mode, examId: value.examId, revision: value.revision, contest: value.contest,
          title: String(value.title || '').slice(0, 150), updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0, responses: {}};
        for (const [id, r] of Object.entries(value.responses || {}).slice(0, 100)) {
          if (!safeId(id) || !r || typeof r !== 'object') continue;
          record.responses[id] = {value: String(r.value || '').slice(0, 20000),
            result: ['correct', 'incorrect'].includes(r.result) ? r.result : null,
            revealed: r.revealed === true, number: Number.isInteger(r.number) ? r.number : 0,
            updatedAt: Number.isFinite(r.updatedAt) ? r.updatedAt : 0};
        }
        clean.sessions[sessionKey(record.mode, record.examId, record.revision)] = record;
      }
      for (const [key, mark] of Object.entries(input.bookmarks || {})) {
        if (mark && ['example', 'private'].includes(mark.mode) && safeId(mark.id) && safeId(mark.examId) && key === bookmarkKey(mark.mode, mark.id)) {
          clean.bookmarks[key] = {mode: mark.mode, id: mark.id, examId: mark.examId, number: Number.isInteger(mark.number) && mark.number > 0 ? mark.number : Number(mark.id.split('-').at(-1)) || 1};
        }
      }
    } catch { /* Empty and corrupt browser state are not imported. */ }
    return clean;
  }
  function canGrade(problem) {
    const q = problem?.quality;
    if (problem?.question_type === 'proof' || !q || q.auto_gradable !== true || q.ready_for_practice !== true || q.structurally_complete !== true) return false;
    if ((q.flags || []).some(f => /disagree|disput|conflict|variant_disagreement/.test(f))) return false;
    if (problem.answer?.type === 'choice') return Array.isArray(problem.answer.accepted) && problem.answer.accepted.length > 0 && problem.answer.accepted.every(a => (problem.choices || []).some(c => c.label === a));
    return problem.answer?.type === 'integer' && Number.isInteger(problem.answer.value) && problem.answer.value >= 0 && problem.answer.value <= 999;
  }
  function grade(problem, value) {
    if (!canGrade(problem)) return {status: 'ungraded', message: '本题不自动判分。'};
    const text = String(value ?? '').trim();
    if (problem.answer.type === 'integer') {
      if (!/^\d{1,3}$/.test(text)) return {status: 'invalid', message: '请输入 0–999 的整数（最多三位）。'};
      return {status: Number(text) === problem.answer.value ? 'correct' : 'incorrect', value: text};
    }
    if (!(problem.choices || []).some(c => c.label === text)) return {status: 'invalid', message: '请先选择一个选项。'};
    return {status: problem.answer.accepted.includes(text) ? 'correct' : 'incorrect', value: text};
  }
  function getSession(state, mode, exam) {
    return state.sessions[sessionKey(mode, exam.id, exam.revision)] || null;
  }
  function updateResponse(state, mode, exam, problem, patch, now = Date.now()) {
    if (!['private', 'example'].includes(mode) || !safeId(exam.id) || !validRevision(exam.revision) || !safeId(problem.id)) throw Error('Invalid practice identity.');
    const key = sessionKey(mode, exam.id, exam.revision);
    const session = state.sessions[key] ||= {mode, examId: exam.id, revision: exam.revision, contest: problem.contest, title: exam.title || exam.id, updatedAt: now, responses: {}};
    const previous = session.responses[problem.id] || {value: '', result: null, revealed: false};
    session.responses[problem.id] = {...previous, ...patch, number: problem.number, updatedAt: now};
    session.updatedAt = now;
    return session.responses[problem.id];
  }
  function submit(state, mode, exam, problem, value, now) {
    const previous = getSession(state, mode, exam)?.responses[problem.id];
    if (previous?.result) return {status: 'locked', message: '已记录本题首次检查结果。'};
    if (previous?.revealed) return {status: 'ungraded', message: '已查看参考答案，本题不再计入正确率。'};
    const result = grade(problem, value);
    if (['correct', 'incorrect'].includes(result.status)) updateResponse(state, mode, exam, problem, {value: result.value, result: result.status}, now);
    return result;
  }
  function summarize(state, mode, catalog = null) {
    const available = catalog ? new Map(catalog.map(e => [e.id, e.revision])) : null;
    let answered = 0, graded = 0, correct = 0, drafts = 0;
    for (const session of Object.values(state.sessions)) {
      if (session.mode !== mode || (available && available.get(session.examId) !== session.revision)) continue;
      for (const response of Object.values(session.responses)) {
        if (response.result) { answered++; graded++; if (response.result === 'correct') correct++; }
        else if (response.value.trim()) drafts++;
      }
    }
    return {answered, graded, correct, drafts, accuracy: graded ? Math.round(correct * 100 / graded) : null};
  }
  function examTitle(exam) {
    if (exam.title) return exam.title;
    return `${exam.contest} · ${exam.year}${exam.season === 'fall' ? ' 秋季' : exam.season === 'spring' ? ' 春季' : ''} ${exam.paper === 'SINGLE' || exam.paper === 'single' ? '单卷' : exam.paper}${exam.special_paper ? ' · 补充卷' : ''}`;
  }
  function filterExams(exams, {contest, year = '', query = '', supplemental = false} = {}) {
    const search = query.trim().toLowerCase();
    return exams.filter(e => (!contest || e.contest === contest) && (!year || String(e.year) === String(year)) && (supplemental || !e.special_paper) && (!search || examTitle(e).toLowerCase().includes(search)))
      .sort((a, b) => b.year - a.year || (a.season === b.season ? String(a.paper).localeCompare(String(b.paper)) : a.season === 'fall' ? -1 : 1));
  }
  return {STORAGE_KEY, CONTESTS, empty, load, canGrade, grade, getSession, updateResponse, submit, summarize, examTitle, filterExams, sessionKey, bookmarkKey};
});
