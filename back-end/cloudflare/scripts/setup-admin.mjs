// Provision the first-admin secret through Wrangler stdin, never its arguments/logs.
// The OS browser launcher briefly receives the setup URL; run on a trusted machine.
// Run only after deploying. Re-running rotates the still-unused setup secret.
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const value=process.argv[2];
let origin;
try{const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||!url.hostname.endsWith('.workers.dev'))throw new Error();origin=url.origin;}catch{console.error('Usage: node scripts/setup-admin.mjs https://<your-worker>.<subdomain>.workers.dev');process.exit(1);}
const status=await fetch(origin+'/api/platform/status',{redirect:'error'});
if(!status.ok||(await status.json()).deployment!=='cloudflare')throw new Error('The URL is not this Cloudflare platform. No secret was changed.');
const token=randomBytes(32).toString('base64url');
await new Promise((resolvePromise,reject)=>{
  const child=spawn(process.execPath,[resolve(root,'node_modules/wrangler/bin/wrangler.js'),'secret','put','SETUP_TOKEN','--config','wrangler.jsonc'],{cwd:root,stdio:['pipe','inherit','inherit'],env:{...process.env,WRANGLER_SEND_METRICS:'false',WRANGLER_WRITE_LOGS:'false',WRANGLER_LOG_SANITIZE:'true'}});
  child.on('error',reject);child.on('exit',code=>code===0?resolvePromise():reject(new Error('Wrangler secret provisioning failed; no browser opened.')));child.stdin.on('error',()=>{});child.stdin.end(token+'\n');
});
const setup=origin+'/setup#token='+token;
const command=process.platform==='win32'?['rundll32.exe',['url.dll,FileProtocolHandler',setup]]:process.platform==='darwin'?['open',[setup]]:['xdg-open',[setup]];
await new Promise((resolvePromise,reject)=>{
  const child=spawn(command[0],command[1],{stdio:'ignore'});child.on('error',()=>reject(new Error('Browser opening failed. Run this script again to rotate and retry.')));child.on('exit',code=>code===0?resolvePromise():reject(new Error('Browser opening failed. Run this script again to rotate and retry.')));
});
console.log('First-administrator setup opened in your default browser. Choose your own account and password there; do not paste them into chat. The one-use token was not saved to disk.');
