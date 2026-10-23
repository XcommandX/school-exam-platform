/* Native AP practice UI. Content is inserted with textContent, never as markup. */
(function () {
  'use strict';
  const M = window.APModel;
  const content = document.getElementById('ap-content');
  const notice = document.getElementById('ap-notice');
  const storageNotice = document.getElementById('ap-storage-notice');
  const nav = document.getElementById('ap-nav');
  const dialog = document.getElementById('ap-dialog');
  const labels = { mcq: '选择题', frq: '写作', reference: '参考资料' };
  const responseLabels = { synthesis: 'Synthesis', 'rhetorical-analysis': 'Rhetorical Analysis', argument: 'Argument', essay: 'Essay' };
  const resultLabels = { correct: '正确', incorrect: '错误', unanswered: '未作答', ungraded: '未自动评分' };
  const state = { view: 'catalog', catalog: [], catalogLoaded: false, catalogErrors: 0,
    filters: { search: '', year: '', kind: '', contentMode: '' }, source: null, draft: null,
    request: 0, lastTick: 0, lastAutosave: 0, expiryNotified: false, storageFailed: false, unsavedWork: false, saveTimer: null };

  function element(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
      else if (['disabled', 'checked', 'hidden', 'readOnly'].includes(key)) node[key] = Boolean(value);
      else if (value !== undefined && value !== null) node.setAttribute(key, String(value));
    }
    for (const child of children.flat()) {
      if (child === undefined || child === null) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }
  const button = (label, action, style = '', attrs = {}) => element('button', Object.assign({ type: 'button', class: 'ap-button ' + style, onclick: action }, attrs), label);
  const panel = (...children) => element('section', { class: 'ap-panel' }, ...children);
  const meta = (...children) => element('div', { class: 'ap-meta' }, ...children.map(value => typeof value === 'string' ? element('span', {}, value) : value));
  const actions = (...children) => element('div', { class: 'ap-actions' }, ...children);
  const badge = mode => element('span', { class: 'ap-badge' + (mode === 'synthetic' ? ' ap-badge--synthetic' : '') }, mode === 'synthetic' ? '原创示例 · 不计入真实题库' : '本机私有题库');
  const muted = message => element('p', { class: 'ap-muted' }, message);
  const prose = (message, lang = 'en') => element('p', { class: 'ap-text', lang }, message);
  const formatDate = value => new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  const sourceName = source => [source.year, source.form].filter(Boolean).join(' · ');
  function announce(message, warning = false) {
    notice.textContent = message;
    notice.className = 'ap-notice' + (warning ? ' ap-notice--warning' : '');
    notice.hidden = !message;
  }
  let local;
  try { local = window.localStorage; } catch (_) { local = null; }
  const store = M.createStorage(local, issue => {
    state.storageFailed = issue.reason !== 'corrupt' || state.storageFailed;
    storageNotice.hidden = false;
    storageNotice.textContent = issue.reason === 'corrupt'
      ? '部分 AP 本机记录损坏，已跳过无效记录。其他考试记录不会被读取或修改。'
      : '浏览器未能保存 AP 记录。当前作答仍在本页内存中；请下载作答备份，勿直接关闭页面。';
  });
  function heading(title, ...right) {
    return element('div', { class: 'ap-section-heading' }, element('h2', {}, title), ...right);
  }
  function empty(title, message, ...controls) {
    return element('section', { class: 'ap-panel ap-empty' }, element('h2', {}, title), message ? element('p', {}, message) : null, controls.length ? actions(...controls) : null);
  }
  function replace(...children) {
    content.replaceChildren(...children);
    content.setAttribute('aria-busy', 'false');
  }
  function focusHeading() {
    const target = content.querySelector('h2') || document.getElementById('ap-main');
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
  }
  function setView(view) {
    if (state.view === 'practice' && view !== 'practice') {
      tick();
      saveDraft();
      state.lastTick = 0;
      state.draft = null;
    }
    state.view = view;
    state.request++;
    for (const item of nav.querySelectorAll('[data-view]')) {
      if (item.dataset.view === view) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    }
    announce('');
  }
  function back(label = '题库', action = () => showCatalog()) {
    return button('← ' + label, action, 'ap-back');
  }
  function loading(message) {
    replace(empty(message, ''));
    content.setAttribute('aria-busy', 'true');
  }
  async function getJSON(path) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(response.status === 404 ? '未找到这份题集。它可能已从本机题库移除。' : '题库服务暂不可用（' + response.status + '）。请确认本机服务仍在运行。');
      return await response.json();
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('载入超时。请检查本机服务后重试。');
      if (error instanceof SyntaxError) throw new Error('题库服务返回的内容格式不可用。');
      if (error instanceof TypeError) throw new Error('无法连接题库服务。请检查本机服务后重试。');
      throw error;
    } finally { clearTimeout(timeout); }
  }
  async function showCatalog(reload = false) {
    setView('catalog');
    if (reload || !state.catalogLoaded) {
      loading('正在载入题库…');
      const request = state.request;
      try {
        const catalog = M.validateCatalog(await getJSON('/api/exams/ap/sources'));
        if (request !== state.request) return;
        state.catalog = catalog.sources;
        state.catalogErrors = catalog.errorCount;
        state.catalogLoaded = true;
      } catch (error) {
        if (request !== state.request) return;
        replace(empty('题库暂不可用', error.message, button('重试', () => showCatalog(true), 'ap-button--primary'), button('打开原创示例', () => openSource(null, 'synthetic'))));
        return;
      }
    }
    renderCatalog();
  }
  function selectField(label, key, options) {
    const select = element('select', { 'aria-label': label, onchange: event => { state.filters[key] = event.target.value; renderCatalogResults(); } },
      ...options.map(([value, labelText]) => element('option', { value }, labelText)));
    select.value = state.filters[key];
    return element('label', { class: 'ap-field' }, label, select);
  }
  function renderCatalog() {
    const years = [...new Set(state.catalog.map(source => source.year).filter(year => year !== null))].sort((a, b) => b - a);
    if (state.filters.year && !years.includes(Number(state.filters.year))) state.filters.year = '';
    const search = element('input', { type: 'search', value: state.filters.search, placeholder: '搜索题集', maxlength: 200, oninput: event => { state.filters.search = event.target.value; renderCatalogResults(); } });
    const filters = element('section', { class: 'ap-panel ap-filters', 'aria-label': '筛选题库' },
      element('label', { class: 'ap-field' }, '搜索', search),
      selectField('年份', 'year', [['', '全部年份'], ...years.map(year => [year, year])]),
      selectField('类型', 'kind', [['', '全部类型'], ...Object.entries(labels)]),
      selectField('来源', 'contentMode', [['', '全部来源'], ['private', '本机私有题库'], ['synthetic', '原创示例']]));
    replace(heading('题库', actions(button('刷新', () => showCatalog(true)), button('打开原创示例', () => openSource(null, 'synthetic')))),
      state.catalogErrors ? element('div', { class: 'ap-notice ap-notice--warning', role: 'status' }, state.catalogErrors + ' 份题库记录暂不可用；其余题集仍可使用。') : document.createDocumentFragment(),
      filters, element('div', { id: 'ap-catalog-results', 'aria-live': 'polite' }));
    renderCatalogResults();
  }
  function renderCatalogResults() {
    const container = document.getElementById('ap-catalog-results');
    if (!container) return;
    const sources = M.filterSources(state.catalog, state.filters);
    const real = state.catalog.filter(source => source.contentMode === 'private');
    const count = element('p', { class: 'ap-count' }, real.length + ' 份私有题集 · ' + real.reduce((sum, source) => sum + source.questionCount, 0) + ' 道已结构化题目 · ' + real.reduce((sum, source) => sum + source.documentCount, 0) + ' 份 PDF');
    if (!state.catalog.length) {
      container.replaceChildren(count, empty('本机题库为空', '尚未载入私有 AP 资料。可打开原创示例测试选择题与写作流程；示例不计入真实题库或首页练习统计。', button('打开原创示例', () => openSource(null, 'synthetic'), 'ap-button--primary')));
      return;
    }
    if (!sources.length) {
      container.replaceChildren(count, empty('没有匹配的题集', '试试其他年份、类型或关键词。', button('清除筛选', () => { state.filters = { search: '', year: '', kind: '', contentMode: '' }; renderCatalog(); })));
      return;
    }
    const grid = element('div', { class: 'ap-grid' }, ...sources.map(source => element('article', { class: 'ap-panel ap-source' },
      meta(badge(source.contentMode), sourceName(source)), element('h3', {}, source.title),
      meta(labels[source.kind], source.questionCount ? source.questionCount + ' 道已结构化题目' : '文档阅读', source.documentCount + ' 份 PDF', source.reviewCount ? source.reviewCount + ' 道待核对' : ''),
      actions(button(source.questionCount ? '打开题集' : '阅读文档', () => openSource(source.id, source.contentMode), 'ap-button--primary')))));
    container.replaceChildren(count, grid);
  }
  async function openSource(id, mode = 'private', context = null) {
    setView('source');
    loading('正在载入题集…');
    const request = state.request;
    try {
      const source = M.validateSource(await getJSON(mode === 'synthetic' ? '/api/ap/example' : '/api/exams/ap/sources/' + encodeURIComponent(id)));
      if (request !== state.request) return;
      if (source.contentMode !== mode || (id && source.id !== id)) throw new Error('题集来源不匹配，未载入作答。');
      state.source = source;
      if (context && !M.sourceIdentity(source, context.record)) {
        renderUnavailableRecord(context, '题集已更新，旧记录仍保留原版本。为避免把旧答案套用到新题目，不能直接继续或重新判分。', source);
      } else if (context && context.type === 'draft') {
        const restored = M.restoreDraft(source, context.record);
        if (!restored) renderUnavailableRecord(context, '草稿包含不可用的答案或题号，未将它套用到当前题集。', source);
        else enterPractice(source, restored);
      } else if (context && context.type === 'history') {
        const valid = M.restoreDraft(source, Object.assign({}, context.record, { status: 'in-progress' }));
        const counts = valid ? M.totals(source, valid.answers) : null;
        if (!valid || ['questionCount', 'answeredCount', 'correctCount', 'gradedCount'].some(key => counts[key] !== context.record[key])) {
          renderUnavailableRecord(context, '保存的答案或统计与当前题集不匹配，未重新判分。你仍可下载旧作答。', source);
        } else renderReview(source, context.record);
      } else if (context && context.type === 'wrong') renderWrongQuestion(source, context.record);
      else renderSource(source);
    } catch (error) {
      if (request !== state.request) return;
      if (context) renderUnavailableRecord(context, error.message);
      else replace(back(), empty('题集暂不可用', error.message, button('重试', () => openSource(id, mode), 'ap-button--primary'), button('返回题库', () => showCatalog())));
    }
    focusHeading();
  }
  function pdfLink(doc, page = 1, label = '打开 PDF') {
    const href = M.pdfHref(doc, page);
    return href ? element('a', { class: 'ap-button', href, target: '_blank', rel: 'noopener noreferrer', 'aria-label': doc.label + '，第 ' + page + ' 页，在新标签页打开' }, label + ' ↗') : muted('PDF 链接不可用');
  }
  function documentList(source, review = false) {
    const docs = source.documents.filter(doc => review || !['scoring', 'sample'].includes(doc.role));
    docs.sort((a, b) => (['scoring', 'sample'].includes(a.role) ? 1 : 0) - (['scoring', 'sample'].includes(b.role) ? 1 : 0));
    if (!docs.length) return null;
    const roles = { questions: '题目原卷', scoring: '评分资料', sample: '作答示例', reference: '参考资料' };
    return element('ul', { class: 'ap-document-list' }, ...docs.map(doc => element('li', {},
      element('span', { class: 'ap-document-label' }, doc.label, element('small', {}, roles[doc.role] + ' · ' + doc.pageCount + ' 页')),
      pdfLink(doc))));
  }
  function questionDocuments(source, q, review = false) {
    const controls = [];
    const doc = source.documents.find(item => item.id === q.sourceDocument);
    if (doc) for (const page of q.pages.length ? q.pages : [1]) controls.push(pdfLink(doc, page, '题目原卷 · 第 ' + page + ' 页'));
    if (review) {
      const answer = source.documents.find(item => item.id === q.answerDocument);
      if (answer) controls.push(pdfLink(answer, q.answerPage || 1, '评分参考'));
    }
    return controls.length ? actions(...controls) : null;
  }
  function warnings(source) {
    if (!source.importWarnings.length) return null;
    return element('details', { class: 'ap-warnings' }, element('summary', {}, '导入提示（' + source.importWarnings.length + '）'),
      element('ul', {}, ...source.importWarnings.map(warning => element('li', {}, warning))));
  }
  function renderSource(source) {
    const drafts = store.read('drafts').filter(draft => M.sourceIdentity(source, draft));
    const count = source.questions.length;
    const unverified = source.questions.filter(q => q.reviewStatus !== 'verified').length;
    const docOnly = !count;
    const body = panel(heading(source.title, badge(source.contentMode)), meta(sourceName(source), labels[source.kind], count ? count + ' 道已结构化题目' : '文档阅读', source.documents.length + ' 份 PDF'),
      source.contentMode === 'synthetic' ? element('p', { class: 'ap-notice ap-notice--warning' }, '这是原创流程示例，不是 AP 真题，不计入首页真实练习统计。') : null,
      documentList(source), warnings(source),
      unverified ? muted(unverified + ' 道题尚待核对。未核实答案的选择题只保存作答，不自动判分；请以 PDF 原卷为准。') : null,
      docOnly ? muted('这份资料尚未拆分为可作答题目。可阅读原 PDF；不会虚构题量或生成答题成绩。') : muted('写作仅保存草稿与提交稿，不自动评分，也不换算 AP 1–5 分。记录仅保存在当前浏览器。'),
      actions(...(docOnly ? [] : [button('开始练习', () => startNew(source), 'ap-button--primary')]),
        ...(drafts.length ? [button('继续草稿', () => enterPractice(source, M.restoreDraft(source, drafts[0])))] : []),
        ...(docOnly && source.documents.some(doc => ['scoring', 'sample'].includes(doc.role)) ? [button('进入资料复盘', () => renderDocumentReview(source))] : [])));
    replace(back(), body);
  }
  function renderDocumentReview(source) {
    setView('document-review');
    replace(back('题集', () => renderSourceView(source)), panel(heading('资料复盘', badge(source.contentMode)), element('h3', {}, source.title), documentList(source, true), muted('文档阅读不会生成题目作答数量或成绩。')));
  }
  function renderSourceView(source) { setView('source'); renderSource(source); focusHeading(); }
  function newId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return 'ap-attempt:' + window.crypto.randomUUID();
    return 'ap-attempt:' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  }
  function startNew(source) {
    if (!source.questions.length) return;
    enterPractice(source, M.createDraft(source, Date.now(), newId()));
  }
  function enterPractice(source, draft) {
    if (!draft) { announce('草稿无法继续。可保留旧记录并开始新的练习。', true); return; }
    setView('practice');
    state.source = source;
    state.draft = draft;
    state.lastTick = Date.now();
    state.expiryNotified = false;
    saveDraft();
    renderPractice();
    focusHeading();
  }
  function updateSaveState(ok, pending = false) {
    const target = document.getElementById('ap-save-state');
    if (target) target.textContent = pending ? '待保存' : ok ? '草稿已保存' : '尚未写入浏览器';
  }
  function saveDraft() {
    clearTimeout(state.saveTimer);
    state.saveTimer = null;
    if (!state.draft || state.draft.status !== 'in-progress') return true;
    state.draft.updated = Math.max(state.draft.started, Date.now());
    state.lastAutosave = Date.now();
    const previous = store.read('drafts').filter(draft => draft.id !== state.draft.id);
    const ok = store.write('drafts', [state.draft, ...previous]);
    if (!ok) state.unsavedWork = true;
    updateSaveState(ok);
    return ok;
  }
  function scheduleSave() {
    clearTimeout(state.saveTimer);
    updateSaveState(false, true);
    state.saveTimer = setTimeout(saveDraft, 450);
  }
  function tick() {
    if (state.view !== 'practice' || !state.draft || !state.lastTick) return;
    const now = Date.now();
    const seconds = Math.floor((now - state.lastTick) / 1000);
    if (seconds > 0) {
      state.draft.elapsedSeconds = Math.min(31536000, state.draft.elapsedSeconds + seconds);
      state.lastTick += seconds * 1000;
    }
    updateTimer();
  }
  function updateTimer() {
    const timer = document.getElementById('ap-timer');
    if (!state.draft || !timer) return;
    timer.hidden = !state.draft.timerEnabled;
    const duration = state.source.defaultDurationSeconds;
    const remaining = Math.max(0, duration - state.draft.elapsedSeconds);
    timer.textContent = duration ? '剩余 ' + M.formatTime(remaining) : '已用 ' + M.formatTime(state.draft.elapsedSeconds);
    if (state.draft.timerEnabled && duration && remaining === 0 && !state.expiryNotified) {
      state.expiryNotified = true;
      saveDraft();
      announce('计时结束。作答已保留，不会自动提交；你可以继续修改或提交复盘。', true);
    }
  }
  setInterval(() => { tick(); if (!document.hidden && state.view === 'practice' && state.draft && Date.now() - state.lastAutosave >= 15000) saveDraft(); }, 1000);
  function setAnswer(q, value) {
    state.draft.answers[q.id] = value;
    const count = document.getElementById('ap-word-count');
    if (q.type === 'free-response' && count) count.textContent = M.countWords(value) + ' words';
    const navButton = document.getElementById('ap-qnav-' + state.draft.cursor);
    if (navButton) {
      navButton.dataset.answered = String(M.answered(q, value));
      navButton.setAttribute('aria-label', '第 ' + q.number + ' 题' + (M.answered(q, value) ? '，已作答' : '，未作答'));
    }
    scheduleSave();
  }
  function goQuestion(index) {
    tick();
    saveDraft();
    state.draft.cursor = index;
    saveDraft();
    renderPractice();
    focusHeading();
  }
  function renderPractice() {
    const source = state.source;
    const draft = state.draft;
    const q = source.questions[draft.cursor];
    const timerCheck = element('input', { type: 'checkbox', checked: draft.timerEnabled, onchange: event => { tick(); draft.timerEnabled = event.target.checked; saveDraft(); updateTimer(); } });
    const timer = element('span', { id: 'ap-timer', class: 'ap-timer', role: 'timer', 'aria-live': 'off', hidden: !draft.timerEnabled });
    const toolbar = element('div', { class: 'ap-practice-toolbar' },
      meta(element('label', { class: 'ap-check' }, timerCheck, '计时'), timer, element('span', { id: 'ap-save-state', class: 'ap-save-state', role: 'status' }, state.storageFailed ? '请保留作答备份' : '草稿已保存')),
      actions(button('下载作答', () => downloadAnswers(draft, source)), button('保存并退出', () => { tick(); saveDraft(); showDrafts(); }), button('提交复盘', confirmSubmit, 'ap-button--primary')));
    const qnav = element('nav', { class: 'ap-question-nav', 'aria-label': '题目导航' }, ...source.questions.map((question, index) =>
      element('button', { type: 'button', id: 'ap-qnav-' + index, 'aria-label': '第 ' + question.number + ' 题' + (M.answered(question, draft.answers[question.id]) ? '，已作答' : '，未作答'), 'aria-current': index === draft.cursor ? 'step' : null, 'data-answered': M.answered(question, draft.answers[question.id]), onclick: () => goQuestion(index) }, question.number)));
    const answer = q.type === 'mcq' ? renderOptions(q, draft.answers[q.id]) : renderEditor(q, draft.answers[q.id]);
    const question = element('section', { class: 'ap-panel ap-question' }, heading('第 ' + q.number + ' 题', element('span', { class: 'ap-badge ap-badge--neutral' }, q.type === 'mcq' ? '选择题' : responseLabels[q.responseType])),
      q.reviewStatus !== 'verified' ? element('div', { class: 'ap-notice ap-notice--warning' }, '题目尚待核对，请对照原卷；本题不自动评分。') : null,
      element('p', { class: 'ap-prompt', lang: 'en' }, q.prompt), questionDocuments(source, q), answer,
      element('div', { class: 'ap-pagination' }, button('上一题', () => goQuestion(draft.cursor - 1), '', { disabled: draft.cursor === 0 }), button(draft.cursor === source.questions.length - 1 ? '提交复盘' : '下一题', draft.cursor === source.questions.length - 1 ? confirmSubmit : () => goQuestion(draft.cursor + 1), draft.cursor === source.questions.length - 1 ? 'ap-button--primary' : '')));
    const workspace = element('div', { class: 'ap-workspace' + (!q.passage ? ' ap-workspace--single' : '') },
      q.passage ? element('section', { class: 'ap-panel ap-reading', tabindex: '0', 'aria-label': '阅读材料' }, element('h3', {}, '阅读材料'), prose(q.passage)) : null,
      question);
    replace(heading(source.title, badge(source.contentMode)), toolbar, qnav, workspace);
    updateTimer();
  }
  function renderOptions(q, selected) {
    const fieldset = element('fieldset', { class: 'ap-options' }, element('legend', {}, '选择一个答案'));
    q.options.forEach((option, index) => fieldset.append(element('label', { class: 'ap-option' },
      element('input', { type: 'radio', name: 'ap-answer', value: index, checked: selected === index, onchange: () => setAnswer(q, index) }),
      element('span', { class: 'ap-option-letter' }, String.fromCharCode(65 + index) + '.'), element('span', { class: 'ap-option-copy', lang: 'en' }, option))));
    fieldset.append(button('清除选择', () => {
      delete state.draft.answers[q.id];
      saveDraft();
      renderPractice();
    }));
    return fieldset;
  }
  function renderEditor(q, selected) {
    const value = typeof selected === 'string' ? selected : '';
    const textarea = element('textarea', { id: 'ap-essay', lang: 'en', spellcheck: 'true', maxlength: M.MAX_TEXT, 'aria-describedby': 'ap-word-count ap-essay-note', oninput: event => setAnswer(q, event.target.value) });
    textarea.value = value;
    return element('div', {}, element('label', { class: 'ap-field', for: 'ap-essay' }, '你的作答', textarea),
      element('div', { class: 'ap-word-row' }, element('span', { id: 'ap-word-count', 'aria-live': 'off' }, M.countWords(value) + ' words'), element('span', { id: 'ap-essay-note' }, '自动保存草稿 · 不自动评分')));
  }
  function openDialog(title, message, confirmLabel, onConfirm, danger = false) {
    const opener = document.activeElement;
    document.getElementById('ap-dialog-title').textContent = title;
    document.getElementById('ap-dialog-content').replaceChildren(element('p', {}, message));
    document.getElementById('ap-dialog-actions').replaceChildren(button('取消', () => dialog.close()), button(confirmLabel, () => { dialog.close(); onConfirm(); }, danger ? 'ap-button--danger' : 'ap-button--primary'));
    dialog.addEventListener('close', () => { if (opener && opener.isConnected) opener.focus(); }, { once: true });
    dialog.showModal();
  }
  function confirmSubmit() {
    tick();
    saveDraft();
    const counts = M.totals(state.source, state.draft.answers);
    openDialog('提交练习', '已作答 ' + counts.answeredCount + ' / ' + counts.questionCount + ' 题。提交后可查看原卷、已核实的选择题答案和评分资料；作文不自动评分。', '提交复盘', complete);
  }
  function complete() {
    tick();
    const source = state.source;
    const record = M.finish(source, state.draft, Date.now());
    const history = store.read('history').filter(item => item.id !== record.id);
    const saved = store.write('history', [record, ...history]);
    if (!saved) state.unsavedWork = true;
    store.write('wrong', M.updateWrongBook(store.read('wrong'), source, record));
    if (saved) store.write('drafts', store.read('drafts').filter(item => item.id !== record.id));
    clearTimeout(state.saveTimer);
    state.draft = null;
    state.lastTick = 0;
    renderReview(source, record);
    if (!saved) announce('练习已在本页完成，但浏览器未能保存记录。旧草稿仍保留；请下载作答备份。', true);
    focusHeading();
  }
  function renderReview(source, record) {
    setView('review');
    const counts = M.totals(source, record.answers);
    const report = panel(heading('练习复盘', badge(record.contentMode)), element('h3', {}, record.title),
      meta(formatDate(record.finished), '用时 ' + M.formatTime(record.elapsedSeconds)),
      actions(button('下载作答', () => downloadAnswers(record, source)), button('重新练习', () => startNew(source))),
      documentList(source, true), muted('仅对已作答且答案已核实的选择题计算正确率。作文与未核实题目不自动评分，不换算 AP 分数。'));
    const stats = element('div', { class: 'ap-stats' }, stat(counts.answeredCount + ' / ' + counts.questionCount, '已作答'), stat(counts.correctCount + ' / ' + counts.gradedCount, '正确 / 已判分'), stat(counts.gradedCount ? Math.round(counts.correctCount / counts.gradedCount * 100) + '%' : '—', '客观题正确率'));
    const outcomes = M.results(source, record.answers);
    replace(back('练习记录', showHistory), report, stats, ...source.questions.map((q, index) => reviewQuestion(source, q, record.answers[q.id], outcomes[index])));
  }
  function stat(value, label) { return element('div', { class: 'ap-stat' }, element('b', {}, value), element('span', {}, label)); }
  function reviewQuestion(source, q, response, outcome, open = false) {
    const detail = element('details', { class: 'ap-panel ap-review' }, element('summary', {}, '第 ' + q.number + ' 题', element('span', { class: 'ap-result-label ap-result-label--' + outcome.status }, resultLabels[outcome.status])));
    detail.open = open;
    if (q.passage) detail.append(prose(q.passage));
    detail.append(prose(q.prompt), questionDocuments(source, q, true) || document.createDocumentFragment());
    if (q.type === 'mcq') {
      const opts = element('div', { class: 'ap-options' });
      const canGrade = q.reviewStatus === 'verified' && q.correctOption !== null;
      q.options.forEach((option, index) => opts.append(element('div', { class: 'ap-option' + (canGrade && index === q.correctOption ? ' ap-option--correct' : outcome.correct === false && index === response ? ' ap-option--incorrect' : '') },
        element('span', { class: 'ap-option-letter' }, String.fromCharCode(65 + index) + '.'),
        element('span', { class: 'ap-option-copy', lang: 'en' }, option, index === response ? '（你的选择）' : '', canGrade && index === q.correctOption ? '（已核实答案）' : ''))));
      detail.append(opts);
      if (!canGrade) detail.append(muted('没有已核实答案，不判定对错。请对照原卷与评分资料自行核对。'));
    } else {
      detail.append(element('div', { class: 'ap-answer' }, element('h4', {}, '你的作答 · ' + M.countWords(response) + ' words'), prose(typeof response === 'string' && response.trim() ? response : '未作答', typeof response === 'string' && response.trim() ? 'en' : 'zh-CN')));
    }
    if (q.explanation) detail.append(element('h4', {}, q.type === 'free-response' ? '自查提示' : '解析'), prose(q.explanation));
    if (q.answerProvenance) detail.append(element('p', { class: 'ap-muted' }, '答案来源：' + q.answerProvenance));
    return detail;
  }
  function showDrafts() {
    setView('drafts');
    const items = store.read('drafts');
    replace(heading('草稿'), items.length ? element('div', { class: 'ap-list' }, ...items.map(record => recordCard(record, 'draft'))) : empty('暂无草稿', '开始练习后，选择题作答与作文草稿会保存在当前浏览器。', button('打开题库', () => showCatalog(), 'ap-button--primary')));
    focusHeading();
  }
  function showHistory() {
    setView('history');
    const items = store.read('history');
    replace(heading('练习记录'), items.length ? element('div', { class: 'ap-list' }, ...items.map(record => recordCard(record, 'history'))) : empty('暂无已完成练习', '', button('打开题库', () => showCatalog(), 'ap-button--primary')));
    focusHeading();
  }
  function recordCard(record, type) {
    const key = type === 'draft' ? 'drafts' : 'history';
    return element('article', { class: 'ap-panel ap-record' }, element('div', {}, element('h3', {}, record.title),
      meta(badge(record.contentMode), formatDate(record.finished || record.updated), type === 'history' ? '已作答 ' + record.answeredCount + ' / ' + record.questionCount : '草稿', type === 'history' ? '正确 ' + record.correctCount + ' / 已判分 ' + record.gradedCount : '用时 ' + M.formatTime(record.elapsedSeconds))),
      actions(button(type === 'draft' ? '继续练习' : '查看复盘', () => openSource(record.sourceId, record.contentMode, { type, record }), 'ap-button--primary'),
        button('下载作答', () => downloadAnswers(record)), button('删除', () => openDialog('删除' + (type === 'draft' ? '草稿' : '记录'), '仅删除当前浏览器中的这份 AP ' + (type === 'draft' ? '草稿。' : '记录；不会清空错题本。'), '删除', () => {
          const ok = store.write(key, store.read(key).filter(item => item.id !== record.id));
          if (state.draft && state.draft.id === record.id) state.draft = null;
          if (type === 'draft') showDrafts(); else showHistory();
          if (!ok) announce('尚未从浏览器持久存储中删除，刷新后可能重新出现。', true);
        }, true), 'ap-button--danger')));
  }
  function renderUnavailableRecord(context, message, source) {
    setView('saved-record');
    const record = context.record;
    const returnAction = context.type === 'draft' ? showDrafts : context.type === 'wrong' ? showWrong : showHistory;
    const savedAnswers = record.answers ? Object.entries(record.answers) : [];
    replace(back(context.type === 'draft' ? '草稿' : context.type === 'wrong' ? '错题本' : '练习记录', returnAction),
      panel(heading(record.title, badge(record.contentMode)), element('p', { class: 'ap-notice ap-notice--warning' }, message),
        meta('原版本 ' + record.revision.slice(0, 12), record.finished || record.updated ? formatDate(record.finished || record.updated) : ''),
        actions(record.answers ? button('下载旧作答', () => downloadAnswers(record)) : null, source && source.questions.length ? button('以当前题集开始新练习', () => startNew(source), 'ap-button--primary') : null)),
      ...savedAnswers.map(([id, response]) => panel(element('h3', {}, '保存的作答 · ' + id.split(':').pop()), prose(typeof response === 'string' ? response : '选项 ' + String.fromCharCode(65 + response), typeof response === 'string' ? 'en' : 'zh-CN'))));
  }
  function showWrong() {
    setView('wrong');
    const items = store.read('wrong');
    replace(heading('错题本', element('span', { class: 'ap-count' }, items.length + ' 道已核实选择题')),
      items.length ? element('div', { class: 'ap-list' }, ...items.map(record => element('article', { class: 'ap-panel ap-record' },
        element('div', {}, element('h3', {}, record.title + ' · 第 ' + record.number + ' 题'), meta(badge(record.contentMode), formatDate(record.updated))),
        actions(button('查看错题', () => openSource(record.sourceId, record.contentMode, { type: 'wrong', record }), 'ap-button--primary'), button('移出错题本', () => {
          const ok = store.write('wrong', store.read('wrong').filter(item => M.wrongKey(item) !== M.wrongKey(record)));
          showWrong();
          if (!ok) announce('尚未从浏览器持久存储中移除，刷新后可能重新出现。', true);
        }))))) : empty('暂无错题', '已提交练习中，有已核实答案的选择题答错后才会进入错题本。'));
    focusHeading();
  }
  function renderWrongQuestion(source, record) {
    setView('wrong-review');
    const q = source.questions.find(question => question.id === record.questionId);
    if (!q || q.type !== 'mcq' || q.reviewStatus !== 'verified' || q.correctOption !== record.correctOption) {
      renderUnavailableRecord({ type: 'wrong', record }, '这道题的答案记录与当前题集不匹配，未重新判分。', source);
      return;
    }
    const outcome = M.results(source, { [q.id]: record.selectedOption }).find(item => item.id === q.id);
    replace(back('错题本', showWrong), panel(heading(record.title, badge(record.contentMode)), actions(button('重新练习题集', () => startNew(source), 'ap-button--primary'))), reviewQuestion(source, q, record.selectedOption, outcome, true));
  }
  function downloadAnswers(record, source) {
    const questions = source ? new Map(source.questions.map(q => [q.id, q])) : new Map();
    const lines = [record.title, 'AP Language and Composition', '来源：' + record.sourceId, '版本：' + record.revision,
      '内容：' + (record.contentMode === 'synthetic' ? '原创示例' : '本机私有题库'), '状态：' + record.status,
      '更新时间：' + new Date(record.finished || record.updated).toISOString(), ''];
    for (const [id, response] of Object.entries(record.answers)) {
      const q = questions.get(id);
      lines.push(q ? '第 ' + q.number + ' 题' : id, typeof response === 'string' ? response : '选项 ' + String.fromCharCode(65 + response), '');
    }
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' }));
    const link = element('a', { href: url, download: 'ap-answers-' + record.started + '.txt' });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  nav.addEventListener('click', event => {
    const target = event.target.closest('[data-view]');
    if (!target) return;
    const screens = { catalog: showCatalog, drafts: showDrafts, wrong: showWrong, history: showHistory };
    screens[target.dataset.view]();
  });
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && state.view === 'practice') {
      event.preventDefault();
      tick();
      saveDraft();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (state.view !== 'practice') return;
    if (document.hidden) { tick(); saveDraft(); state.lastTick = 0; }
    else state.lastTick = Date.now();
  });
  window.addEventListener('pagehide', () => { tick(); saveDraft(); });
  window.addEventListener('beforeunload', event => {
    tick();
    const saved = saveDraft();
    if (!saved || state.unsavedWork) { event.preventDefault(); event.returnValue = ''; }
  });
  window.addEventListener('storage', event => {
    if (!Object.values(M.KEYS).includes(event.key)) return;
    if (state.view === 'practice') announce('另一个标签页修改了 AP 本机记录。请避免在多个标签页编辑同一草稿，并下载当前作答备份。', true);
  });
  const initialView = new URLSearchParams(window.location.search).get('view');
  if (initialView === 'history') showHistory();
  else if (initialView === 'wrong') showWrong();
  else if (initialView === 'drafts') showDrafts();
  else showCatalog();
}());
