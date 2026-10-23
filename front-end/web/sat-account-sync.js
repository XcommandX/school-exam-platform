'use strict';
// Account sync journals only durable practice actions. Exam timers and the
// shared question library never become upload jobs.
(() => {
  const auth=window.PlatformAuth,owner=window.PlatformSession?.user?.id;
  if(!owner||!auth||!location.pathname.startsWith('/sat/'))return;
  const allowedSettings=new Set(['appConfig','practiceDurationPreferences','customPracticeDurationSeconds','timingTargets','questionTimer']);
  const paths={attempts:'attempts',wrongBook:'wrong-book',settings:'settings'};
  const protectedViews=new Set(['exam','ready','preparing','check','saving','congrats','moduleOver','sectionBreak','sectionReady']);
  let initialized=false,initializing=null,running=null,timer=null,status='正在加载学习记录…',pendingCount=0,conflictCount=0,applied=false,lastError='';
  let resolveReady,practiceRelease=null,practiceAcquiring=null;
  const ready=new Promise(resolve=>{resolveReady=resolve;});
  const channel=typeof BroadcastChannel==='function'?new BroadcastChannel('school-exam-platform:sat:sync:'+owner):null;
  const clone=value=>value===undefined?undefined:structuredClone(value);
  const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  const entityKey=(kind,id)=>kind+':'+id;
  const url=(kind,id)=>'/api/sat/'+paths[kind]+'/'+encodeURIComponent(id);
  const safe=()=>!window.SATApp||(!protectedViews.has(window.SATApp.appState.view)&&!window.SATApp.appState.busy);
  async function api(path,options={}){
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),60000);
    try{return await auth.api(path,{...options,signal:controller.signal});}finally{clearTimeout(timeout);}
  }
  const request=request=>new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  async function transaction(stores,work){
    const db=await SATStorage.open();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(stores,'readwrite');let result;
      tx.oncomplete=()=>resolve(result);
      tx.onabort=()=>reject(tx.error||new Error('本机同步队列未能保存。'));
      tx.onerror=()=>{};
      Promise.resolve().then(()=>work(tx)).then(value=>{result=value;}).catch(error=>{try{tx.abort();}catch{}reject(error);});
    });
  }
  function announce(message){
    status=message;
    window.dispatchEvent(new CustomEvent('sat-account-sync-status',{detail:{status,pending:pendingCount,conflicts:conflictCount}}));
  }
  async function counts(){
    const rows=await SATStorage.all('accountSync');
    pendingCount=rows.filter(row=>row.pending&&!row.conflictId).length;
    conflictCount=rows.filter(row=>row.conflictId).length;
    return rows;
  }
  async function finishStatus(message){
    await counts();
    announce(conflictCount?'有 '+conflictCount+' 项同步冲突待处理':message||lastError||(pendingCount?'有 '+pendingCount+' 项记录待同步':'已同步'));
  }
  function schedule(delay=1000){
    if(!initialized||timer||!auth.active)return;
    timer=setTimeout(()=>{timer=null;sync().catch(()=>{});},delay);
  }
  function clearRuntime(id){
    const key=window.SATPlatformBridge?.runtimeKey;
    if(!key)return;
    try{const value=JSON.parse(localStorage.getItem(key)||'null');if(value?.activePractice?.id===id)localStorage.removeItem(key);}catch{}
  }
  async function seedLocal(){
    // This is the already authenticated account's existing database. Never
    // inspect a legacy, anonymous or another account's namespace.
    await transaction(['attempts','wrongBook','settings','questions','sources','accountSync'],async tx=>{
      const metadata=tx.objectStore('accountSync');
      for(const kind of ['attempts','wrongBook','settings']){
        const rows=await request(tx.objectStore(kind).getAll());
        for(const row of rows){
          const id=kind==='wrongBook'?row.questionId:row.id;
          if(kind==='settings'&&!allowedSettings.has(id))continue;
          if(await request(metadata.get(entityKey(kind,id))))continue;
          let value=kind==='settings'?row.value:clone(row);
          if(kind==='wrongBook'&&!value.questionSnapshot){
            value.questionSnapshot=await request(tx.objectStore('questions').get(id));
            if(!value.questionSnapshot&&value.sourceAttemptId){const attempt=await request(tx.objectStore('attempts').get(value.sourceAttemptId));value.questionSnapshot=attempt?.questionSnapshots?.find(q=>q.id===id);}
            if(value.questionSnapshot?.metadata?.sourceId)value.sourceSnapshot=await request(tx.objectStore('sources').get(value.questionSnapshot.metadata.sourceId));
            tx.objectStore('wrongBook').put(value);
          }
          metadata.put({id:entityKey(kind,id),kind,entityId:id,revision:0,deleted:false,pending:{mutationId:crypto.randomUUID(),revision:0,value,deleted:false,updatedAt:Date.now()}});
        }
      }
    });
  }
  async function manifest(){
    const all=new Map();let cursor=null;
    do{
      const page=await api('/api/sat/bootstrap'+(cursor?'?cursor='+encodeURIComponent(cursor):''));
      for(const kind of ['attempts','wrongBook','settings'])for(const item of page[kind]||[]){const id=kind==='settings'?(item.key||item.id):item.id;all.set(entityKey(kind,id),{...item,kind,id});}
      cursor=page.nextCursor||null;
    }while(cursor);
    return [...all.values()];
  }
  async function remote(kind,id){return api(url(kind,id));}
  async function hydrateWrong(tx,value){
    const q=value?.questionSnapshot;if(!q?.id)return;
    const qs=tx.objectStore('questions');
    if(!await request(qs.get(q.id)))qs.put({...clone(q),accountSnapshot:true});
    const source=value.sourceSnapshot;
    if(source?.id&&!await request(tx.objectStore('sources').get(source.id)))tx.objectStore('sources').put({...clone(source),contentHash:'account-snapshot:'+source.id,originalContentHash:source.contentHash,accountSnapshot:true});
    else if(q.metadata?.sourceId&&!await request(tx.objectStore('sources').get(q.metadata.sourceId))){
      tx.objectStore('sources').put({id:q.metadata.sourceId,fileName:q.metadata.sourceFileName||'Saved practice',displayName:q.metadata.sourceFileName||'Saved practice',importedAt:q.metadata.importedAt||Date.now(),contentHash:'account-snapshot:'+q.metadata.sourceId,questionCount:1,accountSnapshot:true});
    }
  }
  async function applyRemote(kind,id,item,{force=false,conflictId=null,expectedMutation=null}={}){
    let changed=false;
    await transaction([kind,'questions','sources','accountSync','accountSyncConflicts'],async tx=>{
      const meta=tx.objectStore('accountSync'),key=entityKey(kind,id),current=await request(meta.get(key));
      if(!force&&(current?.pending||current?.conflictId))return;
      if(force&&conflictId&&current?.conflictId!==conflictId)return;
      if(force&&expectedMutation&&current?.pending?.mutationId!==expectedMutation)throw new Error('本机记录刚刚更新，请重新选择要保留的版本。');
      if(item.deleted)tx.objectStore(kind).delete(id);
      else if(item.value!==null&&item.value!==undefined){
        tx.objectStore(kind).put(kind==='settings'?{id,value:clone(item.value)}:clone(item.value));
        if(kind==='wrongBook')await hydrateWrong(tx,item.value);
      }
      if(current?.conflictId)tx.objectStore('accountSyncConflicts').delete(current.conflictId);
      meta.put({id:key,kind,entityId:id,revision:item.revision,deleted:!!item.deleted,baseline:kind==='settings'?clone(item.value):undefined,pending:null});changed=true;
    });
    if(changed){applied=true;if(kind==='attempts'&&(item.deleted||item.value?.status==='completed'))clearRuntime(id);}
    return changed;
  }
  async function acknowledge(row,sent,result){
    await transaction(['accountSync'],async tx=>{
      const store=tx.objectStore('accountSync'),current=await request(store.get(row.id));if(!current||result.revision<(current.revision||0))return;
      // A newer local write can occur while the HTTP request is in flight.
      // Acknowledge only this generation and carry its successor forward.
      if(current.pending?.mutationId===sent.mutationId)current.pending=null;
      else if(current.pending&&current.pending.revision===sent.revision)current.pending.revision=result.revision;
      current.revision=Math.max(current.revision||0,result.revision);current.deleted=!!result.deleted;
      if(row.kind==='settings')current.baseline=clone(sent.value);
      store.put(current);
    });
  }
  async function conflict(row,sent,item){
    await transaction(['accountSync','accountSyncConflicts'],async tx=>{
      const store=tx.objectStore('accountSync'),current=await request(store.get(row.id));
      if(!current?.pending)return;
      const id=row.id+':'+current.pending.mutationId;
      const canKeepLocal=!(row.kind==='attempts'&&(item.deleted||item.value?.status==='completed'));
      const reason=item.deleted?'这条记录已在另一设备删除。':row.kind==='attempts'&&item.value?.status==='completed'?'另一设备已完成这次练习，已完成记录不可覆盖。':'本机和另一设备都修改了这条记录，请选择要保留的版本。';
      tx.objectStore('accountSyncConflicts').put({id,kind:row.kind,entityId:row.entityId,label:current.pending.value?.practiceName||(row.kind==='settings'?'练习设置：'+row.entityId:row.kind==='wrongBook'?'错题记录':'练习记录'),reason,canKeepLocal,localValue:clone(current.pending.value),localDeleted:current.pending.deleted,localUpdatedAt:current.pending.updatedAt,serverUpdatedAt:item.updatedAt,serverRevision:item.revision,createdAt:Date.now()});
      if(current.conflictId&&current.conflictId!==id)tx.objectStore('accountSyncConflicts').delete(current.conflictId);
      current.conflictId=id;current.revision=item.revision;current.deleted=!!item.deleted;store.put(current);
    });
  }
  async function rebasePending(row,sent,item,value,deleted=sent.deleted){
    return transaction(['accountSync',row.kind],async tx=>{
      const store=tx.objectStore('accountSync'),current=await request(store.get(row.id));
      if(!current?.pending||current.pending.mutationId!==sent.mutationId)return false;
      current.revision=item.revision;current.deleted=!!item.deleted;
      current.pending={...current.pending,revision:item.revision,value:clone(value),deleted,mutationId:crypto.randomUUID()};
      if(row.kind==='wrongBook'&&!deleted&&item.deleted)current.pending.restore=true;
      if(row.kind==='settings'&&!deleted){tx.objectStore('settings').put({id:row.entityId,value:clone(value)});applied=true;}
      store.put(current);return true;
    });
  }
  function mergeSettings(local,server,base){
    if(equal(local,server)||equal(server,base))return {value:local};
    if(equal(local,base))return {value:server};
    if(local&&server&&typeof local==='object'&&typeof server==='object'&&!Array.isArray(local)&&!Array.isArray(server)){
      const value={...server};let collided=false;
      for(const key of new Set([...Object.keys(local),...Object.keys(server),...Object.keys(base||{})])){
        if(equal(local[key],base?.[key]))continue;
        if(equal(server[key],base?.[key])||equal(local[key],server[key])){if(local[key]===undefined)delete value[key];else value[key]=clone(local[key]);}
        else collided=true;
      }
      return {value,conflict:collided};
    }
    return {conflict:true};
  }
  async function uploadOne(row){
    const sent=clone(row.pending);if(!sent||row.conflictId)return;
    try{
      const body={value:sent.value,revision:sent.revision,deleted:!!sent.deleted,mutationId:sent.mutationId};
      if(sent.restore)body.restore=true;
      const result=await api(url(row.kind,row.entityId),{method:'PUT',body});
      await acknowledge(row,sent,result);
    }catch(error){
      if(error.status!==409||['account_changed','session_changed','account_mismatch'].includes(error.code))throw error;
      if(!safe())return;
      const item=await remote(row.kind,row.entityId);
      if(item.deleted&&sent.deleted){await acknowledge(row,sent,item);return;}
      if(!item.deleted&&!sent.deleted&&equal(item.value,sent.value)){await acknowledge(row,sent,item);return;}
      if(sent.deleted){await rebasePending(row,sent,item,null,true);return;}
      if(row.kind==='settings'&&!item.deleted){
        const merged=mergeSettings(sent.value,item.value,sent.baseValue);
        if(!merged.conflict){await rebasePending(row,sent,item,merged.value);return;}
      }
      // Preserve both answers. Completed records and tombstones are never
      // silently downgraded or resurrected by a stale browser.
      await conflict(row,sent,item);
    }
  }
  async function uploadPending(){
    const failures=new Map();
    for(let round=0;round<3;round++){
      const rows=(await SATStorage.all('accountSync')).filter(row=>row.pending&&!row.conflictId&&!failures.has(row.id));
      if(!rows.length)break;
      for(const row of rows){
        if(!auth.active)return;
        try{await uploadOne(row);}catch(error){if(!auth.active||error.status===401)throw error;failures.set(row.id,error);}
      }
    }
    if(failures.size)throw failures.values().next().value;
  }
  async function notifyApplied(){
    if(!applied||!safe())return;
    applied=false;
    await window.SATSettings?.load();
    window.dispatchEvent(new CustomEvent('sat-account-sync-applied'));
  }
  async function synchronize(initial=false){
    if(!auth.active)return;
    announce('正在同步…');
    try{
      await uploadPending();
      if(initial||safe()){
        for(const item of await manifest()){
          if(!initial&&!safe())break;
          const current=await SATStorage.get('accountSync',entityKey(item.kind,item.id));
          if(current?.pending||current?.conflictId||current?.revision===item.revision)continue;
          const value=item.kind==='settings'?{...item,value:item.value}:item.deleted?{...item,value:null}:await remote(item.kind,item.id);
          // A practice may start while a large snapshot is downloading.
          if(!initial&&!safe())break;
          await applyRemote(item.kind,item.id,value);
        }
        await notifyApplied();
      }
      lastError='';await finishStatus();
      channel?.postMessage({type:'synced',owner});
    }catch(error){
      lastError=error.status===413?'记录较大，尚未同步；本机作答已保留。':error.message||'同步未完成；本机作答已保留。';
      await finishStatus(lastError);
      if(!error.status||error.status===429||error.status>=500)schedule(15000);
    }
  }
  function acquirePractice(){
    if(practiceRelease)return Promise.resolve(true);
    if(practiceAcquiring)return practiceAcquiring;
    if(!navigator.locks?.request)return Promise.reject(new Error('当前浏览器无法保护多标签练习，请使用较新版本的 Chrome、Edge 或 Safari 后继续。'));
    practiceAcquiring=new Promise((resolve,reject)=>{
      navigator.locks.request('school-exam-platform:sat:practice:'+owner,{ifAvailable:true},async lock=>{
        if(!lock){reject(new Error('此账号已在另一标签页练习，请先在那里保存并退出，再回到此页面继续。'));return;}
        const held=new Promise(release=>{practiceRelease=release;});
        resolve(true);await held;
      }).catch(reject);
    }).finally(()=>{practiceAcquiring=null;});
    return practiceAcquiring;
  }
  function releasePractice(){const release=practiceRelease;practiceRelease=null;release?.();}
  function withLock(work){
    return navigator.locks?.request?navigator.locks.request('school-exam-platform:sat:sync:'+owner,work):work();
  }
  function sync(){
    if(!initialized)return initialize();
    if(running)return running;
    running=withLock(()=>synchronize(false)).finally(()=>{running=null;});
    return running;
  }
  function initialize(){
    if(initializing)return initializing;
    initializing=(async()=>{
      try{await seedLocal();initialized=true;await withLock(()=>synchronize(true));}
      finally{resolveReady();}
    })();
    return initializing;
  }
  async function getConflicts(){
    return (await SATStorage.all('accountSyncConflicts')).map(({localValue,...info})=>info);
  }
  async function resolveConflict(id,choice){
    if(!safe())throw new Error('请先保存并退出当前练习，再处理同步冲突。');
    if(!['local','server'].includes(choice))throw new Error('请选择要保留的版本。');
    return withLock(async()=>{
      const saved=await SATStorage.get('accountSyncConflicts',id);if(!saved)return;
      const observed=await SATStorage.get('accountSync',entityKey(saved.kind,saved.entityId));
      const item=await remote(saved.kind,saved.entityId);
      if(choice==='server')await applyRemote(saved.kind,saved.entityId,item,{force:true,conflictId:id,expectedMutation:observed?.pending?.mutationId});
      else{
        if(saved.kind==='attempts'&&(item.deleted||item.value?.status==='completed'))throw new Error(item.deleted?'已删除的练习不能恢复到原记录。请先下载本机副本。':'已完成的服务器记录不能覆盖。请先下载本机副本。');
        await transaction(['accountSync','accountSyncConflicts'],async tx=>{
          const store=tx.objectStore('accountSync'),current=await request(store.get(entityKey(saved.kind,saved.entityId)));
          if(current?.conflictId!==id)return;
          const previous=current.pending;
          current.pending={mutationId:crypto.randomUUID(),revision:item.revision,value:(previous?.deleted??saved.localDeleted)?null:clone(previous?previous.value:saved.localValue),deleted:previous?.deleted??saved.localDeleted,updatedAt:Date.now(),...(saved.kind==='wrongBook'&&item.deleted&&!(previous?.deleted??saved.localDeleted)?{restore:true}:{})};
          current.revision=item.revision;current.deleted=!!item.deleted;delete current.conflictId;store.put(current);tx.objectStore('accountSyncConflicts').delete(id);
        });
        await uploadPending();
      }
      await notifyApplied();await finishStatus();
    });
  }
  async function downloadConflict(id){
    const saved=await SATStorage.get('accountSyncConflicts',id);if(!saved)throw new Error('这条冲突已处理。');
    const meta=await SATStorage.get('accountSync',entityKey(saved.kind,saved.entityId));
    const blob=new Blob([JSON.stringify({formatVersion:'sat-account-conflict/1',kind:saved.kind,id:saved.entityId,value:meta?.pending?meta.pending.value:saved.localValue,deleted:meta?.pending?.deleted??saved.localDeleted,exportedAt:Date.now()},null,2)],{type:'application/json'});
    const target=URL.createObjectURL(blob),link=document.createElement('a');link.href=target;link.download='sat-conflict-'+saved.kind+'-'+Date.now()+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(target),1000);
  }
  async function logout(){
    if(!safe())throw new Error('请先保存并退出当前练习，再退出账号。');
    await sync();await counts();
    if((pendingCount||conflictCount)&&!window.confirm('仍有记录未同步或存在冲突，本机副本会保留。仍要退出登录吗？'))return;
    await auth.logout();
  }
  window.SATAccountSync=Object.freeze({ready,initialize,sync,acquirePractice,releasePractice,getStatus:()=>status,getConflicts,resolveConflict,downloadConflict,logout});
  window.addEventListener('sat-account-local-change',()=>{counts().then(()=>announce(conflictCount?'有 '+conflictCount+' 项同步冲突待处理':lastError||'有 '+pendingCount+' 项记录待同步')).catch(()=>{});schedule();channel?.postMessage({type:'changed',owner});});
  channel?.addEventListener('message',event=>{if(event.data?.owner===owner&&event.data.type==='changed')schedule();else if(event.data?.owner===owner&&event.data.type==='synced'&&safe()){applied=true;notifyApplied().catch(()=>{});finishStatus().catch(()=>{});}});
  window.addEventListener('online',()=>schedule(200));
  window.addEventListener('focus',()=>schedule(250));
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)schedule(250);});
  window.addEventListener('sat-attempt-finished',()=>{releasePractice();schedule(2500);});
  setInterval(()=>{if(!document.hidden&&safe())schedule(100);},30000);
})();
