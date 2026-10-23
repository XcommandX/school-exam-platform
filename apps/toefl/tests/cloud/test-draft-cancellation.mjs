import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import worker,{seal,sealJSON,openJSON,progressSummary,passwordHash} from './worker.mjs';
const db=new DatabaseSync(':memory:');
db.exec(fs.readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));
const DB={beforeRun:null,beforeBatch:null,prepare(sql){return{sql,args:[],bind(...args){this.args=args.map(x=>x instanceof ArrayBuffer?Buffer.from(x):x);return this},async first(){return db.prepare(sql).get(...this.args)||null},async all(){return{results:db.prepare(sql).all(...this.args)}},async run(){if(DB.beforeRun)await DB.beforeRun(this);return{meta:{changes:Number(db.prepare(sql).run(...this.args).changes)}}}}},async batch(statements){if(DB.beforeBatch)await DB.beforeBatch(statements);db.exec('BEGIN');try{const results=statements.map(s=>({meta:{changes:Number(db.prepare(s.sql).run(...s.args).changes)}}));db.exec('COMMIT');return results}catch(error){db.exec('ROLLBACK');throw error}}};
const env={DB,CONTENT_KEY:Buffer.alloc(32,8).toString('base64'),ENABLE_AI:'true',AI:{async run(){return{response:JSON.stringify({score:4,feedback:'请求表达清楚。'})}}},ASSETS:{async fetch(req){if(req.url.endsWith('/grading/writing.json'))return new Response(await seal(env,new TextEncoder().encode(JSON.stringify({'writing-t2:test':[{id:'q1',kind:'email',prompt:'Ask for project help.'}]}))));if(req.url.endsWith('/grading/speaking.json'))return new Response(await seal(env,new TextEncoder().encode(JSON.stringify({'speaking-t1:test':[{id:'q1',kind:'repeat',prompt:'Hello there.',reference:'Hello there.'}]}))));return new Response(null,{status:404})}}};
const tokens={owner:'a'.repeat(64),other:'b'.repeat(64)},sessionHash=async token=>Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))).toString('hex');
for(const user of ['owner','other']){db.prepare('INSERT INTO users(id,username,salt,password_hash,role,created) VALUES(?,?,?,?,?,?)').run(user,user,'qa','qa',user==='owner'?'admin':'user',1);db.prepare('INSERT INTO sessions(id,expires,user_id) VALUES(?,?,?)').run(await sessionHash(tokens[user]),Date.now()+1000000,user)}
function request(path,method='GET',body,user='owner',type='application/json'){return new Request('https://qa.invalid'+path,{method,headers:{Origin:'https://qa.invalid',Cookie:'session='+tokens[user],'X-Account-ID':user,...(body!==undefined?{'Content-Type':type}:{})},...(body!==undefined?{body:type==='application/json'?JSON.stringify(body):body}:{})})}
const call=(path,method,body,user,type)=>worker.fetch(request(path,method,body,user,type),env);
const state=async key=>{let r=db.prepare('SELECT value,revision FROM states WHERE key=?').get('owner:'+key);return r?{...r,value:await openJSON(env,r.value)}:{revision:0,value:[]}};
const put=async(key,value,revision)=>(await call('/api/state','PUT',{key,value,revision}));
const audio=async(attempt,user='owner')=>call('/api/recordings?key='+attempt+':speaking-t1:test:q1','POST',new Uint8Array([1,2,3]),user,'audio/webm');
const count=(table,key)=>db.prepare('SELECT COUNT(*) AS n FROM '+table+' WHERE key=?').get(key).n;
async function assessment(key,value={score:4}){db.prepare('INSERT INTO assessments(key,value) VALUES(?,?)').run(key,await sealJSON(env,value))}
const live={id:'discard',values:{answer:'discarded'}},keep={id:'keep',values:{answer:'preserved'}},finished={id:'finished',values:{answer:'old draft'}};
assert.equal((await put('four.drafts.v2',[live,keep,finished],0)).status,200);
assert.equal((await put('four.history.v1',[{id:'finished',score:4}],0)).status,200);
for(const attempt of ['discard','discard_extra','keep','finished'])assert.equal((await audio(attempt)).status,200);
assert.equal((await audio('discard','other')).status,200);
for(const key of ['owner:discard:writing-t2:test:q1','owner:discard_extra:writing-t2:test:q1','owner:finished:writing-t2:test:q1','owner:cache:shared','owner:transcript:shared','owner:example:shared','other:discard:writing-t2:test:q1'])await assessment(key);
const cancel=(id,cancelledAt=1700000000000)=>({id,cancelled:true,cancelledAt,values:{answer:'must be removed'}});
assert.equal((await put('four.drafts.v2',[cancel('discard'),keep,finished],0)).status,409);
assert.equal(count('recordings','owner:discard:speaking-t1:test:q1'),1,'a revision conflict never deletes audio');
for(const row of [cancel('discard',0),cancel('wrong/id'),cancel('cache')])assert.equal((await put('four.drafts.v2',[row,keep],1)).status,400);
let response=await put('four.drafts.v2',[cancel('discard'),keep,cancel('finished')],1);assert.equal(response.status,200);let normalized=await response.json();assert.deepEqual(normalized.value.find(x=>x.id==='discard'),{id:'discard',cancelled:true,cancelledAt:1700000000000});
assert.equal(count('recordings','owner:discard:speaking-t1:test:q1'),0);assert.equal(count('assessments','owner:discard:writing-t2:test:q1'),0);
for(const [table,key] of [['recordings','owner:discard_extra:speaking-t1:test:q1'],['recordings','other:discard:speaking-t1:test:q1'],['recordings','owner:finished:speaking-t1:test:q1'],['assessments','owner:finished:writing-t2:test:q1'],['assessments','owner:cache:shared'],['assessments','owner:transcript:shared'],['assessments','owner:example:shared'],['assessments','other:discard:writing-t2:test:q1']])assert.equal(count(table,key),1,key+' must survive');
assert.equal(progressSummary({'four.drafts.v2':normalized.value}).inProgress,1,'cancellation markers do not count as active practice');
response=await put('four.drafts.v2',[{...live,values:{answer:'stale device edit'}},keep],2);assert.equal(response.status,200);normalized=await response.json();assert.equal(normalized.value.filter(x=>x.cancelled).length,2);assert(!normalized.value.some(x=>x.id==='discard'&&!x.cancelled),'the server retains cancellation even from an old client');
response=await put('four.history.v1',[{id:'discard',score:5},{id:'finished',score:0}],1);assert.equal(response.status,200);assert.deepEqual((await response.json()).value,[{id:'finished',score:4}],'late finishes are removed while an existing finished report is retained');
assert.equal((await audio('discard')).status,410);
function grading(attempt,responseText='Please review our project outline.'){let form=new FormData();form.set('record','writing-t2:test');form.set('question','q1');form.set('attempt',attempt);form.set('response',responseText);return worker.fetch(new Request('https://qa.invalid/api/assess',{method:'POST',headers:{Origin:'https://qa.invalid',Cookie:'session='+tokens.owner,'X-Account-ID':'owner'},body:form}),env)}
assert.equal((await grading('discard')).status,410);
// Cancelling a leftover draft preserves an already submitted report, whose
// unchanged answers may still receive AI/rubric/self-evaluation updates.
let originalReport={id:'retained',finished:123,score:4,results:[{id:'writing-t2:test',items:[{id:'q1',response:'Please review our project outline.'}]},{id:'speaking-t1:test',items:[{id:'q1',response:''}]}]};
let existingDrafts=await state('four.drafts.v2');await put('four.drafts.v2',[...existingDrafts.value,{id:'retained'}],existingDrafts.revision);assert.equal((await audio('retained')).status,200);
let existingHistory=await state('four.history.v1');assert.equal((await put('four.history.v1',[...existingHistory.value,originalReport],existingHistory.revision)).status,200);
existingDrafts=await state('four.drafts.v2');assert.equal((await put('four.drafts.v2',[...existingDrafts.value.filter(x=>x.id!=='retained'),cancel('retained')],existingDrafts.revision)).status,200);
let retainedGrade=await grading('retained');assert.equal(retainedGrade.status,200);let retainedAI=await retainedGrade.json();assert.equal(count('assessments','owner:retained:writing-t2:test:q1'),1);
let updatedReport={...originalReport,ai:{'writing-t2:test':{q1:retainedAI}},aiErrors:{},rubric:{'writing-t2:test':{q1:{score:4,note:'Review note'}}},selfEvaluation:{'writing-t2:test':{0:true}}};existingHistory=await state('four.history.v1');assert.equal((await put('four.history.v1',existingHistory.value.map(x=>x.id==='retained'?updatedReport:x),existingHistory.revision)).status,200);assert.deepEqual((await state('four.history.v1')).value.find(x=>x.id==='retained'),updatedReport);
let staleReport=structuredClone(updatedReport);staleReport.results[0].items[0].response='A different late answer';staleReport.ai['writing-t2:test'].q1={score:0};staleReport.rubric={changed:true};existingHistory=await state('four.history.v1');assert.equal((await put('four.history.v1',existingHistory.value.map(x=>x.id==='retained'?staleReport:x),existingHistory.revision)).status,200);assert.deepEqual((await state('four.history.v1')).value.find(x=>x.id==='retained'),updatedReport,'changed answers may replace neither the retained report nor its AI metadata');assert.equal((await grading('retained','A different late answer')).status,410);
assert.equal((await audio('retained')).status,410,'the preserved recording cannot be overwritten');
env.AI={async run(model){return model.includes('whisper')?{text:'Hello there.'}:{response:JSON.stringify({score:4,feedback:'表达清楚。'})}}};
async function oralGrade(bytes){let form=new FormData();form.set('attempt','retained');form.set('record','speaking-t1:test');form.set('question','q1');form.set('audio',new Blob([new Uint8Array(bytes)],{type:'audio/webm'}),'qa.webm');return worker.fetch(new Request('https://qa.invalid/api/assess',{method:'POST',headers:{Origin:'https://qa.invalid',Cookie:'session='+tokens.owner,'X-Account-ID':'owner'},body:form}),env)}
assert.equal((await oralGrade([9,9,9])).status,410,'changed audio is refused for a cancelled leftover draft');assert.equal((await oralGrade([1,2,3])).status,200,'the exact retained recording remains assessable');
// A history save that wins while cancellation is being prepared protects its
// report and audio: cancellation must retry instead of deleting either.
let draft=await state('four.drafts.v2');await put('four.drafts.v2',[...draft.value,{id:'save_race'}],draft.revision);await audio('save_race');
DB.beforeBatch=async statements=>{if(statements[0].args.includes('owner:four.drafts.v2')){DB.beforeBatch=null;let history=await state('four.history.v1');assert.equal((await put('four.history.v1',[...history.value,{id:'save_race',score:3}],history.revision)).status,200)}};
draft=await state('four.drafts.v2');response=await put('four.drafts.v2',[...draft.value.filter(x=>x.id!=='save_race'),cancel('save_race')],draft.revision);assert.equal(response.status,409);assert.equal(count('recordings','owner:save_race:speaking-t1:test:q1'),1);
draft=await state('four.drafts.v2');assert.equal((await put('four.drafts.v2',[...draft.value.filter(x=>x.id!=='save_race'),cancel('save_race')],draft.revision)).status,200);assert.equal(count('recordings','owner:save_race:speaking-t1:test:q1'),1);
// A late history PUT prepared before cancellation cannot add a cancelled ID.
draft=await state('four.drafts.v2');await put('four.drafts.v2',[...draft.value,{id:'history_race'}],draft.revision);
DB.beforeBatch=async statements=>{if(statements[0].args.includes('owner:four.history.v1')){DB.beforeBatch=null;let current=await state('four.drafts.v2');assert.equal((await put('four.drafts.v2',[...current.value.filter(x=>x.id!=='history_race'),cancel('history_race')],current.revision)).status,200)}};
let history=await state('four.history.v1');assert.equal((await put('four.history.v1',[...history.value,{id:'history_race',score:5}],history.revision)).status,409);assert(!(await state('four.history.v1')).value.some(x=>x.id==='history_race'));
// A cleanup error rolls the state marker and all resource deletes back.
draft=await state('four.drafts.v2');await put('four.drafts.v2',[...draft.value,{id:'cleanup_failure'}],draft.revision);await audio('cleanup_failure');await assessment('owner:cleanup_failure:writing-t2:test:q1');
db.exec("CREATE TRIGGER qa_cleanup_failure BEFORE DELETE ON assessments WHEN OLD.key='owner:cleanup_failure:writing-t2:test:q1' BEGIN SELECT RAISE(ABORT,'qa rollback'); END");
draft=await state('four.drafts.v2');assert.equal((await put('four.drafts.v2',[...draft.value.filter(x=>x.id!=='cleanup_failure'),cancel('cleanup_failure')],draft.revision)).status,503);assert((await state('four.drafts.v2')).value.some(x=>x.id==='cleanup_failure'&&!x.cancelled));assert.equal(count('recordings','owner:cleanup_failure:speaking-t1:test:q1'),1);assert.equal(count('assessments','owner:cleanup_failure:writing-t2:test:q1'),1);db.exec('DROP TRIGGER qa_cleanup_failure');
// Pause exactly before a recording's final SQL statement. Cancellation must
// win, even though upload processing already passed its initial read.
draft=await state('four.drafts.v2');await put('four.drafts.v2',[...draft.value,{id:'upload_race'}],draft.revision);
DB.beforeRun=async statement=>{if(statement.sql.startsWith('INSERT INTO recordings')&&statement.args[0].includes(':upload_race:')){DB.beforeRun=null;let current=await state('four.drafts.v2');assert.equal((await put('four.drafts.v2',[...current.value.filter(x=>x.id!=='upload_race'),cancel('upload_race')],current.revision)).status,200)}};
assert.equal((await audio('upload_race')).status,410);assert.equal(count('recordings','owner:upload_race:speaking-t1:test:q1'),0);
// An AI request can finish after cancellation, but cannot recreate its report.
draft=await state('four.drafts.v2');await put('four.drafts.v2',[...draft.value,{id:'grade_race'}],draft.revision);
let started,release;const modelStarted=new Promise(resolve=>started=resolve),modelRelease=new Promise(resolve=>release=resolve);env.AI={async run(){started();await modelRelease;return{response:JSON.stringify({score:3,feedback:'可以继续补充细节。'})}}};let scoring=grading('grade_race','A new unique project request for race coverage.');await modelStarted;
draft=await state('four.drafts.v2');assert.equal((await put('four.drafts.v2',[...draft.value.filter(x=>x.id!=='grade_race'),cancel('grade_race')],draft.revision)).status,200);release();assert.equal((await scoring).status,410);assert.equal(count('assessments','owner:grade_race:writing-t2:test:q1'),0);
// Final validation is required even if the assessment began before the
// leftover draft was cancelled and a report now exists for that attempt.
let retainedRace={id:'retained_grade_race',finished:123,results:[{id:'writing-t2:test',items:[{id:'q1',response:'The saved answer stays unchanged.'}]}]};draft=await state('four.drafts.v2');await put('four.drafts.v2',[...draft.value,{id:retainedRace.id}],draft.revision);history=await state('four.history.v1');await put('four.history.v1',[...history.value,retainedRace],history.revision);
let raceStarted,raceRelease;const retainedStarted=new Promise(resolve=>raceStarted=resolve),retainedRelease=new Promise(resolve=>raceRelease=resolve);env.AI={async run(){raceStarted();await retainedRelease;return{response:JSON.stringify({score:3,feedback:'这是迟到的评分结果。'})}}};const retainedScoring=grading(retainedRace.id,'An edited answer submitted before cancellation.');await retainedStarted;draft=await state('four.drafts.v2');await put('four.drafts.v2',[...draft.value.filter(x=>x.id!==retainedRace.id),cancel(retainedRace.id)],draft.revision);raceRelease();assert.equal((await retainedScoring).status,410);assert.equal(count('assessments','owner:retained_grade_race:writing-t2:test:q1'),0);assert.deepEqual((await state('four.history.v1')).value.find(x=>x.id===retainedRace.id),retainedRace);
console.log('PASS: cancellation markers persist and normalize, stale clients and late history cannot revive drafts, and atomic cleanup preserves exact account/attempt boundaries, shared caches and existing reports.');
// Any request already authenticated when its account is removed must not
// recreate data in the eventual SQL write (including shared model caches).
for(const target of ['states','recordings','assessments','account_activity']){
 const user='remove_'+target,token='c'.repeat(64);tokens[user]=token;db.prepare('INSERT INTO users(id,username,salt,password_hash,role,created) VALUES(?,?,?,?,?,?)').run(user,user,'qa','qa','user',1);db.prepare('INSERT INTO sessions(id,expires,user_id) VALUES(?,?,?)').run(await sessionHash(token),Date.now()+1000000,user);
 DB.beforeRun=async statement=>{if(statement.sql.startsWith('INSERT')&&statement.sql.includes('INTO '+target+'(')){DB.beforeRun=null;db.prepare('DELETE FROM users WHERE id=?').run(user);db.prepare('DELETE FROM sessions WHERE user_id=?').run(user)}};
 if(target==='states')await call('/api/state','PUT',{key:'four.words.v1',value:{new:true},revision:0},user);
 if(target==='recordings')await audio('user_removed',user);
 if(target==='account_activity')await call('/api/me','GET',undefined,user);
 if(target==='assessments'){
  env.AI={async run(){return{response:JSON.stringify({score:3,feedback:'表达清楚。'})}}};let form=new FormData();form.set('record','writing-t2:test');form.set('question','q1');form.set('attempt','user_removed');form.set('response','Unique reply for the removed-account check.');await worker.fetch(new Request('https://qa.invalid/api/assess',{method:'POST',headers:{Origin:'https://qa.invalid',Cookie:'session='+token,'X-Account-ID':user},body:form}),env);
 }
 const sql=target==='account_activity'?'SELECT COUNT(*) AS n FROM account_activity WHERE user_id=?':'SELECT COUNT(*) AS n FROM '+target+' WHERE key>=? AND key<?',args=target==='account_activity'?[user]:[user+':',user+';'];assert.equal(db.prepare(sql).get(...args).n,0,target+' must not reappear after account deletion');DB.beforeRun=null;
}
console.log('PASS: final state/audio/assessment/activity writes are guarded against in-flight account deletion. No production database or external AI was used.');

// Legacy databases may contain two valid cookies for one account. The newest
// expiry wins immediately; a deterministic ID tie-break still admits only one.
assert.match(await(await call('/login')).text(),/同一账号仅保留最新登录/);
const legacyUser='legacy_sessions',legacyTokens=['d'.repeat(64),'e'.repeat(64)];db.prepare('INSERT INTO users(id,username,salt,password_hash,role,created) VALUES(?,?,?,?,?,?)').run(legacyUser,legacyUser,'qa','qa','user',1);const legacyIds=await Promise.all(legacyTokens.map(sessionHash)),legacyExpiry=Date.now()+1000000;
for(let i=0;i<legacyIds.length;i++)db.prepare('INSERT INTO sessions(id,expires,user_id) VALUES(?,?,?)').run(legacyIds[i],legacyExpiry+i,legacyUser);
const legacyMe=token=>worker.fetch(new Request('https://qa.invalid/api/me',{headers:{Cookie:'session='+token,'X-Account-ID':legacyUser}}),env);
assert.deepEqual(await Promise.all(legacyTokens.map(async token=>(await legacyMe(token)).status)),[401,200]);db.prepare('UPDATE sessions SET expires=? WHERE user_id=?').run(legacyExpiry+2,legacyUser);const tied=await Promise.all(legacyTokens.map(async token=>(await legacyMe(token)).status));assert.equal(tied.filter(x=>x===200).length,1);assert.equal(tied[legacyIds.indexOf([...legacyIds].sort().at(-1))],200);
// Removing an account after password verification cannot leave an orphaned
// session or issue a cookie from the already-running login request.
const loginUser='deleted_during_login',loginPassword='qa-login-password-123',loginSalt='qa-login-salt',loginPasswordHash=await passwordHash(loginPassword,loginSalt);db.prepare('INSERT INTO users(id,username,salt,password_hash,role,created) VALUES(?,?,?,?,?,?)').run(loginUser,loginUser,loginSalt,loginPasswordHash,'user',1);
env.ADMIN_USERNAME='owner';env.PASSWORD_HASH='qa';env.PASSWORD_SALT='qa';DB.beforeBatch=async statements=>{if(statements.some(statement=>statement.sql.startsWith('INSERT INTO sessions')&&statement.args.includes(loginUser))){DB.beforeBatch=null;db.prepare('DELETE FROM users WHERE id=?').run(loginUser);db.prepare('DELETE FROM sessions WHERE user_id=?').run(loginUser)}};
let deletedLogin=await call('/api/login','POST',{username:loginUser,password:loginPassword});assert.equal(deletedLogin.status,401);assert.equal(deletedLogin.headers.get('Set-Cookie'),null);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id=?').get(loginUser).n,0);
console.log('PASS: retained reports can grade only unchanged saved answers/audio and preserve metadata updates; legacy multi-session data admits only one cookie and concurrent deletion cannot create login sessions.');
