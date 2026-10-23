'use strict';
(() => {
  const auth=window.PlatformAuth;if(!auth?.user||!auth.active)return;
  const $=id=>document.getElementById(id), esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let users=[], timer, lastTrigger=null, loading=false;
  const dialog=$('account-dialog'), confirmDialog=$('confirm-dialog');
  const name=user=>user.displayName||user.name||user.username;
  const initial=user=>Array.from(name(user))[0]?.toUpperCase()||'?';
  const isActive=user=>user.active!==false;
  function toast(value){clearTimeout(timer);$('toast').textContent=value;$('toast').hidden=false;timer=setTimeout(()=>$('toast').hidden=true,3200);}
  function renderIdentity(){const user=auth.user;$('identity-name').textContent=name(user);$('identity-username').textContent=user.username;$('identity-avatar').textContent=initial(user);$('identity-role').textContent=user.role==='admin'?'管理员':'学生';$('identity-role').classList.toggle('admin',user.role==='admin');$('users-section').hidden=user.role!=='admin';$('page-title').textContent=user.role==='admin'?'账号管理':'个人中心';document.title=$('page-title').textContent+' · Study Space';}
  function status(text,error=false){$('users-status').textContent=text;$('users-status').hidden=!text;$('users-status').classList.toggle('error',error);}
  function renderUsers(){
    const query=$('user-search').value.trim().toLocaleLowerCase(),role=$('role-filter').value,state=$('status-filter').value;
    const shown=users.filter(user=>(!query||(user.username+' '+name(user)).toLocaleLowerCase().includes(query))&&(!role||user.role===role)&&(!state||isActive(user)===(state==='active')));
    $('user-count').textContent=String(users.length);
    $('user-list').innerHTML=shown.map(user=>`<tr><td><div class="user-cell"><span class="user-avatar" aria-hidden="true">${esc(initial(user))}</span><span><strong>${esc(user.username)}</strong>${String(user.id)===String(auth.user.id)?'<span class="self-label">我</span>':''}<small>${esc(name(user))}</small></span></div></td><td><span class="role-pill ${user.role==='admin'?'admin':''}">${user.role==='admin'?'管理员':'学生'}</span></td><td><span class="status-pill ${isActive(user)?'':'inactive'}">${isActive(user)?'已启用':'已停用'}</span></td><td><div class="user-actions"><button type="button" data-action="edit" data-id="${esc(user.id)}" aria-label="管理 ${esc(user.username)}">管理</button><button type="button" data-action="reset" data-id="${esc(user.id)}" aria-label="重置 ${esc(user.username)} 的密码">重置密码</button><button type="button" data-action="toggle" data-id="${esc(user.id)}" class="${isActive(user)?'danger-action':''}" aria-label="${isActive(user)?'停用':'启用'} ${esc(user.username)}">${isActive(user)?'停用':'启用'}</button></div></td></tr>`).join('');
    status(shown.length?'':query||role||state?'没有符合条件的账号':'暂无账号');
  }
  async function loadUsers(){if(loading||auth.user.role!=='admin')return;loading=true;$('reload-users').disabled=true;status('正在读取账号…');try{const result=await auth.api('/api/admin/users');users=Array.isArray(result)?result:result.users||[];renderUsers();}catch(error){status(error.message,true);}finally{loading=false;$('reload-users').disabled=false;}}
  function confirmAction(title,message,label='确认'){
    $('confirm-title').textContent=title;$('confirm-message').textContent=message;$('confirm-ok').textContent=label;confirmDialog.returnValue='';confirmDialog.showModal();$('confirm-cancel').focus();
    return new Promise(resolve=>{confirmDialog.addEventListener('close',()=>resolve(confirmDialog.returnValue==='confirm'),{once:true});});
  }
  $('confirm-cancel').addEventListener('click',()=>confirmDialog.close('cancel'));$('confirm-ok').addEventListener('click',()=>confirmDialog.close('confirm'));
  function openForm(kind,user){
    lastTrigger=document.activeElement;let title='',fields='';
    if(kind==='create'){
      title='创建账号';fields='<label class="field">账号<input name="username" autocomplete="off" autocapitalize="none" spellcheck="false" minlength="3" maxlength="40" pattern="[A-Za-z0-9]([A-Za-z0-9_.]|-){2,39}" required></label><p class="field-hint">3–40 位，以字母或数字开头，支持字母、数字、下划线、点和连字符。</p><label class="field">显示名称<input name="displayName" autocomplete="off" maxlength="60"></label><label class="field">初始密码<input name="password" type="password" autocomplete="new-password" minlength="6" maxlength="256" required></label><label class="field">角色<select name="role"><option value="student">学生</option><option value="admin">管理员</option></select></label>';
    }else if(kind==='edit'){
      title='管理账号';fields=`<label class="field">账号<input value="${esc(user.username)}" readonly></label><label class="field">显示名称<input name="displayName" value="${esc(name(user))}" maxlength="60" required></label><label class="field">角色<select name="role"><option value="student" ${user.role==='student'?'selected':''}>学生</option><option value="admin" ${user.role==='admin'?'selected':''}>管理员</option></select></label>`;
    }else if(kind==='reset'){
      title='重置密码';fields=`<label class="field">账号<input value="${esc(user.username)}" readonly></label><label class="field">新密码<input type="password" name="password" autocomplete="new-password" minlength="6" maxlength="256" required></label><label class="field">确认新密码<input type="password" name="confirmPassword" autocomplete="new-password" minlength="6" maxlength="256" required></label><p class="field-hint">至少 6 位。重置后，此账号的所有设备需要重新登录。</p>`;
    }else if(kind==='profile'){
      title='编辑资料';fields=`<label class="field">账号<input value="${esc(auth.user.username)}" readonly></label><label class="field">显示名称<input name="displayName" value="${esc(name(auth.user))}" maxlength="60" autocomplete="nickname" required></label>`;
    }else{
      title='修改密码';fields='<label class="field">当前密码<input type="password" name="currentPassword" autocomplete="current-password" maxlength="256" required></label><label class="field">新密码<input type="password" name="password" autocomplete="new-password" minlength="6" maxlength="256" required></label><label class="field">确认新密码<input type="password" name="confirmPassword" autocomplete="new-password" minlength="6" maxlength="256" required></label><p class="field-hint">至少 6 位。修改后，所有设备需要重新登录。</p>';
    }
    $('account-dialog-title').textContent=title;
    $('account-dialog-content').innerHTML=`<form id="account-form" class="account-form">${fields}<p class="form-error" id="form-error" role="alert"></p><div class="dialog-actions"><button type="button" class="button" data-close>取消</button><button type="submit" class="button primary">${kind==='create'?'创建账号':kind==='reset'?'重置密码':'保存'}</button></div></form>`;
    const form=$('account-form');
    form.addEventListener('submit',async event=>{
      event.preventDefault();const button=form.querySelector('[type="submit"]');if(button.disabled)return;button.disabled=true;$('form-error').textContent='';
      const value=Object.fromEntries(new FormData(form));
      try{
        if(value.confirmPassword!==undefined&&value.password!==value.confirmPassword)throw new Error('两次输入的新密码不一致。');
        if(kind==='create'){
          if(value.role==='admin'&&!await confirmAction('创建管理员',`将授予 ${value.username.trim()} 创建、停用账号和重置密码的权限。`,'创建管理员'))return;
          await auth.api('/api/admin/users',{method:'POST',body:{username:value.username.trim(),displayName:value.displayName.trim()||value.username.trim(),password:value.password,role:value.role}});
        }else if(kind==='edit'){
          if(value.role!==user.role&&!await confirmAction('更改角色',`将 ${user.username} 设为${value.role==='admin'?'管理员，可管理其他账号':'学生，取消账号管理权限'}。`,'更改角色'))return;
          const result=await auth.api('/api/admin/users/'+encodeURIComponent(user.id),{method:'PATCH',body:{displayName:value.displayName.trim(),role:value.role}});
          if(String(user.id)===String(auth.user.id)){if(value.role!==user.role){auth.announce('logout');auth.invalidate('updated');return;}auth.updateUser(result.user||result);auth.announce('profile');}
        }else if(kind==='reset'){
          if(!await confirmAction('重置密码',`确认重置 ${user.username} 的密码？此账号的所有登录会话将失效。`,'重置密码'))return;
          await auth.api('/api/admin/users/'+encodeURIComponent(user.id)+'/password',{method:'POST',body:{password:value.password}});
          if(String(user.id)===String(auth.user.id)){auth.invalidate('password');return;}
        }else if(kind==='profile'){
          const result=await auth.api('/api/me',{method:'PATCH',body:{displayName:value.displayName.trim()}});auth.updateUser(result.user||result);auth.announce('profile');
        }else{
          await auth.api('/api/auth/password',{method:'POST',body:{currentPassword:value.currentPassword,newPassword:value.password}});
          form.reset();auth.announce('logout');auth.invalidate('password');return;
        }
        form.reset();dialog.close();renderIdentity();toast(kind==='create'?'账号已创建':kind==='reset'?'密码已重置':'已保存');await loadUsers();
      }catch(error){$('form-error').textContent=error.message;}finally{button.disabled=false;}
    });
    dialog.showModal();
  }
  document.addEventListener('click',async event=>{
    if(event.target.closest('[data-close]'))dialog.close();
    const button=event.target.closest('[data-action]');if(!button)return;
    const user=users.find(item=>String(item.id)===button.dataset.id);if(!user)return;
    if(button.dataset.action!=='toggle'){openForm(button.dataset.action,user);return;}
    const action=isActive(user)?'停用':'启用';
    if(!await confirmAction(action+'账号',`确认${action} ${user.username}？${isActive(user)?'停用后，该账号将立即退出并无法登录。':'该账号将可以重新登录。'}`,action))return;
    button.disabled=true;try{await auth.api('/api/admin/users/'+encodeURIComponent(user.id),{method:'PATCH',body:{active:!isActive(user)}});if(String(user.id)===String(auth.user.id)){auth.invalidate();return;}toast('账号已'+action);await loadUsers();}catch(error){toast(error.message);button.disabled=false;}
  });
  dialog.addEventListener('close',()=>{if(lastTrigger?.isConnected)lastTrigger.focus();});
  for(const modal of [dialog,confirmDialog])modal.addEventListener('click',event=>{if(event.target!==modal)return;const rect=modal.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)modal.close('cancel');});
  $('edit-profile').addEventListener('click',()=>openForm('profile'));$('change-password').addEventListener('click',()=>openForm('password'));$('create-user').addEventListener('click',()=>openForm('create'));$('reload-users').addEventListener('click',loadUsers);
  $('user-search').addEventListener('input',renderUsers);$('role-filter').addEventListener('change',renderUsers);$('status-filter').addEventListener('change',renderUsers);
  $('logout').addEventListener('click',async()=>{$('logout').disabled=true;try{await auth.logout();}catch(error){toast(error.message);$('logout').disabled=false;}});
  document.addEventListener('platform:user',()=>{renderIdentity();if(auth.user.role!=='admin'){users=[];$('user-list').replaceChildren();}});
  renderIdentity();loadUsers();
})();
