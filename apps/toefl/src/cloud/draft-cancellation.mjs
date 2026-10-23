// Draft cancellations share the existing encrypted state row. Keeping a small
// marker prevents an old/offline device from restoring discarded answer data.
const DRAFTS='four.drafts.v2',HISTORY='four.history.v1';
const validId=id=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,150}$/.test(id)&&!['cache','transcript','example'].includes(id);
const marker=row=>({id:row.id,cancelled:true,cancelledAt:row.cancelledAt});
const metadata=['ai','aiErrors','rubric','selfEvaluation'];
const stable=value=>JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const reportCore=report=>Object.fromEntries(Object.entries(report).filter(([key])=>!metadata.includes(key)));
export function cancelledDrafts(incoming,stored=[]){
 if(!Array.isArray(incoming)||!Array.isArray(stored))throw Error('无效的练习草稿。');
 const cancelled=new Map();
 for(const row of [...stored,...incoming])if(row?.cancelled===true){
  if(!validId(row.id)||!Number.isSafeInteger(row.cancelledAt)||row.cancelledAt<=0)throw Error('无效的取消练习编号或时间。');
  if(!cancelled.has(row.id))cancelled.set(row.id,marker(row));
 }
 return [...incoming.filter(row=>row&&typeof row==='object'&&!cancelled.has(row.id)),...cancelled.values()];
}
export function cancelledHistory(incoming,stored,cancelled){
 if(!Array.isArray(incoming)||!Array.isArray(stored))throw Error('无效的练习记录。');
 const incomingById=new Map(incoming.filter(row=>row&&typeof row==='object').map(row=>[row.id,row]));
 const retained=new Map(stored.filter(row=>row&&cancelled.has(row.id)).map(row=>{
  const edit=incomingById.get(row.id);
  if(!edit||stable(reportCore(edit))!==stable(reportCore(row)))return[row.id,row];
  const updated={...row};
  for(const key of metadata){if(Object.hasOwn(edit,key))updated[key]=edit[key];else delete updated[key]}
  return[row.id,updated];
 }));
 return [...incoming.filter(row=>row&&typeof row==='object'&&!cancelled.has(row.id)),...retained.values()];
}
export function createDraftCancellationFeatures({json,openJSON,sealJSON,recordingHash}){
 const conflict=()=>json({error:'其他设备更新了这份记录，请刷新合并后重试。'},409);
 const cancelled=()=>json({error:'该练习已取消，不能继续上传作答。',code:'attempt_cancelled'},410);
 const deleted=()=>json({error:'账号已删除，请重新登录。',code:'account_deleted'},401);
 async function row(env,user,key){return env.DB.prepare('SELECT key,value,revision FROM states WHERE key=?').bind(user+':'+key).first()}
 async function value(env,stored){return stored?await openJSON(env,stored.value):[]}
 function unchanged(stored,key){return stored?{sql:'EXISTS(SELECT 1 FROM states WHERE key=? AND revision=? AND value=?)',args:[key,stored.revision,stored.value]}:{sql:'NOT EXISTS(SELECT 1 FROM states WHERE key=?)',args:[key]}}
 async function alive(env,user){return !!await env.DB.prepare('SELECT id FROM users WHERE id=?').bind(user).first()}
 async function checkAttempt(env,session,attempt,{assessment=false}={}){
  let drafts=await value(env,await row(env,session.user_id,DRAFTS));
  if(!drafts.some(x=>x?.id===attempt&&x.cancelled===true))return null;
  if(assessment&&(await value(env,await row(env,session.user_id,HISTORY))).some(x=>x?.id===attempt))return null;
  return cancelled();
 }
 async function assessmentSnapshot(env,session,attempt,proof){
  const user=session.user_id,draftRow=await row(env,user,DRAFTS),drafts=await value(env,draftRow);
  if(!drafts.some(x=>x?.id===attempt&&x.cancelled===true))return{draftRow};
  const historyRow=await row(env,user,HISTORY),report=(await value(env,historyRow)).find(x=>x?.id===attempt);
  const item=report?.results?.find(x=>x.id===proof?.record)?.items?.find(x=>x.id===proof?.question);
  if(!item||!proof)return{stopped:cancelled()};
  if(proof.audioHash){
   const saved=await env.DB.prepare('SELECT value FROM recordings WHERE key=?').bind(user+':'+attempt+':'+proof.record+':'+proof.question).first();
   if(!saved||!recordingHash||await recordingHash(env,saved.value)!==proof.audioHash)return{stopped:cancelled()};
  }else if(typeof item.response!=='string'||item.response!==proof.response)return{stopped:cancelled()};
  return{draftRow,historyRow};
 }
 async function checkAssessment(env,session,attempt,proof){return(await assessmentSnapshot(env,session,attempt,proof)).stopped||null}
 async function writeState(env,session,d){
  if(d.key!==DRAFTS&&d.key!==HISTORY)return null;
  const user=session.user_id,key=user+':'+d.key;
  const [draftRow,historyRow]=await Promise.all([row(env,user,DRAFTS),row(env,user,HISTORY)]);
  const own=d.key===DRAFTS?draftRow:historyRow,other=d.key===DRAFTS?historyRow:draftRow;
  if(d.revision!==(own?.revision||0))return conflict();
  const [drafts,history]=await Promise.all([value(env,draftRow),value(env,historyRow)]);
  let normalized;
  try{normalized=d.key===DRAFTS?cancelledDrafts(d.value,drafts):cancelledHistory(d.value,history,new Set(drafts.filter(x=>x?.cancelled===true).map(x=>x.id)))}catch(error){return json({error:error.message},400)}
  if(JSON.stringify(normalized).length>1500000)return json({error:'记录较大，请先导出备份'},413);
  const encrypted=await sealJSON(env,normalized),otherGuard=unchanged(other,user+':'+(d.key===DRAFTS?HISTORY:DRAFTS));
  const userGuard='EXISTS(SELECT 1 FROM users WHERE id=?)';
  const write=d.revision===0?
   env.DB.prepare('INSERT OR IGNORE INTO states(key,value,revision) SELECT ?,?,1 WHERE '+otherGuard.sql+' AND '+userGuard).bind(key,encrypted,...otherGuard.args,user):
   env.DB.prepare('UPDATE states SET value=?,revision=revision+1 WHERE key=? AND revision=? AND '+otherGuard.sql+' AND '+userGuard).bind(encrypted,key,d.revision,...otherGuard.args,user);
  const statements=[write];
  if(d.key===DRAFTS){
   const retained=new Set(history.map(x=>x?.id)),ids=normalized.filter(x=>x.cancelled===true&&!retained.has(x.id)).map(x=>x.id);
   // Every cleanup is conditional on this exact successful encrypted write.
   // A failed revision check can never delete recordings or reports.
   for(let offset=0;offset<ids.length;offset+=40){
    const chunk=ids.slice(offset,offset+40),ranges=chunk.map(()=>'(key>=? AND key<?)').join(' OR '),args=chunk.flatMap(id=>[user+':'+id+':',user+':'+id+';']);
    for(const table of ['recordings','assessments'])statements.push(env.DB.prepare('DELETE FROM '+table+' WHERE ('+ranges+') AND EXISTS(SELECT 1 FROM states WHERE key=? AND revision=? AND value=?)').bind(...args,key,d.revision+1,encrypted));
   }
  }
  const results=await env.DB.batch(statements);
  if(!results[0].meta.changes)return await alive(env,user)?conflict():deleted();
  return json({revision:d.revision+1,value:normalized});
 }
 // The final SQL write checks the same encrypted drafts snapshot that was read.
 // If cancellation wins during an upload/model call, the write retries against
 // its marker. Only an unchanged, already saved report may still be graded.
 async function writeAttempt(env,session,attempt,{table,key,type,value:payload,assessment}){
  if(!validId(attempt)||!['recordings','assessments'].includes(table))throw Error('Invalid attempt write');
  const user=session.user_id;
  for(let n=0;n<3;n++){
   let snapshot;
   if(table==='assessments')snapshot=await assessmentSnapshot(env,session,attempt,assessment);
   else{const draftRow=await row(env,user,DRAFTS),drafts=await value(env,draftRow);snapshot={draftRow,stopped:drafts.some(x=>x?.id===attempt&&x.cancelled===true)?cancelled():null}}
   if(snapshot.stopped)return snapshot.stopped;
   let guard=unchanged(snapshot.draftRow,user+':'+DRAFTS);
   if(snapshot.historyRow){const historyGuard=unchanged(snapshot.historyRow,user+':'+HISTORY);guard={sql:guard.sql+' AND '+historyGuard.sql,args:[...guard.args,...historyGuard.args]}}
   const sql=table==='recordings'?
    'INSERT INTO recordings(key,type,value) SELECT ?,?,? WHERE '+guard.sql+' AND EXISTS(SELECT 1 FROM users WHERE id=?) ON CONFLICT(key) DO UPDATE SET type=excluded.type,value=excluded.value':
    'INSERT INTO assessments(key,value) SELECT ?,? WHERE '+guard.sql+' AND EXISTS(SELECT 1 FROM users WHERE id=?) ON CONFLICT(key) DO UPDATE SET value=excluded.value';
   const args=table==='recordings'?[key,type,payload]:[key,payload];
   const result=await env.DB.prepare(sql).bind(...args,...guard.args,user).run();
   if(result.meta.changes)return null;
   if(!await alive(env,user))return deleted();
  }
  return conflict();
 }
 return {writeState,checkAttempt,checkAssessment,writeAttempt};
}
