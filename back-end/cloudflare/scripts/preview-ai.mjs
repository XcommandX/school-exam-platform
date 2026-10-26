#!/usr/bin/env node
// Isolated local Cloudflare runtime. Real remote inference requires explicit --real-ai.
const realAI=process.argv.includes('--real-ai');
import { readFile, stat } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { browserFiles } from './build.mjs';
import { buildToeflAIQuestions } from './build-helpers.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const assets = resolve(root, 'local-data/builds/cloudflare/assets');
await stat(resolve(assets, '_catalog/routes.json')).catch(() => { throw Error('Run node back-end/cloudflare/scripts/build.mjs first.'); });
const sources = new Map(browserFiles().map(row => ['/' + row.target, resolve(root, row.source)]));
const bank = JSON.parse(await readFile(resolve(root,'back-end/question-banks/toefl/bank.json'),'utf8'));
const questionIndex = JSON.stringify(buildToeflAIQuestions(bank));
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.webp':'image/webp', '.mp3':'audio/mpeg', '.wav':'audio/wav', '.woff2':'font/woff2' };
const setupToken = randomBytes(32).toString('hex');
const username = 'ai-preview', password = 'Preview-only-2026!';
const remote=realAI?await (await import('./real-ai-binding.mjs')).realAIBinding(root):null;
const entry=resolve(root,'back-end/cloudflare/src/worker.mjs');
const wrapper=`import worker from './worker.mjs';export * from './worker.mjs';export default {fetch(request,env,ctx){env.AI??={run:async(model,input)=>{const r=await env.LOCAL_AI.fetch('https://local-ai/run',{method:'POST',body:JSON.stringify({model,input})});if(!r.ok)throw Error(r.status===429?'quota':'AI unavailable');return r.json()}};return worker.fetch(request,env,ctx)}};`;
const bundle = await build({ ...(realAI?{stdin:{contents:wrapper,resolveDir:resolve(root,'back-end/cloudflare/src'),sourcefile:'local-real-ai-wrapper.mjs'}}:{entryPoints:[entry]}), bundle:true, write:false, format:'esm', platform:'neutral', external:['node:*'], target:'es2022' });
const mf = new Miniflare(convertV4MiniflareOptions({
  host:'127.0.0.1', port:realAI?8791:8790, https:true, modules:true, script:bundle.outputFiles[0].text,
  compatibilityDate:'2026-10-20', compatibilityFlags:['nodejs_compat'],
  bindings:{ SETUP_TOKEN:setupToken, AI_PREVIEW:realAI?'false':'true', ENABLE_AI:realAI?'true':'false' },
  durableObjects:{ AUTH:{className:'PlatformAuthStore',useSQLite:true}, ACCOUNTS:{className:'PlatformAccountStore',useSQLite:true}, BANK:{className:'PlatformBankStore',useSQLite:true} },
  serviceBindings:{ ...(remote?{LOCAL_AI:remote.service}:{}), ASSETS:async request => {
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    if(pathname === '/_catalog/toefl-ai-questions.json') return new Response(questionIndex,{headers:{'Content-Type':'application/json'}});
    const built = resolve(assets, '.' + pathname);
    if (!built.startsWith(assets + sep)) return new Response('Not found',{status:404});
    const path = sources.get(pathname) || built;
    try { return new Response(request.method==='HEAD'?null:await readFile(path), {headers:{'Content-Type':mime[extname(path)]||'application/octet-stream'}}); }
    catch { return new Response('Not found',{status:404}); }
  } }
}));
const origin = (await mf.ready).origin;
async function api(path, body, extra={}) {
  const response = await mf.dispatchFetch(origin+path, {method:'POST', headers:{Origin:origin,'Content-Type':'application/json',...extra},body:JSON.stringify(body)});
  const value = await response.json();
  if (!response.ok) throw Error('Preview initialization failed: '+response.status+' '+value.code);
  return {response,value};
}
try {
  const {response,value} = await api('/api/auth/bootstrap',{setupToken,username,password,displayName:'AI 本地预览'});
  const cookie = response.headers.get('Set-Cookie').split(';')[0];
  const records = bank.records.filter(r=>r.complete&&['writing-t2','writing-t3'].includes(r.module)).slice(0,1);
  const reports = records.map((record,index)=>{
    const key = record.key || record.module+':'+record.id;
    const response = 'Dear Professor, I am writing to ask for your advice. I think our study group can help students learn together. Last week, we shared our notes and discussed difficult problems. This activity was helpful because everyone had a chance to explain an idea. Could we meet next Tuesday to discuss the plan? Thank you for your time.';
    return {id:'local-ai-example-'+index,subject:'writing',finished:Date.now(),elapsed:300,queue:[key],answers:{[key]:{[record.items[0].id]:response}},recorded:{},results:[{id:key,total:0,correct:0,automatic:false,items:[{id:record.items[0].id,response,correct:null,answered:true}]}]};
  });
  const saved = await mf.dispatchFetch(origin+'/api/toefl/state',{method:'PUT',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie,'X-Account-ID':value.user.id},body:JSON.stringify({key:'four.history.v1',value:reports,revision:0})});
  if(!saved.ok)throw Error('Cannot create synthetic preview report: '+saved.status);
  console.log(JSON.stringify({url:origin+'/toefl/?view=history',username,password,mode:realAI?'真实 Cloudflare AI（本地测试，最多 6 次模型调用）':'界面演示（非真实 AI）',database:'isolated ephemeral local Durable Objects',externalAI:realAI,productionChanges:false}));
  console.log('Local self-signed HTTPS certificate; accept only this 127.0.0.1 preview certificate. Stop with Ctrl+C. Restart resets preview accounts and records.');
} catch(error) { await mf.dispose();await remote?.dispose(); throw error; }
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, async()=>{await mf.dispose();await remote?.dispose();process.exit(0);});
