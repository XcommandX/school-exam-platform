// Deployment-only setup screen. The one-use secret is supplied in a URL
// fragment, immediately removed from browser history and never sent in a GET.
export const setupHTML=`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>创建管理员 · Study Space</title><link rel="stylesheet" href="/web/styles.css"><link rel="stylesheet" href="/web/login.css"><script src="/setup.js" defer></script></head>
<body class="login-page"><header class="site-header"><a class="brand" href="/login"><span class="brand-type">Study Space</span></a></header><main class="login-shell"><section class="login-panel" aria-labelledby="setup-title"><h1 id="setup-title">创建管理员</h1><form id="setup-form">
<label class="field" for="setup-token">初始化凭证<input id="setup-token" type="password" autocomplete="off" required maxlength="256"></label>
<label class="field" for="username">账号<input id="username" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="40" required></label>
<label class="field" for="display-name">显示名称<input id="display-name" name="displayName" autocomplete="nickname" maxlength="60" required></label>
<label class="field" for="password">密码<input id="password" name="password" type="password" autocomplete="new-password" minlength="6" maxlength="256" required></label>
<label class="field" for="confirm-password">确认密码<input id="confirm-password" type="password" autocomplete="new-password" minlength="6" maxlength="256" required></label>
<p class="login-status" id="setup-status" role="status" aria-live="polite">密码只在此页面设置，请勿发送到聊天中。此入口只能创建第一个管理员。</p><button class="login-submit" id="setup-submit" type="submit">创建并登录</button></form></section></main></body></html>`;
export const setupJS=`'use strict';
(() => {
  const byId=id=>document.getElementById(id);
  const token=new URLSearchParams(location.hash.slice(1)).get('token');
  history.replaceState(null,'',location.pathname);
  if(token){byId('setup-token').value=token;byId('setup-token').closest('label').hidden=true;}
  byId('setup-form').addEventListener('submit',async event=>{
    event.preventDefault();const status=byId('setup-status'),button=byId('setup-submit');
    if(byId('password').value!==byId('confirm-password').value){status.textContent='两次密码不一致。';return;}
    button.disabled=true;status.textContent='正在创建管理员…';
    try{
      const response=await fetch('/api/auth/bootstrap',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({setupToken:byId('setup-token').value,username:byId('username').value,password:byId('password').value,displayName:byId('display-name').value})});
      const value=await response.json();if(!response.ok)throw new Error(value.error||'创建失败，请稍后重试。');
      byId('setup-form').reset();location.replace('/account');
    }catch(error){status.textContent=error.message;button.disabled=false;}
  });
})();`;
