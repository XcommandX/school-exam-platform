/* Study Space contest module. Real content stays in the local private bank. */
(function () {
  'use strict';
  const M = window.ContestModel;
  const T = window.ContestTimer, auth = window.PlatformAuth;
  const owner = auth?.user?.id;
  const storageKey = owner ? T.storageKey(owner) : null;
  const $ = id => document.getElementById(id);
  const names = {AMC10: 'AMC 10', AMC12: 'AMC 12', AIME: 'AIME', USAMO: 'USAMO'};
  const symbols = {AMC10: '∑', AMC12: 'π', AIME: '∞', USAMO: '∴'};
  const flags = {
    missing_solution: '暂无参考解答', answer_source_disagreement: '来源答案不一致',
    statement_variant_disagreement: '题面版本有分歧', missing_answer: '缺少参考答案',
    solution_version_unchecked: '解答与当前题面版本未核对',
    official_original_not_independently_verified: '原卷未经独立官方核验',
    optional_mirror_diagram_not_in_selected_source: '镜像附加示意图未包含于所选题面',
    diagram_derived_from_reviewed_source: '图示由人工核对后的源坐标重绘',
    solution_is_answer_only: '参考解答只有简短答案', source_paraphrase_not_verbatim: '来源使用改写题面',
    mirror_truncated_statement_restored: '已由第二来源补齐遗漏的题面',
    mirror_may_omit_display_math: '镜像解答可能遗漏独立公式', possibly_different_problem_version: '解答可能对应另一题面版本',
    choices_not_structured: '请核对题面中的选项', asset_not_local: '存在未本地化资源',
    statement_diagram_not_rendered: '图示源码未执行', missing_diagram_placeholder: '缺少图示'
  };
  const params = new URLSearchParams(location.search);
  let mode = params.get('mode') === 'example' ? 'example' : 'private';
  let contest = M.CONTESTS.includes(params.get('contest')) ? params.get('contest') : 'AMC10';
  let view = 'library', catalog = [], exam = null, index = 0, requestVersion = 0, catalogVersion = 0, renderVersion = 0;
  let mathQueue = Promise.resolve();
  let state = M.empty(), storageAvailable = true, storageWriter = false;
  let timed = T.empty(), attempt = null, timedMode = false, day = 0, newAttempt = false;
  let storageHealthy = true, releaseWriter;
  const reviewed = new Set();
  let initialExamNavigation = true;
  const active = () => Boolean(owner && auth?.active && String(auth.user?.id) === String(owner));
  function notice(id, text, kind = '') { const node = $(id); node.textContent = text; node.className = `notice ${kind}`; node.hidden = !text; }
  function storageWarning() { storageAvailable = false; notice('storage-notice', '浏览器无法保存记录。当前仍可练习，但刷新后进度可能丢失。', 'warning'); }
  async function initializeStorage() {
    if (!active()) throw Error('请先登录后打开竞赛。');
    const load = () => { try {
      const raw = localStorage.getItem(storageKey);
      if (raw !== null) {
        const snapshot = JSON.parse(raw);
        if (snapshot.version !== 2 || snapshot.regular?.version !== 1) throw Error('记录版本异常');
        timed = T.load(snapshot.timed); state = M.load(JSON.stringify(snapshot.regular));
      }
    } catch { storageHealthy = false; storageWarning(); notice('storage-notice', '无法读取保存记录；原记录未覆盖。限时开始已禁用。', 'warning'); } };
    const readonly = text => { storageAvailable = false; notice('storage-notice', text, 'warning'); load(); };
    if (!navigator.locks?.request) {
      readonly('当前浏览器无法安全协调多个标签页，本页仅临时练习，不保存记录。请使用支持 Web Locks 的现代浏览器。');
      return;
    }
    await new Promise(resolve => {
      navigator.locks.request(storageKey + ':writer', {ifAvailable: true}, async lock => {
        if (!lock) { readonly('另一个标签页正在保存记录。本页仅临时练习；关闭另一个竞赛标签页后刷新本页以保存。'); resolve(); return; }
        storageWriter = true; load(); if (storageHealthy) save(); resolve();
        // Keep the write lease until this document unloads; no stale whole-state overwrites.
        await new Promise(release => { releaseWriter = release; });
      }).catch(() => { readonly('无法取得记录保存权限，本页仅临时练习，不保存记录。'); resolve(); });
    });
  }
  function save() {
    if (!active() || !storageWriter || !storageHealthy) return false;
    try { localStorage.setItem(storageKey, JSON.stringify({version: 2, regular: state, timed})); storageAvailable = true; notice('storage-notice', ''); return true; }
    catch { storageWarning(); return false; }
  }
  const session = () => attempt?.sessions[day];
  const examAttempts = () => exam ? timed.attempts.filter(a => a.key === T.key(mode, exam)) : [];
  const unfinished = a => a.sessions.some(s => ['running', 'ready'].includes(s.status));
  const canReview = () => active() && !examAttempts().some(unfinished) && (!timedMode || T.ended(session()));
  const reviewKey = () => `${attempt?.id}:${current()?.id}`;
  function allowedNumber(number) {
    return !timedMode || (session() || T.plan(exam, mode).sessions[day])?.numbers.includes(number);
  }
  function restrictIndex() {
    if (timedMode && !attempt && !exam.problems.some(p => allowedNumber(p.number))) {
      const availableDay = T.plan(exam, mode).sessions.findIndex(s => s.numbers.some(n => exam.problems.some(p => p.number === n)));
      if (availableDay >= 0) day = availableDay;
    }
    if (timedMode && !allowedNumber(current()?.number)) index = Math.max(0, exam.problems.findIndex(p => allowedNumber(p.number)));
  }
  function captureDraft() {
    if (view !== 'practice' || !current() || !active() || $('question-panel').inert) return;
    const p = current();
    const value = p.question_type === 'proof' ? $('proof-draft').value : p.question_type === 'integer' ? $('integer-answer').value : $('choices').querySelector('input:checked')?.value || '';
    // Input events persist every edit, including IME drafts. Never accept a new edit after deadline.
    if (timedMode) {
      if (attempt && storageWriter && storageHealthy && T.write(attempt, day, p, value, Date.now())) save();
    } else if (!response().result) { M.updateResponse(state, mode, exam, p, {value}); save(); }
  }
  function currentReport() {
    if (!exam || !canReview()) return null;
    return timedMode ? T.report(attempt, exam, M) : M.scoreReport(exam, M.getSession(state, mode, exam)?.responses || {}, {mode});
  }
  function renderScore() {
    const report = currentReport();
    $('score-report').hidden = !report;
    if (!report) { $('score-items').replaceChildren(); $('score-total').textContent = ''; return; }
    $('score-title').textContent = report.label;
    $('score-total').textContent = report.policy ? `${report.score} / ${report.maximum} 分` : '不自动给分';
    $('score-counts').textContent = `正确 ${report.correct} · 错误 ${report.incorrect} · 空白 ${report.blank} · 无效作答 ${report.invalid} · 待提交 ${report.pending} · 不可判分 ${report.omitted} · 看答案后作答 ${report.revealed}`;
    $('score-policy').textContent = report.policy ? `${report.policy.label}。缺题、不可判分及先看答案的题不计入分数与满分；答案依据当前题库，未经官方认证。` : '证明题保留草稿，请自行或由教师复核。';
    const labels = {correct:'正确',incorrect:'错误',blank:'空白',invalid:'无效作答',ungraded:'不可判分',revealed:'已看答案，不计分',pending:'待提交'};
    $('score-items').replaceChildren(...report.items.map(item => node('li', `第 ${item.number} 题 · ${labels[item.status]}${item.points === null ? '' : ` · ${item.points} 分`}`)));
  }
  function renderTimer() {
    if (!exam) return;
    const schedule = T.plan(exam, mode), s = session();
    $('untimed-mode').setAttribute('aria-pressed', String(!timedMode));
    $('timed-mode').setAttribute('aria-pressed', String(timedMode));
    $('untimed-mode').disabled = examAttempts().some(a => a.sessions.some(x => ['running','ready'].includes(x.status)));
    const select = $('timed-attempt'); select.replaceChildren();
    for (const [i, a] of examAttempts().entries()) { const option = node('option', `第 ${i + 1} 轮 · ${new Date(a.createdAt).toLocaleString('zh-CN')}`); option.value = a.id; select.append(option); }
    if (newAttempt || !attempt) { const option = node('option', '待开始的新一轮'); option.value = ''; select.append(option); }
    select.value = newAttempt ? '' : attempt?.id || ''; select.disabled = !timedMode;
    $('new-attempt').disabled = !timedMode || examAttempts().some(a => a.sessions.some(x => ['running','ready'].includes(x.status)));
    $('timer-days').replaceChildren(...(timedMode ? (attempt?.sessions || schedule.sessions).map((entry, i) => {
      const b = button(`${entry.label} · ${entry.minutes} 分钟`, () => { captureDraft(); day = i; restrictIndex(); renderTimer(); renderQuestion(); });
      b.dataset.day = i; b.setAttribute('aria-pressed', String(day === i));
      b.disabled = entry.status === 'unavailable' || !!attempt?.sessions.some((x, j) => j !== i && x.status === 'running') || i > 0 && (attempt ? attempt.sessions.slice(0, i).some(x => !T.ended(x) && x.status !== 'unavailable') : schedule.sessions.slice(0, i).some(x => x.numbers.some(n => exam.problems.some(p => p.number === n))));
      return b;
    }) : []));
    $('timer-status').dataset.status = s?.status || '';
    $('timer-status').textContent = !timedMode ? '普通练习 · 不计时' : !attempt ? '待开始' : ({ready:'待开始',running:'计时中',finished:'已结束 · 只读',expired:'时间到 · 只读',unavailable:'本场未收录题目'})[s?.status] || '';
    const millis = timedMode ? s ? T.remaining(s, Date.now()) : schedule.sessions[day].minutes * 60000 : 0;
    const seconds = Math.ceil(millis / 1000);
    $('timer-remaining').textContent = timedMode ? `${String(Math.floor(seconds / 3600)).padStart(2,'0')}:${String(Math.floor(seconds / 60) % 60).padStart(2,'0')}:${String(seconds % 60).padStart(2,'0')}` : '';
    $('timer-start').hidden = !timedMode || !!s && s.status !== 'ready';
    $('timer-start').disabled = !active() || !storageWriter || !storageAvailable || !storageHealthy || !exam.problems.some(p => allowedNumber(p.number));
    $('timer-start').textContent = `开始${(s || schedule.sessions[day]).label}计时`;
    $('timer-finish').hidden = !timedMode || s?.status !== 'running';
    $('timer-finish').disabled = !active() || !storageWriter;
    $('timer-note').textContent = attempt && timedMode ? attempt.note : schedule.note;
    $('timer-source').hidden = !canReview();
    if (canReview()) $('timer-source').href = schedule.source;
    else $('timer-source').removeAttribute('href');
    renderScore();
  }
  function tick() {
    if (!active()) return;
    let changed = false;
    for (const a of timed.attempts) changed = T.reconcile(a, Date.now()) || changed;
    if (changed) save();
    if (view === 'practice' && exam) {
      // Updating the clock must not rebuild focused buttons or inputs every second.
      const s = session();
      if (timedMode && s) {
        const seconds = Math.ceil(T.remaining(s, Date.now()) / 1000);
        $('timer-remaining').textContent = `${String(Math.floor(seconds / 3600)).padStart(2,'0')}:${String(Math.floor(seconds / 60) % 60).padStart(2,'0')}:${String(seconds % 60).padStart(2,'0')}`;
      }
      if (changed || timedMode && s?.status !== $('timer-status').dataset.status) { renderTimer(); controls(); navigation(); showFeedback(); }
    }
  }
  function choosePractice(timedChoice) {
    captureDraft(); tick();
    if (!timedChoice && examAttempts().some(a => a.sessions.some(s => ['running','ready'].includes(s.status)))) return;
    timedMode = timedChoice; restrictIndex(); renderTimer(); renderQuestion();
  }
  async function beginTimed() {
    if (!exam || !timedMode || !active() || !storageWriter || !storageAvailable || !storageHealthy) return;
    const schedule = T.plan(exam, mode), target = session() || schedule.sessions[day];
    if (!confirm(`${exam.title}\n${schedule.note}\n${target.label}，${target.minutes} 分钟。确认后立即计时；普通练习答案保留，本轮从空白答案开始。确定开始？`)) return;
    const identity = exam, currentMode = mode, selectedAttempt = attempt, selectedDay = day;
    const backup = JSON.stringify(timed), oldId = attempt?.id;
    try {
      await auth.verify();
      if (!active() || exam !== identity || mode !== currentMode || attempt !== selectedAttempt || day !== selectedDay || !timedMode || view !== 'practice') return;
      if (!attempt) attempt = T.create(timed, mode, exam, crypto.randomUUID(), Date.now());
      T.start(attempt, day, Date.now());
      if (!save()) { timed = T.load(JSON.parse(backup)); attempt = timed.attempts.find(a => a.id === oldId) || null; renderTimer(); return; }
      newAttempt = false; restrictIndex(); renderTimer(); renderQuestion();
    } catch (error) { notice('error', error.message, 'error'); }
  }
  function finishTimed() {
    tick();
    if (!active() || !storageWriter || session()?.status !== 'running') return;
    if (!confirm('结束本场并锁定答案？结束后不能继续修改；全部场次结束后可查看参考解答。')) return;
    captureDraft(); T.finish(attempt, day, Date.now()); save(); renderTimer(); renderQuestion();
  }
  function node(tag, text, className) { const result = document.createElement(tag); if (text !== undefined) result.textContent = text; if (className) result.className = className; return result; }
  function button(text, action, className = 'quiet-button') { const result = node('button', text, className); result.type = 'button'; result.addEventListener('click', action); return result; }
  function fail(error) { notice('error', `无法加载：${error.message}。请确认本机服务正在运行后重试。`, 'error'); }
  async function get(url) { return auth.api(url); }
  function modeQuery() { return mode === 'example' ? '?mode=example' : ''; }
  function setURL() {
    const query = new URLSearchParams({contest});
    if (mode === 'example') query.set('mode', mode);
    if (view === 'practice' && exam) { query.set('exam', exam.id); query.set('q', exam.problems[index].number); }
    if (view === 'practice' && timedMode) { query.set('timed', '1'); if (attempt) query.set('attempt', attempt.id); query.set('day', day); }
    else if (view !== 'library') query.set('view', view);
    history.replaceState(null, '', `/contests/?${query}`);
  }
  function safeURL(value) {
    if (typeof value !== 'string' || /[\x00-\x20\x7f\\]/.test(value)) return null;
    try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
  }
  // Construct a fresh safe tree: never insert source HTML directly into the live document.
  function content(target, fragment, fallback = '') {
    const parsed = new DOMParser().parseFromString(fragment || '', 'text/html');
    const allowed = new Set(['P','DIV','SPAN','BR','B','STRONG','I','EM','U','S','SUB','SUP','UL','OL','LI','TABLE','TBODY','THEAD','TR','TD','TH','BLOCKQUOTE','PRE','CODE','HR','H3','H4','H5','A','IMG']);
    const skip = new Set(['SCRIPT','STYLE','IFRAME','OBJECT','EMBED','SVG','MATH','FORM','INPUT','BUTTON','TEXTAREA','LINK','META','BASE','TEMPLATE']);
    function copy(source) {
      if (source.nodeType === Node.TEXT_NODE) return document.createTextNode(source.textContent);
      if (source.nodeType !== Node.ELEMENT_NODE || skip.has(source.tagName)) return document.createDocumentFragment();
      const result = allowed.has(source.tagName) ? document.createElement(source.tagName.toLowerCase()) : document.createDocumentFragment();
      if (source.tagName === 'A') {
        const href = safeURL(source.getAttribute('href'));
        if (href) { result.href = href; result.target = '_blank'; result.rel = 'noopener noreferrer'; }
      }
      if (source.tagName === 'IMG') {
        const src = source.getAttribute('src') || '';
        if (!/^\/contest-assets\/assets\/[a-zA-Z0-9_./-]+\.(?:svg|png|jpe?g|webp)$/i.test(src) || src.split('/').some(p => ['.', '..'].includes(p))) return document.createTextNode('[图示不可用]');
        result.src = src; result.alt = (source.getAttribute('alt') || '题目图示').slice(0, 250); result.loading = 'lazy';
        result.addEventListener('error', () => { result.replaceWith(node('span', '图示加载失败，请重新导入完整题库。')); });
      }
      if (['TD','TH'].includes(source.tagName)) for (const attr of ['colspan','rowspan']) if (/^[1-9]\d?$/.test(source.getAttribute(attr) || '')) result.setAttribute(attr, source.getAttribute(attr));
      for (const child of source.childNodes) result.append(copy(child));
      return result;
    }
    const output = document.createDocumentFragment();
    for (const child of parsed.body.childNodes) output.append(copy(child));
    if (!output.childNodes.length) output.append(document.createTextNode(fallback));
    target.replaceChildren(output);
  }
  function fitMath(container) {
    // The shared design system sizes icon SVGs. Restore MathJax's generated ex dimensions.
    for (const svg of container.querySelectorAll('mjx-container svg')) {
      for (const key of ['width', 'height']) {
        const value = svg.getAttribute(key) || '';
        if (/^\d+(?:\.\d+)?(?:ex|em|px)$/.test(value)) svg.style[key] = value;
      }
    }
  }
  function stats() {
    const result = M.summarize(state, mode, catalog);
    $('count-total').textContent = catalog.reduce((n, e) => n + e.problem_count, 0).toLocaleString();
    $('count-answered').textContent = result.answered;
    $('count-accuracy').textContent = result.accuracy === null ? '—' : `${result.accuracy}%`;
  }
  function switchView(next) {
    if (next !== 'practice') { ++requestVersion; ++renderVersion; }
    view = next;
    $('library-view').hidden = view !== 'library';
    $('saved-view').hidden = !['wrong','bookmarks','history'].includes(view);
    $('practice-view').hidden = view !== 'practice';
    document.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-current', b.dataset.view === (view === 'practice' ? 'library' : view) ? 'page' : 'false'));
    if (view === 'library') renderLibrary();
    if (['wrong','bookmarks','history'].includes(view)) renderSaved();
    setURL();
  }
  function renderCards() {
    $('contest-cards').replaceChildren(...M.CONTESTS.map(name => {
      const entries = catalog.filter(e => e.contest === name);
      const card = button('', () => { contest = name; $('year').value = ''; $('search').value = ''; updateYears(); renderCards(); renderLibrary(); setURL(); }, 'contest-card');
      card.dataset.contest = name; card.dataset.symbol = symbols[name]; card.setAttribute('aria-pressed', String(contest === name));
      card.append(node('strong', names[name]));
      const meta = node('span', undefined, 'card-meta');
      meta.append(node('span', `${entries.length} 卷 · ${entries.reduce((n, e) => n + e.problem_count, 0).toLocaleString()} 题`), node('span', '↗', 'arrow'));
      card.append(meta); return card;
    }));
  }
  function updateYears() {
    const old = $('year').value;
    const option = (value, title) => { const result = node('option', title); result.value = value; return result; };
    const years = [...new Set(catalog.filter(e => e.contest === contest).map(e => e.year))].sort((a, b) => b - a);
    $('year').replaceChildren(option('', '全部年份'), ...years.map(y => option(y, y)));
    if (years.includes(Number(old))) $('year').value = old;
  }
  function empty(title, message, action) {
    const el = node('div', undefined, 'empty-state'); el.append(node('h3', title), node('p', message)); if (action) el.append(action); return el;
  }
  function renderLibrary() {
    $('library-title').textContent = names[contest];
    const rows = M.filterExams(catalog, {contest, year: $('year').value, query: $('search').value, supplemental: $('supplemental').checked});
    $('exam-count').textContent = `${rows.length} 份试卷`;
    if (!rows.length) {
      $('exam-list').replaceChildren(catalog.length ? empty('没有匹配的试卷', '调整年份、搜索条件或补充卷选项。') : empty('尚未导入竞赛题库', '当前尚无可用的真实题目。请联系管理员检查题库，也可以先体验原创示例。', button('打开原创示例', () => changeMode('example'), 'primary-button')));
      return;
    }
    $('exam-list').replaceChildren(...rows.map(item => {
      const el = button('', () => openExam(item.id).catch(fail), 'exam-tile'); el.dataset.exam = item.id;
      const top = node('span', undefined, 'tile-top');
      top.append(node('strong', `${item.year}${item.season === 'fall' ? ' 秋季' : item.season === 'spring' ? ' 春季' : ''}`), node('span', item.paper && !/^single$/i.test(item.paper) ? `${item.paper} 卷` : '单卷', 'paper-chip'));
      const meta = node('span', undefined, 'tile-meta');
      const attempted = Object.values(M.getSession(state, mode, item)?.responses || {}).filter(r => r.result).length;
      const missing = item.missing_numbers?.length;
      meta.append(node('span', `${item.problem_count} 题${missing ? ` · 缺 ${missing} 题` : ''}${item.special_paper ? ' · 补充卷' : ''}`), node('span', attempted ? `已答 ${attempted} ↗` : '开始练习 ↗'));
      el.append(top, meta); el.title = M.examTitle(item); return el;
    }));
  }
  async function loadCatalog(initialExam, initialQuestion, initialView) {
    const token = ++catalogVersion, navigationToken = requestVersion;
    notice('error', ''); notice('notice', '正在读取题库…');
    const result = await get('/api/contests/catalog' + modeQuery());
    if (token !== catalogVersion) return;
    catalog = result.exams;
    $('private-mode').setAttribute('aria-pressed', String(mode === 'private'));
    $('example-mode').setAttribute('aria-pressed', String(mode === 'example'));
    notice('notice', mode === 'example' ? '原创示例模式：不是历年真题，记录与竞赛题库分开保存。' : result.errors?.length ? '部分本机资源未通过校验，请检查导入报告。' : '');
    updateYears(); renderCards(); stats(); renderLibrary();
    if (['wrong','bookmarks','history'].includes(view)) renderSaved();
    window.startContestMath(result.mathjaxAvailable).then(ok => { if (!ok) notice('math-notice', '公式渲染未就绪，当前显示 LaTeX 原文。请重试或联系管理员检查公式资源。', 'warning'); });
    if (navigationToken !== requestVersion) return;
    if (initialExam && catalog.some(e => e.id === initialExam)) await openExam(initialExam, initialQuestion, false);
    else if (['wrong','bookmarks','history'].includes(initialView)) switchView(initialView);
  }
  async function changeMode(next) {
    if (next === mode) return;
    captureDraft();
    mode = next; exam = null; catalog = []; $('search').value = ''; $('year').value = ''; switchView('library'); renderCards(); stats();
    try { await loadCatalog(); } catch (error) { fail(error); }
  }
  async function openExam(id, number, focus = true) {
    captureDraft();
    const token = ++requestVersion;
    const item = catalog.find(e => e.id === id);
    if (!item) throw Error('竞赛题库中未找到该试卷');
    notice('error', '');
    const data = await get(`/api/contests/exams/${encodeURIComponent(id)}${modeQuery()}`);
    if (token !== requestVersion) return;
    if (!Array.isArray(data.problems) || !data.problems.length || data.id !== id) throw Error('试卷数据无效');
    if (data.revision !== item.revision) throw Error('题库版本已改变，请刷新页面');
    let expired = false;
    for (const a of timed.attempts) expired = T.reconcile(a, Date.now()) || expired;
    if (expired) save();
    exam = {...item, ...data, title: M.examTitle(item)}; contest = item.contest;
    const attempts = examAttempts(), useURL = initialExamNavigation;
    initialExamNavigation = false;
    attempt = attempts.find(unfinished) || (useURL && attempts.find(a => a.id === params.get('attempt'))) || attempts.at(-1) || null;
    timedMode = useURL && params.get('timed') === '1' || !!attempt && unfinished(attempt);
    newAttempt = false;
    day = Math.max(0, attempt?.sessions.findIndex(s => s.status === 'running' || s.status === 'ready') ?? 0);
    if (useURL && params.get('attempt') === attempt?.id && !unfinished(attempt)) day = Math.max(0, Math.min(Number(params.get('day')) || 0, attempt.sessions.length - 1));
    index = Math.max(0, data.problems.findIndex(p => p.number === Number(number)));
    restrictIndex(); renderTimer();
    renderCards(); switchView('practice');
    $('exam-title').textContent = exam.title;
    const missing = exam.missing_numbers || [];
    notice('missing-notice', missing.length ? `本卷缺少题号：${missing.join('、')}。不显示为完整试卷。` : '', 'warning');
    const rendering = renderQuestion(), rendered = renderVersion;
    await rendering;
    if (focus && token === requestVersion && rendered === renderVersion && view === 'practice') $('question-title').focus({preventScroll: true});
  }
  function current() { return exam?.problems[index]; }
  function responses() { return timedMode ? attempt?.responses || {} : M.getSession(state, mode, exam)?.responses || {}; }
  function response() { return exam && responses()[current().id] || {}; }
  function navigation() {
    $('question-total').textContent = `${exam.problems.length} 题`;
    $('question-nav').replaceChildren(...exam.problems.map((p, i) => {
      const r = responses()[p.id];
      const el = button(p.number, () => move(i), r?.result ? 'is-done' : r?.value?.trim() ? 'is-draft' : '');
      el.disabled = !allowedNumber(p.number);
      el.setAttribute('aria-label', `第 ${p.number} 题${r?.result ? '，已答' : r?.value?.trim() ? '，有草稿' : ''}`); el.setAttribute('aria-current', String(i === index)); return el;
    }));
    const done = Object.values(responses()).filter(r => timedMode ? r.value?.trim() : r.result).length;
    $('practice-progress').textContent = `已答 ${done} / ${exam.problems.length}`;
    $('position').textContent = `${index + 1} / ${exam.problems.length}`;
    $('previous').disabled = index === 0 || !allowedNumber(exam.problems[index - 1]?.number); $('next').disabled = index === exam.problems.length - 1 || !allowedNumber(exam.problems[index + 1]?.number);
  }
  function controls() {
    const p = current(), r = response();
    $('check-answer').hidden = p.question_type === 'proof' || timedMode;
    $('check-answer').disabled = !M.canGrade(p) || !!r.result || !!r.revealed;
    $('check-answer').textContent = r.result ? '已记录结果' : '检查答案';
    $('reveal-answer').hidden = !p.answer || !canReview();
    $('solution-details').hidden = !canReview(); $('source-details').hidden = !canReview();
    if (!canReview()) { $('solution-details').open = false; $('source-details').open = false; $('solution-body').replaceChildren(); $('source-body').replaceChildren(); }
    else if (!$('source-body').childElementCount) sourceInfo(p);
    document.querySelectorAll('#statement a, #choices a').forEach(a => {
      if (!canReview()) { if (a.hasAttribute('href')) a.dataset.reviewHref = a.getAttribute('href'); a.removeAttribute('href'); }
      else if (a.dataset.reviewHref) { a.href = a.dataset.reviewHref; delete a.dataset.reviewHref; }
    });
    const locked = !active() || !!r.result || timedMode && (!storageWriter || !storageHealthy || session()?.status !== 'running' || Date.now() >= session().deadline);
    document.querySelectorAll('#choices input').forEach(input => { input.disabled = locked; });
    $('integer-answer').disabled = locked; $('proof-draft').disabled = locked;
    const marked = !!state.bookmarks[M.bookmarkKey(mode, p.id)];
    $('bookmark').setAttribute('aria-pressed', String(marked)); $('bookmark').textContent = marked ? '★ 已收藏' : '☆ 收藏';
  }
  function showFeedback() {
    renderScore();
    const r = response(), p = current();
    if (!canReview()) { notice('feedback', ''); return; }
    let text = '', kind = '';
    if (r.result) { text = r.result === 'correct' ? '回答正确。' : '答案不匹配，已加入错题本。'; kind = r.result; }
    const item = currentReport()?.items.find(item => item.id === p.id);
    if (timedMode && item) { kind = ['correct','incorrect'].includes(item.status) ? item.status : ''; text = ({correct:'回答正确。',incorrect:'答案不匹配。',blank:'未作答。',invalid:'作答格式无效。',ungraded:'本题不可自动判分。'}[item.status] || '') + (item.points === null ? '' : ` 本题 ${item.points} 分。`); }
    else if (r.result && item?.points !== null && item) text += ` 本题 ${item.points} 分。`;
    if (r.revealed || r.result || timedMode && reviewed.has(reviewKey())) {
      if (p.answer) text += ` 参考答案：${p.answer.display ?? p.answer.value ?? p.answer.accepted?.join(' / ')}`;
      if (!r.result) text += timedMode ? '（限时记录只读，不计入普通练习统计。）' : '（查看参考内容后，不计入本题正确率。）';
    }
    notice('feedback', text.trim(), kind);
  }
  function sourceInfo(p) {
    const body = $('source-body'); body.replaceChildren();
    body.append(node('p', `题目 ID：${p.id}`));
    const list = node('ul');
    const links = [{dataset: '原题来源', url: p.source_url}, ...(p.provenance || [])];
    const seen = new Set();
    for (const source of links) {
      const url = safeURL(source.url); if (!url || seen.has(url)) continue; seen.add(url);
      const a = node('a', source.dataset || '来源'); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; const li = node('li'); li.append(a); list.append(li);
    }
    body.append(list);
    if (p.quality.flags?.length) body.append(node('p', p.quality.flags.map(f => flags[f] || '来源质量提示').join('；')));
    body.append(node('p', '题面与解答来自不同公开来源，不代表 MAA 或 AoPS 官方认证；格式校验不等于数学正确性核验。'));
  }
  async function renderQuestion() {
    const token = ++renderVersion, p = current();
    $('question-panel').inert = true; $('question-panel').setAttribute('aria-busy', 'true');
    mathQueue = mathQueue.catch(() => {}).then(async () => {
      if (token !== renderVersion || view !== 'practice') return;
      if (window.MathJax?.typesetClear) MathJax.typesetClear([$('question-panel')]);
      const r = response();
      $('question-title').textContent = `第 ${p.number} 题`;
      $('question-kind').textContent = {multiple_choice: '选择题', integer: '整数填空', proof: '证明题'}[p.question_type] || '题目';
      notice('quality-notice', p.question_type !== 'proof' && !M.canGrade(p) ? '本题的答案或题面仍需核对，不自动判分；参考答案不应视为定论。' : '', 'warning');
      content($('statement'), p.statement.html, p.statement.text_latex);
      $('choices').replaceChildren(node('legend', '选择答案', 'sr-only'));
      $('choices').hidden = p.question_type !== 'multiple_choice';
      for (const choice of p.choices || []) {
        const label = node('label', undefined, 'choice');
        const input = node('input'); input.type = 'radio'; input.name = 'answer'; input.value = choice.label; input.checked = r.value === choice.label;
        input.addEventListener('change', () => { if (input.checked) draft(input.value); });
        const text = node('span', undefined, 'choice-content');
        if (!p.statement.html_includes_choices) content(text, choice.html, choice.text_latex);
        label.append(input, node('span', choice.label, 'choice-letter'), text); $('choices').append(label);
      }
      $('integer-area').hidden = p.question_type !== 'integer'; $('integer-answer').value = r.value || '';
      $('proof-area').hidden = p.question_type !== 'proof'; $('proof-draft').value = r.value || '';
      $('draft-status').textContent = r.value ? storageAvailable ? '草稿已保存在此浏览器' : '草稿仅在当前页面，尚未保存' : '';
      $('solution-details').open = false; $('solution-count').textContent = `(${p.solutions.length}${p.reference_links?.length ? ` + ${p.reference_links.length} 外部链接` : ''})`; $('solution-warning').hidden = !p.solutions.length && !p.reference_links?.length; $('solution-body').replaceChildren();
      $('source-details').open = false; sourceInfo(p); showFeedback(); navigation(); controls(); setURL();
      const ok = await window.contestMathReady;
      if (token !== renderVersion || view !== 'practice') return;
      if (ok) { await MathJax.typesetPromise([$('statement'), $('choices')]); fitMath($('question-panel')); }
      if (token !== renderVersion) return;
      $('question-panel').inert = false; $('question-panel').setAttribute('aria-busy', 'false');
    }).catch(error => { if (token === renderVersion) { $('question-panel').inert = false; $('question-panel').setAttribute('aria-busy', 'false'); notice('math-notice', '部分公式无法渲染，请核对 LaTeX 原文。', 'warning'); } console.warn('Contest rendering:', error.message); });
    await mathQueue;
  }
  function move(next) {
    if (!exam || next < 0 || next >= exam.problems.length || !allowedNumber(exam.problems[next].number)) return;
    captureDraft();
    index = next;
    const rendering = renderQuestion(), token = renderVersion;
    rendering.then(() => { if (token === renderVersion && view === 'practice') $('question-title').focus({preventScroll: true}); });
  }
  function draft(value) {
    if (!exam || !active() || response().result || $('question-panel').inert) return;
    if (timedMode) {
      if (!attempt || !storageWriter || !storageHealthy || !T.write(attempt, day, current(), value, Date.now())) { tick(); controls(); return; }
    } else M.updateResponse(state, mode, exam, current(), {value});
    $('draft-status').textContent = save() ? '草稿已保存在此浏览器' : '草稿仅在当前页面，尚未保存'; navigation();
  }
  function reveal() {
    tick();
    if (!exam || !canReview()) return;
    if (timedMode) reviewed.add(reviewKey());
    else { M.updateResponse(state, mode, exam, current(), {revealed: true}); save(); }
    controls(); showFeedback();
  }
  function check() {
    tick();
    if (!exam || !active() || timedMode || !canReview()) return;
    const p = current();
    const value = p.question_type === 'integer' ? $('integer-answer').value : $('choices').querySelector('input:checked')?.value;
    const result = M.submit(state, mode, exam, p, value);
    if (result.message) { notice('feedback', result.message, 'warning'); return; }
    save(); controls(); showFeedback(); navigation(); stats();
  }
  function savedRow(title, detail, action, actionLabel = '继续练习') {
    const row = node('div', undefined, 'saved-row'), text = node('div');
    text.append(node('h3', title), node('p', detail)); row.append(text); if (action) row.append(button(actionLabel, action)); return row;
  }
  function renderSaved() {
    $('saved-title').textContent = {wrong: '错题本', bookmarks: '收藏', history: '练习记录'}[view];
    $('clear-history').hidden = view !== 'history';
    const rows = [], byId = new Map(catalog.map(e => [e.id, e]));
    if (view === 'bookmarks') {
      for (const mark of Object.values(state.bookmarks).filter(m => m.mode === mode)) {
        const item = byId.get(mark.examId);
        if (!item) continue;
        const number = mark.number || Number(mark.id.split('-').at(-1));
        rows.push(savedRow(`${M.examTitle(item)} · 第 ${number} 题`, '已收藏', () => openExam(item.id, number).catch(fail), '打开'));
      }
    } else {
      for (const record of Object.values(state.sessions).filter(r => r.mode === mode).sort((a, b) => b.updatedAt - a.updatedAt)) {
        const item = byId.get(record.examId), isCurrent = item?.revision === record.revision;
        if (view === 'wrong') {
          if (!isCurrent) continue;
          for (const r of Object.values(record.responses).filter(r => r.result === 'incorrect')) rows.push(savedRow(`${M.examTitle(item)} · 第 ${r.number} 题`, '首次检查答案不匹配', () => openExam(item.id, r.number).catch(fail), '复盘'));
        } else {
          const responses = Object.values(record.responses), checked = responses.filter(r => r.result), right = checked.filter(r => r.result === 'correct').length;
          const drafts = responses.filter(r => !r.result && r.value.trim()).length;
          const date = record.updatedAt ? new Date(record.updatedAt).toLocaleString('zh-CN', {month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'}) : '';
          rows.push(savedRow(record.title, `${date} · 已答 ${checked.length} · 正确 ${right}${drafts ? ` · 草稿 ${drafts}` : ''}${!isCurrent ? ' · 旧版本，不计入当前统计' : ''}`, item ? () => openExam(item.id, isCurrent ? responses.at(-1)?.number : undefined).catch(fail) : null, isCurrent ? '继续' : '打开新版'));
        }
      }
    }
    if (view === 'history') {
      for (const a of timed.attempts.filter(a => a.mode === mode).slice().reverse()) {
        const item = byId.get(a.examId), isCurrent = item?.revision === a.revision;
        const detail = a.sessions.map(s => `${s.label} · ${s.minutes} 分钟 · ${{ready:'待开始',running:'计时中',expired:'时间到',finished:'已结束',unavailable:'未收录'}[s.status]}`).join(' / ');
        const row = savedRow(`${a.title} · 限时记录`, `${new Date(a.createdAt).toLocaleString('zh-CN')} · ${detail}${isCurrent ? '' : ' · 旧版本归档'}`, isCurrent ? async () => {
          await openExam(a.examId);
          attempt = a; timedMode = true; newAttempt = false;
          day = Math.max(0, a.sessions.findIndex(s => ['ready','running'].includes(s.status)));
          restrictIndex(); renderTimer(); renderQuestion();
        } : null, unfinished(a) ? '继续计时' : '查看归档');
        row.dataset.attempt = a.id;
        if (!isCurrent) {
          const archive = node('details'), summary = node('summary', '已保存作答'); archive.append(summary);
          for (const r of Object.values(a.responses)) archive.append(node('pre', `第 ${r.number} 题\n${r.value}`));
          row.append(archive);
        }
        rows.push(row);
      }
    }
    $('saved-list').replaceChildren(...(rows.length ? rows : [empty('暂无记录', view === 'wrong' ? '检查答案后，答错的题目会出现在这里。' : view === 'bookmarks' ? '在答题页面点击收藏，即可在这里找到题目。' : '作答和证明草稿会保存在当前浏览器。')]));
  }
  $('untimed-mode').onclick = () => choosePractice(false);
  $('timed-mode').onclick = () => choosePractice(true);
  $('timer-start').onclick = beginTimed;
  $('timer-finish').onclick = finishTimed;
  $('new-attempt').onclick = () => {
    tick();
    if (!exam || examAttempts().some(unfinished)) return;
    captureDraft(); attempt = null; newAttempt = true; timedMode = true; day = 0;
    restrictIndex(); renderTimer(); renderQuestion();
  };
  $('timed-attempt').onchange = () => {
    captureDraft(); tick();
    attempt = examAttempts().find(a => a.id === $('timed-attempt').value) || null;
    newAttempt = !attempt; timedMode = true;
    day = Math.max(0, attempt?.sessions.findIndex(s => ['ready','running'].includes(s.status)) ?? 0);
    restrictIndex(); renderTimer(); renderQuestion();
  };
  const clock = setInterval(tick, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  window.addEventListener('pageshow', tick);
  window.addEventListener('pagehide', () => { captureDraft(); });
  document.addEventListener('platform:session-ended', () => {
    clearInterval(clock); ++requestVersion; ++catalogVersion; ++renderVersion;
    storageWriter = false; releaseWriter?.();
    $('main-content').inert = true;
    notice('storage-notice', '账号会话已结束，请重新登录。', 'warning');
  });
  document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => { captureDraft(); switchView(b.dataset.view); }));
  $('private-mode').onclick = () => changeMode('private'); $('example-mode').onclick = () => changeMode('example');
  $('search').addEventListener('input', renderLibrary); $('year').onchange = renderLibrary; $('supplemental').onchange = renderLibrary;
  $('back-library').onclick = () => { updateYears(); renderCards(); switchView('library'); };
  $('previous').onclick = () => move(index - 1); $('next').onclick = () => move(index + 1);
  $('integer-answer').addEventListener('input', event => draft(event.target.value));
  $('proof-draft').addEventListener('input', event => draft(event.target.value));
  $('check-answer').onclick = check; $('reveal-answer').onclick = reveal;
  $('bookmark').onclick = () => { const p = current(), key = M.bookmarkKey(mode, p.id); if (state.bookmarks[key]) delete state.bookmarks[key]; else state.bookmarks[key] = {mode, id: p.id, examId: exam.id, number: p.number}; save(); controls(); };
  $('solution-details').addEventListener('toggle', () => {
    tick();
    if (!canReview()) { $('solution-details').open = false; return; }
    if (!$('solution-details').open || !exam || $('solution-body').childElementCount) return;
    const p = current(), token = renderVersion;
    const links = (p.reference_links || []).filter(link => safeURL(link.url));
    if (!p.solutions.length && !links.length) { $('solution-body').append(node('p', '暂未收录参考解答。')); return; }
    reveal();
    mathQueue = mathQueue.catch(() => {}).then(async () => {
      if (token !== renderVersion || !$('solution-details').open || !canReview()) return;
      for (const solution of p.solutions) {
        const entry = node('section', undefined, 'solution-entry'); entry.append(node('h4', solution.title || '参考解答'));
        if (solution.quality_flags?.length) entry.append(node('div', solution.quality_flags.map(f => flags[f] || '来源质量提示').join('；'), 'notice warning'));
        const body = node('div'); content(body, solution.html, solution.text_latex); entry.append(body);
        const url = safeURL(solution.source_url || solution.url || solution.source?.url);
        if (url) { const a = node('a', '解答来源'); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; entry.append(a); }
        $('solution-body').append(entry);
      }
      if (links.length) {
        const section = node('section', undefined, 'external-solutions'); section.append(node('h4', '外部参考解答（未审核）'));
        section.append(node('p', '链接需联网打开，不是本机已收录解答；来源内容可能变化。'));
        for (const link of links) { const a = node('a', link.title || '查看外部参考解答'); a.href = safeURL(link.url); a.target = '_blank'; a.rel = 'noopener noreferrer'; section.append(a); }
        $('solution-body').append(section);
      }
      if (await window.contestMathReady && token === renderVersion) { await MathJax.typesetPromise([$('solution-body')]); fitMath($('solution-body')); }
    }).catch(() => notice('math-notice', '部分解答公式无法渲染，请核对原文。', 'warning'));
  });
  $('clear-history').onclick = () => {
    if (!active() || !confirm(`清除${mode === 'example' ? '原创示例' : '竞赛题库'}的普通练习作答和证明草稿？限时记录、收藏和另一模式的记录保留。`)) return;
    for (const [key, record] of Object.entries(state.sessions)) if (record.mode === mode) delete state.sessions[key];
    save(); stats(); renderSaved();
  };
  // Initial requests are guarded against stale responses after mode/exam changes.
  renderCards();
  const initialNavigation = requestVersion;
  initializeStorage().then(() => initialNavigation === requestVersion
    ? loadCatalog(params.get('exam'), params.get('q'), params.get('view'))
    : loadCatalog()).catch(fail);
})();
