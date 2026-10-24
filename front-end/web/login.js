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
  const register = document.getElementById('register-form'), sent = document.getElementById('registration-sent');
  const registerStatus = document.getElementById('register-status'), registerSubmit = document.getElementById('register-submit');
  const switcher = document.getElementById('auth-switch'), loginTab = document.getElementById('show-login'), registerTab = document.getElementById('show-register');
  let registrationEnabled = false, submitting = false;
  function mode(registering) {
    if (submitting || submit.disabled || registering && !registrationEnabled) return;
    form.hidden = registering; register.hidden = !registering; sent.hidden = true;
    document.getElementById('login-title').textContent = registering ? '注册' : '登录';
    document.title = (registering ? '注册' : '登录') + ' · Study Space';
    loginTab.setAttribute('aria-pressed', String(!registering)); registerTab.setAttribute('aria-pressed', String(registering));
    password.value = ''; register.elements.password.value = ''; register.elements.confirmPassword.value = '';
    register.elements.confirmPassword.setCustomValidity('');
    if (!register.dataset.unavailable) {registerStatus.textContent = ''; registerStatus.classList.remove('error');}
    (registering ? register.elements.username : form.elements.username).focus();
  }
  loginTab.addEventListener('click', () => mode(false));
  registerTab.addEventListener('click', () => mode(true));
  document.getElementById('back-to-login').addEventListener('click', () => mode(false));
  register.addEventListener('input', () => {
    register.elements.confirmPassword.setCustomValidity('');
    if (!register.dataset.unavailable && registerStatus.classList.contains('error')) {registerStatus.textContent = ''; registerStatus.classList.remove('error');}
  });
  register.addEventListener('submit', async event => {
    event.preventDefault(); if (submitting || !registrationEnabled || register.dataset.unavailable) return;
    if (register.elements.password.value !== register.elements.confirmPassword.value) {
      register.elements.confirmPassword.setCustomValidity('两次输入的密码不一致。'); register.elements.confirmPassword.reportValidity(); return;
    }
    submitting = true; registerSubmit.disabled = true; loginTab.disabled = registerTab.disabled = true;
    register.setAttribute('aria-busy', 'true'); registerStatus.classList.remove('error'); registerStatus.textContent = '正在提交注册申请…';
    try {
      const username = register.elements.username.value.trim();
      const result = await auth.api('/api/auth/register', {method:'POST', body:{username, displayName:register.elements.displayName.value.trim(), password:register.elements.password.value}});
      if (result.pending !== true) throw new Error('申请未完成，请重试。');
      register.reset(); form.elements.username.value = username; register.hidden = true; sent.hidden = false;
      document.getElementById('sent-title').focus();
    } catch (error) {registerStatus.textContent = error.message; registerStatus.classList.add('error');}
    finally {submitting = false; registerSubmit.disabled = false; loginTab.disabled = registerTab.disabled = false; register.removeAttribute('aria-busy');}
  });
  // The original local Python server does not expose registration. Keep its login usable.
  auth.api('/api/auth/registration-config').then(config => {
    if (typeof config.enabled !== 'boolean' || config.mode !== 'admin') return;
    registrationEnabled = true; switcher.hidden = false;
    if (!config.enabled) {
      registerSubmit.disabled = true;
      registerStatus.textContent = '注册暂未开放，请联系管理员或稍后再试。';
      registerStatus.classList.add('error');
      register.dataset.unavailable = 'true';
    }
  }).catch(() => {});
  auth.verify().then(session => {if(session?.authenticated && !params.has('reason')) location.replace(next);}).catch(() => {});
})();
