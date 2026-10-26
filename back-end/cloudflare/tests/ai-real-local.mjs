// Explicit opt-in real inference, synthetic inputs only. Never part of automated tests.
import assert from 'node:assert/strict';
import https from 'node:https';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
if(!process.argv.includes('--confirm-remote-ai'))throw Error('Requires --confirm-remote-ai; consumes Cloudflare quota.');
const root=fileURLToPath(new URL('../../../',import.meta.url)),origin='https://127.0.0.1:8791';
const artifacts=resolve(root,'local-data/test-artifacts/ai-real');await mkdir(artifacts,{recursive:true});
function sixBand(result){assert.equal(result.scoreScale,'toefl-practice-1-6-v1');assert.equal(result.scoreMax,6);assert.equal(result.scoreMin,1);assert.ok(result.score>=1&&result.score<=6&&Number.isInteger(result.score*2));for(const d of Object.values(result.dimensions))assert.ok(d.score>=1&&d.score<=6&&Number.isInteger(d.score*2));}
let cookie='',account='';
async function api(path,{method='GET',body}={}){
 let bytes,headers={Origin:origin,Cookie:cookie,'X-Account-ID':account};
 if(body instanceof FormData){const r=new Request(origin,{method:'POST',body});bytes=Buffer.from(await r.arrayBuffer());headers['Content-Type']=r.headers.get('Content-Type');}
 else if(body!==undefined){bytes=Buffer.from(JSON.stringify(body));headers['Content-Type']='application/json';}
 if(bytes)headers['Content-Length']=bytes.length;
 return new Promise((yes,no)=>{const req=https.request(origin+path,{method,headers,rejectUnauthorized:false},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{let value;try{value=JSON.parse(Buffer.concat(chunks).toString())}catch{return no(Error('Non-JSON response '+res.statusCode))}yes({status:res.statusCode,value,headers:res.headers})});});req.on('error',no);req.setTimeout(150000,()=>req.destroy(Error('Local request timeout')));req.end(bytes);});
}
const login=await api('/api/auth/login',{method:'POST',body:{username:'ai-preview',password:'Preview-only-2026!'}});assert.equal(login.status,200);cookie=login.headers['set-cookie'][0].split(';')[0];account=login.value.user.id;
const cfg=await api('/api/toefl/ai-config');assert.equal(cfg.value.preview,false);assert.equal(cfg.value.enabled,true);
const boot=await api('/api/toefl/bootstrap');
const bank=JSON.parse(await readFile(resolve(root,'back-end/question-banks/toefl/bank.json'),'utf8'));
const writing=bank.records.find(r=>r.complete&&['writing-t2','writing-t3'].includes(r.module));
const key=writing.key||writing.module+':'+writing.id;
const response='Dear Professor, I am writing to ask for your advice. I think our study group can help students learn together. Last week, we shared our notes and discussed difficult problems. This activity was helpful because everyone had a chance to explain an idea. Could we meet next Tuesday to discuss the plan? Thank you for your time.';
const form=new FormData();for(const [k,v] of Object.entries({record:key,question:writing.items[0].id,attempt:'local-ai-example-0',consent:'true',response}))form.set(k,v);
const started=Date.now();const result=await api('/api/toefl/assess',{method:'POST',body:form});await writeFile(resolve(artifacts,'writing-result.json'),JSON.stringify({elapsedMs:Date.now()-started,...result.value},null,2));assert.equal(result.status,200,JSON.stringify(result.value));assert.equal(result.value.demo,false);sixBand(result.value);console.log('REAL WRITING PASS',result.value.score);
// Oral test fixture is added to the isolated local account only.
const oral=bank.records.find(r=>r.complete&&r.module==='speaking-t2'),oralKey=oral.key||oral.module+':'+oral.id,qid=oral.items[0].id;
const audio=await readFile(resolve(artifacts,'synthetic-speaking.wav')),hash=createHash('sha256').update(audio).digest('hex');
const report={id:'local-real-oral',subject:'speaking',finished:Date.now(),elapsed:30,queue:[oralKey],answers:{},recorded:{[oralKey+':'+qid]:true},recordingHashes:{[oralKey+':'+qid]:hash},results:[{id:oralKey,total:0,correct:0,automatic:false,items:[{id:qid,response:'',correct:null,answered:true}]}]};
const state=boot.value.state.items.find(x=>x.key==='four.history.v1');
const saved=await api('/api/toefl/state',{method:'PUT',body:{key:'four.history.v1',value:[...(state?.value||[]).filter(r=>r.id!==report.id),report],revision:state?.revision??0}});assert.equal(saved.status,200,JSON.stringify(saved.value));
const oralForm=new FormData();for(const [k,v] of Object.entries({record:oralKey,question:qid,attempt:report.id,consent:'true'}))oralForm.set(k,v);oralForm.set('audio',new Blob([audio],{type:'audio/wav'}),'synthetic.wav');
const oralStarted=Date.now();const oralResult=await api('/api/toefl/assess',{method:'POST',body:oralForm});await writeFile(resolve(artifacts,'speaking-result.json'),JSON.stringify({elapsedMs:Date.now()-oralStarted,...oralResult.value},null,2));assert.equal(oralResult.status,200,JSON.stringify(oralResult.value));assert.equal(oralResult.value.demo,false);sixBand(oralResult.value);assert.ok(oralResult.value.transcript?.length);assert.equal(oralResult.value.audioHash,hash);console.log('REAL SPEAKING PASS',oralResult.value.score,oralResult.value.transcript);
