'use strict';
// Platform-only adapter. The imported TOEFL source and its cloud client stay untouched.
(() => {
  if (!location.pathname.startsWith('/toefl/')) return;
  const namespace = 'school-exam-platform:toefl:';
  const names = new Map([
    ['four.history.v1', namespace + 'history:v1'],
    ['four.drafts.v2', namespace + 'drafts:v2'],
    ['four.draft.v1', namespace + 'draft:v1'],
    ['four.words.v1', namespace + 'words:v1'],
    ['four.learning.v1', namespace + 'learning:v1'],
    ['t1lab.history.v1', namespace + 'legacy-history:v1'],
    ['practice.ui.v1', namespace + 'ui:v1'],
  ]);
  let local;
  try { local = window.localStorage; } catch (_) { /* Private browsing may disable storage. */ }
  for (const method of ['getItem', 'setItem', 'removeItem']) {
    const nativeMethod = Storage.prototype[method];
    Storage.prototype[method] = function (key, ...args) {
      if (this === local) key = names.get(String(key)) || key;
      return Reflect.apply(nativeMethod, this, [key, ...args]);
    };
  }
  if (window.indexedDB) {
    const factory = window.indexedDB;
    const nativeOpen = factory.open;
    factory.open = function (name, ...args) {
      return Reflect.apply(nativeOpen, this, [name === 'toefl-recordings-v1'
        ? 'SchoolExamPlatform:toefl:recordings:v1' : name, ...args]);
    };
  }

  // The anonymous frontend has no URL router. Seed its existing navigation state
  // before deferred scripts execute, using only known entry pages and sections.
  const params = new URLSearchParams(location.search);
  const section = params.get('section');
  const sections = ['reading', 'listening', 'speaking', 'writing'];
  const entries = {
    practice: {view: 'bank'}, mock: {view: 'sets'},
    plan: {view: 'learning', ltab: 'today'},
    wrongBook: {view: 'learning', ltab: 'review'},
    report: {view: 'history'}, progress: {view: 'progress'}, vocab: {view: 'vocab'},
  };
  const view = params.get('view');
  const entry = Object.hasOwn(entries, view) ? entries[view] : null;
  const navigation = history.state;
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const entryViews = ['bank', 'sets', 'learning', 'vocab', 'history', 'progress'];
  const route = navigation?.toeflRoute;
  const reference = value => value == null || typeof value === 'string';
  const nativeRoute = object(navigation) && navigation.owner === 'local'
    && navigation.navigationVersion === 2 && Number.isSafeInteger(navigation.depth) && navigation.depth >= 0
    && object(route) && object(route.state) && [...entryViews, 'exam', 'review'].includes(route.state.view)
    && Number.isFinite(route.y) && ['study', 'attempt', 'draft'].every(key => reference(route[key]))
    && (route.entry == null || object(route.entry) && entryViews.includes(route.entry.view) && object(route.entry.state))
    && (route.preview == null || object(route.preview) && Array.isArray(route.preview.queue)
      && route.preview.queue.every(key => typeof key === 'string'))
    && (route.state.view !== 'exam' || Boolean(route.draft))
    && (route.state.view !== 'review' || Boolean(route.study || route.attempt || route.preview?.queue?.length));
  // Native navigation keeps the original deep-link URL while moving into an
  // exam or report. On refresh its valid route must win over that entry URL.
  if (!nativeRoute && (entry || sections.includes(section))) {
    const state = {...(entry || {view: 'bank'})};
    if (sections.includes(section)) {
      state.subject = section;
      state.module = section + '-t1';
      state.lsubject = section;
      state.hsubject = section;
      state.setSubject = section;
    }
    history.replaceState({owner: 'local', depth: 0, navigationVersion: 2,
      toeflRoute: {state, entry: null, study: null, attempt: null, draft: null, y: 0}}, '');
  } else if (!nativeRoute && navigation?.toeflRoute !== undefined) {
    // Foreign owners and malformed/older navigation snapshots are never reused.
    // Omitting the URL argument retains all native URL parameters.
    history.replaceState(null, '');
  }
  window.TOEFLPlatformBridge = Object.freeze({
    storageKeys: Object.freeze(Object.fromEntries(names)),
    recordingDatabase: 'SchoolExamPlatform:toefl:recordings:v1',
  });
})();
