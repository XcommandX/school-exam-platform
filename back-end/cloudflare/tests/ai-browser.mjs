// Real local Cloudflare preview + installed Chrome; no remote AI/production.
// Start `node back-end/cloudflare/scripts/preview-ai.mjs` before running.
import assert from 'node:assert/strict';
import {readFile,mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const artifacts=resolve(root,'local-data/test-artifacts/ai-preview');
await mkdir(artifacts,{recursive:true});
const profile=await mkdtemp(resolve(artifacts,'chrome-'));
const origin='https://127.0.0.1:8790';
const chrome=spawn(process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--disable-background-networking','--ignore-certificate-errors','--no-proxy-server','--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--user-data-dir='+profile,'about:blank'],{stdio:'ignore'});
let socket,seq=0,accept=false;const calls=new Map(),errors=[],external=[],grades=[];
async function until(fn,label){const end=Date.now()+60000;while(Date.now()<end){if(await fn())return;await delay(100)}throw Error('Timed out '+label);}
function cmd(method,params={}){return new Promise((yes,no)=>{const id=++seq;const timer=setTimeout(()=>{calls.delete(id);no(Error('CDP timeout '+method))},60000);calls.set(id,{yes:x=>{clearTimeout(timer);yes(x)},no});socket.send(JSON.stringify({id,method,params}));});}
async function evaluate(expression){const d=await cmd('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(d.exceptionDetails)throw Error(d.exceptionDetails.exception?.description||d.exceptionDetails.text);return d.result.value;}
async function ready(expression,label){await until(async()=>{try{return await evaluate(expression)}catch{return false}},label);}
async function shot(name){const d=await cmd('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});await writeFile(resolve(artifacts,name+'.png'),Buffer.from(d.data,'base64'));}
try {
  let port;await until(async()=>{try{port=(await readFile(resolve(profile,'DevToolsActivePort'),'utf8')).split(/\r?\n/)[0];return true}catch{return false}},'Chrome');
  const pages=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();socket=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await once(socket,'open');
  socket.addEventListener('message',e=>{const d=JSON.parse(e.data);if(d.id){const c=calls.get(d.id);if(c){calls.delete(d.id);d.error?c.no(Error(d.error.message)):c.yes(d.result)}return}if(d.method==='Runtime.exceptionThrown')errors.push(d.params.exceptionDetails.text);if(d.method==='Page.javascriptDialogOpening')void cmd('Page.handleJavaScriptDialog',{accept});if(d.method==='Network.requestWillBeSent'&&d.params.request.url.includes('/api/toefl/assess'))grades.push(d.params.request.url);if(d.method==='Fetch.requestPaused'){const {requestId,request}=d.params;if(/^https?:/.test(request.url)&&!request.url.startsWith(origin+'/')){external.push(request.url);void cmd('Fetch.failRequest',{requestId,errorReason:'BlockedByClient'})}else void cmd('Fetch.continueRequest',{requestId})}});
  await cmd('Page.enable');await cmd('Runtime.enable');await cmd('Network.enable');await cmd('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]});
  await cmd('Emulation.setDeviceMetricsOverride',{width:1365,height:1000,deviceScaleFactor:1,mobile:false});
  await cmd('Page.navigate',{url:origin+'/login?next='+encodeURIComponent('/toefl/?view=history')});
  await ready('document.readyState === "complete" && !!window.PlatformAuth && !!document.querySelector("#login-form")','login');
  await evaluate('document.querySelector("#username").value="ai-preview";document.querySelector("#password").value="Preview-only-2026!";document.querySelector("#login-submit").click()');
  await ready('!!document.querySelector("[data-a=history-item]")','synthetic history');
  await evaluate('document.querySelector("[data-a=history-item]").click()');
  await ready('!!document.querySelector("[data-a=ai-batch]")','report grading button');
  assert.equal(await evaluate('PracticeCloud.aiPreview'),true);assert.equal(grades.length,0,'no automatic grading/upload');
  await shot('writing-before');
  await evaluate('document.querySelector("[data-a=ai-batch]").click()');
  assert.equal(grades.length,0,'declined consent sends no grading request');
  accept=true;await evaluate('document.querySelector("[data-a=ai-batch]").click()');
  await ready('document.querySelector(".assessment-slot")?.innerText.includes("固定")','demo result');
  assert.equal(grades.length,1);assert.equal(await evaluate('JSON.parse(localStorage.getItem(PracticeCloud.storageKey("four.history.v1"))).some(row=>!!row.ai)'),false,'demo excluded from history');
  await shot('writing-demo');
  await cmd('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await shot('writing-mobile');
  const overflow=await evaluate('document.documentElement.scrollWidth>innerWidth+2');assert.equal(overflow,false,'mobile no horizontal overflow');
  await evaluate('window.__beforeAIReload=true');await cmd('Page.reload');await ready('!window.__beforeAIReload && document.readyState === "complete" && !!window.PracticeCloud&&!!document.querySelector("#app .site-header")','reload');
  assert.equal(await evaluate('JSON.parse(localStorage.getItem(PracticeCloud.storageKey("four.history.v1"))).some(row=>!!row.ai)'),false);
  // Synthetic one-second silent WAV exercises upload/hash plumbing, not microphone/ASR quality.
  await evaluate(`(async()=>{const r=FOUR_DATA.records.find(r=>r.source==='JIJING'&&r.complete&&r.module==='speaking-t2');const q=r.items[0],key=r.module+':'+r.id,id='local-oral-browser';const rows=JSON.parse(localStorage.getItem(PracticeCloud.storageKey('four.history.v1')));const report={id,subject:'speaking',finished:Date.now(),elapsed:60,queue:[key],answers:{},recorded:{[key+':'+q.id]:true},results:[{id:key,total:0,correct:0,automatic:false,items:[{id:q.id,response:'',correct:null,answered:true}]}]};PracticeCloud.queue('four.history.v1',[...rows.filter(x=>x.id!==id),report]);const bytes=new ArrayBuffer(32044),v=new DataView(bytes);const text=(at,s)=>{for(let i=0;i<s.length;i++)v.setUint8(at+i,s.charCodeAt(i))};text(0,'RIFF');v.setUint32(4,32036,true);text(8,'WAVE');text(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,16000,true);v.setUint32(28,32000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);text(36,'data');v.setUint32(40,32000,true);await new Promise((yes,no)=>{const req=indexedDB.open(PracticeCloud.recordingDatabase,1);req.onupgradeneeded=()=>{const s=req.result.createObjectStore('recordings',{keyPath:'key'});s.createIndex('attempt','attempt')};req.onerror=()=>no(req.error);req.onsuccess=()=>{const db=req.result,tx=db.transaction('recordings','readwrite');tx.objectStore('recordings').put({key:id+':'+key+':'+q.id,attempt:id,blob:new Blob([bytes],{type:'audio/wav'}),updated:Date.now(),cloudSynced:false});tx.oncomplete=()=>{db.close();yes()};tx.onerror=()=>no(tx.error)}});})()`);
  await ready('!localStorage.getItem(PracticeCloud.storageKey("cloud.pending.four.history.v1"))','oral fixture sync');
  await evaluate('window.__beforeAIReload=true');await cmd('Page.reload');
  await ready('!window.__beforeAIReload && document.readyState === "complete" && !!window.PracticeCloud && !!document.querySelector("[data-a=back]")','oral fixture reload');
  await evaluate('document.querySelector("[data-a=back]").click()');
  await ready('!!document.querySelector("[data-id=local-oral-browser]")','oral fixture');
  await evaluate('document.querySelector("[data-id=local-oral-browser]").click()');
  await ready('!!document.querySelector("[data-a=ai-batch]")','oral report');
  await evaluate('document.querySelector("[data-a=ai-batch]").click()');
  await ready('document.querySelector(".assessment-slot")?.innerText.includes("固定")','oral demo');
  assert.equal(grades.length,2,'one writing and one oral request');
  const oral=await evaluate('JSON.parse(localStorage.getItem(PracticeCloud.storageKey("four.history.v1"))).find(x=>x.id==="local-oral-browser")');
  assert.equal(Object.values(oral.recordingHashes).length,1);assert.match(Object.values(oral.recordingHashes)[0],/^[a-f0-9]{64}$/);assert.equal(oral.ai,undefined);
  await shot('speaking-demo');
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  await writeFile(resolve(artifacts,'result.json'),JSON.stringify({passed:true,checks:['local authenticated Cloudflare report','no automatic upload','declined consent','confirmed demo request','demo not saved as grades','mobile overflow','reload isolation','no external requests'],errors,external},null,2));
  console.log('AI BROWSER PASSED; screenshots in local-data/test-artifacts/ai-preview');
} catch(error) { console.error('Browser state',await evaluate('({url:location.href,text:document.body.innerText.slice(0,5000),cloud:window.PracticeCloud?.getStatus?.()})').catch(()=>null));await shot('failure').catch(()=>{});throw error; } finally {socket?.close();chrome.kill();}
