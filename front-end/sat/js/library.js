'use strict';
window.SATLibrary = (() => {
  const categories = [
    {source: '测试', id: 'full-length', title: 'Full-Length Tests'},
    {source: '英语', id: 'reading-writing', title: 'Reading and Writing'},
    {source: '数学', id: 'math', title: 'Math'}
  ];
  // Official calendar dates group source titles by month; they do not certify
  // a local collection's identity, regional label, questions, or answer key.
  const scheduleSources = Object.freeze({
    A: 'https://highered.collegeboard.org/media/pdf/digital-sat-what-higher-ed-needs-to-know-accessibility-final.pdf',
    B: 'https://counselors.collegeboard.org/media/pdf/23-24_AP_SAT_Dates.pdf',
    C: 'https://newsroom.collegeboard.org/digital-sat-launches-across-country-completing-transition-digital-and-providing-simpler-testing',
    D: 'https://international.collegeboard.org/media/pdf/2024%20Sep_Annual%20Intl%20School%20Webinar_Final%20for%20Sharing.pdf',
    E: 'https://satsuite.collegeboard.org/k12-educators/educator-experience/comparing-sat-weekend-school-day',
    F: 'https://satsuite.collegeboard.org/dates/august-22-2026-sat-test-date'
  });
  const officialSchedule = Object.freeze([
    ...['2023-03-11', '2023-05-06', '2023-06-03'].map(date => ({date, sourceUrl: scheduleSources.A})),
    ...['2023-10-07', '2023-11-04', '2023-12-02', '2024-03-09', '2024-05-04', '2024-06-01'].map(date => ({date, sourceUrl: scheduleSources.B})),
    {date: '2025-03-08', sourceUrl: scheduleSources.D},
    ...['2025-08-23', '2025-10-04', '2025-11-08', '2025-12-06', '2026-03-14', '2026-05-02'].map(date => ({date, sourceUrl: scheduleSources.E})),
    {date: '2026-08-22', sourceUrl: scheduleSources.F}
  ].map(entry => Object.freeze({...entry, month: entry.date.slice(0, 7), precision: 'day', source: 'official-schedule'})));
  const schoolDayWindow = Object.freeze({date: '2024-04', month: '2024-04', precision: 'month', source: 'official-schedule', sourceUrl: scheduleSources.B, sourceUrls: Object.freeze([scheduleSources.B, scheduleSources.C])});
  const state = {status: 'idle', catalog: [], errors: [], message: '', category: '测试', selectedId: null};
  const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]));
  const identity = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value);
  let refreshing = null;

  function currentCategory() {
    return categories.find(category => category.source === state.category) || categories[0];
  }

  function displayTitle(title) {
    return String(title || '')
      .replace(/(?:[（(【\[]\s*)?(?:去重精校版|去重校对版|去重版|精校版|精校|去重)(?:\s*[）)】\]])?/g, '')
      .replace(/\.(?:json|zip)$/i, '')
      .replace(/\s+/g, ' ').replace(/^[\s_—–-]+|[\s_—–-]+$/g, '').trim() || 'Untitled Test';
  }

  function testDate(title) {
    if (/(?:blue\s*book|蓝皮|难题|拼卷|零散|汇总|合集)/i.test(title)) return {key: 'undated', label: 'Undated Tests', sort: -2};
    if (/(?:原创|合成|样例|模拟|bluebook|synthetic|sample|original)/i.test(title)) return {key: 'practice', label: 'Practice Tests', sort: -1};
    let match = title.match(/(?:^|[^\d])((?:19|20)\d{2}|\d{2})年\s*(1[0-2]|0?[1-9])月(?:\s*(3[01]|[12]\d|0?[1-9])(?:日|号))?/);
    if (!match) match = title.match(/(?:^|[^\d])((?:19|20)\d{2})[-/.](1[0-2]|0?[1-9])(?:[-/.](3[01]|[12]\d|0?[1-9]))?(?!\d)/);
    if (!match) return {key: 'undated', label: 'Undated Tests', sort: -2};
    const year = Number(match[1]) + (match[1].length === 2 ? 2000 : 0), month = Number(match[2]), titleDay = match[3] ? Number(match[3]) : null;
    const titleDate = new Date(Date.UTC(year, month - 1, titleDay || 1));
    if (titleDate.getUTCFullYear() !== year || titleDate.getUTCMonth() !== month - 1 || titleDay && titleDate.getUTCDate() !== titleDay) return {key: 'undated', label: 'Undated Tests', sort: -2};
    const monthKey = `${year}-${String(month).padStart(2, '0')}`;
    const schoolDay = /(?:school\s*day|校内考试|学校日)/i.test(title);
    if (schoolDay && monthKey !== schoolDayWindow.month) return {key: 'undated', label: 'Undated Tests', sort: -2};
    const official = monthKey === schoolDayWindow.month ? schoolDayWindow : officialSchedule.find(entry => entry.month === monthKey);
    const day = official ? official.precision === 'day' ? Number(official.date.slice(-2)) : null : titleDay;
    const key = official ? official.date : monthKey + (day ? '-' + String(day).padStart(2, '0') : '');
    const date = new Date(Date.UTC(year, month - 1, day || 1));
    const monthLabel = ['Jan.', 'Feb.', 'Mar.', 'Apr.', 'May.', 'Jun.', 'Jul.', 'Aug.', 'Sep.', 'Oct.', 'Nov.', 'Dec.'][month - 1];
    const label = `${monthLabel} ${day ? day + ', ' : ''}${year}`;
    return {key, label, sort: date.getTime(), precision: day ? 'day' : 'month', source: official ? official.source : 'source-title', ...(official ? {sourceUrl: official.sourceUrl, ...(official.sourceUrls ? {sourceUrls: official.sourceUrls} : {})} : {})};
  }

  function compare(a, b) {
    return testDate(b.title).sort - testDate(a.title).sort || displayTitle(a.title).localeCompare(displayTitle(b.title), 'en', {numeric: true}) || a.collectionId.localeCompare(b.collectionId);
  }

  function visible() {
    return state.catalog.filter(collection => collection.category === currentCategory().id).sort(compare);
  }

  function ensureSelection() {
    const collections = visible();
    if (!collections.some(collection => collection.collectionId === state.selectedId)) state.selectedId = collections[0]?.collectionId || null;
  }

  async function request(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(url, {credentials: 'same-origin', cache: 'no-store', signal: controller.signal});
      if (!response.ok) throw new Error('The selected test collection could not be loaded.');
      return await response.json();
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('The test library took too long to respond. Please try again.');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function refresh() {
    if (refreshing) return refreshing;
    state.status = 'loading';
    state.message = '';
    refreshing = (async () => {
      try {
        const response = await request('/api/sat-library');
        if (response?.schemaVersion !== 1 || !Array.isArray(response.categories)) throw new Error('The test library format is not supported.');
        const catalog = [], seen = new Set();
        for (const category of categories) {
          const group = response.categories.find(group => group?.id === category.id);
          if (!group || !Array.isArray(group.collections)) continue;
          for (const collection of group.collections) {
            if (!collection || !identity(collection.collectionId) || seen.has(collection.collectionId) || typeof collection.title !== 'string' || !Number.isInteger(collection.questionCount) || collection.questionCount < 1) continue;
            seen.add(collection.collectionId);
            // Keep only directory metadata. Question packages are requested on demand.
            catalog.push({
              collectionId: collection.collectionId, title: collection.title, category: category.id, examDate: testDate(collection.title),
              sourceCategory: category.source, subgroup: typeof collection.subgroup === 'string' ? collection.subgroup : '',
              questionCount: collection.questionCount, fullSAT: collection.fullSAT === true,
              sectionCounts: Object.fromEntries(Object.entries(collection.sectionCounts || {}).filter(([section, count]) => ['reading-writing', 'math'].includes(section) && Number.isInteger(count) && count > 0)),
              modules: Array.isArray(collection.modules) ? collection.modules.filter(module => module && ['reading-writing', 'math'].includes(module.section) && Number.isInteger(module.moduleNumber) && module.moduleNumber > 0 && Number.isInteger(module.questionCount) && module.questionCount > 0).map(module => ({section: module.section, moduleNumber: module.moduleNumber, questionCount: module.questionCount, ...(Number.isInteger(module.durationSeconds) && module.durationSeconds > 0 ? {durationSeconds: module.durationSeconds} : {})})) : []
            });
          }
        }
        state.catalog = catalog;
        state.errors = Array.isArray(response.errors) ? response.errors.map(error => ({collectionId: identity(error?.collectionId) ? error.collectionId : null, error: typeof error?.error === 'string' ? error.error : 'A test collection is unavailable.'})) : [];
        state.status = 'ready';
        state.message = response.available === false ? 'No test library is connected.' : '';
        ensureSelection();
      } catch (error) {
        state.status = 'error';
        state.message = error.message || 'The test library could not be loaded.';
      } finally {
        refreshing = null;
      }
      return state;
    })();
    return refreshing;
  }

  function find(id) {
    return state.catalog.find(collection => collection.collectionId === id) || null;
  }

  async function collection(id) {
    if (!identity(id) || !find(id)) throw new Error('The selected test collection is unavailable.');
    return request(`/api/sat-library/collections/${encodeURIComponent(id)}`);
  }

  function setCategory(value) {
    const category = categories.find(category => category.source === value || category.id === value);
    if (category) {
      state.category = category.source;
      ensureSelection();
    }
    return state.category;
  }

  function select(id) {
    const collection = find(id);
    if (collection && collection.category === currentCategory().id) state.selectedId = id;
    return collection;
  }

  function card(collection, completed, resumable) {
    const selected = collection.collectionId === state.selectedId, id = escape(collection.collectionId), title = escape(displayTitle(collection.title));
    const button = (label, action, primary) => `<button type="button" class="app-button sat-library-action${primary ? ' filled' : ''}" data-action="library-${action}" data-id="${id}">${label}</button>`;
    return `<article class="sat-library-card${selected ? ' is-selected' : ''}" data-action="library-select" data-id="${id}"><div class="sat-library-card-top"><h3><button type="button" class="sat-library-select" data-action="library-select" data-id="${id}" aria-pressed="${selected}" aria-label="Select ${title}">${title}</button></h3><span class="sat-library-selection" aria-hidden="true">${selected ? '✓' : ''}</span></div><div class="sat-library-facts"><span>${collection.questionCount} Questions</span>${collection.modules.length ? `<span>${collection.modules.length} ${collection.modules.length === 1 ? 'Module' : 'Modules'}</span>` : ''}${collection.category === 'full-length' && !collection.fullSAT ? '<span>Partial Test</span>' : ''}${resumable ? '<span>In Progress</span>' : completed ? '<span class="sat-library-completed">Completed</span>' : ''}</div><div class="sat-library-card-actions">${resumable ? button('Resume Exam', 'resume', true) : ''}${completed ? button('Open Review', 'review', !resumable) + button('Restart Exam', 'restart', false) : resumable ? button('Restart Exam', 'restart', false) : button('Start Exam', 'start', true)}</div></article>`;
  }

  function render(attempts = []) {
    const active = currentCategory();
    const tabs = `<div class="sat-library-tabs" role="group" aria-label="Test category">${categories.map(category => `<button type="button" class="sat-library-tab${active.id === category.id ? ' is-active' : ''}" data-action="library-category" data-category="${category.source}" aria-pressed="${active.id === category.id}">${category.title}</button>`).join('')}</div>`;
    let content;
    if (state.status === 'idle' || state.status === 'loading') content = '<div class="sat-library-empty" role="status">Loading tests…</div>';
    else if (state.status === 'error') content = `<div class="sat-library-empty sat-library-error" role="alert"><div><p>${escape(state.message)}</p><button type="button" class="app-button sat-library-action" data-action="library-refresh">Retry</button></div></div>`;
    else {
      const collections = visible();
      const records = (Array.isArray(attempts) ? attempts : []).filter(attempt => identity(attempt?.libraryCollectionId));
      const completed = new Set(records.filter(attempt => attempt.status === 'completed').map(attempt => attempt.libraryCollectionId));
      const resumable = new Set(records.filter(attempt => attempt.status === 'incomplete' && attempt.resumable).map(attempt => attempt.libraryCollectionId));
      if (!collections.length) content = `<div class="sat-library-empty" role="status">${escape(state.message || 'No tests are available in this category.')}</div>`;
      else if (active.id !== 'full-length') content = `<div class="sat-library-grid">${collections.map(collection => card(collection, completed.has(collection.collectionId), resumable.has(collection.collectionId))).join('')}</div>`;
      else {
        const groups = new Map();
        for (const collection of collections) {
          const date = testDate(collection.title);
          if (!groups.has(date.key)) groups.set(date.key, {date, collections: []});
          groups.get(date.key).collections.push(collection);
        }
        content = `<div class="sat-library-timeline">${[...groups.values()].map(group => `<section class="sat-library-time-group"><h2 class="sat-library-date">${group.date.precision ? `<time datetime="${group.date.key}">${group.date.label}</time>` : group.date.label}</h2><div class="sat-library-grid">${group.collections.map(collection => card(collection, completed.has(collection.collectionId), resumable.has(collection.collectionId))).join('')}</div></section>`).join('')}</div>`;
      }
      if (state.errors.length) content += `<p class="sat-library-warning" role="status">${state.errors.length} ${state.errors.length === 1 ? 'test collection is' : 'test collections are'} unavailable.</p>`;
    }
    return `<section class="sat-library" aria-labelledby="satLibraryTitle"><div class="app-heading"><h1 id="satLibraryTitle">Start Practice</h1></div>${tabs}<div class="sat-library-content" aria-busy="${state.status === 'loading'}">${content}</div></section>`;
  }

  return {state, refresh, collection, render, find, setCategory, select, officialSchedule};
})();
