// Unified-platform AI boundary. No recordings or answers are logged or stored here.
import {createHash,randomUUID} from 'node:crypto';
import {InputError,fail} from './json-stream.mjs';
import {ASSESSMENT_VERSION,SCORE_CONTRACT,isCurrentAssessment,assessmentResponseFormat,assessmentMessages,parseAssessment,validateAssessment,repeatAlignment,exactRepeat,transcribe,dimensionNames} from '../../toefl/src/assessment.mjs';
export const TEXT_MODEL='@cf/meta/llama-3.3-70b-instruct-fp8-fast';
export const DEMO_PROVIDER='界面演示（非真实 AI）';
export const AI_LIMITS=Object.freeze({bodyBytes:8_200_000,audioBytes:8_000_000,responseCharacters:18000,requestsPerMinute:20,assessmentsPerDay:30,concurrency:1});
const MIME=new Set(['audio/webm','audio/ogg','audio/wav','audio/x-wav','audio/mp4','audio/mpeg','audio/flac']);
const hash=value=>createHash('sha256').update(value).digest('hex');
const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json; charset=utf-8'}});
export function aiConfig(env,url){
  const preview=env.AI_PREVIEW==='true'&&['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname);
  const configured=env.ENABLE_AI==='true'&&(!env.ASSESSMENT_PROVIDER||env.ASSESSMENT_PROVIDER==='cloudflare')&&(!env.TEXT_MODEL||env.TEXT_MODEL===TEXT_MODEL)&&typeof env.AI?.run==='function';
  return {...SCORE_CONTRACT,enabled:preview||configured,preview,provider:preview?DEMO_PROVIDER:'Cloudflare Workers AI',notice:preview?'仅用于界面演示；不会调用真实 AI，也不会保存演示评分。':configured?'单题练习估分（1–6，0.5 分档），不是 ETS 官方分项或总成绩。口语仅评估转写内容，不评估发音或语音流利度。':'AI 评分尚未启用。',examples:false,limits:AI_LIMITS};
}
export async function boundedBytes(request,maximum){
  const declared=request.headers.get('Content-Length');
  if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>maximum))fail('请求文件过大。',413,'body_too_large');
  if(!request.body)fail('请求不能为空。');
  const reader=request.body.getReader(),chunks=[];let size=0;
  try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>maximum)fail('请求文件过大。',413,'body_too_large');chunks.push(value);}}
  catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
  const result=new Uint8Array(size);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.length;}return result;
}
export async function assessmentForm(request){
  const type=request.headers.get('Content-Type')||'';
  if(!/^multipart\/form-data\s*;/i.test(type))fail('评分请求必须使用 multipart/form-data。',415,'multipart_required');
  const bytes=await boundedBytes(request,AI_LIMITS.bodyBytes);let form;
  try{form=await new Response(bytes,{headers:{'Content-Type':type}}).formData();}catch{fail('作答格式不完整。');}
  const allowed=new Set(['record','question','attempt','response','audio','consent']);
  for(const key of form.keys())if(!allowed.has(key)||form.getAll(key).length!==1)fail('评分字段无效或重复。');
  if(form.get('consent')!=='true')fail('请先明确同意发送本次作答用于评分。',403,'consent_required');
  const record=form.get('record'),question=form.get('question'),attempt=form.get('attempt'),response=form.get('response')??'';
  if(typeof record!=='string'||!record||record.length>300||typeof question!=='string'||!question||question.length>150||typeof attempt!=='string'||!/^[A-Za-z0-9_-]{1,150}$/.test(attempt)||['cache','transcript','example'].includes(attempt))fail('题目或练习编号无效。');
  if(typeof response!=='string')fail('请提供文本作答。');
  if(response.length>AI_LIMITS.responseCharacters)fail('作答文本过长。',413,'response_too_large');
  const audio=form.get('audio');let audioBytes=null,audioType=null;
  if(audio!==null){
    if(typeof audio==='string'||typeof audio.arrayBuffer!=='function'||audio.size===0||audio.size>AI_LIMITS.audioBytes)fail('请提供不超过 8 MB 的录音。',413,'audio_too_large');
    audioType=audio.type.toLowerCase().split(';')[0].trim();if(!MIME.has(audioType))fail('录音格式不支持。',415,'audio_type');
    audioBytes=new Uint8Array(await audio.arrayBuffer());
  }
  return {record,question,attempt,response,audioBytes,audioType};
}
// Only this build-produced internal asset is authoritative. No eval or user URL.
const banks=new WeakMap();
async function loadQuestions(env){
  const asset=await env.ASSETS.fetch('https://assets/_catalog/toefl-ai-questions.json');
  if(!asset.ok)fail('题库评分索引尚未构建。',503,'question_unavailable');
  let value;
  try{value=JSON.parse(new TextDecoder().decode(await boundedBytes(asset,12*1024*1024+1)));}catch{fail('题库评分索引不可用。',503,'question_unavailable');}
  if(value.schemaVersion!==1||!Array.isArray(value.questions)||value.questions.length>20000)fail('题库评分索引格式无效。',503,'question_unavailable');
  const index=new Map();
  for(const row of value.questions){
    const q=row.question;
    if(typeof row.record!=='string'||!q||typeof q.id!=='string'||!Object.hasOwn(dimensionNames,q.kind)||typeof q.prompt!=='string'||JSON.stringify(q).length>32768)fail('题库评分索引格式无效。',503,'question_unavailable');
    const key=JSON.stringify([row.record,q.id]);if(index.has(key))fail('题目编号重复。',503,'question_unavailable');index.set(key,q);
  }
  return index;
}
export async function canonicalQuestion(env,record,id){
  if(!banks.has(env))banks.set(env,loadQuestions(env).catch(error=>{banks.delete(env);throw error;}));
  const q=(await banks.get(env)).get(JSON.stringify([record,id]));if(!q)fail('该题不支持 AI 评分。',400,'unsupported_question');return q;
}
function providerError(error){
  if(error instanceof InputError)return error;
  const raw=String(error?.message||'');
  const code=/3036|daily.*allocation|quota/i.test(raw)?'ai_quota':/3040|capacity|busy|429/i.test(raw)?'ai_busy':/3007|timeout|timed out|abort/i.test(raw)?'ai_timeout':'ai_unavailable';
  // Never forward provider messages, which may contain student input.
  return new InputError(code==='ai_quota'?'今日评分额度已用完，请稍后重试。':code==='ai_busy'?'评分服务繁忙，请稍后重试。':code==='ai_timeout'?'评分超时，作答仍保留。':'评分服务暂不可用，作答仍保留。',code==='ai_busy'||code==='ai_quota'?429:503,code);
}
async function timedRun(env,model,input,signal){
  if(signal?.aborted)fail('评分已停止。',409,'cancelled');
  let timer,onAbort;
  try{return await Promise.race([env.AI.run(model,input),new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(new InputError('评分超时，作答仍保留。',503,'ai_timeout')),55000);
    onAbort=()=>reject(new InputError('评分已停止。',409,'cancelled'));signal?.addEventListener('abort',onAbort,{once:true});
  })]);}catch(error){throw providerError(error);}finally{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);}
}
export async function assess(request,env,{rpc,config}){
  if(!config.enabled)fail('AI 评分尚未启用。',503,'ai_disabled');
  const form=await assessmentForm(request),q=await canonicalQuestion(env,form.record,form.question),oral=['repeat','interview'].includes(q.kind);
  if(oral?!form.audioBytes||form.response!=='':form.audioBytes!==null||!form.response.trim())fail(oral?'口语评分需要本次录音，不接受客户端转写。':'写作评分需要文本作答。');
  const audioHash=form.audioBytes?hash(form.audioBytes):null;
  const proof={attempt:form.attempt,record:form.record,question:form.question,oral,responseHash:hash(form.response),audioHash};
  const key=hash(JSON.stringify({v:ASSESSMENT_VERSION,adapter:1,q,proof,model:TEXT_MODEL,preview:config.preview})),lease=randomUUID();
  const reserved=await rpc('reserve',{proof,key,lease,demo:config.preview});
  if(reserved.cached)return json(reserved.cached);
  let committed=false,retainLease=false;
  try{
    let response=form.response,out;
    if(config.preview){
      out={score:3.5,feedback:'界面演示样例：此分数与建议为固定占位内容，未分析你的作答，不代表真实 AI 或官方成绩。',strengths:['演示：此处展示内容优点。'],improvements:['演示：此处展示后续练习建议。'],dimensions:Object.fromEntries(dimensionNames[q.kind].map(name=>[name,{score:3.5,note:'固定演示占位，不评价实际能力。'}])),corrections:[],demo:true};
    }else{
      if(oral){const result=await transcribe({},form.audioBytes,form.audioType,(_env,model,input)=>timedRun(env,model,input,request.signal));response=result?.text;if(typeof response!=='string'||!response.trim()||response.length>AI_LIMITS.responseCharacters)fail('录音未能转写为有效文本，请检查后重试。',422,'asr_empty');}
      const alignment=q.kind==='repeat'?repeatAlignment(q.prompt,response):null;
      if(alignment?.exact)out=exactRepeat(alignment);
      else{
        const messages=assessmentMessages(q,response,alignment);
        messages[1].content=JSON.stringify({...JSON.parse(messages[1].content),recipient:q.recipient,subject:q.subject,requirements:q.requirements});
        if(oral)messages[0].content+=' Only a text transcript is available. Never infer or score pronunciation, acoustic intelligibility, speech fluency, accent, timing, or delivery; evaluate content and written language only.';
        const generated=await timedRun(env,TEXT_MODEL,{messages,max_tokens:1200,temperature:0,response_format:assessmentResponseFormat(q.kind)},request.signal);
        const raw=generated?.response??generated?.choices?.[0]?.message?.content;
        if(typeof raw==='string'&&raw.length>24000)fail('评分结果格式无效，请重试。',502,'ai_format');
        try{out=validateAssessment(parseAssessment(raw),q.kind,response);}catch{fail('评分结果格式无效，请重试。',502,'ai_format');}
        if(alignment)out.alignment=alignment;
      }
      out={...out,demo:false,...(oral?{transcript:response}:{})};
    }
    if(request.signal?.aborted)fail('评分已停止。',409,'cancelled');
    out={...out,...SCORE_CONTRACT,provider:config.provider,created:Date.now(),version:ASSESSMENT_VERSION,...(audioHash?{audioHash}:{}),notice:config.notice};
    const {transcript:_transientTranscript,...cacheValue}=out;
    await rpc('complete',{proof,key,lease,demo:config.preview,value:cacheValue});committed=true;return json(out);
  }catch(error){
    // AI.run has no documented cancellation guarantee. Keep the durable lease
    // after a timeout/abort so an immediate frontend retry cannot double-bill.
    retainLease=['ai_timeout','cancelled'].includes(error?.code);throw error;
  }finally{if(!committed&&!retainLease)await rpc('release',{lease}).catch(()=>{});}
}

// Durable state belongs to the already authenticated account DO, not an isolate map.
export class AccountAIStore{
  constructor(store){this.store=store;this.sql=store.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS toefl_ai_cache(key TEXT PRIMARY KEY,value TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS toefl_ai_control(id INTEGER PRIMARY KEY,minute INTEGER NOT NULL,requests INTEGER NOT NULL,day INTEGER NOT NULL,assessments INTEGER NOT NULL,lease TEXT,lease_until INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS toefl_ai_cache_age ON toefl_ai_cache(created_at);`);
  }
  async snapshot(proof){
    if(!proof||typeof proof.attempt!=='string'||typeof proof.record!=='string'||typeof proof.question!=='string')fail('评分记录无效。');
    const historyRow=this.store.row('toefl','four.history.v1'),draftRow=this.store.row('toefl','four.drafts.v2'),release=this.store.pin([historyRow,draftRow]);
    try{
      const history=await this.store.load(historyRow)||[],drafts=await this.store.load(draftRow)||[];
      const reports=history.filter(r=>r?.id===proof.attempt),report=reports[0];
      if(!report){if(drafts.some(r=>r?.id===proof.attempt&&r.cancelled))fail('该练习已取消。',410,'attempt_cancelled');fail('请先同步已提交的练习记录。',409,'attempt_not_submitted');}
      const records=report.results?.filter(r=>r?.id===proof.record)||[],items=records[0]?.items?.filter(i=>i?.id===proof.question)||[],item=items[0];
      if(reports.length!==1||!Number.isFinite(report.finished)||report.finished<=0||records.length!==1||items.length!==1||item.answered!==true)fail('该题不属于当前账号的已提交作答。',409,'attempt_not_submitted');
      if(proof.oral){if(!/^[a-f0-9]{64}$/.test(proof.audioHash||'')||report.recordingHashes?.[proof.record+':'+proof.question]!==proof.audioHash)fail('录音已变化，请同步后重新评分。',409,'answer_changed');}
      else if(typeof item.response!=='string'||hash(item.response)!==proof.responseHash)fail('作答已变化，请同步后重新评分。',409,'answer_changed');
      return {historyRevision:historyRow.revision,draftRevision:draftRow?.revision||0};
    }finally{release();}
  }
  current(snapshot){if((this.store.row('toefl','four.history.v1')?.revision||0)!==snapshot.historyRevision||(this.store.row('toefl','four.drafts.v2')?.revision||0)!==snapshot.draftRevision)fail('记录正在更新，请重试。',409,'answer_changed');}
  async handle(action,body,verify){
    if(action==='release'){this.sql.exec('UPDATE toefl_ai_control SET lease=NULL,lease_until=0 WHERE id=1 AND lease=?',body.lease);return {ok:true};}
    const snapshot=await this.snapshot(body.proof);await verify();
    return this.store.storage.transactionSync(()=>{
      this.current(snapshot);const now=this.store.clock(),minute=Math.floor(now/60000),day=Math.floor(now/86400000);
      this.sql.exec('DELETE FROM toefl_ai_cache WHERE created_at<?',now-7*86400000);
      const control=this.store.one('SELECT * FROM toefl_ai_control WHERE id=1');
      if(action==='reserve'){
        const requests=control?.minute===minute?control.requests:0,assessments=control?.day===day?control.assessments:0;
        if(requests>=AI_LIMITS.requestsPerMinute)fail('评分请求过于频繁，请稍后重试。',429,'ai_rate_limited',{retryAfter:60});
        const row=!body.demo&&this.store.one('SELECT value FROM toefl_ai_cache WHERE key=?',body.key);
        let cached=null;
        if(row){try{const value=JSON.parse(row.value);if(value.version===ASSESSMENT_VERSION&&isCurrentAssessment(value))cached=value;}catch{}if(!cached)this.sql.exec('DELETE FROM toefl_ai_cache WHERE key=?',body.key);}
        if(!cached&&control?.lease_until>now)fail('已有评分正在处理，请稍后重试。',429,'ai_busy',{retryAfter:3});
        if(!cached&&assessments>=AI_LIMITS.assessmentsPerDay)fail('本账号今日评分次数已用完。',429,'ai_quota');
        this.sql.exec('INSERT INTO toefl_ai_control VALUES (1,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET minute=excluded.minute,requests=excluded.requests,day=excluded.day,assessments=excluded.assessments,lease=excluded.lease,lease_until=excluded.lease_until',minute,requests+1,day,assessments+(cached?0:1),cached?control?.lease||null:body.lease,cached?control?.lease_until||0:now+125000);
        return cached?{cached}:{ok:true};
      }
      if(action!=='complete'||control?.lease!==body.lease||control.lease_until<=now)fail('评分请求已过期，请重试。',409,'ai_stale');
      if(!body.demo){const serialized=JSON.stringify(body.value);if(serialized.length>64000)fail('评分结果过大。',502,'ai_format');this.store.capacity(128*1024);this.sql.exec('INSERT OR REPLACE INTO toefl_ai_cache VALUES (?,?,?)',body.key,serialized,now);this.sql.exec('DELETE FROM toefl_ai_cache WHERE key IN (SELECT key FROM toefl_ai_cache ORDER BY created_at DESC LIMIT -1 OFFSET 100)');}
      this.sql.exec('UPDATE toefl_ai_control SET lease=NULL,lease_until=0 WHERE id=1');return {ok:true};
    });
  }
}
