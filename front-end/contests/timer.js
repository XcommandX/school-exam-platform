/* Pure timed-practice state machine. All times are absolute epoch milliseconds. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ContestTimer = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const SOURCE = 'https://maa.org/student-programs/amc/';
  const empty = () => ({version: 1, attempts: []});
  const key = (mode, exam) => JSON.stringify([mode, exam.id, exam.revision]);
  const storageKey = account => {
    if (!account) throw Error('需要登录账号。');
    return 'study-space:contests:account:' + encodeURIComponent(String(account)) + ':v2';
  };
  function plan(exam, mode) {
    const name = exam.contest;
    if (!['AMC10', 'AMC12', 'AIME', 'USAMO'].includes(name)) throw Error('未知竞赛。');
    const year = Number(exam.year);
    const oldSingle = name === 'USAMO' && year >= 1972 && year <= 1995;
    const oldDouble = name === 'USAMO' && year >= 1996 && year <= 2001;
    const count = name === 'USAMO' ? oldSingle ? 5 : 6 : name === 'AIME' ? 15 : 25;
    const numbers = Array.from({length: count}, (_, i) => i + 1);
    const actual = (exam.problems || []).map(p => p.number);
    const partial = mode === 'example' || exam.example === true || (exam.missing_numbers || []).length > 0 || actual.length !== count || numbers.some(n => !actual.includes(n));
    const historical = oldDouble || oldSingle && year >= 1989;
    const minutes = oldSingle ? 210 : oldDouble ? 180 : name === 'USAMO' ? 270 : name === 'AIME' ? 180 : 75;
    const sessions = name === 'USAMO' && !oldSingle
      ? [{label: oldDouble ? '同日第 1 场' : '第 1 天', minutes, numbers: [1, 2, 3]}, {label: oldDouble ? '同日第 2 场' : '第 2 天', minutes, numbers: [4, 5, 6]}]
      : [{label: '整卷', minutes, numbers}];
    const source = historical && year >= 1989 ? `https://olimpicos.net/files/usamo/USAMO_${year}_Q1-${oldSingle ? 5 : 6}.pdf` : SOURCE;
    return {sessions, partial, historical, source,
      note: [mode === 'example' ? '原创示例，非官方试卷。' : partial ? '题目不完整，仅作部分题限时练习。' : '标准时长练习，不代表官方考试或官方评分。',
        oldSingle ? year < 1989 ? '早期赛制时长尚待逐年核实；本次按 210 分钟、题 1–5 练习，不代表当年官方时限。' : '1989–1995 历史赛制：单场 210 分钟，题 1–5。'
          : oldDouble ? '1996–2001 历史赛制：同一天两场，各 180 分钟，题 1–3 / 4–6；第二场须独立开始。'
          : name === 'USAMO' ? '现代标准：两天各 270 分钟，题 1–3 / 4–6；第二天须独立开始。'
          : `${name === 'AMC12' && year < 2000 ? '早年原赛制未逐年核实，采用现代 AMC 12 标准练习：' : ''}时限 ${minutes} 分钟。`,
        historical ? '历史时限据历史资料与试卷镜像核对；镜像非官方原站独立认证。' : '',
        '开始后不可暂停；离开页面仍计时。记录为本机练习，修改系统时钟可能影响计时，不用于正式监考。'].filter(Boolean).join(' ')};
  }
  function create(state, mode, exam, id, now) {
    if (!['private', 'example'].includes(mode) || !id || !Number.isFinite(now)) throw Error('无效计时身份。');
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(exam.id) || !/^[a-f0-9]{64}$/.test(exam.revision)) throw Error('无效试卷身份。');
    if (state.attempts.some(a => a.id === id)) throw Error('重复练习编号。');
    for (const previous of state.attempts) reconcile(previous, now);
    if (state.attempts.some(a => a.key === key(mode, exam) && a.sessions.some(s => s.status === 'running' || s.status === 'ready'))) throw Error('请先完成已有练习。');
    const schedule = plan(exam, mode);
    const attempt = {id, key: key(mode, exam), mode, examId: exam.id, revision: exam.revision,
      title: exam.title || exam.id, createdAt: now, note: schedule.note, responses: {},
      sessions: schedule.sessions.map(s => ({...s, status: s.numbers.some(n => exam.problems.some(p => p.number === n)) ? 'ready' : 'unavailable', startedAt: null, deadline: null, endedAt: null}))};
    state.attempts.push(attempt);
    return attempt;
  }
  function start(attempt, day, now) {
    const s = attempt.sessions[day];
    if (!s || s.status !== 'ready' || !Number.isFinite(now) || now < attempt.createdAt || attempt.sessions.slice(0, day).some(x => !['finished', 'expired', 'unavailable'].includes(x.status) || x.endedAt > now)) throw Error('该场尚不可开始。');
    s.status = 'running'; s.startedAt = now; s.deadline = now + s.minutes * 60000;
    return s;
  }
  function reconcile(attempt, now) {
    let changed = false;
    for (const s of attempt.sessions) if (s.status === 'running' && now >= s.deadline) {
      s.status = 'expired'; s.endedAt = s.deadline; changed = true;
    }
    return changed;
  }
  function remaining(session, now) {
    return session.status === 'running' ? Math.max(0, session.deadline - now) : session.status === 'ready' ? session.minutes * 60000 : 0;
  }
  function write(attempt, day, problem, value, now) {
    reconcile(attempt, now);
    const s = attempt.sessions[day];
    if (!Number.isFinite(now) || s?.status !== 'running' || now < s.startedAt || !s.numbers.includes(problem.number) || !/^[a-zA-Z0-9_-]{1,160}$/.test(problem.id)) return false;
    attempt.responses[problem.id] = {value: String(value ?? '').slice(0, 20000), number: problem.number, updatedAt: now};
    return true;
  }
  function finish(attempt, day, now) {
    reconcile(attempt, now);
    const s = attempt.sessions[day];
    if (!Number.isFinite(now) || s?.status !== 'running' || now < s.startedAt) return false;
    s.status = 'finished'; s.endedAt = now; return true;
  }
  const ended = session => ['finished', 'expired'].includes(session?.status);
  // Reject malformed snapshots instead of silently losing attempts or extending deadlines.
  function load(input) {
    if (!input || input.version !== 1 || !Array.isArray(input.attempts)) throw Error('计时记录格式异常；未覆盖原记录。');
    const copy = JSON.parse(JSON.stringify(input)), ids = new Set(), liveKeys = new Set();
    for (const a of copy.attempts) {
      if (!a.id || ids.has(a.id) || !['private', 'example'].includes(a.mode) || !/^[a-zA-Z0-9_-]{1,160}$/.test(a.examId) || !/^[a-f0-9]{64}$/.test(a.revision) || a.key !== key(a.mode, {id: a.examId, revision: a.revision}) || !a.responses || !Array.isArray(a.sessions) || ![1,2].includes(a.sessions.length)) throw Error('计时身份异常；未覆盖原记录。');
      if (typeof a.id !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(a.id) || !Number.isFinite(a.createdAt) || typeof a.title !== 'string' || typeof a.note !== 'string' || typeof a.responses !== 'object' || Array.isArray(a.responses)) throw Error('计时记录异常；未覆盖原记录。');
      ids.add(a.id);
      if (a.sessions.some(s => ['ready','running'].includes(s?.status))) {
        if (liveKeys.has(a.key)) throw Error('同卷计时重叠；未覆盖原记录。');
        liveKeys.add(a.key);
      }
      const numbers = new Set();
      for (const s of a.sessions) {
        if (!['ready', 'running', 'finished', 'expired', 'unavailable'].includes(s.status) || ![75,180,210,270].includes(s.minutes) || !Array.isArray(s.numbers) || !s.numbers.length || s.numbers.some(n => !Number.isInteger(n) || n < 1 || n > 25)) throw Error('计时场次异常；未覆盖原记录。');
        if (['running','finished','expired'].includes(s.status) && (!Number.isFinite(s.startedAt) || s.deadline !== s.startedAt + s.minutes * 60000)) throw Error('截止时间异常；未覆盖原记录。');
        if (ended(s) && (!Number.isFinite(s.endedAt) || s.endedAt < s.startedAt || s.endedAt > s.deadline)) throw Error('结束时间异常；未覆盖原记录。');
        if (s.status === 'expired' && s.endedAt !== s.deadline || ['ready','unavailable'].includes(s.status) && [s.startedAt,s.deadline,s.endedAt].some(v => v !== null) || s.status === 'running' && s.endedAt !== null) throw Error('场次状态异常；未覆盖原记录。');
        if (s.startedAt !== null && s.startedAt < a.createdAt) throw Error('开始时间异常；未覆盖原记录。');
        for (const n of s.numbers) { if (numbers.has(n)) throw Error('题号重叠；未覆盖原记录。'); numbers.add(n); }
      }
      for (const [id, r] of Object.entries(a.responses)) {
        if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id) || !r || Object.keys(r).some(k => !['value','number','updatedAt'].includes(k)) || typeof r.value !== 'string' || r.value.length > 20000 || !numbers.has(r.number) || !Number.isFinite(r.updatedAt)) throw Error('计时作答异常；未覆盖原记录。');
        const s = a.sessions.find(s => s.numbers.includes(r.number));
        if (s.startedAt === null || r.updatedAt < s.startedAt || r.updatedAt >= s.deadline || ended(s) && r.updatedAt > s.endedAt) throw Error('作答时间异常；未覆盖原记录。');
      }
      if (a.sessions.filter(s => s.status === 'running').length > 1 || a.sessions.some((s,i) => s.startedAt !== null && a.sessions.slice(0,i).some(p => !ended(p) && p.status !== 'unavailable' || p.endedAt > s.startedAt))) throw Error('场次重叠；未覆盖原记录。');
    }
    return copy;
  }
  return {SOURCE, empty, key, storageKey, plan, create, start, reconcile, remaining, write, finish, ended, load};
});
