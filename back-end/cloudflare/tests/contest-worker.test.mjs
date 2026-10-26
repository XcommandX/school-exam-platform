import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/worker.mjs';
import {HTML_TEMPLATES} from '../scripts/build.mjs';

const token = 'contest-fixture-session_1234567890123456789';
const user = {id: 'a'.repeat(32), username: 'fixture', displayName: '</script><script>bad()</script>', role: 'student'};
function fixture() {
  const requested = [];
  const empty = {mode:'private',exams:[],totalProblems:0,errors:[],mathjaxAvailable:false};
  const exam = {id:'example-amc10-2026',mode:'example',revision:'1'.repeat(64),problems:[]};
  const examples = {...empty,mode:'example',exams:[{id:exam.id}],totalProblems:0};
  const route = asset => ({asset,contentType:'application/json; charset=utf-8'});
  const files = new Map([
    ['/_catalog/routes.json', JSON.stringify({schemaVersion:1,htmlTemplates:HTML_TEMPLATES,protectedRoutes:{
      '/contest-assets/assets/shared.png':{...route('/_catalog/contest-media/shared.png'),contentType:'image/png'},
      '/contest-vendor/mathjax/es5/tex-svg.js':{...route('/_catalog/contest-media/tex-svg.js'),contentType:'application/javascript'},
      '/api/contests/exams/shared-2026':route('/_catalog/contests/shared.json'),
      '/api/contests/catalog':route('/_catalog/contests/catalog.json'),
      '/api/contests/catalog?mode=example':route('/_catalog/contests/examples.json'),
      [`/api/contests/exams/${exam.id}?mode=example`]:route('/_catalog/contests/exam.json'),
    }})],
    ['/_catalog/contest-media/shared.png','synthetic-image'],
    ['/_catalog/contest-media/tex-svg.js','/* pinned fixture */'],
    ['/_catalog/contests/shared.json',JSON.stringify({id:'shared-2026',mode:'private',problems:[]})],
    ['/_catalog/contests/catalog.json',JSON.stringify(empty)],
    ['/_catalog/contests/examples.json',JSON.stringify(examples)],
    ['/_catalog/contests/exam.json',JSON.stringify(exam)],
    ['/contests/index.html','<!doctype html><html><head></head><body>Original example fixture</body></html>'],
    ['/contests/app.js','/* fixture */'],
    // Even accidentally packaged raw examples cannot bypass the route allowlist.
    ['/contests/examples/amc10.json','RAW_MUST_NOT_BE_SERVED'],
  ]);
  const env = {
    AUTH:{getByName:()=>({fetch:async (_url, options)=>new Response(JSON.stringify({authenticated:JSON.parse(options.body).token===token,loginEnabled:true,user}))})},
    ASSETS:{fetch:async request=>{
      const path = new URL(typeof request === 'string' ? request : request.url).pathname; requested.push(path);
      return files.has(path)?new Response(files.get(path),{headers:{'Content-Type':path.endsWith('.html')?'text/html':'application/json'}}):new Response('Not found',{status:404});
    }},
  };
  const call=(path, authenticated=true, method='GET')=>worker.fetch(new Request('https://contest-fixture.invalid'+path,{method,headers:authenticated?{Cookie:'study_session='+token}:{}}),env);
  return {call,requested,empty,examples,exam};
}

test('contest pages, scripts and both modes are protected before any asset lookup',async()=>{
  const {call,requested}=fixture();
  for(const path of ['/contests','/contests/','/contests/index.html']){
    const response=await call(path,false);assert.equal(response.status,302);
    assert.equal(response.headers.get('Location'),'/login?next='+encodeURIComponent(path));
  }
  for(const path of ['/api/contests/catalog','/api/contests/catalog?mode=example','/api/contests/exams/example-amc10-2026?mode=example'])assert.equal((await call(path,false)).status,401);
  for(const path of ['/contests/app.js','/contests/examples/amc10.json','/contest-assets/assets/test.svg','/contest-vendor/mathjax/es5/tex-svg.js'])assert.equal((await call(path,false)).status,404);
  assert.deepEqual(requested,[]);
});

test('contest HTML injects escaped PlatformSession and private APIs never fall back to examples',async()=>{
  const {call,empty,examples,exam}=fixture();
  const html=await call('/contests/');assert.equal(html.status,200);
  const text=await html.text();assert.match(text,/window\.PlatformSession=/);assert.match(text,/src="\/web\/platform-auth.js"/);
  assert.doesNotMatch(text,/<script>bad\(\)/);assert.match(html.headers.get('Cache-Control'),/no-store/);
  assert.equal((await call('/contests?mode=example')).headers.get('Location'),'/contests/?mode=example');
  assert.deepEqual(await (await call('/api/contests/catalog')).json(),empty);
  assert.deepEqual(await (await call('/api/contests/catalog?mode=private')).json(),empty);
  assert.deepEqual(await (await call('/api/contests/catalog?mode=example')).json(),examples);
  assert.deepEqual(await (await call('/api/contests/exams/'+exam.id+'?mode=example')).json(),exam);
  assert.equal((await call('/api/contests/exams/'+exam.id)).status,404);
  assert.equal((await call('/api/contests/exams/'+exam.id+'?mode=private')).status,404);
  for(const query of ['?mode=','?mode=other','?mode=example&mode=private','?mode=example&mode=example'])assert.equal((await call('/api/contests/catalog'+query)).status,400);
  assert.equal((await call('/api/contests/exams/not-found?mode=example')).status,404);
  assert.equal((await call('/contests/app.js')).status,200);
  assert.equal((await (await call('/api/contests/exams/shared-2026')).json()).mode,'private');
  assert.equal((await call('/api/contests/exams/shared-2026?mode=example')).status,404);
  for (const path of ['/contest-assets/assets/shared.png','/contest-vendor/mathjax/es5/tex-svg.js']) {
    assert.equal((await call(path)).status,200); assert.equal((await call(path,false)).status,404);
  }
  assert.equal((await call('/_catalog/contest-media/shared.png')).status,404);
  for(const path of ['/contests/examples/amc10.json','/_catalog/contests/examples.json','/contests/%252e%252e/private.json','/contest-assets/assets/test.svg'])assert.equal((await call(path)).status,404);
  const head=await call('/api/contests/catalog?mode=example',true,'HEAD');assert.equal(head.status,200);assert.equal(await head.text(),'');
});
