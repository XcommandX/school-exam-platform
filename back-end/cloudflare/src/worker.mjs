import {createHash,timingSafeEqual} from 'node:crypto';
import {InputError,fail,readJSON} from './json-stream.mjs';
import {fields,identity} from './validation.mjs';
import {setupHTML,setupJS} from './setup.mjs';
import {aiConfig,assess} from './toefl-ai.mjs';
import {apConfig,assessAP} from './ap-ai.mjs';
export {PlatformAuthStore} from './auth.mjs';
export {PlatformAccountStore} from './data.mjs';
export {PlatformBankStore} from './bank.mjs';
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8'}});
const notFound=()=>json({error:'Not found.',code:'not_found'},404);
const redirect=path=>new Response(null,{status:302,headers:{Location:path}});
const catalogues=new WeakMap();
const cookieToken=request=>{
  const values=(request.headers.get('Cookie')||'').split(';').map(s=>s.trim()).filter(s=>s.startsWith('study_session='));
  if(values.length!==1)return null;const value=values[0].slice(14);
  return /^[A-Za-z0-9_-]{32,256}$/.test(value)?value:null;
};
const cookie=token=>`study_session=${token||''}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${token?43200:0}`;
const csrf=token=>createHash('sha256').update('sat-bank-csrf-v1\0'+token).digest('hex');
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&/^[a-f0-9]{64}$/.test(a)&&/^[a-f0-9]{64}$/.test(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
function safePath(url){
  // Account identifiers intentionally contain ':' and literal '%xx' text.
  // They are decoded exactly once in the account DO, never sent to ASSETS.
  const account=url.pathname.match(/^\/api\/sat\/(attempts|wrong-book|settings)\/([^/]+)$/);
  if(account){try{return '/api/sat/'+account[1]+'/'+identity(decodeURIComponent(account[2]));}catch{return null;}}
  const source=url.pathname.match(/^\/api\/exams\/sat\/sources\/([^/]+)$/);
  if(source){try{const id=decodeURIComponent(source[1]);return /^sat:[A-Za-z0-9._-]+$/.test(id)?'/api/exams/sat/sources/'+id:null;}catch{return null;}}
  const apSource=url.pathname.match(/^\/api\/exams\/ap\/sources\/([^/]+)$/);
  if(apSource){try{const id=decodeURIComponent(apSource[1]);return /^ap:[a-z0-9][a-z0-9-]{0,119}$/.test(id)?'/api/exams/ap/sources/'+id:null;}catch{return null;}}
  let path;try{path=decodeURIComponent(url.pathname);}catch{return null;}
  if(/[%:\\\x00-\x1f\x7f]/.test(path)||path.split('/').some(s=>s==='.'||s==='..'||/[ .]$/.test(s))||path.includes('//'))return null;
  return path;
}
function headers(response,{html=false}={}){
  const result=new Response(response.body,{status:response.status,headers:response.headers});
  result.headers.set('Cache-Control','private, no-store');
  result.headers.set('X-Content-Type-Options','nosniff');
  result.headers.set('Referrer-Policy','no-referrer');
  result.headers.set('X-Frame-Options','DENY');
  result.headers.set('Cross-Origin-Resource-Policy','same-origin');
  result.headers.set('Strict-Transport-Security','max-age=31536000');
  result.headers.set('Permissions-Policy','camera=(), geolocation=(), payment=()');
  if(html)result.headers.set('Content-Security-Policy',"base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'");
  result.headers.delete('Access-Control-Allow-Origin');
  return result;
}
async function auth(env,path,body){return env.AUTH.getByName('platform-auth-v1').fetch('https://internal'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});}
async function session(env,token){
  if(!token)return {authenticated:false,loginEnabled:true,user:null,expiresAt:null};
  const response=await auth(env,'/session',{token});
  if(!response.ok)throw new InputError('账号服务暂不可用。',503,'storage_unavailable');
  return response.json();
}
function writeOrigin(request,url,{multipart=false}={}){
  if(request.headers.get('Origin')!==url.origin||request.headers.get('Sec-Fetch-Site')==='cross-site')fail('请从当前网站页面操作。',403,'invalid_origin');
  if(!multipart&&request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()!=='application/json')fail('请求必须使用 JSON。',415,'json_required');
}
async function catalogue(env){
  if(!catalogues.has(env))catalogues.set(env,(async()=>{
    const response=await env.ASSETS.fetch('https://assets/_catalog/routes.json');
    if(!response.ok)throw new Error('Missing deployment catalogue');
    const value=await response.json();if(value.schemaVersion!==1||!value.htmlTemplates||!value.protectedRoutes)throw new Error('Invalid deployment catalogue');return value;
  })().catch(error=>{catalogues.delete(env);throw error;}));
  return catalogues.get(env);
}
async function asset(env,path,request){
  const url=new URL(request.url);url.pathname=path;url.search='';
  const headers=new Headers(request.headers);headers.delete('Cookie');headers.delete('Authorization');headers.delete('If-None-Match');headers.delete('If-Modified-Since');
  return env.ASSETS.fetch(new Request(url,{method:request.method==='HEAD'?'HEAD':'GET',headers}));
}
async function pdfAsset(env,record,request){
  const total=record.bytes,etag='"'+record.sha256+'"';
  const h=new Headers({'Content-Type':'application/pdf','Accept-Ranges':'bytes','Content-Length':String(total),ETag:etag});
  let start=0,end=total-1,status=200;
  const range=request.headers.get('Range'),ifRange=request.headers.get('If-Range');
  if(request.method!=='HEAD'&&range&&(!ifRange||ifRange===etag)){
    const match=/^bytes=(\d*)-(\d*)$/.exec(range);
    if(!match||(!match[1]&&!match[2]))return new Response(null,{status:416,headers:{...Object.fromEntries(h),'Content-Range':`bytes */${total}`,'Content-Length':'0'}});
    if(match[1]){start=Number(match[1]);end=match[2]?Math.min(Number(match[2]),total-1):total-1;}
    else {const suffix=Number(match[2]);start=Math.max(0,total-suffix);}
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>end||start>=total)
      return new Response(null,{status:416,headers:{...Object.fromEntries(h),'Content-Range':`bytes */${total}`,'Content-Length':'0'}});
    status=206;h.set('Content-Range',`bytes ${start}-${end}/${total}`);h.set('Content-Length',String(end-start+1));
  }
  if(request.method==='HEAD')return new Response(null,{headers:h});
  const names=record.chunks||[record.asset],sizes=record.chunkBytes||[total];
  let offset=0;const selected=[];
  for(let i=0;i<names.length;i++){if(offset<=end&&offset+sizes[i]>start)selected.push({name:names[i],offset});offset+=sizes[i];}
  const requestHeaders=new Headers(request.headers);requestHeaders.delete('Range');requestHeaders.delete('If-Range');
  const fullRequest=new Request(request,{headers:requestHeaders});let index=0,reader,position=0;
  const stream=new ReadableStream({async pull(controller){
    try{while(true){
      if(!reader){if(index>=selected.length){controller.close();return;}const item=selected[index++];position=item.offset;
        const response=await asset(env,item.name,fullRequest);if(!response.ok||!response.body)throw new Error('Incomplete PDF asset');reader=response.body.getReader();}
      const part=await reader.read();if(part.done){reader.releaseLock();reader=null;continue;}
      const next=position+part.value.length,from=Math.max(0,start-position),to=Math.min(part.value.length,end+1-position);position=next;
      if(to>from)controller.enqueue(part.value.subarray(from,to));
      if(position>end){await reader.cancel();reader=null;controller.close();return;}
      if(to>from)return;
    }}catch(error){await reader?.cancel().catch(()=>{});controller.error(error);}
  },async cancel(){await reader?.cancel();}});
  return new Response(stream,{status,headers:h});
}
async function protectedAsset(env,record,request){
  if(record.byteRanges&&record.contentType==='application/pdf')return pdfAsset(env,record,request);
  if(record.asset){const res=await asset(env,record.asset,request);if(!res.ok)return res;const h=new Headers(res.headers);h.set('Content-Type',record.contentType);return new Response(res.body,{status:record.status||res.status,headers:h});}
  const h={'Content-Type':record.contentType,'Content-Length':String(record.bytes)};
  const chunkHeaders=new Headers(request.headers);chunkHeaders.delete('Range');chunkHeaders.delete('If-Range');
  request=new Request(request,{headers:chunkHeaders});
  if(request.method==='HEAD')return new Response(null,{status:record.status||200,headers:h});
  // Fetch chunks lazily and stream their bytes unchanged. A UTF-8 codepoint may
  // cross a 25MiB boundary, so per-chunk text/JSON decoding would corrupt data.
  let index=0,reader;
  const stream=new ReadableStream({async pull(controller){
    try{
      while(true){
        if(!reader){if(index>=record.chunks.length){controller.close();return;}const res=await asset(env,record.chunks[index++],request);if(!res.ok||!res.body)throw new Error('Incomplete catalogue asset');reader=res.body.getReader();}
        const part=await reader.read();if(part.done){reader.releaseLock();reader=null;continue;}controller.enqueue(part.value);return;
      }
    }catch(error){controller.error(error);}
  },async cancel(){await reader?.cancel();}});
  return new Response(stream,{status:record.status||200,headers:h});
}
async function html(env,path,request,current){
  const response=await asset(env,path,request);if(!response.ok)return response;
  let body=await response.text();
  if(current?.authenticated){
    const value=JSON.stringify({authenticated:true,loginEnabled:true,user:current.user}).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
    body=body.replace('<head>','<head><script>window.PlatformSession='+value+';</script><script src="/web/platform-auth.js"></script>');
  }
  if(path==='/sat/html/index.html')body=body.replace('</head>','<script src="/web/sat-bridge.js"></script><script src="/web/sat-account-sync.js"></script></head>');
  if(path==='/toefl/index.html'){
    body=body.replace(/<script\b[^>]*\bsrc=["'](?:\.\/)?four-(?:data|logic|learning|app)\.js(?:\?[^"']*)?["'][^>]*>\s*<\/script>/g,'');
    body=body.replace('</head>','<script type="module" src="/web/toefl-bridge.js"></script></head>');
  }
  return new Response(body,{headers:{'Content-Type':'text/html; charset=utf-8'}});
}
function internal(request,user,token,path=request.url){
  const h=new Headers();h.set('Content-Type','application/json');h.set('X-Platform-Token',token);h.set('X-Platform-User',user.id);
  return new Request(path,{method:request.method,headers:h,body:['GET','HEAD'].includes(request.method)?undefined:request.body,duplex:'half'});
}
async function authResponse(response,{issueCookie=false,clearCookie=false}={}){
  const value=await response.json(),token=value.token;delete value.token;
  const result=json(value,response.status);
  if(response.ok&&issueCookie&&token)result.headers.set('Set-Cookie',cookie(token));
  if(response.ok&&clearCookie)result.headers.set('Set-Cookie',cookie(null));
  if(response.headers.has('Retry-After'))result.headers.set('Retry-After',response.headers.get('Retry-After'));
  return result;
}
export async function handle(request,env){
  const url=new URL(request.url),path=safePath(url),method=request.method;
  if(!path||path.startsWith('/_catalog')||path.startsWith('/.'))return notFound();
  if(!['GET','HEAD','POST','PUT','PATCH'].includes(method))return json({error:'接口不支持此操作。',code:'method_not_allowed'},405);
  const writing=!['GET','HEAD'].includes(method);
  if(writing)writeOrigin(request,url,{multipart:path==='/api/toefl/assess'&&method==='POST'});
  if(path==='/robots.txt'&&method==='GET')return new Response('User-agent: *\nDisallow: /\n');
  if(path==='/api/platform/status'&&method==='GET')return json({service:'school-exam-platform-v1',deployment:'cloudflare',auth:{mode:'session',loginEnabled:true}});
  if(path==='/setup'&&!writing)return new Response(setupHTML,{headers:{'Content-Type':'text/html; charset=utf-8'}});
  if(path==='/setup.js'&&!writing)return new Response(setupJS,{headers:{'Content-Type':'text/javascript; charset=utf-8'}});
  const registrationRoutes={
    '/api/auth/registration-config':{method:'GET',rpc:'/registration-config',fields:[]},
    '/api/auth/register':{method:'POST',rpc:'/register',fields:['username','displayName','password']},
  };
  if(['/registration-review','/registration-review/','/web/registration-review.html','/web/registration-review.js','/api/auth/registration-review','/api/auth/registration-approve'].includes(path))return json({error:'邮件审批链接已停用，请管理员登录站内审批。',code:'registration_mail_retired'},410);
  if(Object.hasOwn(registrationRoutes,path)){
    const route=registrationRoutes[path];
    if(url.search)fail('请求字段无效。'); // Never accept bearer tokens in query strings.
    if(method!==route.method)return json({error:'接口不支持此操作。',code:'method_not_allowed'},405);
    if(method==='GET')return authResponse(await auth(env,route.rpc,{}));
    const body=await readJSON(request,16*1024);
    if(!fields(body,route.fields)||route.fields.some(key=>!Object.hasOwn(body,key)))fail('请求字段无效。');
    // Never accept client-supplied IP, role, active, recipient or origin fields.
    return authResponse(await auth(env,route.rpc,{...body,address:request.headers.get('CF-Connecting-IP')||'local-dev'}));
  }
  const token=cookieToken(request);
  if(path==='/api/auth/login'&&method==='POST'){
    const body=await readJSON(request,16*1024);
    if(!fields(body,['username','password'])||!('username'in body)||!('password'in body))fail('请提供用户名和密码。');
    return authResponse(await auth(env,'/login',{...body,address:request.headers.get('CF-Connecting-IP')||'local-dev'}),{issueCookie:true});
  }
  if(path==='/api/auth/bootstrap'&&method==='POST'){
    const body=await readJSON(request,16*1024);
    if(!fields(body,['setupToken','username','password','displayName']))fail('管理员初始化字段无效。');
    return authResponse(await auth(env,'/bootstrap',body),{issueCookie:true});
  }
  // Login styles/scripts are public; no question media or other HTML is public.
  const publicWeb=/^\/web\/[^/]+\.(?:css|js|svg|png|ico)$/.test(path);
  const publicLogin=['/login','/login/','/login.html','/web/login.html'].includes(path);
  if(!writing&&publicWeb)return asset(env,path,request);
  const current=await session(env,token);
  if(path==='/api/auth/session'&&method==='GET')return json(current);
  if(publicLogin&&!writing){if(current.authenticated)return redirect('/');return html(env,'/web/login.html',request,null);}
  if(!current.authenticated){
    if(path.startsWith('/api/'))fail('请先登录。',401,'session_expired');
    if(['/', '/index.html','/account','/accounts','/sat','/sat/','/sat/html/index.html','/toefl','/toefl/','/toefl/index.html','/ap','/ap/','/ap/index.html'].includes(path))return redirect('/login?next='+encodeURIComponent(url.pathname+url.search));
    return notFound();
  }
  const user=current.user,owner=request.headers.get('X-Account-ID');
  if((writing||owner!==null)&&owner!==user.id)fail('当前账号已切换，请刷新页面后继续。',409,'account_changed');
  if(path==='/api/auth/logout'&&method==='POST'){
    const body=await readJSON(request,16*1024);if(Object.keys(body).length)fail('退出请求字段无效。');
    return authResponse(await auth(env,'/logout',{token}),{clearCookie:true});
  }
  if(path==='/api/me'&&method==='GET')return json(user);
  if(path==='/api/me'&&method==='PATCH')return authResponse(await auth(env,'/update-user',{token,targetId:user.id,changes:await readJSON(request,16*1024),ownProfile:true}));
  if(path==='/api/auth/password'&&method==='POST'){
    const body=await readJSON(request,16*1024);if(!fields(body,['currentPassword','newPassword'])||Object.keys(body).length!==2)fail('请提供当前密码与新密码。');
    return authResponse(await auth(env,'/password',{token,...body}),{clearCookie:true});
  }
  if(path==='/api/admin/registrations'||path.startsWith('/api/admin/registrations/')){
    if(user.role!=='admin')fail('需要管理员权限。',403,'admin_required');
    if(url.search)fail('请求字段无效。');
    if(path==='/api/admin/registrations'&&method==='GET')return authResponse(await auth(env,'/registrations',{token}));
    const decision=path.match(/^\/api\/admin\/registrations\/([a-f0-9]{32})\/(approve|reject)$/);
    if(decision&&method==='POST'){
      const body=await readJSON(request,16*1024);if(!fields(body,[])||Object.keys(body).length)fail('请求字段无效。');
      return authResponse(await auth(env,'/decide-registration',{token,requestId:decision[1],approve:decision[2]==='approve'}));
    }
    return json({error:'接口不支持此操作。',code:'method_not_allowed'},405);
  }
  if(path==='/api/admin/users'&&method==='GET')return authResponse(await auth(env,'/users',{token}));
  if(path==='/api/admin/users'&&method==='POST'){
    const body=await readJSON(request,16*1024);if(!fields(body,['username','password','role','displayName']))fail('账号创建字段无效。');
    return authResponse(await auth(env,'/create-user',{...body,token}));
  }
  const admin=path.match(/^\/api\/admin\/users\/([a-f0-9]{32})(\/password)?$/);
  if(admin&&admin[2]&&method==='POST'){
    const body=await readJSON(request,16*1024);if(!fields(body,['password'])||Object.keys(body).length!==1)fail('请提供新密码。');
    return authResponse(await auth(env,'/password',{token,targetId:admin[1],newPassword:body.password}));
  }
  if(admin&&!admin[2]&&method==='PATCH')return authResponse(await auth(env,'/update-user',{token,targetId:admin[1],changes:await readJSON(request,16*1024)}));
  if(path==='/api/ap/ai-config'||path==='/api/ap/assess'){
    if(url.search)fail('评分接口不接受查询参数。');
    const config=apConfig(env);
    if(path.endsWith('/ai-config')&&method==='GET')return json(config);
    if(path.endsWith('/assess')&&method==='POST')return assessAP(request,env,{config,rpc:async(action,body)=>{
      const response=await env.ACCOUNTS.getByName('account-v1:'+user.id).fetch(new Request('https://internal/internal/ap-ai/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Platform-Token':token,'X-Platform-User':user.id},body:JSON.stringify(body)}));
      const value=await response.json();if(!response.ok)throw new InputError(value.error,response.status,value.code,{...(value.retryAfter?{retryAfter:value.retryAfter}:{})});return value;
    }});
    return json({error:'接口不支持此操作。',code:'method_not_allowed'},405);
  }
  if(path==='/api/toefl/ai-config'||path==='/api/toefl/assess'){
    if(url.search)fail('评分接口不接受查询参数。');
    const config=aiConfig(env,request.url);
    if(path.endsWith('/ai-config')&&method==='GET')return json(config);
    if(path.endsWith('/assess')&&method==='POST')return assess(request,env,{config,rpc:async(action,body)=>{
      const rpc=new Request('https://internal/internal/toefl-ai/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Platform-Token':token,'X-Platform-User':user.id},body:JSON.stringify(body)});
      const response=await env.ACCOUNTS.getByName('account-v1:'+user.id).fetch(rpc),value=await response.json();
      if(!response.ok)throw new InputError(value.error,response.status,value.code,{...(value.retryAfter?{retryAfter:value.retryAfter}:{})});return value;
    }});
    return json({error:'接口不支持此操作。',code:'method_not_allowed'},405);
  }
  if(path.startsWith('/api/sat/')||path==='/api/me/home'||path==='/api/toefl/state'||path==='/api/toefl/bootstrap'){
    const forwarded=internal(request,user,token);
    if(path==='/api/toefl/bootstrap')forwarded.headers.set('X-Platform-AI-Config',JSON.stringify(aiConfig(env,request.url)));
    return env.ACCOUNTS.getByName('account-v1:'+user.id).fetch(forwarded);
  }
  if(path==='/api/question-bank/status'&&method==='GET')return json({service:'sat-question-bank-v1',project:'school-exam-platform-cloudflare',name:'SAT shared question bank',token:csrf(token),writable:user.role==='admin'});
  if(path==='/api/question-bank'){
    if(method==='POST'&&!same(request.headers.get('X-SAT-Bank-Token'),csrf(token)))fail('题库操作验证已过期，请刷新后重试。',403);
    if(['GET','POST'].includes(method))return env.BANK.getByName('shared-bank-v1').fetch(internal(request,user,token,'https://internal/question-bank'));
  }
  if(path==='/api/exams/sat/sources'||path.startsWith('/api/exams/sat/sources/')){
    if(method==='GET')return env.BANK.getByName('shared-bank-v1').fetch(internal(request,user,token,'https://internal'+path.replace('/api/exams/sat','')));
  }
  // No local active.json is deployed. This legacy switching-backup endpoint
  // must reject rather than pretend a backup was saved against a nonexistent set.
  if(path==='/api/sat-library-backup'&&method==='POST')return json({error:'云端没有旧活动题集，无需切库备份；练习记录按账号独立同步。',code:'no_active_collection'},409);
  if(writing)return json({error:'接口不支持此操作。',code:'method_not_allowed'},405);
  if(path==='/sat'||path==='/sat/')return redirect('/sat/html/index.html'+url.search);
  if(path==='/toefl')return redirect('/toefl/'+url.search);
  if(path==='/ap')return redirect('/ap/'+url.search);
  const catalog=await catalogue(env);
  if(Object.hasOwn(catalog.htmlTemplates,path))return html(env,catalog.htmlTemplates[path],request,current);
  if(Object.hasOwn(catalog.protectedRoutes,path))return protectedAsset(env,catalog.protectedRoutes[path],request);
  if(path.startsWith('/api/'))return notFound();
  if(path.startsWith('/sat/')||path.startsWith('/toefl/')||path.startsWith('/ap/')||path.startsWith('/question-assets/')){
    // ASSETS contains an explicit build allowlist only; HTML must use injected
    // templates, and internal catalogue URLs are never available here.
    if(/\.html?$/i.test(path)||path.endsWith('/'))return notFound();
    return asset(env,path,request);
  }
  return notFound();
}
export default {
  async fetch(request,env){
    try{
      const response=await handle(request,env),result=headers(response,{html:response.headers.get('Content-Type')?.includes('text/html')});
      if(request.method==='HEAD'){await result.body?.cancel();return new Response(null,{status:result.status,headers:result.headers});}
      return result;
    }catch(error){
      if(error instanceof InputError)return headers(json({error:error.message,code:error.code,...error.extra},error.status));
      // Never log cookie, request bodies, credentials, SQL bindings or user data.
      console.error('Platform request failed:',error?.name||'Error');
      return headers(json({error:'服务暂不可用，请稍后重试。',code:'service_unavailable'},503));
    }
  }
};
