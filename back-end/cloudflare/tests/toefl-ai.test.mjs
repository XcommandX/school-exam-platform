import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {AccountStore} from '../src/data.mjs';
import {AccountAIStore,aiConfig,assessmentForm,boundedBytes,canonicalQuestion,assess,TEXT_MODEL} from '../src/toefl-ai.mjs';
import {buildToeflAIQuestions} from '../scripts/build-helpers.mjs';
import {ASSESSMENT_VERSION,SCORE_CONTRACT,isCurrentAssessment,validateAssessment,assessmentResponseFormat,assessmentMessages,dimensionNames} from '../../toefl/src/assessment.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex');
function storage(){const db=new DatabaseSync(':memory:');return {sql:{exec(query,...args){if(query.includes(';\n')){db.exec(query);return [];}return db.prepare(query).all(...args);}},transactionSync(fn){db.exec('BEGIN');try{const value=fn();db.exec('COMMIT');return value;}catch(e){db.exec('ROLLBACK');throw e;}}};}
const question={id:'q1',kind:'email',prompt_text:'Write a polite request to your teacher.'};
const record='writing-t2:sample';
const response='Dear teacher, could you please review my plan? Thank you.';
const proof={attempt:'submitted',record,question:'q1',oral:false,responseHash:hash(response),audioHash:null};
function makeStore(){let now=100000;const store=new AccountStore(storage(),{clock:()=>now}),ai=new AccountAIStore(store);store.bind('owner');store.saveJSON('toefl','four.history.v1',[{id:'submitted',finished:1,results:[{id:record,items:[{id:'q1',response,answered:true}]}]}],1);return {store,ai,tick:value=>{now+=value;}};}
function envFor(item=question){return {ASSETS:{async fetch(url){if(new URL(url).pathname==='/_catalog/toefl-ai-questions.json')return Response.json({schemaVersion:1,questions:[{record:item.kind==='repeat'?'speaking-t1:sample':record,question:{...item,prompt:item.prompt_text}}]});return new Response(null,{status:404});}}};}
function form(extra={}){const f=new FormData();for(const [k,v]of Object.entries({record,question:'q1',attempt:'submitted',response,consent:'true',...extra}))if(v!==null)f.set(k,v);return f;}
const request=f=>new Request('http://localhost/api/toefl/assess',{method:'POST',body:f});
const code=wanted=>e=>e.code===wanted;
test('six-band task rubric strictly validates half-step bounds without rescaling',()=>{
  assert.notEqual(ASSESSMENT_VERSION,'2026-10-20-r3');
  for(const kind of Object.keys(dimensionNames)){
    const label=dimensionNames[kind][0],prompt=assessmentMessages({kind,prompt:'Fixture'},'Sample answer')[0].content;
    assert.match(prompt,/1-6 TASK/);assert.match(prompt,/EVERY dimension/);assert.match(prompt,/NOT official TOEFL\/ETS section/);assert.match(prompt,/never convert or linearly rescale/);assert(!/0[-–]5/.test(prompt));
    for(let score=1;score<=6;score+=0.5){const result=validateAssessment({score,feedback:'Evidence.',dimensions:{[label]:{score}}},kind);assert.equal(result.score,score);assert.equal(result.dimensions[label].score,score);assert(isCurrentAssessment(result));}
    for(const score of [0,0.5,0.99,1.1,3.7,5.99,6.01,6.5,NaN,Infinity,'6',null]){
      assert.throws(()=>validateAssessment({score,feedback:'Evidence.'},kind));
      assert.throws(()=>validateAssessment({score:4,feedback:'Evidence.',dimensions:{[label]:{score}}},kind));
    }
  }
  assert(!isCurrentAssessment({score:5}));
  for(const fields of [{scoreScale:'old'},{scoreMin:0},{scoreMax:5}])assert.throws(()=>validateAssessment({score:4,feedback:'Evidence.',...fields},'email'));
});
test('Cloudflare response schema constrains task-specific dimensions and six-band scores',()=>{
  for(const kind of Object.keys(dimensionNames)){
    const format=assessmentResponseFormat(kind),schema=format.json_schema;
    assert.equal(format.type,'json_schema');assert.equal(schema.type,'object');assert.equal(schema.additionalProperties,false);
    assert.deepEqual(schema.required,Object.keys(schema.properties));
    assert.deepEqual(schema.properties.score.enum,[1,1.5,2,2.5,3,3.5,4,4.5,5,5.5,6]);
    assert.equal(schema.properties.feedback.minLength,1);
    const dimensions=schema.properties.dimensions;assert.deepEqual(dimensions.required,dimensionNames[kind]);assert.equal(dimensions.additionalProperties,false);
    for(const label of dimensionNames[kind]){const dimension=dimensions.properties[label];assert.deepEqual(dimension.required,['score','note']);assert.equal(dimension.additionalProperties,false);assert.deepEqual(dimension.properties.score,schema.properties.score);}
    for(const [key,value] of Object.entries(SCORE_CONTRACT))assert.deepEqual(schema.properties[key].enum,[value]);
  }
  assert.throws(()=>assessmentResponseFormat('unsupported'));
});
test('durable cache rejects unscaled, old-version and malformed scores even at a current key',async()=>{
  for(const value of [{score:5},{...SCORE_CONTRACT,score:4,version:'2026-10-20-r3'},{...SCORE_CONTRACT,score:3.7,version:ASSESSMENT_VERSION},{...SCORE_CONTRACT,score:4,version:ASSESSMENT_VERSION,dimensions:{x:{score:0}}}]){
    const {store,ai}=makeStore();store.sql.exec('INSERT INTO toefl_ai_cache VALUES (?,?,?)','current-key',JSON.stringify(value),100000);
    const reserved=await ai.handle('reserve',{proof,key:'current-key',lease:'new'},async()=>{});
    assert.equal(reserved.cached,undefined);assert.equal(reserved.ok,true);assert.equal(store.one('SELECT COUNT(*) AS n FROM toefl_ai_cache').n,0);
  }
});
test('grading build index normalizes kinds and includes only authoritative task material',()=>{
  const bank={records:[{id:'sample',module:'writing-t2',private:'omit',items:[{...question,kind:'write_email',translation:'omit',answer:'omit'}]}]};
  const index=buildToeflAIQuestions(bank);assert.equal(index.schemaVersion,1);assert.equal(index.questions[0].question.kind,'email');assert.equal(index.questions[0].question.answer,undefined);assert.equal(index.questions[0].question.translation,undefined);
  assert.throws(()=>buildToeflAIQuestions({records:[...bank.records,...bank.records]}),/Invalid/);
  assert.throws(()=>buildToeflAIQuestions({records:[{...bank.records[0],items:[{...question,prompt_text:'x'.repeat(40000)}]}]}),/oversized/);
});
test('AI activation is explicit, provider/model allowlisted, demo only loopback',()=>{
  assert.equal(aiConfig({},'https://school.invalid').enabled,false);
  for(const env of [{ENABLE_AI:true,AI:{run(){}}},{ENABLE_AI:'true',ASSESSMENT_PROVIDER:'groq',AI:{run(){}}},{ENABLE_AI:'true',TEXT_MODEL:'invalid',AI:{run(){}}}])assert.equal(aiConfig(env,'https://school.invalid').enabled,false);
  const activeConfig=aiConfig({ENABLE_AI:'true',AI:{run(){}}},'https://school.invalid');assert.equal(activeConfig.enabled,true);
  for(const [key,value] of Object.entries(SCORE_CONTRACT))assert.equal(activeConfig[key],value);
  assert.match(activeConfig.notice,/1–6/);assert.match(activeConfig.notice,/不是 ETS 官方分项或总成绩/);
  for(const url of ['https://school.invalid','https://localhost.attacker.invalid','https://127.0.0.1.attacker.invalid'])assert.equal(aiConfig({AI_PREVIEW:'true'},url).enabled,false);
  assert.equal(aiConfig({AI_PREVIEW:'true'},'http://127.0.0.1').preview,true);
});
test('streamed multipart enforces actual bytes, explicit consent, unique fields and MIME',async()=>{
  assert.equal((await assessmentForm(request(form()))).response,response);
  await assert.rejects(()=>assessmentForm(request(form({consent:null}))),code('consent_required'));
  const duplicate=form();duplicate.append('record',record);await assert.rejects(()=>assessmentForm(request(duplicate)),code('invalid_request'));
  const audio=form({audio:new Blob(['abc'],{type:'text/plain'})});await assert.rejects(()=>assessmentForm(request(audio)),code('audio_type'));
  const stream=new ReadableStream({start(c){c.enqueue(new Uint8Array(4));c.enqueue(new Uint8Array(4));c.close();}});
  await assert.rejects(()=>boundedBytes(new Request('https://test',{method:'POST',body:stream,duplex:'half'}),7),code('body_too_large'));
});
test('canonical questions are read from build assets, never the form or client snapshots',async()=>{
  const q=await canonicalQuestion(envFor(),record,'q1');assert.equal(q.prompt,question.prompt_text);assert.equal(q.kind,'email');
  await assert.rejects(()=>canonicalQuestion(envFor(),'writing-t2:forged','q1'),code('unsupported_question'));
});
test('durable ownership, exact answer checks, cache, restart throttle and stale writes',async()=>{
  const {store,ai,tick}=makeStore();const verify=async()=>{};
  await assert.rejects(()=>ai.handle('reserve',{proof:{...proof,attempt:'other'},key:'k',lease:'a'},verify),code('attempt_not_submitted'));
  await assert.rejects(()=>ai.handle('reserve',{proof:{...proof,responseHash:hash('changed')},key:'k',lease:'a'},verify),code('answer_changed'));
  await ai.handle('reserve',{proof,key:'k',lease:'a'},verify);
  await assert.rejects(()=>new AccountAIStore(store).handle('reserve',{proof,key:'k2',lease:'b'},verify),code('ai_busy'));
  await ai.handle('complete',{proof,key:'k',lease:'a',value:{...SCORE_CONTRACT,version:ASSESSMENT_VERSION,score:3}},verify);
  assert.equal((await new AccountAIStore(store).handle('reserve',{proof,key:'k',lease:'c'},verify)).cached.score,3);
  for(let n=0;n<18;n++)await ai.handle('reserve',{proof,key:'k',lease:'x'},verify);
  await assert.rejects(()=>new AccountAIStore(store).handle('reserve',{proof,key:'k',lease:'x'},verify),code('ai_rate_limited'));
  tick(60000);await ai.handle('reserve',{proof,key:'new',lease:'new'},verify);
  store.saveJSON('toefl','four.history.v1',[],2);store.saveJSON('toefl','four.drafts.v2',[{id:'submitted',cancelled:true,cancelledAt:1}],1);
  await assert.rejects(()=>ai.handle('complete',{proof,key:'new',lease:'new',value:{score:5}},verify),code('attempt_cancelled'));
  assert.equal(store.one('SELECT COUNT(*) AS n FROM toefl_ai_cache').n,1);
});
test('demo result is labelled and never persisted; real output validated and cached',async()=>{
  const {ai,store}=makeStore(),env=envFor(),rpc=(action,body)=>ai.handle(action,body,async()=>{});
  const demo=await (await assess(request(form()),env,{rpc,config:aiConfig({AI_PREVIEW:'true'},'http://localhost')})).json();
  assert.equal(demo.demo,true);assert(isCurrentAssessment(demo));assert.equal(demo.provider,'界面演示（非真实 AI）');assert.equal(store.one('SELECT COUNT(*) AS n FROM toefl_ai_cache').n,0);
  let calls=0;env.ENABLE_AI='true';env.AI={async run(model,input){calls++;assert.equal(model,TEXT_MODEL);assert.equal(input.max_tokens,1200);assert.deepEqual(input.response_format,assessmentResponseFormat('email'));return {response:JSON.stringify({score:4,feedback:'Useful response.',corrections:[{original:'invented text',suggestion:'bad'}]})};}};
  const config=aiConfig(env,'https://school.invalid');const result=await(await assess(request(form()),env,{rpc,config})).json();assert.equal(result.demo,false);assert(isCurrentAssessment(result));assert.equal(result.score,4);assert.deepEqual(result.corrections,[]);
  await assess(request(form()),env,{rpc,config});assert.equal(calls,1);
});
test('oral ASR uses approved model, binds audio hash, returns transient transcript and prevents stale cache',async()=>{
  const {ai,store}=makeStore(),oralRecord='speaking-t1:sample',bytes=new Uint8Array([1,2,3]),audioHash=hash(bytes);
  const report={id:'submitted',finished:1,recordingHashes:{[oralRecord+':q1']:audioHash},results:[{id:oralRecord,items:[{id:'q1',response:'',answered:true}]}]};store.saveJSON('toefl','four.history.v1',[report],2);
  const env=envFor({id:'q1',kind:'repeat',prompt_text:'A clear sample sentence.'});env.ENABLE_AI='true';let calls=0;
  env.AI={async run(model,input){calls++;assert.equal(model,'@cf/openai/whisper-large-v3-turbo');assert.equal(input.audio,'AQID');return {text:'A clear sample sentence.'};}};
  const rpc=(action,body)=>ai.handle(action,body,async()=>{}),config=aiConfig(env,'https://test');
  const make=()=>form({record:oralRecord,response:null,audio:new Blob([bytes],{type:'audio/webm'})});
  const result=await(await assess(request(make()),env,{rpc,config})).json();assert.equal(result.method,'reference-match');assert.equal(result.score,6);assert(isCurrentAssessment(result));assert.match(result.feedback,/不评价发音/);assert.equal(result.audioHash,audioHash);assert.equal(result.transcript,'A clear sample sentence.');assert.equal(calls,1);
  const cached=JSON.parse(store.one('SELECT value FROM toefl_ai_cache').value);assert.equal(cached.transcript,undefined);
  report.recordingHashes[oralRecord+':q1']=hash('different');store.saveJSON('toefl','four.history.v1',[report],3);
  await assert.rejects(()=>assess(request(make()),env,{rpc,config}),code('answer_changed'));assert.equal(calls,1);
});
test('answer edits during provider latency prevent response and cache write',async()=>{
  const {ai,store}=makeStore(),env=envFor();env.ENABLE_AI='true';
  env.AI={async run(){store.saveJSON('toefl','four.history.v1',[{id:'submitted',finished:1,results:[{id:record,items:[{id:'q1',response:'changed while grading',answered:true}]}]}],2);return {response:{score:4,feedback:'Should never be saved.'}};}};
  const rpc=(action,body)=>ai.handle(action,body,async()=>{});
  await assert.rejects(()=>assess(request(form()),env,{rpc,config:aiConfig(env,'https://test')}),code('answer_changed'));
  assert.equal(store.one('SELECT COUNT(*) AS n FROM toefl_ai_cache').n,0);
});
test('provider timeout retains a durable lease to block immediate duplicate billing',async()=>{
  const {ai}=makeStore(),env=envFor();env.ENABLE_AI='true';env.AI={async run(){throw Error('timed out');}};
  const rpc=(action,body)=>ai.handle(action,body,async()=>{}),config=aiConfig(env,'https://test');
  await assert.rejects(()=>assess(request(form()),env,{rpc,config}),code('ai_timeout'));
  await assert.rejects(()=>assess(request(form()),env,{rpc,config}),code('ai_busy'));
});
test('blank writing and empty ASR fail instead of becoming band 1',async()=>{
  const {ai,store}=makeStore(),env=envFor();env.ENABLE_AI='true';let calls=0;env.AI={async run(){calls++;return {text:'  '};}};
  const rpc=(action,body)=>ai.handle(action,body,async()=>{}),config=aiConfig(env,'https://test');
  await assert.rejects(()=>assess(request(form({response:'  '})),env,{rpc,config}));assert.equal(calls,0);
  const oralRecord='speaking-t1:sample',bytes=new Uint8Array([1,2,3]),audioHash=hash(bytes);
  store.saveJSON('toefl','four.history.v1',[{id:'submitted',finished:1,recordingHashes:{[oralRecord+':q1']:audioHash},results:[{id:oralRecord,items:[{id:'q1',response:'',answered:true}]}]}],2);
  const oralEnv={...envFor({id:'q1',kind:'repeat',prompt_text:'A clear sentence.'}),ENABLE_AI:'true',AI:env.AI};
  await assert.rejects(()=>assess(request(form({record:oralRecord,response:null,audio:new Blob([bytes],{type:'audio/webm'})})),oralEnv,{rpc,config}),code('asr_empty'));
  assert.equal(calls,1);assert.equal(store.one('SELECT COUNT(*) AS n FROM toefl_ai_cache').n,0);
});
test('invalid total or dimension half-step values never persist through the API',async()=>{
  for(const value of [{score:0},{score:6.5},{score:3.7},{score:4,dimensions:{'任务完成':{score:0}}},{score:4,dimensions:{'任务完成':{score:4.2}}},{score:4,scoreScale:'legacy'}]){
    const {ai,store}=makeStore(),env=envFor();env.ENABLE_AI='true';env.AI={async run(){return {response:{feedback:'Invalid fixture.',...value}};}};
    await assert.rejects(()=>assess(request(form()),env,{rpc:(action,body)=>ai.handle(action,body,async()=>{}),config:aiConfig(env,'https://test')}),code('ai_format'));
    assert.equal(store.one('SELECT COUNT(*) AS n FROM toefl_ai_cache').n,0);
  }
});
test('provider errors are sanitized; invalid scores are not cached',async()=>{
  const {ai,store}=makeStore(),env=envFor(),rpc=(action,body)=>ai.handle(action,body,async()=>{});env.ENABLE_AI='true';env.AI={async run(){return {response:'{"score":99,"feedback":"unsafe"}'};}};
  await assert.rejects(()=>assess(request(form()),env,{rpc,config:aiConfig(env,'https://test')}),code('ai_format'));
  assert.equal(store.one('SELECT COUNT(*) AS n FROM toefl_ai_cache').n,0);
  env.AI.run=async()=>{throw Error('quota SECRET STUDENT ANSWER');};
  await assert.rejects(()=>assess(request(form()),env,{rpc,config:aiConfig(env,'https://test')}),e=>e.code==='ai_quota'&&!e.message.includes('SECRET'));
});
