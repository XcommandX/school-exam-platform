// Admin reads use an explicit projection. Original responses and credentials never
// enter this API, and all state/audio writes retain their original account scope.
const number=v=>typeof v==='number'&&Number.isFinite(v)?v:undefined;
const score=v=>number(v)!==undefined&&v>=0&&v<=5?v:undefined;
const rows=v=>Array.isArray(v)?v.filter(x=>x&&typeof x==='object'):[];
const text=(v,max=200)=>typeof v==='string'?v.slice(0,max):'';
const booleanMap=(value,valid)=>Object.fromEntries(Object.keys(value||{}).filter(k=>value[k]&&(!valid||valid.has(k))).map(k=>[k,true]));
export function projectAccountData(values,groups,catalog=[]){
 const source=values['four.words.v1']||{},words=Object.create(null),knownWords=new Set(groups.map(g=>g.word)),byKey=new Map(catalog.map(r=>[r.module+':'+r.id,r]));
 for(let g of groups){let forms=[...new Set([g.word,...g.forms])],states=forms.map(k=>source[k]).filter(x=>x&&typeof x==='object'),base=source[g.word],mastered=typeof base?.mastered==='boolean'?base.mastered:states.some(x=>x.mastered===true),seen=states.some(x=>typeof x.mastered==='boolean'||number(x.lastReviewed)!==undefined),lastReviewed=Math.max(0,...states.map(x=>number(x.lastReviewed)||0)),updated=Math.max(0,...states.map(x=>number(x.updated)||0)),latest=states.slice().sort((a,b)=>(number(b.updated)||0)-(number(a.updated)||0))[0];
  if(seen||lastReviewed)words[g.word]={mastered,lastReviewed:lastReviewed||undefined,updated:updated||undefined,due:number(latest?.due),streak:number(latest?.streak)};
 }
 let history=rows(values['four.history.v1']),legacy=rows(values['t1lab.history.v1']),seen=new Set();
 const attempts=[...history,...legacy.map((h,index)=>({...h,id:'legacy:'+(h.id||index+':'+h.finished),results:rows(h.results).map(r=>({...r,id:r.id?.startsWith('reading-t1:')?r.id:'reading-t1:'+r.id}))}))].filter(h=>!h.preview&&!h.conflictCopy&&number(h.finished)!==undefined&&(!h.id||!seen.has(h.id)&&seen.add(h.id))).map(h=>{
  let ai=Object.create(null),recorded=Object.create(null),results=rows(h.results).map(r=>{let key=text(r.id),meta=byKey.get(key),oral=key.startsWith('speaking-'),validTotal=number(r.total)!==undefined&&r.total>0&&number(r.correct)!==undefined&&r.correct>=0&&r.correct<=r.total,items=rows(r.items).map((q,i)=>{let id=text(q.id),answered=oral?!!h.recorded?.[key+':'+q.id]:!!(q.answered??(Array.isArray(q.response)?q.response.length:typeof q.response==='string'&&q.response.trim())),value=typeof q.correct==='boolean'?undefined:score(h.ai?.[r.id]?.[q.id]?.score);if(oral&&answered)recorded[key+':'+id]=true;if(value!==undefined){ai[key]||=Object.create(null);ai[key][id]={score:value}}return {id,number:i+1,answered,correct:typeof q.correct==='boolean'?q.correct:null,score:value}});return {id:key,title:meta?.title||key,module:meta?.module||key.split(':')[0],correct:validTotal?r.correct:0,total:validTotal?r.total:0,automatic:validTotal&&r.automatic!==false,focused:!!r.focused,items}});
  return {id:text(h.id),subject:text(h.subject,20),finished:h.finished,elapsed:Math.max(0,Math.min(number(h.elapsed)||0,86400)),results,ai,recorded};
 }).sort((a,b)=>b.finished-a.finished);
 let learning=rows(values['four.learning.v1']).filter(r=>r.type==='progress'&&!r.disabled||r.id?.startsWith('knowledge:')).map(r=>r.type==='progress'?{id:text(r.id),type:'progress',day:/^\d{4}-\d{2}-\d{2}$/.test(r.day)?r.day:'',at:number(r.at),mastered:number(r.mastered),total:number(r.total),words:booleanMap(r.words,knownWords),knowledge:booleanMap(r.knowledge)}:{id:text(r.id),lastReviewed:number(r.lastReviewed)});
 return {attempts,words,learning,groups};
}
export function createAccountFeatures(deps){
 const {json,hash,random,passwordHash,openJSON,assetDecoded,auth,recordActivity,groups}=deps;
 async function body(req){let raw=await req.text();if(raw.length>4096)return null;try{return JSON.parse(raw)}catch{return null}}
 async function rate(req,env,failed=false){let id='invite:'+await hash(req.headers.get('CF-Connecting-IP')||'local'),now=Date.now(),row=await env.DB.prepare('SELECT count,reset FROM login_limits WHERE id=?').bind(id).first();if(row?.reset>now&&row.count>=8)return false;if(failed)await env.DB.prepare('INSERT INTO login_limits(id,count,reset) VALUES(?,1,?) ON CONFLICT(id) DO UPDATE SET count=CASE WHEN reset<? THEN 1 ELSE count+1 END,reset=CASE WHEN reset<? THEN ? ELSE reset END').bind(id,now+900000,now,now,now+900000).run();return true}
 async function invitation(req,env){if(!await rate(req,env))return {response:json({error:'尝试次数较多，请 15 分钟后重试。'},429)};let data=await body(req);if(!data||typeof data.token!=='string'||!/^ti_[a-f0-9]{64}$/.test(data.token)){await rate(req,env,true);return {response:json({error:'邀请链接无效、已过期或已使用。'},403)}}let digest=await hash(data.token),row=await env.DB.prepare('SELECT id,expires FROM invitations WHERE token_hash=? AND used_at IS NULL AND revoked_at IS NULL AND expires>?').bind(digest,Date.now()).first();if(!row){await rate(req,env,true);return {response:json({error:'邀请链接无效、已过期或已使用。'},403)}}return {data,digest,row}}
 async function checkInvitation(req,env){let out=await invitation(req,env);return out.response||json({valid:true,expires:out.row.expires})}
 async function register(req,env,ctx){
  if(await auth(req,env))return json({error:'请先退出当前账号，再使用邀请链接注册。'},409);
  let out=await invitation(req,env);if(out.response)return out.response;let {data,digest}=out,username=typeof data.username==='string'?data.username.trim():'';
  if(!/^[A-Za-z0-9_-]{2,40}$/.test(username)||typeof data.password!=='string'||data.password.length<10||data.password.length>200||!data.password.trim())return json({error:'用户名需为 2–40 位字母、数字、下划线或连字符；密码至少 10 位。'},400);
  let id=random(),salt=random(),derived=await passwordHash(data.password,salt),now=Date.now(),token=random(),sessionId=await hash(token);
  // D1 batch is transactional: exactly one racing claim may insert its user.
  await env.DB.batch([
   env.DB.prepare("INSERT OR IGNORE INTO users(id,username,salt,password_hash,role,created) SELECT ?,?,?,?,'user',? WHERE EXISTS(SELECT 1 FROM invitations WHERE token_hash=? AND used_at IS NULL AND revoked_at IS NULL AND expires>?)").bind(id,username,salt,derived,now,digest,now),
   env.DB.prepare('UPDATE invitations SET used_at=?,used_by=? WHERE token_hash=? AND used_at IS NULL AND revoked_at IS NULL AND expires>? AND EXISTS(SELECT 1 FROM users WHERE id=?)').bind(now,id,digest,now,id),
   env.DB.prepare('INSERT INTO sessions(id,expires,user_id) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM users WHERE id=?)').bind(sessionId,now+14*86400000,id,id)
  ]);
  let user=await env.DB.prepare('SELECT id,username,role FROM users WHERE id=?').bind(id).first();
  if(!user){await rate(req,env,true);let taken=await env.DB.prepare('SELECT id FROM users WHERE username=? COLLATE NOCASE').bind(username).first();return json({error:taken?'用户名已存在，请换一个用户名。':'邀请链接已失效，请联系管理员重新邀请。'},409)}
  await recordActivity(env,id,ctx,true);
  return json({ok:true},201,{'Set-Cookie':`session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=1209600`});
 }
 async function invitations(req,env,session,id){
  if(session.role!=='admin')return json({error:'只有管理员可以管理邀请。'},403);
  if(id){if(req.method!=='POST')return json({error:'不支持该操作'},405);let result=await env.DB.prepare('UPDATE invitations SET revoked_at=? WHERE id=? AND used_at IS NULL AND revoked_at IS NULL').bind(Date.now(),id).run();return result.meta.changes?json({ok:true}):json({error:'邀请已使用、已撤销或不存在。'},409)}
  if(req.method==='GET'){let rows=await env.DB.prepare('SELECT i.id,i.created,i.expires,i.used_at,i.revoked_at,u.username AS used_by FROM invitations i LEFT JOIN users u ON u.id=i.used_by ORDER BY i.created DESC LIMIT 100').all();return json({invitations:rows.results||[]})}
  if(req.method!=='POST')return json({error:'不支持该操作'},405);
  let now=Date.now(),active=await env.DB.prepare('SELECT COUNT(*) AS count FROM invitations WHERE used_at IS NULL AND revoked_at IS NULL AND expires>?').bind(now).first();if(active.count>=20)return json({error:'已有 20 条有效邀请，请先使用或撤销。'},409);
  let token='ti_'+random(),expires=now+7*86400000;await env.DB.prepare('INSERT INTO invitations(id,token_hash,created_by,created,expires) VALUES(?,?,?,?,?)').bind(random(),await hash(token),session.user_id,now,expires).run();
  return json({url:new URL('/register#token='+token,req.url).href,expires},201);
 }
 async function userDetail(req,env,session,id){
  if(session.role!=='admin')return json({error:'只有管理员可以查看学习详情。'},403);
  let user=await env.DB.prepare('SELECT id,username,role,created FROM users WHERE id=?').bind(id).first();if(!user)return json({error:'没有这个账号。'},404);
  let rows=await env.DB.prepare('SELECT key,value FROM states WHERE key>=? AND key<?').bind(id+':',id+';').all(),values=Object.create(null);for(let row of rows.results||[])values[row.key.slice(id.length+1)]=await openJSON(env,row.value);
  let response=await env.ASSETS.fetch(new Request(new URL('/data/catalog.json',req.url))),catalog=response.ok?JSON.parse(new TextDecoder().decode(await assetDecoded(env,await response.arrayBuffer()))).records:[];
  return json({user,...projectAccountData(values,groups,catalog)});
 }
 const safe=fn=>async(...args)=>{try{return await fn(...args)}catch{return json({error:'账号服务暂不可用，请稍后重试。',code:'unavailable'},503)}};return Object.fromEntries(Object.entries({checkInvitation,register,invitations,userDetail}).map(([key,fn])=>[key,safe(fn)]));
}
