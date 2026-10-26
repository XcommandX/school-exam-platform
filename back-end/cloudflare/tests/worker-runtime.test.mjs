import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {ProjectedJSON} from '../src/json-stream.mjs';
import {satProjection} from '../src/validation.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const assets=resolve(root,'../../local-data/builds/cloudflare/assets');
const origin='https://study-test.invalid',setupToken='worker-fixture_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ';
async function runtime(){
  const bundled=await build({entryPoints:[resolve(root,'src/worker.mjs')],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*'],target:'es2022'});
  return new Miniflare(convertV4MiniflareOptions({modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2026-10-20',compatibilityFlags:['nodejs_compat'],bindings:{SETUP_TOKEN:setupToken},durableObjects:{AUTH:{className:'PlatformAuthStore',useSQLite:true},ACCOUNTS:{className:'PlatformAccountStore',useSQLite:true},BANK:{className:'PlatformBankStore',useSQLite:true}},serviceBindings:{ASSETS:async request=>{
    const url=new URL(request.url),path=resolve(assets,'.'+decodeURIComponent(url.pathname));
    if(!path.startsWith(assets+sep))return new Response('not found',{status:404});
    try{const data=await readFile(path);return new Response(request.method==='HEAD'?null:data,{headers:{'Content-Type':path.endsWith('.html')?'text/html':path.endsWith('.json')?'application/json':path.endsWith('.js')?'application/javascript':'application/octet-stream'}});}catch{return new Response('not found',{status:404});}
  }}}));
}
async function call(mf,path,{method='GET',body,cookie,user,headers={}}={}){
  const h={...headers};if(body!==undefined){h['Content-Type']='application/json';h.Origin??=origin;}if(cookie)h.Cookie=cookie;if(user)h['X-Account-ID']=user;
  const response=await mf.dispatchFetch(origin+path,{method,headers:h,body:body===undefined?undefined:JSON.stringify(body),redirect:'manual'});
  const text=await response.text();let value;try{value=JSON.parse(text);}catch{value=text;}
  return {status:response.status,headers:response.headers,value,cookie:response.headers.get('Set-Cookie')?.split(';')[0]};
}
async function setup(mf){const result=await call(mf,'/api/auth/bootstrap',{method:'POST',body:{setupToken,username:'worker-admin',password:'fixture-password',displayName:'匿名管理员'}});assert.equal(result.status,201,JSON.stringify(result.value));return result;}
function attempt(id='test'){return {id,practiceName:'合成SAT',status:'completed',completedAt:1,totalQuestions:1,questionIds:['q1'],questionSnapshots:[{id:'q1',section:'math',image:'fixture'}],answers:{q1:{answered:true,correctness:true}},correctCount:1,incorrectCount:0,unansweredCount:0,ungradedCount:0};}
test('full Worker security boundary, authentication, account isolation and API contracts',{timeout:60000},async t=>{
  const mf=await runtime();t.after(()=>mf.dispose());
  for(const path of ['/_catalog/routes.json','/%5fcatalog/routes.json','/back-end/server/platform_auth.py','/.git/config','/local-data/auth/accounts.db','/toefl/audio/not-real.mp3'])assert.equal((await call(mf,path)).status,404,path);
  assert.equal((await call(mf,'/')).status,302);assert.equal((await call(mf,'/api/sat/bootstrap')).status,401);
  assert.equal((await call(mf,'/login')).status,200);assert.equal((await call(mf,'/web/styles.css')).status,200);
  for(const path of ['/ap','/ap/','/ap/index.html'])assert.equal((await call(mf,path)).status,302,path);
  for(const path of ['/api/ap/example','/api/exams/ap/sources'])assert.equal((await call(mf,path)).status,401,path);
  assert.equal((await call(mf,'/ap/examples/synthetic-practice.json')).status,404);
  const admin=await setup(mf),owner=admin.value.user.id,auth={cookie:admin.cookie,user:owner};
  const apHTML=await call(mf,'/ap/',auth);assert.equal(apHTML.status,200);assert.match(apHTML.value,/window.PlatformSession=/);assert.match(apHTML.value,/platform-auth.js/);
  assert.equal((await call(mf,'/ap?kind=frq',auth)).headers.get('Location'),'/ap/?kind=frq');
  assert.equal((await call(mf,'/ap/app.js',auth)).status,200);
  const apCatalog=await call(mf,'/api/exams/ap/sources',auth);assert.equal(apCatalog.status,200);assert.deepEqual(apCatalog.value.sources,[]);
  const apExample=await call(mf,'/api/ap/example',auth);assert.equal(apExample.status,200);assert.equal(apExample.value.contentMode,'synthetic');assert.deepEqual(apExample.value.documents,[]);
  assert.equal((await call(mf,'/api/ap/example',{...auth,user:'another-account'})).status,409);
  assert.equal((await call(mf,'/api/exams/ap/sources/local-private',auth)).status,404);
  assert.equal('token'in admin.value,false);assert.match(admin.headers.get('Set-Cookie'),/HttpOnly; Secure; SameSite=Strict/);
  assert.match(admin.headers.get('Cache-Control'),/no-store/);
  assert.equal((await call(mf,'/api/auth/bootstrap',{method:'POST',body:{setupToken,username:'other',password:'password'}})).status,409);
  assert.equal((await call(mf,'/api/me',auth)).value.id,owner);
  assert.deepEqual((await call(mf,'/api/me/home',auth)).value,{revision:0,value:null});
  assert.deepEqual((await call(mf,'/api/toefl/bootstrap',auth)).value.state,{items:[]});
  assert.equal((await call(mf,'/api/me/home',{cookie:admin.cookie,method:'PUT',body:{value:{},revision:0}})).status,409);
  assert.equal((await call(mf,'/api/me/home',{...auth,method:'PUT',headers:{Origin:'https://other.invalid'},body:{value:{},revision:0}})).status,403);
  assert.equal((await call(mf,'/api/me/home',{...auth,method:'PUT',body:{value:{plan:{dailyGoal:30,note:'fixture'}},revision:0}})).status,200);
  assert.equal((await call(mf,'/api/toefl/state',{...auth,method:'PUT',body:{key:'four.words.v1',value:{new:['word']},revision:0}})).status,200);
  assert.equal((await call(mf,'/api/toefl/state',{...auth,method:'PUT',body:{key:'four.learning.v1',value:[{id:'learning',result:'fixture'}],revision:0}})).status,200);
  const sat={value:attempt(),revision:0,mutationId:'first'};
  assert.equal((await call(mf,'/api/sat/attempts/test',{...auth,method:'PUT',body:sat})).status,200);
  assert.deepEqual((await call(mf,'/api/sat/attempts/test',auth)).value.value,sat.value);
  assert.equal((await call(mf,'/api/sat/summary',auth)).value.attempts.length,1);
  const questionId='pack:'+encodeURIComponent('题目/一')+'@revision',wrongPath='/api/sat/wrong-book/'+encodeURIComponent(questionId);
  const wrong={questionId,addedAt:1,reason:'manual',questionSnapshot:{id:questionId,body:'fixture'}};
  assert.equal((await call(mf,wrongPath,{...auth,method:'PUT',body:{value:wrong,revision:0,mutationId:'wrong-first'}})).status,200);
  assert.deepEqual((await call(mf,wrongPath,auth)).value.value,wrong);
  const create=await call(mf,'/api/admin/users',{...auth,method:'POST',body:{username:'worker-student',password:'student-password'}});assert.equal(create.status,201,JSON.stringify(create.value));
  const login=await call(mf,'/api/auth/login',{method:'POST',body:{username:'worker-student',password:'student-password'}});assert.equal(login.status,200);
  const student={cookie:login.cookie,user:login.value.user.id};
  assert.equal((await call(mf,'/api/admin/users',student)).status,403);
  assert.equal((await call(mf,'/api/sat/attempts/test',student)).value.value,null);
  assert.equal((await call(mf,'/api/sat/attempts/test',{...student,user:owner,method:'PUT',body:sat})).status,409);
  const again=await call(mf,'/api/auth/login',{method:'POST',body:{username:'worker-admin',password:'fixture-password'}});assert.equal(again.status,200);
  assert.equal((await call(mf,'/api/me',auth)).status,401);
  const device2={cookie:again.cookie,user:owner};assert.equal((await call(mf,'/api/me/home',device2)).value.value.plan.dailyGoal,30);
  const satHTML=await call(mf,'/sat/html/index.html',device2);assert.equal(satHTML.status,200);assert.match(satHTML.value,/window.PlatformSession=/);assert.match(satHTML.value,/sat-account-sync.js/);
  const toeflHTML=await call(mf,'/toefl/',device2);assert.equal(toeflHTML.status,200);assert.match(toeflHTML.value,/type="module" src="\/web\/toefl-bridge.js"/);assert.doesNotMatch(toeflHTML.value,/<script[^>]*src=["'](?:\.\/)?four-data\.js/);
  for(const path of ['/_catalog/routes.json','/sat/%252e%252e/_catalog/routes.json','/toefl/%252E%252E/_catalog/sat-library.json'])assert.equal((await call(mf,path,device2)).status,404,path);
  const library=await call(mf,'/api/sat-library',device2);assert.equal(library.status,200);assert.ok(JSON.stringify(library.value).includes('18867')||JSON.stringify(library.value).length>100000);
  const status=await call(mf,'/api/question-bank/status',device2);assert.equal(status.value.writable,true);assert.equal((await call(mf,'/api/question-bank/status',student)).value.writable,false);
  const imported={name:'synthetic.json',text:JSON.stringify({title:'Synthetic source',questions:[{prompt:'Choose A.',options:['A','B','C','D'],answer:'A'}]})};
  assert.equal((await call(mf,'/api/question-bank',{...device2,method:'POST',headers:{'X-SAT-Bank-Token':'é'.repeat(64)},body:imported})).status,403);
  const saved=await call(mf,'/api/question-bank',{...device2,method:'POST',headers:{'X-SAT-Bank-Token':status.value.token},body:imported});assert.equal(saved.status,201,JSON.stringify(saved.value));
  const sources=await call(mf,'/api/exams/sat/sources',device2);assert.equal(sources.value.sources.length,1);
  const source=await call(mf,'/api/exams/sat/sources/'+encodeURIComponent(sources.value.sources[0].id),device2);assert.equal(source.status,200);assert.equal(source.value.questions[0].correctOption,0);
});
test('real workerd stores and streams a 62MiB SAT record across SQLite row limits',{timeout:60000},async t=>{
  const mf=await runtime();t.after(()=>mf.dispose());const admin=await setup(mf);
  const value=attempt('big');value.questionSnapshots[0].image='MARKER';
  const [before,after]=JSON.stringify({value,revision:0,mutationId:'large'}).split('MARKER');let stage=0,count=0;
  const body=new ReadableStream({pull(controller){if(stage===0){controller.enqueue(Buffer.from(before));stage=1;}else if(count++<248)controller.enqueue(Buffer.alloc(256*1024,97));else if(stage===1){controller.enqueue(Buffer.from(after));stage=2;}else controller.close();}});
  const response=await mf.dispatchFetch(origin+'/api/sat/attempts/big',{method:'PUT',headers:{'Content-Type':'application/json',Origin:origin,Cookie:admin.cookie,'X-Account-ID':admin.value.user.id},body,duplex:'half'});
  assert.equal(response.status,200,await response.text());
  const result=await mf.dispatchFetch(origin+'/api/sat/attempts/big',{headers:{Cookie:admin.cookie}});assert.equal(result.status,200);
  const parser=new ProjectedJSON({select:satProjection});for await(const chunk of result.body)parser.write(chunk);assert.equal(parser.end().value.id,'big');assert.ok(parser.captureEnd-parser.captureStart>60*1024*1024);
});
test('real workerd concatenates protected catalogue chunks without JSON/Unicode damage',{timeout:60000},async t=>{
  const mf=await runtime();t.after(()=>mf.dispose());const admin=await setup(mf);
  const response=await mf.dispatchFetch(origin+'/api/sat-library/question-index',{headers:{Cookie:admin.cookie,Range:'bytes=0-9'}});assert.equal(response.status,200);
  const data=await response.arrayBuffer();const catalog=JSON.parse(await readFile(resolve(assets,'_catalog/routes.json'),'utf8'));
  const route=catalog.protectedRoutes['/api/sat-library/question-index'];assert.equal(data.byteLength,route.bytes);
  const {createHash}=await import('node:crypto');assert.equal(createHash('sha256').update(new Uint8Array(data)).digest('hex'),route.sha256);assert.ok(JSON.parse(Buffer.from(data).toString()));
});
