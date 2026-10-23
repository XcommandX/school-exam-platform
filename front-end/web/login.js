'use strict';
(() => {
  const auth = window.PlatformAuth, form = document.getElementById('login-form');
  const password = document.getElementById('password'), toggle = document.getElementById('password-toggle');
  const status = document.getElementById('login-status'), submit = document.getElementById('login-submit');
  const params = new URLSearchParams(location.search), next = auth.safeNext(params.get('next'));
  const reasons = {updated:'账号权限已更新，请重新登录。', expired:'登录已失效，请重新登录。', changed:'账号已在其他页面切换，请重新登录。', logout:'你已退出登录。', password:'密码已更新，请重新登录。'};
  status.textContent = reasons[params.get('reason')] || '';
  toggle.addEventListener('click', () => {const show = password.type === 'password'; password.type = show ? 'text' : 'password'; toggle.setAttribute('aria-pressed', String(show));toggle.setAttribute('aria-label',show?'隐藏密码':'显示密码');});
  form.addEventListener('input', () => {if(status.classList.contains('error')) {status.textContent='';status.classList.remove('error');}});
  form.addEventListener('submit', async event => {
    event.preventDefault(); if(submit.disabled) return;
    status.classList.remove('error');status.textContent = '正在登录…';submit.disabled = true;
    form.closest('.login-panel').setAttribute('aria-busy','true');
    try {
      const result = await auth.api('/api/auth/login',{method:'POST',body:{username:form.elements.username.value.trim(),password:password.value}});
      if (!result.authenticated || !result.user?.id) throw new Error('登录未完成，请重试。');
      password.value = '';auth.announce('login',String(result.user.id));location.replace(next);
    } catch(error) {status.textContent = error.message;status.classList.add('error');submit.disabled = false;form.closest('.login-panel').removeAttribute('aria-busy');}
  });
  auth.verify().then(session => {if(session?.authenticated && !params.has('reason')) location.replace(next);}).catch(() => {});
})();
