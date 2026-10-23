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

  // The TOEFL module owns URL entry mapping and account-scoped route recovery.
  // Do not seed history here: it would override its published entry interface.
  window.TOEFLPlatformBridge = Object.freeze({
    storageKeys: Object.freeze(Object.fromEntries(names)),
    recordingDatabase: 'SchoolExamPlatform:toefl:recordings:v1',
  });
})();
