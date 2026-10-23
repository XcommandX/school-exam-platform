'use strict';
(() => {
  const paths = {
    arrow:'<path d="M5 12h14m-5-5 5 5-5 5"/>',chevron:'<path d="m9 5 7 7-7 7"/>',chevronDown:'<path d="m6 9 6 6 6-6"/>',close:'<path d="m6 6 12 12M6 18 18 6"/>',
    book:'<path d="M12 5.5C9.2 3.5 5.5 3.5 3 4.5v15c2.5-1 6.2-1 9 1 2.8-2 6.5-2 9-1v-15c-2.5-1-6.2-1-9 1Zm0 0v15"/>',
    headphones:'<path d="M4 14v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="12" width="4" height="8" rx="2"/><rect x="17" y="12" width="4" height="8" rx="2"/>',
    mic:'<rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2m-7 9v3m-4 0h8"/>',
    pencil:'<path d="m15 5 4 4M4 20l4.5-1L20 7.5a2.8 2.8 0 0 0-4-4L4.5 15 4 20Z"/>',
    globe:'<circle cx="12" cy="12" r="9"/><path d="m5 5 3 3-1 4 4 2 1 7m0-18 2 5 5 1 2 4-5 3-2-3 2-4"/>',
    sigma:'<path d="M19 4H5l7 8-7 8h14"/>',calculator:'<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M8 6h8M8 10h1m3 0h1m3 0h0M8 14h1m3 0h1m3 0h0M8 18h1m3 0h1m3 0h0"/>',
    cap:'<path d="m2 9 10-5 10 5-10 5L2 9Zm4 2v6c4 3 8 3 12 0v-6m4-2v7"/>',plane:'<path d="m21 3-6 18-4-8-8-4 18-6ZM11 13 21 3"/>',landmark:'<path d="m3 9 9-6 9 6H3Zm2 3v6m5-6v6m4-6v6m5-6v6M3 21h18"/>',
    function:'<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 9h8m-7 8c4 0 1-10 6-10"/>',sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4M17.6 17.6 19 19M5 19l1.4-1.4M17.6 6.4 19 5"/>',
    flame:'<path d="M12 2c1 6-5 7-5 11 0 2 1 3 2 3-1-3 2-4 3-6 3 3 6 5 5 8a6 6 0 0 1-11-1C3 12 9 8 9 5c2 1 2 2 3 3 1-2 1-4 0-6Z"/>',
    check:'<path d="m8 12 3 3 7-8"/><path d="M21 11v1a9 9 0 1 1-5-8"/>',trophy:'<path d="M8 3h8v7a4 4 0 0 1-8 0V3Zm0 2H4v3a4 4 0 0 0 4 4m8-7h4v3a4 4 0 0 1-4 4m-4 2v7m-4 0h8"/>',
    user:'<circle cx="12" cy="8" r="3.5"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/>',target:'<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
    calendar:'<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18m-13 5 3 3 5-5"/>',chart:'<path d="M4 3v18h17M8 17v-5m5 5V8m5 9V4m-11 5 5-4 5 2 4-5"/>',history:'<path d="M3 11a9 9 0 1 1 2.4 7M3 5v6h6m3-4v5l3 2"/>',
    star:'<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z"/>',settings:'<path d="m9 3-.7 2.2-2 .9L4 5.6l-2 3.5L3.6 11v2L2 14.9l2 3.5 2.3-.5 2 .9L9 21h4l.7-2.2 2-.9 2.3.5 2-3.5-1.6-1.9v-2L20 9.1l-2-3.5-2.3.5-2-.9L13 3H9Z"/><circle cx="11" cy="12" r="3"/>',
  };
  const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.book}</svg>`;
  const esc = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const $ = id => document.getElementById(id);
  const format = n => new Intl.NumberFormat('zh-CN').format(n);
  const auth = window.PlatformAuth;
  if (!auth?.user?.id || !auth.active) return;
  const accountId = String(auth.user.id), prefix = `school-exam-platform:account:${accountId}:`;
  const keys = {plan:prefix+'home:plan:v1',targets:prefix+'home:targets:v1',preferences:prefix+'preferences:v1',history:prefix+'toefl:four.history.v1',learning:prefix+'toefl:four.learning.v1'};
  let homeRevision = null, homeLoaded = false, homeConflict = false, homeSaving = false;
  function renderUser() {
    const user=auth.user, name=user.displayName||user.name||user.username;
    document.querySelectorAll('[data-user-name]').forEach(el=>{el.textContent=name;el.title=name;});
    document.querySelectorAll('[data-user-initial]').forEach(el=>{el.textContent=Array.from(name)[0]?.toUpperCase()||'?';});
    $('account-button').setAttribute('aria-label',`${name} 的个人账号与设置`);
    $('account-role').textContent=user.role==='admin'?'管理员':'学生';
    $('manage-accounts').hidden=user.role!=='admin';
  }
  function applyHome(value={}) {
    const p=value.plan||{};
    state.plan={dailyGoal:Number.isInteger(p.dailyGoal)&&p.dailyGoal>=1&&p.dailyGoal<=500?p.dailyGoal:30,note:typeof p.note==='string'?p.note.slice(0,500):''};
    state.targets=HomeModel.targets(value.targets||{});
    state.preferences={reduceMotion:Boolean(value.preferences?.reduceMotion)};
    save(keys.plan,state.plan);save(keys.targets,state.targets);save(keys.preferences,state.preferences);
    renderStats();
  }
  async function loadHome() {
    const response=await auth.api('/api/me/home');
    homeRevision=response.revision;homeLoaded=true;homeConflict=false;
    applyHome(response.value||{});note('home','');
  }
  async function saveHome(patch) {
    if(homeSaving)throw new Error('正在保存，请稍候。');
    if(homeConflict)throw new Error('设置已在其他页面更新，请先读取最新设置。');
    if(!homeLoaded)throw new Error('设置尚未读取成功，请刷新页面后重试。');
    homeSaving=true;
    try {
      const value={plan:state.plan,targets:state.targets,preferences:state.preferences,...patch};
      const result=await auth.api('/api/me/home',{method:'PUT',body:{value,revision:homeRevision}});
      homeRevision=result.revision;applyHome(result.value||value);return true;
    } catch(error) {
      if(error.status===409){homeConflict=true;error.message='设置已在其他页面更新。读取最新设置后，再进行修改。';}
      throw error;
    } finally {homeSaving=false;}
  }
  function showFormError(error) {
    const el=$('form-error');if(!el){toast(error.message);return;}
    el.textContent=error.message;
    if(homeConflict){const button=document.createElement('button');button.type='button';button.className='button';button.dataset.reloadHome='true';button.textContent='读取最新设置';el.append(document.createElement('br'),button);}
  }
  const notes = new Map();
  let storageUnavailable=false, lastTrigger=null, toastTimer, refreshId=0;
  function read(key, fallback) {try{return JSON.parse(localStorage.getItem(key)) ?? fallback;}catch {storageUnavailable=true;return fallback;}}
  const array = v => Array.isArray(v) ? v : [];
  const savedPlan = read(keys.plan,{});
  const state = {plan:{dailyGoal:Number.isInteger(savedPlan?.dailyGoal)&&savedPlan.dailyGoal>=1&&savedPlan.dailyGoal<=500?savedPlan.dailyGoal:30,note:typeof savedPlan?.note==='string'?savedPlan.note.slice(0,500):''},targets:HomeModel.targets(read(keys.targets,{})),preferences:read(keys.preferences,{}),summary:HomeModel.summarize()};
  if (!state.preferences || typeof state.preferences!=='object') state.preferences={};
  function note(id, text) {if(text)notes.set(id,text);else notes.delete(id);$('service-note').hidden=!notes.size;$('service-note').textContent=[...notes.values()].join(' ');}
  function toast(message) {clearTimeout(toastTimer);$('toast').textContent=message;$('toast').hidden=false;toastTimer=setTimeout(()=>$('toast').hidden=true,2800);}
  function save(key,value) {try{localStorage.setItem(key,JSON.stringify(value));return true;}catch {note('storage','浏览器无法保存记录；本次调整仅在当前页面有效。');return false;}}
  function fillIcons(root=document) {root.querySelectorAll('[data-icon]').forEach(el=>{el.innerHTML=icon(el.dataset.icon);});}
  function renderStats() {
    const s=state.summary,t=state.targets;
    renderUser();
    $('streak-days').textContent=format(s.streak);$('today-progress').textContent=`${format(s.today)} / ${state.plan.dailyGoal}`;
    $('menu-streak').textContent=format(s.streak);$('menu-answers').textContent=format(s.all.answers);$('menu-accuracy').textContent=s.all.graded?`${Math.round(s.all.correct/s.all.graded*100)}%`:'—';
    $('toefl-target').textContent=t.toefl?t.toefl.total.toFixed(1):'—';$('sat-target').textContent=t.sat?format(t.sat.total):'—';
    $('target-tooltip').innerHTML=`<strong>TOEFL 目标 · ${t.toefl?t.toefl.total.toFixed(1):'未设置'}</strong><p>${t.toefl?`阅读 ${t.toefl.reading.toFixed(1)} · 听力 ${t.toefl.listening.toFixed(1)}<br>口语 ${t.toefl.speaking.toFixed(1)} · 写作 ${t.toefl.writing.toFixed(1)}`:''}</p><hr><strong>SAT 目标 · ${t.sat?format(t.sat.total):'未设置'}</strong><p>${t.sat?`英语 ${t.sat.english} · 数学 ${t.sat.math}`:''}</p>`;
    const hour=new Date().getHours();$('greeting').textContent=hour<6?'夜深了':hour<12?'上午好':hour<18?'下午好':'晚上好';
    document.body.classList.toggle('reduced-motion',Boolean(state.preferences.reduceMotion));
  }
  async function satLocalState() {
    const empty={attempts:[],pending:[]};
    if(!window.indexedDB)return empty;
    const name=`SchoolExamPlatform:account:${accountId}:sat:v1`;
    try {
      if(indexedDB.databases && !(await indexedDB.databases()).some(d=>d.name===name))return empty;
      const db=await new Promise((resolve,reject)=>{const req=indexedDB.open(name);req.onupgradeneeded=()=>req.transaction.abort();req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);req.onblocked=()=>reject(new Error('Storage busy'));});
      try {
        if(!db.objectStoreNames.contains('attempts'))return empty;
        const stores=['attempts',...(db.objectStoreNames.contains('accountSync')?['accountSync']:[])];
        return await new Promise((resolve,reject)=>{
          const tx=db.transaction(stores,'readonly'),a=tx.objectStore('attempts').getAll(),meta=stores.includes('accountSync')?tx.objectStore('accountSync').getAll():null;
          tx.oncomplete=()=>resolve({attempts:a.result||[],pending:(meta?.result||[]).filter(row=>row.kind==='attempts'&&row.pending&&!row.conflictId)});
          tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
        });
      } finally {db.close();}
    } catch {return empty;}
  }
  async function refresh() {
    const id=++refreshId;
    const [satResult,toeflResult,satServerResult]=await Promise.allSettled([satLocalState(),auth.api('/api/toefl/state'),auth.api('/api/sat/summary')]);
    if(id!==refreshId||!auth.active)return;
    const local=satResult.status==='fulfilled'?satResult.value:{attempts:[],pending:[]};
    let attempts=local.attempts;
    if(satServerResult.status==='fulfilled') {
      const merged=new Map(array(satServerResult.value.attempts).map(row=>[row.id,row]));
      for(const row of local.pending){if(row.pending.deleted)merged.delete(row.entityId);else if(row.pending.value)merged.set(row.entityId,row.pending.value);}
      attempts=[...merged.values()];note('sat-records',local.pending.length?'SAT 有本机记录等待同步。':'');
    } else note('sat-records','暂时无法读取已保存的 SAT 记录，当前显示本机缓存。');
    let history=array(read(keys.history,[])),learning=array(read(keys.learning,[]));
    if(toeflResult.status==='fulfilled') {
      const items=toeflResult.value.items||[];
      history=array(items.find(item=>item.key==='four.history.v1')?.value);
      learning=array(items.find(item=>item.key==='four.learning.v1')?.value);
      note('records','');
    } else note('records','暂时无法读取已保存的 TOEFL 记录，当前显示本机缓存。');
    state.summary=HomeModel.summarize(attempts,history,learning);
    renderStats();
    if(storageUnavailable)note('storage','浏览器存储暂不可用，学习统计可能无法显示。');
  }
  function destination(href,title) {return `<a href="${href}"><span><strong>${title}</strong></span>${icon('arrow')}</a>`;}
  function empty(title,symbol='book'){return `<div class="empty-state"><span data-icon="${symbol}"></span><h3>${title}</h3></div>`;}
  function input(name,label,value,min,max,step,placeholder='') {return `<label class="field">${label}<input type="number" name="${name}" value="${value??''}" min="${min}" max="${max}" step="${step}" placeholder="${placeholder}" inputmode="decimal"></label>`;}
  function statsTiles(s) {return `<div class="report-grid"><div class="report-stat"><b>${format(s.attempts)}</b><small>已完成练习</small></div><div class="report-stat"><b>${format(s.answers)}</b><small>已答题目</small></div><div class="report-stat"><b>${s.graded?Math.round(s.correct/s.graded*100)+'%':'—'}</b><small>客观题正确率</small></div></div>`;}
  const dialog=$('home-dialog');
  function open(name,trigger) {
    lastTrigger=trigger||document.activeElement;
    let title='',body='';const t=state.targets,s=state.summary;
    if(name==='targets') {
      title='目标分数';body=`<form id="targets-form"><fieldset class="form-section"><legend>TOEFL iBT（1–6 分，0.5 分档）</legend><div class="field-grid">${[['reading','阅读'],['listening','听力'],['speaking','口语'],['writing','写作']].map(([k,v])=>input('toefl-'+k,v,t.toefl?.[k],1,6,.5,'例如 5.0')).join('')}</div></fieldset><fieldset class="form-section"><legend>SAT（每科 200–800 分，10 分档）</legend><div class="field-grid">${input('sat-english','英语',t.sat?.english,200,800,10,'例如 700')}${input('sat-math','数学',t.sat?.math,200,800,10,'例如 800')}</div></fieldset><p class="field-hint" id="target-preview"></p><p class="form-error" id="form-error" role="alert"></p><div class="dialog-actions"><button class="button" type="button" data-close-dialog>取消</button><button class="button primary" type="submit">保存目标</button></div></form>`;
    } else if(name==='plan') {
      title='学习计划';body=`${statsTiles({attempts:s.streak,answers:s.today,graded:0,correct:0}).replace('已完成练习','连续坚持天数').replace('已答题目','今日完成').replace('<div class="report-stat"><b>—</b><small>客观题正确率</small></div>',`<div class="report-stat"><b>${state.plan.dailyGoal}</b><small>每日题目目标</small></div>`)}<form id="plan-form"><label class="field">每日学习目标（题）<input type="number" name="dailyGoal" required min="1" max="500" step="1" value="${state.plan.dailyGoal}" inputmode="numeric"></label><label class="field" style="margin-top:14px">给自己的计划<textarea name="note" maxlength="500" placeholder="例如：先练英语，再复习今天的错题。">${esc(state.plan.note)}</textarea></label><p class="form-error" id="form-error" role="alert"></p><div class="dialog-actions"><button type="submit" class="button primary">保存计划</button></div></form><div class="destination-list" style="margin-top:24px">${destination('/toefl/?view=plan','TOEFL 今日学习')}${destination('/sat/?view=practiceBuilder&mode=custom','SAT 自定义训练')}</div>`;
    } else if(name==='report') {
      title='成绩报告';body=`${statsTiles(s.all)}<div class="destination-list">${destination('/toefl/?view=progress','TOEFL 学习进度')}${destination('/sat/?view=dashboard','SAT 练习报告')}</div>`;
    } else if(name==='records') {
      title='练习记录';body=(s.recent.length?`<ul class="records-list">${s.recent.map(r=>`<li><span><strong>${esc(r.name)}</strong><small>${esc(new Date(r.at).toLocaleString('zh-CN',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}))}</small></span><span>${format(r.answered)} 题</span></li>`).join('')}</ul>`:empty('从第一次练习开始','history'))+`<div class="destination-list">${destination('/toefl/?view=report','TOEFL 考试记录')}${destination('/sat/?view=history','SAT 练习记录')}</div>`;
    } else if(name==='saved') {
      title='我的收藏';body=`<div class="destination-list">${destination('/sat/?view=wrongBook','SAT 错题本')}${destination('/toefl/?view=wrongBook','TOEFL 错题本')}${destination('/toefl/?view=vocab','TOEFL 词汇训练')}</div>`;
    } else if(name==='account') {
      title='个人中心';body=`<div class="profile-row"><span class="avatar large">${esc(Array.from(auth.user.displayName||auth.user.username)[0]?.toUpperCase())}</span><div><h3>${esc(auth.user.username)}</h3><p>${auth.user.role==='admin'?'管理员':'学生'}</p></div></div><form id="profile-form"><label class="field">显示名称<input name="displayName" value="${esc(auth.user.displayName||auth.user.name||auth.user.username)}" maxlength="60" required autocomplete="nickname"></label><p class="form-error" id="form-error" role="alert"></p><div class="dialog-actions"><button class="button primary" type="submit">保存资料</button></div></form>`;
    } else if(name==='password') {
      title='修改密码';body=`<form id="password-form"><label class="field">当前密码<input type="password" name="currentPassword" autocomplete="current-password" maxlength="256" required></label><label class="field" style="margin-top:16px">新密码<input type="password" name="newPassword" autocomplete="new-password" minlength="6" maxlength="256" required></label><label class="field" style="margin-top:16px">确认新密码<input type="password" name="confirmPassword" autocomplete="new-password" minlength="6" maxlength="256" required></label><p class="field-hint">至少 6 位。修改后，所有设备需要重新登录。</p><p class="form-error" id="form-error" role="alert"></p><div class="dialog-actions"><button type="submit" class="button primary">更新密码</button></div></form>`;
    } else if(name==='settings') {
      title='设置';body=`<p class="form-error" id="form-error" role="alert"></p><label class="setting-row"><span>减少界面动画</span><input type="checkbox" id="reduce-motion" ${state.preferences.reduceMotion?'checked':''}></label><div class="destination-list" style="margin-top:18px">${destination('/sat/?view=timingSettings','SAT 计时设置')}</div><div class="dialog-actions"><button class="button" type="button" data-dialog="plan">每日目标</button><button class="button" type="button" data-dialog="targets">目标分数</button><button class="button primary" type="button" data-close-dialog>完成</button></div>`;
    } else if(name==='math') {title='SAT 数学';body=`<div class="dialog-actions"><a class="button primary" href="/sat/?view=practiceBuilder&mode=custom&section=math">开始数学练习 ${icon('arrow')}</a></div>`;
    } else if(name==='ap') {title='AP';body=empty('AP 尚未接入');
    } else if(name==='vocab') {title='Personal Vocab';body=empty('Personal Vocab 尚未接入','book')+`<div class="dialog-actions"><a class="button primary" href="/toefl/?view=vocab">TOEFL 词汇训练 ${icon('arrow')}</a></div>`;
    } else return;
    $('dialog-title').textContent=title;$('dialog-content').innerHTML=body;fillIcons(dialog);
    if(!dialog.open)dialog.showModal();
    if(name==='targets')updateTargetPreview();
  }
  function formTargets() {
    const f=$('targets-form');if(!f)return {};
    const group=(exam,fields)=>{const values=fields.map(k=>f.elements[`${exam}-${k}`].value);if(values.every(v=>v===''))return null;if(values.some(v=>v===''))throw new Error(`请填全 ${exam==='toefl'?'TOEFL 四科':'SAT 两科'}目标，或将整组留空。`);return Object.fromEntries(fields.map((k,i)=>[k,Number(values[i])]));};
    return {toefl:group('toefl',['reading','listening','speaking','writing']),sat:group('sat',['english','math'])};
  }
  function updateTargetPreview(){try{const t=HomeModel.targets(formTargets());$('target-preview').textContent=`总目标：TOEFL ${t.toefl?t.toefl.total.toFixed(1):'—'} · SAT ${t.sat?format(t.sat.total):'—'}`;}catch{$('target-preview').textContent='填全各科后，将在这里显示总目标。';}}
  function setMenu(show, focus=false) {$('account-menu').hidden=!show;$('account-button').setAttribute('aria-expanded',String(show));if(show&&focus)$('account-menu').querySelector('button').focus();}
  document.addEventListener('click',async e=>{
    if(e.target.closest('#manage-accounts')){location.href='/account';return;}
    if(e.target.closest('#logout-button')){const button=e.target.closest('button');button.disabled=true;try{await auth.logout();}catch(error){toast(error.message);button.disabled=false;}return;}
    if(e.target.closest('[data-reload-home]')){try{await loadHome();dialog.close();toast('已读取最新设置，请重新打开并修改。');}catch(error){showFormError(error);}return;}
    const account=e.target.closest('#account-button');if(account)setMenu($('account-menu').hidden);else if(!e.target.closest('#account-menu')&&!dialog.contains(e.target)&&!e.target.closest('a,button,input,select,textarea,label,summary'))setMenu(false);
    const trigger=e.target.closest('[data-dialog]');if(trigger)open(trigger.dataset.dialog,trigger);
    if(e.target.closest('[data-close-dialog]'))dialog.close();
  });
  document.addEventListener('submit',async e=>{
    if(!['targets-form','plan-form','profile-form','password-form'].includes(e.target.id))return;
    e.preventDefault();const form=e.target,button=form.querySelector('[type="submit"]');if(button.disabled)return;button.disabled=true;
    try {
      if(form.id==='targets-form') {
        const raw=formTargets(),next=HomeModel.targets(raw);
        if((raw.toefl&&!next.toefl)||(raw.sat&&!next.sat))throw new Error('请按各考试的分数范围和分档填写。');
        await saveHome({targets:next});dialog.close();toast('目标分数已保存');
      } else if(form.id==='plan-form') {
        const goal=Number(form.elements.dailyGoal.value);
        if(!Number.isInteger(goal)||goal<1||goal>500)throw new Error('每日目标请输入 1–500 的整数。');
        await saveHome({plan:{dailyGoal:goal,note:form.elements.note.value.trim().slice(0,500)}});dialog.close();toast('学习计划已保存');
      } else if(form.id==='profile-form') {
        const result=await auth.api('/api/me',{method:'PATCH',body:{displayName:form.elements.displayName.value.trim()}});
        auth.updateUser(result.user||result);auth.announce('profile');renderUser();dialog.close();toast('个人资料已保存');
      } else {
        if(form.elements.newPassword.value!==form.elements.confirmPassword.value)throw new Error('两次输入的新密码不一致。');
        await auth.api('/api/auth/password',{method:'POST',body:{currentPassword:form.elements.currentPassword.value,newPassword:form.elements.newPassword.value}});
        form.reset();auth.announce('logout');auth.invalidate('password');
      }
    }catch(error){showFormError(error);}finally{button.disabled=false;}
  });
  document.addEventListener('input',e=>{if(e.target.closest('#targets-form')){updateTargetPreview();$('form-error').textContent='';}});
  document.addEventListener('change',async e=>{if(e.target.id==='reduce-motion'){const input=e.target;input.disabled=true;try{await saveHome({preferences:{...state.preferences,reduceMotion:input.checked}});}catch(error){input.checked=Boolean(state.preferences.reduceMotion);showFormError(error);}finally{input.disabled=false;}}});
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape'&&!$('account-menu').hidden){setMenu(false);$('account-button').focus();}
    if(e.target.id==='account-button'&&e.key==='ArrowDown'){e.preventDefault();setMenu(true,true);}
    if(!e.target.closest('#account-menu')||!['ArrowUp','ArrowDown','Home','End'].includes(e.key))return;
    e.preventDefault();const buttons=[...$('account-menu').querySelectorAll('button:not([hidden]):not(:disabled)')],i=buttons.indexOf(document.activeElement);buttons[e.key==='Home'?0:e.key==='End'?buttons.length-1:(i+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length].focus();
  });
  dialog.addEventListener('close',()=>{(lastTrigger?.isConnected?lastTrigger:$('account-button')).focus();});
  dialog.addEventListener('click',e=>{if(e.target!==dialog)return;const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();});
  window.addEventListener('focus',refresh);window.addEventListener('pageshow',refresh);
  window.addEventListener('storage',e=>{if([keys.history,keys.learning].includes(e.key))refresh();});
  document.addEventListener('platform:user',renderUser);
  fillIcons();renderStats();refresh();
  loadHome().catch(()=>note('home','暂时无法读取已保存的学习设置，请刷新页面后重试。'));
  auth.api('/api/toefl/status').then(info=>note('toefl',info.available?'':'TOEFL 暂未就绪，请稍后重试。')).catch(()=>note('toefl','暂时无法连接学习服务，请稍后重试。'));
  window.PlatformHome=Object.freeze({open,refresh,examRoutes:Object.freeze({sat:'/sat/?view=dashboard',toefl:'/toefl/',ap:()=>open('ap'),vocab:()=>open('vocab')})});
})();
