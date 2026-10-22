'use strict';

(() => {
  const icons = {
    arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
    chevron: '<path d="m9 5 7 7-7 7"/>',
    left: '<path d="m15 5-7 7 7 7"/>',
    book: '<path d="M12 5.5C9.2 3.5 5.5 3.5 3 4.5v15c2.5-1 6.2-1 9 1 2.8-2 6.5-2 9-1v-15c-2.5-1-6.2-1-9 1Zm0 0v15"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/>',
    check: '<path d="m8 12 3 3 5-6"/><rect x="4" y="3" width="16" height="18" rx="3"/>',
    pencil: '<path d="m15 5 4 4M4 20l4.5-1L20 7.5a2.8 2.8 0 0 0-4-4L4.5 15 4 20Z"/>',
    sliders: '<path d="M5 3v5m0 4v9M12 3v9m0 4v5M19 3v2m0 4v12M2 8h6m1 8h6m1-11h6"/>',
    file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z"/><path d="M14 3v6h6M8 13h8m-8 4h5"/>',
    history: '<path d="M3 11a9 9 0 1 1 2.4 7M3 5v6h6m3-4v5l3 2"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    search: '<circle cx="10.7" cy="10.7" r="6.7"/><path d="m16 16 4.5 4.5"/>',
    user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/>',
    settings: '<path d="m9 3-.7 2.2-2 .9L4 5.6l-2 3.5L3.6 11v2L2 14.9l2 3.5 2.3-.5 2 .9L9 21h4l.7-2.2 2-.9 2.3.5 2-3.5-1.6-1.9v-2L20 9.1l-2-3.5-2.3.5-2-.9L13 3H9Z"/><circle cx="11" cy="12" r="3"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
    home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V10Z"/><path d="M9 21v-8h6v8"/>',
    sparkle: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z"/>',
    flag: '<path d="M5 21V4m0 0c5-4 9 4 14 0v10c-5 4-9-4-14 0"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
  };
  const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.book}</svg>`;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[character]));
  const number = value => new Intl.NumberFormat('zh-CN').format(Number(value) || 0);
  const examInfo = {
    sat: {name:'SAT', subtitle:'阅读与文法，从有目标的练习开始。', section:'Reading & Writing', upcoming:'Math', detail:'阅读与文法题库已接入，可按题目来源练习，或建立自己的训练计划。'},
    ap: {name:'AP', subtitle:'按学科组织题目，建立自己的备考节奏。', section:'学科题库', detail:'这里将提供独立的 AP 学科题库、自定义训练、真题模考与错题复习。'},
    toefl: {name:'TOEFL', subtitle:'听、说、读、写，在一个空间里练习。', section:'Reading · Listening · Speaking · Writing', detail:'这里将接入 TOEFL 独立题库，提供分项训练、模拟考试与错题复习。'},
    vocab: {name:'Personal Vocab', subtitle:'让遇到的每一个新词，成为自己的积累。', section:'个人词库', detail:'这里将收集来自不同考试的生词，提供词汇训练与复习。'},
  };
  const params = new URLSearchParams(location.search);
  const firstExam = Object.hasOwn(examInfo, params.get('exam')) ? params.get('exam') : 'sat';
  const state = {exam:firstExam, catalog:null, error:false, search:'', section:'all', page:1, pageSize:5, learning:{attempts:[], wrongBook:[]}};
  const content = document.getElementById('page-content');
  const announcer = document.getElementById('announcer');
  let catalogRequest = 0;

  function fillIcons(root = document) {
    root.querySelectorAll('[data-icon]').forEach(element => { element.innerHTML = icon(element.dataset.icon); });
  }
  function selectedCatalog() {
    return state.catalog?.exams?.find(exam => exam.id === state.exam);
  }
  function isAvailable() {
    return Boolean(selectedCatalog()?.available);
  }
  function satLink(view, extra = {}) {
    return `/sat/?${new URLSearchParams({view, ...extra})}`;
  }
  function sectionLabel(section) {
    const text = String(section || 'Reading & Writing');
    return /reading\s*(?:and|&)\s*writing/i.test(text) ? 'Reading & Writing' : text;
  }
  function sectionsFor(exam) {
    return [...new Set((exam?.sources || []).map(source => sectionLabel(source.section)))];
  }
  function todayAnswers() {
    const today = new Date().toDateString();
    return state.learning.attempts.filter(attempt => attempt.status === 'completed' && new Date(attempt.completedAt).toDateString() === today)
      .reduce((total, attempt) => total + Math.max(0, (Number(attempt.totalQuestions) || 0) - (Number(attempt.unansweredCount) || 0)), 0);
  }
  function statCard(label, value, caption, symbol, tone = '', unit = '') {
    return `<div class="stat-card"><span class="stat-icon ${tone}">${icon(symbol)}</span><div><div class="stat-label">${label}</div><div class="stat-number">${value}${unit ? `<small>${unit}</small>` : ''}</div><div class="stat-caption">${caption}</div></div></div>`;
  }
  function feature(title, description, symbol, label, href, action, featured = false, count) {
    const available = isAvailable();
    const tag = available ? 'a' : 'div';
    return `<${tag} ${available ? `href="${escape(href)}"` : ''} class="feature-card ${featured ? 'featured' : ''} ${available ? 'enabled' : 'unavailable'}"><div class="feature-topline"><span class="feature-icon">${icon(symbol)}</span><span class="feature-label">${label}</span></div><h3>${title}</h3><p>${description}</p><span class="feature-action">${count !== undefined && available ? `<span class="wrong-count">${number(count)}</span>` : ''}${available ? action : '待接入'}${icon('arrow')}</span></${tag}>`;
  }
  function learningPanel() {
    const attempts = state.exam === 'sat' ? [...state.learning.attempts].sort((a, b) => (b.savedAt || b.completedAt || 0) - (a.savedAt || a.completedAt || 0)) : [];
    return `<section class="panel sidebar-panel"><div class="sidebar-heading"><h2 style="font-size:inherit;font-weight:inherit">最近练习</h2>${icon('history')}</div>${attempts.length ? `<div class="records">${attempts.slice(0, 3).map(attempt => `<a class="recent-record" href="${satLink('dashboard')}"><strong>${escape(attempt.practiceName || 'SAT 练习')}</strong><small><span>${attempt.status === 'completed' ? '已完成' : '未完成'} · ${number(attempt.totalQuestions)} 题</span><span>${new Date(attempt.savedAt || attempt.completedAt).toLocaleDateString('zh-CN', {month:'numeric', day:'numeric'})}</span></small></a>`).join('')}</div><a class="link-button" href="${satLink('dashboard')}" style="margin-top:14px">全部练习记录${icon('arrow')}</a>` : `<div class="record-empty"><div class="empty-art">${icon('history')}</div><h3>从第一次练习开始</h3><p>${isAvailable() ? '完成练习后，你的学习足迹<br>会出现在这里。' : '题库接入后，在这里回顾<br>每一次练习与进步。'}</p>${isAvailable() ? `<a class="link-button" href="${satLink('practiceBuilder', {mode:'custom'})}">开始练习${icon('arrow')}</a>` : ''}</div>`}</section>`;
  }
  function scopePanel() {
    const info = examInfo[state.exam];
    const available = isAvailable();
    const rows = state.exam === 'sat'
      ? `<div class="scope-row"><strong>Reading & Writing</strong><span class="small-status ${available ? '' : 'pending'}">${available ? '已接入' : '加载中'}</span></div><div class="scope-row"><strong>Math</strong><span class="small-status pending">待接入</span></div>`
      : (state.exam === 'toefl' ? ['Reading','Listening','Speaking','Writing'] : state.exam === 'ap' ? ['AP 学科题库'] : ['生词收集','词汇复习']).map(label => `<div class="scope-row"><strong>${label}</strong><span class="small-status pending">待接入</span></div>`).join('');
    return `<section class="panel scope-panel"><h2 class="scope-title">${icon('book')}当前学习范围</h2>${rows}<div class="scope-divider"></div><p class="scope-hint">${state.exam === 'sat' ? '当前模考使用原有阅读与文法练习引擎，暂不提供 SAT 量尺分。' : `${escape(info.name)} 的题目与练习记录将独立保存。`}</p></section>`;
  }
  function resumeBanner() {
    if (state.exam !== 'sat' || !isAvailable()) return '';
    const pending = [...state.learning.attempts].filter(attempt => attempt.status === 'incomplete' && attempt.resumable).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))[0];
    if (!pending) return '';
    return `<aside class="resume-banner">${icon('clock')}<div class="resume-banner-text"><strong>继续上次练习 · ${escape(pending.practiceName || 'SAT')}</strong><span>已作答 ${number(Math.max(0, pending.totalQuestions - pending.unansweredCount))} / ${number(pending.totalQuestions)} 题</span></div><a class="button primary" href="${satLink('dashboard')}">继续练习${icon('arrow')}</a></aside>`;
  }
  function render() {
    const exam = selectedCatalog();
    const info = examInfo[state.exam];
    const available = isAvailable();
    const loading = !state.catalog && !state.error;
    const sat = state.exam === 'sat';
    const questionCount = loading ? '—' : number(exam?.questionCount);
    const sourceCount = loading ? '正在加载题库' : `${number(exam?.sourceCount)} 份题目来源`;
    document.title = `${info.name} · Study Space`;
    document.querySelectorAll('[data-exam]').forEach(button => {
      const selected = button.dataset.exam === state.exam;
      button.classList.toggle('active', selected);
      if (selected) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    content.setAttribute('aria-busy', String(loading));
    content.innerHTML = `<div class="breadcrumb">${icon('home')}<span>学习空间</span>${icon('chevron')}<span class="current">${escape(info.name)}</span></div>
      <section class="welcome-row"><div><h1>${escape(info.name)} <span>学习空间</span></h1><p>${escape(info.subtitle)}</p></div><div class="welcome-meta"><strong>${new Date().toLocaleDateString('zh-CN', {year:'numeric', month:'long', day:'numeric', weekday:'long'})}</strong><span>${icon('shield')}你的学习，从这里继续</span></div></section>
      ${state.error ? '<div class="error-banner" role="alert">题库暂时无法加载，请确认本地服务正在运行。<button type="button" data-retry>重新加载</button></div>' : ''}
      <section class="overview" aria-label="学习概览">${statCard('题库储备', questionCount, sourceCount, 'layers', '', '题')}${statCard('今日完成', number(sat ? todayAnswers() : 0), '按今日完成的练习统计已答题数', 'check', 'green', '题')}${statCard('待复习错题', number(sat ? state.learning.wrongBook.length : 0), available ? '错题自动收集，巩固薄弱知识点' : '练习完成后，自动整理错题', 'flag', 'amber', '题')}</section>
      ${!available && !loading && !state.error ? `<aside class="exam-notice">${icon('sparkle')}<div><h2>${escape(info.name)} 学习空间正在准备中</h2><p>${escape(info.detail)}</p></div></aside>` : ''}
      ${resumeBanner()}
      <section aria-labelledby="practice-title"><div class="section-heading"><h2 id="practice-title" class="section-eyebrow">选择练习方式</h2><span class="section-aside">按自己的节奏，稳步前进</span></div><div class="feature-grid">${feature('自定义训练', '自由选择题型、数量与练习时长', 'sliders', 'PERSONAL PRACTICE', satLink('practiceBuilder', {mode:'custom'}), '建立训练', true)}${feature('真题模考', '按套题与模块计时，熟悉考试节奏', 'file', 'MOCK EXAM', satLink('practiceBuilder', {mode:'source'}), '选择套题')}${feature('错题本', '回顾练习错题，把薄弱项逐个掌握', 'book', 'REVIEW & IMPROVE', satLink('wrongBook'), '进入复习', false, sat ? state.learning.wrongBook.length : 0)}</div></section>
      <div class="workspace-grid"><section class="panel library-panel" aria-labelledby="library-title"><div class="section-heading library-heading"><div><h2 id="library-title">${state.exam === 'vocab' ? '我的词库' : '题库与套题'}</h2><p>${available ? '选择一份题目来源，开始专注练习' : '独立题库，统一的学习方式'}</p></div>${available ? `<a class="link-button" href="${satLink('questionLibrary')}">题库管理${icon('arrow')}</a>` : ''}</div><div class="library-toolbar"><label class="search-field">${icon('search')}<span class="sr-only">搜索题目来源</span><input id="source-search" type="search" placeholder="搜索套题或题目来源…" autocomplete="off" value="${escape(state.search)}" ${loading ? 'disabled' : ''}></label><label class="sr-only" for="section-filter">筛选科目</label><select class="filter-select" id="section-filter" ${loading ? 'disabled' : ''}><option value="all">全部科目</option>${sectionsFor(exam).map(section => `<option value="${escape(section)}" ${section === state.section ? 'selected' : ''}>${escape(section)}</option>`).join('')}</select></div><div id="library-results" aria-live="polite"></div></section><aside class="sidebar">${learningPanel()}${scopePanel()}<p class="privacy-note">${icon('shield')}新空间从零记录学习进度，未导入原来的个人作答与错题记录。</p></aside></div>`;
    renderLibrary();
  }
  function renderLibrary() {
    const results = document.getElementById('library-results');
    if (!results) return;
    if (!state.catalog && !state.error) {
      results.innerHTML = `<div aria-label="正在加载题库">${Array.from({length:3}, () => '<div class="loading-row"><div class="loading-line"></div><div class="loading-line"></div></div>').join('')}</div>`;
      return;
    }
    const exam = selectedCatalog();
    const all = exam?.sources || [];
    const query = state.search.trim().toLocaleLowerCase();
    const filtered = all.filter(source => (!query || `${source.title} ${source.section}`.toLocaleLowerCase().includes(query)) && (state.section === 'all' || sectionLabel(source.section) === state.section));
    const pages = Math.max(1, Math.ceil(filtered.length / state.pageSize));
    state.page = Math.min(pages, Math.max(1, state.page));
    const sources = filtered.slice((state.page - 1) * state.pageSize, state.page * state.pageSize);
    if (!sources.length) {
      const searching = Boolean(query || state.section !== 'all');
      const headline = state.error ? '暂时无法读取题库' : searching ? '没有找到匹配的题目来源' : isAvailable() ? '题库还没有题目' : state.exam === 'vocab' ? '你的个人词库，即将开启' : `${examInfo[state.exam].name} 题库即将接入`;
      const caption = state.error ? '保持本地服务运行，然后重新加载。' : searching ? '试试其他关键词，或清除筛选条件。' : isAvailable() ? '通过题库管理导入 JSON 题目后，即可开始练习。' : '准备好之后，就能在这里选择并开始练习。';
      results.innerHTML = `<div class="empty-library"><div class="empty-art">${icon(state.error ? 'history' : 'book')}</div><h3>${escape(headline)}</h3><p>${escape(caption)}</p>${searching ? '<button class="button" type="button" data-reset-search>清除筛选</button>' : isAvailable() ? `<a class="button" href="${satLink('questionLibrary')}">管理题库${icon('arrow')}</a>` : ''}</div>`;
      return;
    }
    results.innerHTML = `<div class="list-columns" aria-hidden="true"><span>题目来源</span><span>题数</span><span>开始练习</span></div><div class="source-list">${sources.map(source => `<div class="source-row"><div class="source-description"><span class="source-icon">${icon('file')}</span><div class="source-text"><strong class="source-name" title="${escape(source.title)}">${escape(source.title)}</strong><div class="source-meta"><span>${escape(sectionLabel(source.section))}</span>${Number(source.moduleCount) > 1 ? `<span class="module-tag">${number(source.moduleCount)} MODULES</span>` : '<span class="module-tag">题目集</span>'}</div></div></div><span class="source-count" aria-label="${number(source.questionCount)} 道题">${number(source.questionCount)}</span><a class="source-start" href="${satLink('practiceBuilder', {mode:'source', source:source.id})}" aria-label="开始练习 ${escape(source.title)}">开始练习</a></div>`).join('')}</div><div class="library-bottom"><span class="list-summary">${query || state.section !== 'all' ? `找到 ${number(filtered.length)} 份来源` : `共 ${number(all.length)} 份来源 · ${number(exam.questionCount)} 道题目`}</span><div class="pagination" aria-label="题库分页"><button type="button" class="page-button" data-page="${state.page - 1}" ${state.page <= 1 ? 'disabled' : ''} aria-label="上一页">${icon('left')}</button><span class="page-label">${state.page} / ${pages}</span><button type="button" class="page-button" data-page="${state.page + 1}" ${state.page >= pages ? 'disabled' : ''} aria-label="下一页">${icon('chevron')}</button></div></div>`;
  }

  async function loadCatalog() {
    const request = ++catalogRequest;
    state.error = false;
    try {
      const response = await fetch('/api/platform/catalog', {headers:{Accept:'application/json'}, cache:'no-store'});
      if (!response.ok) throw new Error('Catalog unavailable');
      const catalog = await response.json();
      if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.exams)) throw new Error('Unsupported catalog');
      catalog.exams.forEach(exam => { if (!Array.isArray(exam.sources)) exam.sources = []; });
      if (request !== catalogRequest) return;
      state.catalog = catalog;
    } catch (_) {
      if (request !== catalogRequest) return;
      state.error = true;
      state.catalog = null;
    }
    render();
  }
  // Read only the unified platform's new namespace. Never inspect the original SAT database.
  async function loadLearning() {
    if (!window.indexedDB) return;
    const databaseName = 'SchoolExamPlatform:sat:v1';
    try {
      if (indexedDB.databases) {
        const databases = await indexedDB.databases();
        if (!databases.some(database => database.name === databaseName)) return;
      }
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(databaseName);
        request.onupgradeneeded = () => { request.transaction.abort(); };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('Database is busy'));
      });
      try {
        if (!db.objectStoreNames.contains('attempts') || !db.objectStoreNames.contains('wrongBook')) return;
        const learning = await new Promise((resolve, reject) => {
          const transaction = db.transaction(['attempts', 'wrongBook'], 'readonly');
          const attempts = transaction.objectStore('attempts').getAll();
          const wrongBook = transaction.objectStore('wrongBook').getAll();
          transaction.oncomplete = () => resolve({attempts:attempts.result || [], wrongBook:wrongBook.result || []});
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error);
        });
        state.learning = learning;
      } finally {
        db.close();
      }
      render();
    } catch (_) { /* Storage may be unavailable in a private browser; the catalog remains usable. */ }
  }
  function selectExam(id, changeHistory = true) {
    if (!Object.hasOwn(examInfo, id) || id === state.exam) return;
    state.exam = id;
    state.search = '';
    state.section = 'all';
    state.page = 1;
    if (changeHistory) {
      const url = new URL(location.href);
      if (id === 'sat') url.searchParams.delete('exam');
      else url.searchParams.set('exam', id);
      history.pushState({exam:id}, '', url);
    }
    render();
    announcer.textContent = `已切换到 ${examInfo[id].name} 学习空间`;
  }
  function setMenu(open, focusFirst = false) {
    const menu = document.getElementById('account-menu');
    menu.hidden = !open;
    document.getElementById('account-button').setAttribute('aria-expanded', String(open));
    if (open && focusFirst) menu.querySelector('button').focus();
  }
  function readPreferences() {
    try {
      const preferences = JSON.parse(localStorage.getItem('school-exam-platform:preferences:v1') || '{}');
      return preferences && typeof preferences === 'object' ? preferences : {};
    }
    catch (_) { return {}; }
  }
  function applyPreferences(preferences) {
    document.body.classList.toggle('reduced-motion', Boolean(preferences.reduceMotion));
    document.body.classList.toggle('compact-list', Boolean(preferences.compactList));
    document.getElementById('reduce-motion').checked = Boolean(preferences.reduceMotion);
    document.getElementById('compact-list').checked = Boolean(preferences.compactList);
  }
  document.addEventListener('click', event => {
    const examButton = event.target.closest('[data-exam]');
    if (examButton) selectExam(examButton.dataset.exam);
    const accountButton = event.target.closest('#account-button');
    if (accountButton) setMenu(document.getElementById('account-menu').hidden);
    else if (!event.target.closest('.account-menu')) setMenu(false);
    const dialogButton = event.target.closest('[data-dialog]');
    if (dialogButton) {
      setMenu(false);
      document.getElementById(`${dialogButton.dataset.dialog}-dialog`).showModal();
    }
    if (event.target.closest('[data-close-dialog]')) event.target.closest('dialog').close();
    const pageButton = event.target.closest('[data-page]');
    if (pageButton && !pageButton.disabled) {
      const direction = Number(pageButton.dataset.page) > state.page ? 1 : -1;
      state.page = Number(pageButton.dataset.page);
      renderLibrary();
      // Re-rendering the list replaces its buttons; keep keyboard users at the pager.
      const nextButton = document.querySelector(`[data-page="${state.page + direction}"]:not(:disabled)`)
        || document.querySelector('.pagination button:not(:disabled)');
      nextButton?.focus();
    }
    if (event.target.closest('[data-reset-search]')) {
      state.search = ''; state.section = 'all'; state.page = 1;
      document.getElementById('source-search').value = '';
      document.getElementById('section-filter').value = 'all';
      renderLibrary();
    }
    if (event.target.closest('[data-retry]')) { state.catalog = null; state.error = false; render(); loadCatalog(); }
  });
  document.addEventListener('input', event => {
    if (event.target.id === 'source-search') { state.search = event.target.value; state.page = 1; renderLibrary(); }
  });
  document.addEventListener('change', event => {
    if (event.target.id === 'section-filter') { state.section = event.target.value; state.page = 1; renderLibrary(); }
    if (event.target.id === 'reduce-motion' || event.target.id === 'compact-list') {
      const preferences = {reduceMotion:document.getElementById('reduce-motion').checked, compactList:document.getElementById('compact-list').checked};
      applyPreferences(preferences);
      try { localStorage.setItem('school-exam-platform:preferences:v1', JSON.stringify(preferences)); } catch (_) { /* Preferences still apply during this visit. */ }
    }
  });
  document.addEventListener('keydown', event => {
    const menu = document.getElementById('account-menu');
    if (event.key === 'Escape' && !menu.hidden) { setMenu(false); document.getElementById('account-button').focus(); }
    if (event.target.id === 'account-button' && event.key === 'ArrowDown') { event.preventDefault(); setMenu(true, true); }
    if (!menu.hidden && event.target.closest('.account-menu') && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      const buttons = [...menu.querySelectorAll('button')];
      const index = buttons.indexOf(document.activeElement);
      buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus();
    }
  });
  document.querySelectorAll('dialog').forEach(dialog => {
    dialog.addEventListener('close', () => document.getElementById('account-button').focus());
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const bounds = dialog.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
    });
  });
  window.addEventListener('popstate', () => selectExam(new URLSearchParams(location.search).get('exam') || 'sat', false));
  window.addEventListener('pageshow', event => { if (event.persisted) { loadCatalog(); loadLearning(); } });
  window.addEventListener('focus', loadLearning);
  fillIcons();
  applyPreferences(readPreferences());
  render();
  loadCatalog();
  loadLearning();
  // Public shell hook for future exam/account adapters; authentication is intentionally not enabled.
  window.PlatformHome = Object.freeze({selectExam, refresh:() => Promise.all([loadCatalog(), loadLearning()])});
})();
