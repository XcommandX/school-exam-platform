// Explicit real local UI acceptance. Uses an already cached synthetic writing answer.
import assert from 'node:assert/strict';
import {readFile,mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
if(!process.argv.includes('--confirm-remote-ai'))throw Error('Explicit consent flag required');
const root=fileURLToPath(new URL('../../../',import.meta.url)),artifacts=resolve(root,'local-data/test-artifacts/ai-real');await mkdir(artifacts,{recursive:true});
const profile=await mkdtemp(resolve(artifacts,'chrome-')),origin='https://127.0.0.1:8791';
const chrome=spawn(process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--disable-background-networking','--ignore-certificate-errors','--no-proxy-server','--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--user-data-dir='+profile,'about:blank'],{stdio:'ignore'});
let socket,seq=0;const calls=new Map(),errors=[];
async function until(fn,label){const end=Date.now()+90000;while(Date.now()<end){try{if(await fn())return;}catch{}await delay(150);}throw Error('Timed out '+label);}
function cmd(method,params={}){return new Promise((yes,no)=>{const id=++seq,t=setTimeout(()=>no(Error('CDP timeout')),100000);calls.set(id,{yes:x=>{clearTimeout(t);yes(x)},no});socket.send(JSON.stringify({id,method,params}));});}
async function evaluate(expression){const d=await cmd('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(d.exceptionDetails)throw Error(d.exceptionDetails.text);return d.result.value;}
try{
 let port;await until(async()=>{port=(await readFile(resolve(profile,'DevToolsActivePort'),'utf8')).split(/\r?\n/)[0];return !!port},'Chrome');
 const pages=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();socket=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await once(socket,'open');
 socket.addEventListener('message',e=>{const d=JSON.parse(e.data);if(d.id){const c=calls.get(d.id);if(c){calls.delete(d.id);d.error?c.no(Error(d.error.message)):c.yes(d.result)}return;}if(d.method==='Page.javascriptDialogOpening')void cmd('Page.handleJavaScriptDialog',{accept:true});if(d.method==='Runtime.exceptionThrown')errors.push(d.params.exceptionDetails.text);});
 await cmd('Page.enable');await cmd('Runtime.enable');await cmd('Emulation.setDeviceMetricsOverride',{width:1365,height:1100,deviceScaleFactor:1,mobile:false});
 await cmd('Page.navigate',{url:origin+'/login?next='+encodeURIComponent('/toefl/?view=history')});
 await until(()=>evaluate('document.readyState==="complete"&&!!window.PlatformAuth&&!!document.querySelector("#login-form")'),'login');
 await evaluate('document.querySelector("#username").value="ai-preview";document.querySelector("#password").value="Preview-only-2026!";document.querySelector("#login-submit").click()');
 await until(()=>evaluate('!!document.querySelector("[data-id=local-ai-example-0]")'),'history');await evaluate('document.querySelector("[data-id=local-ai-example-0]").click()');
 await until(()=>evaluate('!!document.querySelector("[data-a=ai-batch]")'),'report');assert.equal(await evaluate('PracticeCloud.aiPreview'),false);
 await evaluate('document.querySelector("[data-a=ai-batch]").click()');await until(()=>evaluate('document.querySelector(".assessment-slot")?.textContent.includes("/ 6")'),'real feedback');
 const text=await evaluate('document.querySelector(".assessment-slot").innerText');assert.ok(!text.includes('固定展示'));assert.ok(text.includes('/ 6'));assert.ok(!text.includes('/ 5'));assert.ok(text.includes('非官方'));
 const image=await cmd('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});await writeFile(resolve(artifacts,'writing-real.png'),Buffer.from(image.data,'base64'));
 assert.deepEqual(errors,[]);await writeFile(resolve(artifacts,'browser-result.json'),JSON.stringify({passed:true,text,errors},null,2));console.log('REAL AI BROWSER PASS');
}catch(error){console.error('Browser diagnostic',await evaluate('({url:location.href,text:document.body.innerText.slice(0,7000)})').catch(()=>null));throw error;}finally{socket?.close();chrome.kill();}
