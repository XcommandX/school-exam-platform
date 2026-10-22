import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import worker,{passwordHash,seal,sealJSON} from './worker.mjs';
import {projectAccountData} from './account-features.mjs';
const db=new DatabaseSync(':memory:');db.exec(fs.readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));
const DB={prepare(sql){return {sql,args:[],bind(...args){this.args=args.map(x=>x instanceof ArrayBuffer?Buffer.from(x):x);return this},async first(){return db.prepare(sql).get(...this.args)||null},async all(){return {results:db.prepare(sql).all(...this.args)}},async run(){let r=db.prepare(sql).run(...this.args);return {meta:{changes:Number(r.changes)}}}}},async batch(statements){db.exec('BEGIN');try{let results=statements.map(s=>({meta:{changes:Number(db.prepare(s.sql).run(...s.args).changes)}}));db.exec('COMMIT');return results}catch(e){db.exec('ROLLBACK');throw e}}};
const env={DB,CONTENT_KEY:Buffer.alloc(32,4).toString('base64'),ADMIN_USERNAME:'admin_test',PASSWORD_SALT:'test-salt',PASSWORD_HASH:await passwordHash('test-password-123','test-salt'),ASSETS:{async fetch(){return new Response(await seal(env,new TextEncoder().encode(JSON.stringify({records:[{id:'a',module:'reading-t1',title:'QA Reading'}]}))))}}};
const origin='https://test.invalid';
function req(path,method='GET',body,cookie='',id='owner',ip='127.0.0.1') {return new Request(origin+path,{method,headers:{Origin:origin,'CF-Connecting-IP':ip,'X-Account-ID':id,...(cookie?{Cookie:cookie}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})})}
async function fetch(path,method='GET',body,cookie='',id='owner',ip){return worker.fetch(req(path,method,body,cookie,id,ip),env)}
let r=await fetch('/api/login','POST',{username:'admin_test',password:'test-password-123'});assert.equal(r.status,200);const admin=r.headers.get('Set-Cookie').split(';')[0];
async function invite(){let r=await fetch('/api/admin/invites','POST',{},admin);assert.equal(r.status,201);let out=await r.json();assert.equal(new URL(out.url).pathname,'/register');assert.equal(new URL(out.url).search,'');let token=new URLSearchParams(new URL(out.url).hash.slice(1)).get('token');assert.match(token,/^ti_[a-f0-9]{64}$/);assert(Math.abs(out.expires-Date.now()-7*86400000)<3000);let digest=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))).toString('hex');return {out,token,id:db.prepare('SELECT id FROM invitations WHERE token_hash=?').get(digest).id}}
for(let path of ['/api/admin/invites','/api/admin/users/owner/progress'])assert.equal((await fetch(path)).status,401);
r=await fetch('/register');assert.equal(r.status,200);let page=await r.text();assert(!page.includes('QA Reading'));assert.equal(r.headers.get('Referrer-Policy'),'no-referrer');
const one=await invite();let stored=db.prepare('SELECT * FROM invitations').get();assert(!Object.values(stored).includes(one.token));assert.notEqual(stored.token_hash,one.token);
r=await fetch('/api/invitations/check','POST',{token:one.token});assert.equal(r.status,200);assert(!JSON.stringify(await r.json()).includes('token_hash'));
// Logged-in accounts cannot accidentally switch identity through a registration link.
r=await fetch('/api/register','POST',{token:one.token,username:'student_a',password:'student-password-123'},admin);assert.equal(r.status,409);assert.equal(db.prepare('SELECT used_at FROM invitations WHERE id=?').get(stored.id).used_at,null);
// Username collisions, weak input and malicious role fields never consume the link.
r=await fetch('/api/register','POST',{token:one.token,username:'admin_test',password:'student-password-123'});assert.equal(r.status,409);
r=await fetch('/api/register','POST',{token:one.token,username:'student_a',password:'short'});assert.equal(r.status,400);
assert.equal(db.prepare('SELECT used_at FROM invitations WHERE id=?').get(stored.id).used_at,null);
r=await fetch('/api/register','POST',{token:one.token,username:'student_a',password:'student-password-123',role:'admin'});assert.equal(r.status,201);let student=r.headers.get('Set-Cookie').split(';')[0],user=db.prepare('SELECT * FROM users WHERE username=?').get('student_a');assert.equal(user.role,'user');assert.notEqual(user.password_hash,'student-password-123');assert.match(r.headers.get('Set-Cookie'),/HttpOnly; Secure; SameSite=Strict/);
assert.equal(db.prepare('SELECT used_by FROM invitations WHERE id=?').get(stored.id).used_by,user.id);
assert.equal((await fetch('/api/register','POST',{token:one.token,username:'student_b',password:'student-password-123'})).status,403);
assert.equal((await fetch('/api/invitations/check','POST',{token:one.token})).status,403);
assert.equal((await fetch('/api/admin/invites','GET',undefined,student,user.id)).status,403);
assert.equal((await fetch('/api/admin/users/owner/progress','GET',undefined,student,user.id)).status,403);
assert.equal((await fetch('/api/admin/users/owner/progress','GET',undefined,student,'owner')).status,401);
// Two simultaneous claims create exactly one account, with no orphan user.
const racing=await invite();let race=await Promise.all(['racer_a','racer_b'].map(username=>fetch('/api/register','POST',{token:racing.token,username,password:'race-password-123'},'','owner','race-ip')));assert.equal(race.filter(r=>r.status===201).length,1);assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE username IN ('racer_a','racer_b')").get().n,1);
const expired=await invite();let expiredId=expired.id;db.prepare('UPDATE invitations SET expires=? WHERE id=?').run(Date.now()-1,expiredId);assert.equal((await fetch('/api/register','POST',{token:expired.token,username:'expired_user',password:'expired-password-123'},'','owner','expired-ip')).status,403);
const revoked=await invite();let revokedId=revoked.id;assert.equal((await fetch('/api/admin/invites/'+revokedId+'/revoke','POST',{},admin)).status,200);assert.equal((await fetch('/api/register','POST',{token:revoked.token,username:'revoked_user',password:'revoked-password-123'},'','owner','revoked-ip')).status,403);
assert.equal((await fetch('/api/admin/invites/'+stored.id+'/revoke','POST',{},admin)).status,409);
// If session creation fails, the claim and user insertion roll back together.
const atomic=await invite();db.exec("CREATE TRIGGER qa_fail_session BEFORE INSERT ON sessions WHEN NEW.user_id IN (SELECT id FROM users WHERE username='atomic_test') BEGIN SELECT RAISE(ABORT,'qa-only'); END");assert.equal((await fetch('/api/register','POST',{token:atomic.token,username:'atomic_test',password:'atomic-password-123'},'','owner','atomic-ip')).status,503);assert.equal(db.prepare('SELECT id FROM users WHERE username=?').get('atomic_test'),undefined);assert.equal(db.prepare('SELECT used_at FROM invitations WHERE id=?').get(atomic.id).used_at,null);db.exec('DROP TRIGGER qa_fail_session');assert.equal((await fetch('/api/register','POST',{token:atomic.token,username:'atomic_test',password:'atomic-password-123'},'','owner','atomic-ip')).status,201);
const throttled=await invite();for(let n=0;n<8;n++)assert.equal((await fetch('/api/invitations/check','POST',{token:'invalid'},'','owner','rate-ip')).status,403);assert.equal((await fetch('/api/invitations/check','POST',{token:throttled.token},'','owner','rate-ip')).status,429);
// Existing state cannot be exposed through a changed account header or writes.
const sentinel='PRIVATE_RESPONSE_SENTINEL',values={'four.history.v1':[{id:'attempt',subject:'reading',finished:Date.now(),elapsed:100,results:[{id:'reading-t1:a',correct:1,total:2,automatic:true,items:[{id:'q1',correct:true,answered:true,response:sentinel,answer:'SECRET_ANSWER'},{id:'q2',correct:false,answered:true,response:sentinel}]}],ai:{'reading-t1:a':{q1:{score:4,feedback:'SECRET_FEEDBACK',transcript:'SECRET_TRANSCRIPT'}}}}],'four.words.v1':{environment:{mastered:true,note:'SECRET_NOTE',updated:Date.now()},environments:{mastered:false}},'four.learning.v1':[{id:'progress:test',type:'progress',day:'2026-10-21',at:Date.now(),words:{environment:true},mastered:1,total:1679,text:'SECRET_LEARNING_TEXT'}]};
for(let [key,value] of Object.entries(values))await DB.prepare('INSERT INTO states(key,value,revision) VALUES(?,?,1)').bind(user.id+':'+key,await sealJSON(env,value)).run();
r=await fetch('/api/admin/users/'+user.id+'/progress','GET',undefined,admin);assert.equal(r.status,200);let detail=await r.json(),serialized=JSON.stringify(detail);for(let secret of [sentinel,'SECRET_ANSWER','SECRET_FEEDBACK','SECRET_TRANSCRIPT','SECRET_NOTE','SECRET_LEARNING_TEXT','password_hash','salt'])assert(!serialized.includes(secret),secret);assert.equal(detail.attempts[0].results[0].items[0].score,undefined);assert.equal(detail.attempts[0].results[0].title,'QA Reading');assert.equal(detail.words.environment.mastered,true);assert.equal(detail.user.role,'user');
assert.equal((await fetch('/api/admin/users/'+user.id+'/progress','PUT',{},admin)).status,404);
assert.equal((await fetch('/api/admin/users/'+user.id+'/progress','GET',undefined,admin,user.id)).status,401);
const before=db.prepare('SELECT key,value,revision FROM states ORDER BY key').all();await fetch('/api/admin/users/'+user.id+'/progress','GET',undefined,admin);assert.deepEqual(db.prepare('SELECT key,value,revision FROM states ORDER BY key').all(),before,'admin detail is strictly read-only');
assert.equal((await fetch('/api/state','GET',undefined,admin,user.id)).status,401);assert.equal((await fetch('/api/recordings?key=x','GET',undefined,admin,user.id)).status,401);
r=await fetch('/api/admin/invites','GET',undefined,admin);let list=await r.json();assert(!JSON.stringify(list).includes('token_hash'));assert(!JSON.stringify(list).includes(one.token));assert(list.invitations.some(i=>i.used_by==='student_a'));
let cross=req('/api/admin/invites','POST',{},admin);cross.headers.set('Origin','https://evil.invalid');assert.equal((await worker.fetch(cross,env)).status,403);
// Additive migration is repeatable and preserves users, roles and learning state.
let usersBefore=db.prepare('SELECT * FROM users ORDER BY id').all();db.exec(fs.readFileSync(new URL('./migration-invitations.sql',import.meta.url),'utf8'));assert.deepEqual(db.prepare('SELECT * FROM users ORDER BY id').all(),usersBefore);assert.deepEqual(db.prepare('SELECT key,value,revision FROM states ORDER BY key').all(),before);
// Canonical grouping, missing AI grades and false mastery remain explicit.
let projected=projectAccountData({'four.words.v1':{child:{mastered:false},children:{mastered:true,note:sentinel}},'four.history.v1':[{finished:1,results:[{id:'speaking-t1:a',automatic:false,items:[{id:'q',correct:null}]}]}]},[{word:'child',forms:['children']}]);assert.equal(projected.words.child.mastered,false);assert.equal(projected.attempts[0].results[0].items[0].score,undefined);
assert.doesNotThrow(()=>projectAccountData({'four.history.v1':[null,{finished:1,results:{bad:true}}],'four.learning.v1':[null]},[]));
// Drafts, including cancellation tombstones, never enter admin detail projections.
assert.deepEqual(projectAccountData({...values,'four.drafts.v2':[{id:'cancelled-draft',cancelled:true,updated:Date.now(),answers:{q:'CANCELLED_PRIVATE_RESPONSE'}},{id:'active-draft',answers:{q:'PRIVATE_DRAFT_RESPONSE'}}]},[]),projectAccountData(values,[]));
// Destructive account management requires the current administrator and an exact
// username. All owned namespaces disappear together; adjacent accounts survive.
const deleteId='delete_user',otherId='deleteXuser';
for(let [id,username,role] of [[deleteId,'Wrong_Registration','user'],[otherId,'kept_student','user'],['other_admin','other_admin','admin']])db.prepare('INSERT INTO users(id,username,salt,password_hash,role,created) VALUES(?,?,?,?,?,?)').run(id,username,'qa-salt','qa-hash',role,Date.now());
const deletePayload={userId:deleteId,confirmUsername:'Wrong_Registration'};
assert.equal((await fetch('/api/users/delete','POST',deletePayload)).status,401);
assert.equal((await fetch('/api/users/delete','POST',deletePayload,student,user.id)).status,403);
assert.equal((await fetch('/api/users/delete','POST',deletePayload,admin,user.id)).status,401);
let deleteCross=req('/api/users/delete','POST',deletePayload,admin);deleteCross.headers.set('Origin','https://evil.invalid');assert.equal((await worker.fetch(deleteCross,env)).status,403);
for(let payload of [null,{}, {userId:deleteId,confirmUsername:null},{userId:'bad:id',confirmUsername:'x'},{userId:deleteId,confirmUsername:'wrong_registration'},{userId:deleteId,confirmUsername:'Wrong_Registration '}])assert.equal((await fetch('/api/users/delete','POST',payload,admin)).status,400);
for(let id of ['owner','other_admin'])assert.equal((await fetch('/api/users/delete','POST',{userId:id,confirmUsername:id==='owner'?'admin_test':id},admin)).status,403);
assert.equal((await fetch('/api/users/delete','POST',{userId:'no_such_account',confirmUsername:'nothing'},admin)).status,404);
for(let table of ['states','recordings','assessments'])for(let key of [deleteId+':draft',deleteId+':attempt:question',otherId+':draft',deleteId+'_extra:draft',deleteId,deleteId+';keep','example:shared']){
 if(table==='states')db.prepare('INSERT INTO states(key,value,revision) VALUES(?,?,1)').run(key,'qa-'+key);
 else if(table==='recordings')db.prepare('INSERT INTO recordings(key,type,value) VALUES(?,?,?)').run(key,'audio/webm',Buffer.from('qa-'+key));
 else db.prepare('INSERT INTO assessments(key,value) VALUES(?,?)').run(key,'qa-'+key);
}
db.prepare('INSERT INTO sessions(id,expires,user_id) VALUES(?,?,?)').run('delete-session',Date.now()+60000,deleteId);
db.prepare('INSERT INTO account_activity(user_id,value) VALUES(?,?)').run(deleteId,'qa-activity');
db.prepare('INSERT INTO invitations(id,token_hash,created_by,created,expires,used_at,used_by) VALUES(?,?,?,?,?,?,?)').run('delete-consumed','qa-hash-consumed','owner',1,9999999999999,2,deleteId);
db.prepare('INSERT INTO invitations(id,token_hash,created_by,created,expires) VALUES(?,?,?,?,?)').run('delete-created','qa-hash-created',deleteId,1,9999999999999);
const tableSnapshot=()=>Object.fromEntries(['users','sessions','states','recordings','assessments','account_activity','invitations'].map(table=>[table,db.prepare('SELECT * FROM '+table+' ORDER BY 1').all()]));
const beforeDelete=tableSnapshot();
const regularBatch=DB.batch;DB.batch=async statements=>{db.prepare("UPDATE users SET role='admin' WHERE id=?").run(deleteId);return regularBatch.call(DB,statements)};
assert.equal((await fetch('/api/users/delete','POST',deletePayload,admin)).status,409,'a role change between lookup and batch must prevent every deletion');
for(let table of ['sessions','states','recordings','assessments','account_activity','invitations'])assert.deepEqual(tableSnapshot()[table],beforeDelete[table]);
DB.batch=regularBatch;db.prepare("UPDATE users SET role='user' WHERE id=?").run(deleteId);assert.deepEqual(tableSnapshot(),beforeDelete);
db.exec("CREATE TRIGGER qa_fail_delete BEFORE DELETE ON users WHEN OLD.id='delete_user' BEGIN SELECT RAISE(ABORT,'qa-only'); END");
assert.equal((await fetch('/api/users/delete','POST',deletePayload,admin)).status,503);assert.deepEqual(tableSnapshot(),beforeDelete,'a failing delete rolls back every related row');db.exec('DROP TRIGGER qa_fail_delete');
const removed=await Promise.all([fetch('/api/users/delete','POST',deletePayload,admin),fetch('/api/users/delete','POST',deletePayload,admin)]);assert.equal(removed.filter(r=>r.status===200).length,1);assert(removed.every(r=>[200,404,409].includes(r.status)));
const afterDelete=tableSnapshot();
for(let table of ['states','recordings','assessments'])assert.deepEqual(afterDelete[table],beforeDelete[table].filter(row=>!row.key.startsWith(deleteId+':')),table+' removes only the exact account prefix');
for(let table of ['users','sessions','account_activity'])assert.deepEqual(afterDelete[table],beforeDelete[table].filter(row=>(table==='users'?row.id:row.user_id)!==deleteId),table+' keeps every other account');
let consumed=db.prepare('SELECT * FROM invitations WHERE id=?').get('delete-consumed');assert.equal(consumed.used_by,null);assert.equal(consumed.used_at,2);assert.equal(db.prepare('SELECT revoked_at FROM invitations WHERE id=?').get('delete-created').revoked_at>0,true);
assert.deepEqual(afterDelete.invitations.filter(i=>!['delete-consumed','delete-created'].includes(i.id)),beforeDelete.invitations.filter(i=>!['delete-consumed','delete-created'].includes(i.id)),'other invitations are untouched');
assert.equal((await fetch('/api/users/delete','POST',deletePayload,admin)).status,404);
console.log('PASS: admin-only read projections and credential/answer exclusion; unchanged personal state; single-use hashed invitations; collisions, parallel claims, expiry, revocation, role injection and CSRF; additive migration; exact-confirmed atomic account deletion, protected admins, neighbouring accounts and consumed invitations.');
