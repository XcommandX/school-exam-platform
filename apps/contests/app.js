/* Study Space contest module. Real content stays in the local private bank. */
(function () {
  'use strict';
  const M = window.ContestModel;
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
  function notice(id, text, kind = '') { const node = $(id); node.textContent = text; node.className = `notice ${kind}`; node.hidden = !text; }
  function storageWarning() { storageAvailable = false; notice('storage-notice', '浏览器无法保存记录。当前仍可练习，但刷新后进度可能丢失。', 'warning'); }
  async function initializeStorage() {
    const load = () => { try { state = M.load(localStorage.getItem(M.STORAGE_KEY)); } catch { storageWarning(); } };
    const readonly = text => { storageAvailable = false; notice('storage-notice', text, 'warning'); load(); };
    if (!navigator.locks?.request) {
      readonly('当前浏览器无法安全协调多个标签页，本页仅临时练习，不保存记录。请使用支持 Web Locks 的现代浏览器。');
      return;
    }
    await new Promise(resolve => {
      navigator.locks.request(M.STORAGE_KEY + ':writer', {ifAvailable: true}, async lock => {
        if (!lock) { readonly('另一个标签页正在保存记录。本页仅临时练习；关闭另一个竞赛标签页后刷新本页以保存。'); resolve(); return; }
        storageWriter = true; load(); resolve();
        // Keep the write lease until this document unloads; no stale whole-state overwrites.
        await new Promise(() => {});
      }).catch(() => { readonly('无法取得记录保存权限，本页仅临时练习，不保存记录。'); resolve(); });
    });
  }
  function save() {
    if (!storageWriter) return false;
    try { localStorage.setItem(M.STORAGE_KEY, JSON.stringify(state)); storageAvailable = true; notice('storage-notice', ''); return true; }
    catch { storageWarning(); return false; }
  }
  function node(tag, text, className) { const result = document.createElement(tag); if (text !== undefined) result.textContent = text; if (className) result.className = className; return result; }
  function button(text, action, className = 'quiet-button') { const result = node('button', text, className); result.type = 'button'; result.addEventListener('click', action); return result; }
  function fail(error) { notice('error', `无法加载：${error.message}。请确认本机服务正在运行后重试。`, 'error'); }
  async function get(url) { const response = await fetch(url, {cache: 'no-store'}); if (!response.ok) throw Error(`请求返回 ${response.status}`); return response.json(); }
  function modeQuery() { return mode === 'example' ? '?mode=example' : ''; }
  function setURL() {
    const query = new URLSearchParams({contest});
    if (mode === 'example') query.set('mode', mode);
    if (view === 'practice' && exam) { query.set('exam', exam.id); query.set('q', exam.problems[index].number); }
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
      $('exam-list').replaceChildren(catalog.length ? empty('没有匹配的试卷', '调整年份、搜索条件或补充卷选项。') : empty('尚未导入本机题库', '真实题目不随源码上传。完成本机导入后即可练习，也可以先体验原创示例。', button('打开原创示例', () => changeMode('example'), 'primary-button')));
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
    notice('notice', mode === 'example' ? '原创示例模式：不是历年真题，记录与本机题库分开保存。' : result.errors?.length ? '部分本机资源未通过校验，请检查导入报告。' : '');
    updateYears(); renderCards(); stats(); renderLibrary();
    if (['wrong','bookmarks','history'].includes(view)) renderSaved();
    window.startContestMath(result.mathjaxAvailable).then(ok => { if (!ok) notice('math-notice', '公式渲染未就绪，当前显示 LaTeX 原文。请先运行本机公式资源安装脚本。', 'warning'); });
    if (navigationToken !== requestVersion) return;
    if (initialExam && catalog.some(e => e.id === initialExam)) await openExam(initialExam, initialQuestion, false);
    else if (['wrong','bookmarks','history'].includes(initialView)) switchView(initialView);
  }
  async function changeMode(next) {
    if (next === mode) return;
    mode = next; exam = null; catalog = []; $('search').value = ''; $('year').value = ''; switchView('library'); renderCards(); stats();
    try { await loadCatalog(); } catch (error) { fail(error); }
  }
  async function openExam(id, number, focus = true) {
    const token = ++requestVersion;
    const item = catalog.find(e => e.id === id);
    if (!item) throw Error('本机题库中未找到该试卷');
    notice('error', '');
    const data = await get(`/api/contests/exams/${encodeURIComponent(id)}${modeQuery()}`);
    if (token !== requestVersion) return;
    if (!Array.isArray(data.problems) || !data.problems.length || data.id !== id) throw Error('试卷数据无效');
    if (data.revision !== item.revision) throw Error('题库版本已改变，请刷新页面');
    exam = {...item, ...data, title: M.examTitle(item)}; contest = item.contest;
    index = Math.max(0, data.problems.findIndex(p => p.number === Number(number)));
    renderCards(); switchView('practice');
    $('exam-title').textContent = exam.title;
    const missing = exam.missing_numbers || [];
    notice('missing-notice', missing.length ? `本卷缺少题号：${missing.join('、')}。不显示为完整试卷。` : '', 'warning');
    const rendering = renderQuestion(), rendered = renderVersion;
    await rendering;
    if (focus && token === requestVersion && rendered === renderVersion && view === 'practice') $('question-title').focus({preventScroll: true});
  }
  function current() { return exam?.problems[index]; }
  function response() { return exam && M.getSession(state, mode, exam)?.responses[current().id] || {}; }
  function navigation() {
    $('question-total').textContent = `${exam.problems.length} 题`;
    $('question-nav').replaceChildren(...exam.problems.map((p, i) => {
      const r = M.getSession(state, mode, exam)?.responses[p.id];
      const el = button(p.number, () => move(i), r?.result ? 'is-done' : r?.value?.trim() ? 'is-draft' : '');
      el.setAttribute('aria-label', `第 ${p.number} 题${r?.result ? '，已答' : r?.value?.trim() ? '，有草稿' : ''}`); el.setAttribute('aria-current', String(i === index)); return el;
    }));
    const done = Object.values(M.getSession(state, mode, exam)?.responses || {}).filter(r => r.result).length;
    $('practice-progress').textContent = `已答 ${done} / ${exam.problems.length}`;
    $('position').textContent = `${index + 1} / ${exam.problems.length}`;
    $('previous').disabled = index === 0; $('next').disabled = index === exam.problems.length - 1;
  }
  function controls() {
    const p = current(), r = response();
    $('check-answer').hidden = p.question_type === 'proof';
    $('check-answer').disabled = !M.canGrade(p) || !!r.result || !!r.revealed;
    $('check-answer').textContent = r.result ? '已记录结果' : '检查答案';
    $('reveal-answer').hidden = !p.answer;
    document.querySelectorAll('#choices input').forEach(input => { input.disabled = !!r.result; });
    $('integer-answer').disabled = !!r.result;
    const marked = !!state.bookmarks[M.bookmarkKey(mode, p.id)];
    $('bookmark').setAttribute('aria-pressed', String(marked)); $('bookmark').textContent = marked ? '★ 已收藏' : '☆ 收藏';
  }
  function showFeedback() {
    const r = response(), p = current();
    let text = '', kind = '';
    if (r.result) { text = r.result === 'correct' ? '回答正确。' : '答案不匹配，已加入错题本。'; kind = r.result; }
    if (r.revealed || r.result) {
      if (p.answer) text += ` 参考答案：${p.answer.display ?? p.answer.value ?? p.answer.accepted?.join(' / ')}`;
      if (!r.result) text += '（查看参考内容后，不计入本题正确率。）';
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
      $('solution-details').open = false; $('solution-count').textContent = `(${p.solutions.length})`; $('solution-warning').hidden = !p.solutions.length; $('solution-body').replaceChildren();
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
    if (!exam || next < 0 || next >= exam.problems.length) return;
    index = next;
    const rendering = renderQuestion(), token = renderVersion;
    rendering.then(() => { if (token === renderVersion && view === 'practice') $('question-title').focus({preventScroll: true}); });
  }
  function draft(value) {
    if (!exam || response().result) return;
    M.updateResponse(state, mode, exam, current(), {value});
    $('draft-status').textContent = save() ? '草稿已保存在此浏览器' : '草稿仅在当前页面，尚未保存'; navigation();
  }
  function reveal() {
    if (!exam) return;
    M.updateResponse(state, mode, exam, current(), {revealed: true}); save(); controls(); showFeedback();
  }
  function check() {
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
    $('saved-list').replaceChildren(...(rows.length ? rows : [empty('暂无记录', view === 'wrong' ? '检查答案后，答错的题目会出现在这里。' : view === 'bookmarks' ? '在答题页面点击收藏，即可在这里找到题目。' : '作答和证明草稿会保存在当前浏览器。')]));
  }
  document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => switchView(b.dataset.view)));
  $('private-mode').onclick = () => changeMode('private'); $('example-mode').onclick = () => changeMode('example');
  $('search').addEventListener('input', renderLibrary); $('year').onchange = renderLibrary; $('supplemental').onchange = renderLibrary;
  $('back-library').onclick = () => { updateYears(); renderCards(); switchView('library'); };
  $('previous').onclick = () => move(index - 1); $('next').onclick = () => move(index + 1);
  $('integer-answer').addEventListener('input', event => draft(event.target.value));
  $('proof-draft').addEventListener('input', event => draft(event.target.value));
  $('check-answer').onclick = check; $('reveal-answer').onclick = reveal;
  $('bookmark').onclick = () => { const p = current(), key = M.bookmarkKey(mode, p.id); if (state.bookmarks[key]) delete state.bookmarks[key]; else state.bookmarks[key] = {mode, id: p.id, examId: exam.id, number: p.number}; save(); controls(); };
  $('solution-details').addEventListener('toggle', () => {
    if (!$('solution-details').open || !exam || $('solution-body').childElementCount) return;
    const p = current(), token = renderVersion;
    if (!p.solutions.length) { $('solution-body').append(node('p', '暂未收录参考解答。')); return; }
    reveal();
    mathQueue = mathQueue.catch(() => {}).then(async () => {
      if (token !== renderVersion || !$('solution-details').open) return;
      for (const solution of p.solutions) {
        const entry = node('section', undefined, 'solution-entry'); entry.append(node('h4', solution.title || '参考解答'));
        if (solution.quality_flags?.length) entry.append(node('div', solution.quality_flags.map(f => flags[f] || '来源质量提示').join('；'), 'notice warning'));
        const body = node('div'); content(body, solution.html, solution.text_latex); entry.append(body); $('solution-body').append(entry);
      }
      if (await window.contestMathReady && token === renderVersion) { await MathJax.typesetPromise([$('solution-body')]); fitMath($('solution-body')); }
    }).catch(() => notice('math-notice', '部分解答公式无法渲染，请核对原文。', 'warning'));
  });
  $('clear-history').onclick = () => {
    if (!confirm(`清除${mode === 'example' ? '原创示例' : '本机题库'}的作答、证明草稿和练习记录？收藏和另一模式的记录不受影响。`)) return;
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
