'use strict';
// One session owner per document. Never let an old page act as a newly signed-in user.
(() => {
  if (window.PlatformAuth) return;
  const initial = window.PlatformSession;
  let user = initial?.authenticated && initial.user?.id ? Object.freeze({...initial.user}) : null;
  const owner = user?.id ? String(user.id) : null;
  let active = Boolean(owner), verification = null;
  const eventKey = 'school-exam-platform:auth:event:v1';
  const publicPage = /^\/(?:login(?:\.html)?|web\/login\.html)\/?$/.test(location.pathname);
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('school-exam-platform-auth') : null;
  function safeNext(value) {
    try {
      if (!value || !String(value).startsWith('/') || String(value).startsWith('//') || /[\\\x00-\x1f]/.test(value)) return '/';
      const url = new URL(value, location.origin);
      if (url.origin !== location.origin || /^\/(?:login|api|web)(?:\/|\.|$)/.test(url.pathname)) return '/';
      return url.pathname + url.search + url.hash;
    } catch { return '/'; }
  }
  function invalidate(reason = 'expired') {
    active = false;
    document.dispatchEvent(new CustomEvent('platform:session-ended', {detail:{reason}}));
    if (!publicPage) location.replace('/login?reason=' + encodeURIComponent(reason) + '&next=' + encodeURIComponent(safeNext(location.pathname + location.search + location.hash)));
  }
  function announce(type, accountId = owner) {
    const event = {type, accountId, nonce:Date.now() + ':' + Math.random()};
    channel?.postMessage(event);
    try { localStorage.setItem(eventKey, JSON.stringify(event)); } catch { /* BroadcastChannel or focus verification remains available. */ }
  }
  function receive(event) {
    if (!owner || !active) return;
    if (event?.type === 'logout' || event?.type === 'login' && String(event.accountId) !== owner) invalidate('changed');
    else if (event?.type === 'profile') verify().catch(() => {});
  }
  channel?.addEventListener('message', event => receive(event.data));
  window.addEventListener('storage', event => { if (event.key === eventKey) {try {receive(JSON.parse(event.newValue));} catch {}} });
  async function api(path, options = {}) {
    if (!String(path).startsWith('/api/') || String(path).startsWith('//') || /[\\\x00-\x1f]/.test(path)) throw new Error('请求地址无效。');
    const method = (options.method || 'GET').toUpperCase();
    const publicRequest = path === '/api/auth/session' || path === '/api/auth/login';
    if (!publicRequest && (!active || !owner)) { invalidate(); throw new Error('登录已失效，请重新登录。'); }
    const headers = new Headers(options.headers || {});
    if (owner) headers.set('X-Account-ID', owner);
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    let response;
    try {
      response = await fetch(path, {...options, method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body), credentials:'same-origin', cache:'no-store'});
    } catch { throw new Error('暂时无法连接服务器，请检查连接后重试。'); }
    let value;
    try { value = await response.json(); } catch { value = {}; }
    if (!response.ok) {
      const error = new Error(value.message || value.error?.message || (typeof value.error === 'string' ? value.error : '') || '操作未完成，请稍后重试。');
      error.status = response.status; error.code = value.code || value.error?.code; error.data = value;
      if (!publicRequest && (response.status === 401 || error.code === 'account_changed' || error.code === 'session_changed' || error.code === 'account_mismatch')) invalidate('expired');
      throw error;
    }
    if (!publicRequest && !active) throw new Error('账号已切换，请重新打开页面。');
    return value;
  }
  async function verify() {
    if (verification) return verification;
    verification = (async () => {
      const session = await api('/api/auth/session');
      if (owner && (!session.authenticated || String(session.user?.id) !== owner)) {invalidate(session.authenticated ? 'changed' : 'expired');return null;}
      if (owner) updateUser(session.user);
      return session;
    })().finally(() => {verification = null;});
    return verification;
  }
  function updateUser(next) {
    if (!owner || String(next?.id) !== owner) return;
    user = Object.freeze({...user, ...next});
    document.dispatchEvent(new CustomEvent('platform:user', {detail:user}));
  }
  async function logout() {
    await api('/api/auth/logout', {method:'POST',body:{}});
    announce('logout');
    active = false;
    location.replace('/login?reason=logout');
  }
  window.PlatformAuth = Object.freeze({get user(){return user;}, get active(){return active;}, api, verify, logout, invalidate, updateUser, safeNext, announce});
  if (owner) {
    window.addEventListener('focus', () => verify().catch(() => {}));
    window.addEventListener('pageshow', () => verify().catch(() => {}));
    document.addEventListener('visibilitychange', () => {if (!document.hidden) verify().catch(() => {});});
  } else if (!publicPage) invalidate();
})();
