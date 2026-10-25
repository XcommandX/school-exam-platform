import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {buildToeflAIQuestions} from '../scripts/build-helpers.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),origin='http://127.0.0.1',setupToken='toefl-fixture_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const record='writing-t2:fixture',answer='Dear teacher, please review my study plan. Thank you.';
const bank={records:[{id:'fixture',module:'writing-t2',items:[{id:'q1',kind:'write_email',prompt_text:'Ask a teacher for feedback.'}]}]};
async function runtime(preview='true'){
  const bundled=await build({entryPoints:[resolve(root,'src/worker.mjs')],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*'],target:'es2022'});
  return new Miniflare(convertV4MiniflareOptions({modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2026-10-20',compatibilityFlags:['nodejs_compat'],bindings:{SETUP_TOKEN:setupToken,AI_PREVIEW:preview},durableObjects:{AUTH:{className:'PlatformAuthStore',useSQLite:true},ACCOUNTS:{className:'PlatformAccountStore',useSQLite:true},BANK:{className:'PlatformBankStore',useSQLite:true}},serviceBindings:{ASSETS:async request=>new URL(request.url).pathname==='/_catalog/toefl-ai-questions.json'?Response.json(buildToeflAIQuestions(bank)):new Response(null,{status:404})}}));
}
async function call(mf,path,{method='GET',body,cookie,user,headers={},host=origin}={}){
  const h={...headers};if(body!==undefined&&!(body instanceof FormData)){h['Content-Type']='application/json';body=JSON.stringify(body);}if(body!==undefined)h.Origin??=host;if(cookie)h.Cookie=cookie;if(user)h['X-Account-ID']=user;
  if(body instanceof FormData){const encoded=new Request(host+path,{method:'POST',body});h['Content-Type']=encoded.headers.get('Content-Type');body=new Uint8Array(await encoded.arrayBuffer());}
  const response=await mf.dispatchFetch(host+path,{method,headers:h,body,redirect:'manual'});const text=await response.text();let value;try{value=JSON.parse(text);}catch{value=text;}return {status:response.status,value,headers:response.headers,cookie:response.headers.get('Set-Cookie')?.split(';')[0]};
}
function form(extra={}){const f=new FormData();for(const[k,v]of Object.entries({record,question:'q1',attempt:'attempt1',response:answer,consent:'true',...extra}))if(v!==null)f.set(k,v);return f;}
async function setup(mf){const result=await call(mf,'/api/auth/bootstrap',{method:'POST',body:{setupToken,username:'ai-admin',password:'fixture-password',displayName:'Fixture'}});assert.equal(result.status,201,JSON.stringify(result.value));return {cookie:result.cookie,user:result.value.user.id};}
const report={id:'attempt1',finished:1,results:[{id:record,items:[{id:'q1',response:answer,answered:true}]}]};
test('real workerd grading boundary: authentication, trusted config, consent, ownership and durable quota',{timeout:60000},async t=>{
  const mf=await runtime();t.after(()=>mf.dispose());
  assert.equal((await call(mf,'/api/toefl/assess',{method:'POST',body:form()})).status,401);
  assert.equal((await call(mf,'/api/toefl/ai-config')).status,401);
  const auth=await setup(mf);
  let config=await call(mf,'/api/toefl/ai-config',auth);assert.equal(config.value.preview,true);assert.equal(config.value.examples,false);
  const bootstrap=await call(mf,'/api/toefl/bootstrap',{...auth,headers:{'X-Platform-AI-Config':'{"enabled":false}'}});assert.equal(bootstrap.value.me.aiReady,true);assert.equal(bootstrap.value.me.aiDemo,true);
  assert.equal((await call(mf,'/_catalog/toefl-ai-questions.json',auth)).status,404);
  assert.equal((await call(mf,'/api/toefl/assess',{...auth,method:'POST',body:form(),headers:{Origin:'https://attacker.invalid'}})).status,403);
  assert.equal((await call(mf,'/api/toefl/assess',{...auth,user:'wrong',method:'POST',body:form()})).status,409);
  const missing=await call(mf,'/api/toefl/assess',{...auth,method:'POST',body:form({consent:null})});assert.equal(missing.value.code,'consent_required');
  const unsubmitted=await call(mf,'/api/toefl/assess',{...auth,method:'POST',body:form()});assert.equal(unsubmitted.value.code,'attempt_not_submitted');
  assert.equal((await call(mf,'/api/toefl/state',{...auth,method:'PUT',body:{key:'four.history.v1',value:[report],revision:0}})).status,200);
  const stale=await call(mf,'/api/toefl/assess',{...auth,method:'POST',body:form({response:'altered'})});assert.equal(stale.value.code,'answer_changed');
  const first=await call(mf,'/api/toefl/assess',{...auth,method:'POST',body:form()});assert.equal(first.status,200,JSON.stringify(first.value));assert.equal(first.value.demo,true);assert.equal(first.value.scoreScale,'toefl-practice-1-6-v1');assert.equal(first.value.scoreMin,1);assert.equal(first.value.scoreMax,6);assert.equal(first.value.provider,'界面演示（非真实 AI）');assert.match(first.headers.get('Cache-Control'),/no-store/);
  const other=await call(mf,'/api/admin/users',{...auth,method:'POST',body:{username:'other-student',password:'fixture-password',displayName:'Other',role:'student'}});assert.equal(other.status,201);
  const login=await call(mf,'/api/auth/login',{method:'POST',body:{username:'other-student',password:'fixture-password'}});assert.equal(login.status,200);
  const isolated=await call(mf,'/api/toefl/assess',{cookie:login.cookie,user:login.value.user.id,method:'POST',body:form()});assert.equal(isolated.value.code,'attempt_not_submitted');
  // Demo is never a usable public deployment mode, even with the flag on.
  const remote=await call(mf,'/api/toefl/ai-config',{...auth,host:'https://school.invalid'});assert.equal(remote.value.enabled,false);
  // Real minutes can roll over during password hashing; unit tests inject a clock.
  let limited;
  for(let n=0;n<31;n++){const r=await call(mf,'/api/toefl/assess',{...auth,method:'POST',body:form()});if(r.status===429){limited=r;break;}assert.equal(r.status,200,JSON.stringify(r.value));}
  assert.ok(limited,'durable minute or daily limit must reject the burst');assert.ok(['ai_rate_limited','ai_quota'].includes(limited.value.code));
});
test('workerd disabled default rejects forged readiness and never invokes providers',{timeout:60000},async t=>{
  const mf=await runtime('false');t.after(()=>mf.dispose());const auth=await setup(mf);
  const boot=await call(mf,'/api/toefl/bootstrap',{...auth,headers:{'X-Platform-AI-Config':'{"enabled":true,"preview":true}'}});assert.equal(boot.value.me.aiReady,false);assert.equal(boot.value.me.aiDemo,false);assert.equal(boot.value.me.aiProvider,'Cloudflare Workers AI');
  const result=await call(mf,'/api/toefl/assess',{...auth,method:'POST',body:form()});assert.equal(result.status,503);assert.equal(result.value.code,'ai_disabled');
});
