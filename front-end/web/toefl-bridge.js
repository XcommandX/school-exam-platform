'use strict';
// This module is the platform-only TOEFL entry point. The anonymous preview
// keeps its original scripts and never loads this authenticated adapter.
const auth = window.PlatformAuth;
const user = auth?.user || window.PlatformSession?.user;
const namespace = user?.id ? 'school-exam-platform:account:' + user.id + ':toefl:' : null;
const keys = ['four.history.v1', 'four.drafts.v2', 'four.draft.v1', 'four.words.v1',
  'four.learning.v1', 't1lab.history.v1', 'practice.ui.v1'];

function lock() {
  if (auth?.invalidate) auth.invalidate('expired');
  else location.replace('/login?next=' + encodeURIComponent(location.pathname + location.search));
}

async function initialize() {
  if (!location.pathname.startsWith('/toefl/') || !user?.id || !namespace) {
    lock();
    return;
  }
  const recordingDatabase = 'SchoolExamPlatform:account:' + user.id + ':toefl:recordings:v1';
  window.TOEFLPlatformBridge = Object.freeze({
    userId: user.id,
    storageKeys: Object.freeze(Object.fromEntries(keys.map(key => [key, namespace + key]))),
    recordingDatabase,
  });
  window.TOEFLCloudConfig = Object.freeze({
    apiPath(path) {
      if (path === '/api/me') return '/api/me';
      if (!path.startsWith('/api/')) throw new Error('无效的同步地址。');
      return '/api/toefl/' + path.slice('/api/'.length);
    },
    headers: () => ({ 'X-Account-ID': user.id }),
    storageKey: (id, key) => {
      if (id !== user.id) throw new Error('账号已变更，请重新登录。');
      return namespace + key;
    },
    validateUser(me) {
      if (!me?.id || me.id !== user.id) {
        lock();
        throw new Error('账号已变更，请重新登录。');
      }
    },
    preserveLegacyStorage: true,
    recordingsReady: false,
    recordingDatabase,
    accountsUrl: '/account',
    lockChannel: 'school-exam-platform:toefl:lock',
    syncChannel: 'school-exam-platform:toefl:sync',
    lock,
    logout: () => auth.logout(),
  });
  const { initializeCloud } = await import('/web/toefl-cloud.js');
  await initializeCloud();
  if (auth && !auth.active) return;
  // No practice code runs until the server has verified the account and
  // restored only that account's learning state.
  for (const file of ['four-data.js', 'four-logic.js', 'four-learning.js', 'four-app.js']) {
    await import('/toefl/' + file);
  }
}

initialize().catch(error => {
  if (auth && !auth.active) return;
  const app = document.getElementById('app');
  if (!app) return;
  const message = document.createElement('p');
  message.textContent = error?.status === 401 ? '请重新登录。' : '学习记录暂时无法加载，请检查连接后重试。';
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.textContent = '重新加载';
  retry.addEventListener('click', () => location.reload());
  app.replaceChildren(message, retry);
});
