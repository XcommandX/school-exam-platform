import {createHash,randomUUID} from 'node:crypto';
import {AccountAIStore} from './toefl-ai.mjs';
import {ProjectedJSON,readJSON,InputError,fail} from './json-stream.mjs';
import {satProjection,validateSAT,validateHome,mergeTOEFL,identity,settings,toeflKeys,fields,object,integer,MAX_ENTITY,MAX_SETTINGS,MAX_ACCOUNT,MiB} from './validation.mjs';
const CHUNK=256*1024,MAX_PHYSICAL=704*MiB,encoder=new TextEncoder();
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
export function errorResponse(error){
  if(error instanceof InputError)return json({error:error.message,code:error.code,...error.extra},error.status);
  console.error('Account storage operation failed:',error?.name||'Error');
  return json({error:'同步暂不可用，本机记录仍保留。',code:'storage_unavailable'},503);
}
export class AccountStore {
  constructor(storage,{clock=Date.now}={}){
    this.storage=storage;this.sql=storage.sql;this.clock=clock;this.readers=new Map();this.staging=new Set();
    this.sql.exec(`CREATE TABLE IF NOT EXISTS account_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS uploads(id TEXT PRIMARY KEY,created_at INTEGER NOT NULL,size INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS chunks(upload_id TEXT NOT NULL,sequence INTEGER NOT NULL,body BLOB NOT NULL,PRIMARY KEY(upload_id,sequence));
      CREATE TABLE IF NOT EXISTS entities(kind TEXT NOT NULL,id TEXT NOT NULL,upload_id TEXT,start_byte INTEGER NOT NULL,end_byte INTEGER NOT NULL,summary TEXT NOT NULL,value_hash TEXT,revision INTEGER NOT NULL,deleted INTEGER NOT NULL,size INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS mutations(sequence INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,id TEXT NOT NULL,mutation_id TEXT NOT NULL,request_hash TEXT NOT NULL,result TEXT NOT NULL,UNIQUE(kind,id,mutation_id));
      CREATE INDEX IF NOT EXISTS mutations_entity ON mutations(kind,id,sequence);
      CREATE INDEX IF NOT EXISTS entities_upload ON entities(upload_id);`);
  }
  rows(sql,...args){return [...this.sql.exec(sql,...args)];}
  one(sql,...args){return this.rows(sql,...args)[0];}
  bind(user){
    const row=this.one("SELECT value FROM account_meta WHERE key='owner'");
    if(row&&row.value!==user)fail('账号存储身份不一致。',403,'account_mismatch');
    if(!row)this.sql.exec("INSERT INTO account_meta VALUES ('owner',?)",user);
  }
  meta(row,id){return row?{id:row.id,revision:row.revision,deleted:Boolean(row.deleted),updatedAt:row.updated_at}:{id,revision:0,deleted:false,updatedAt:null};}
  row(kind,id){return this.one('SELECT * FROM entities WHERE kind=? AND id=?',kind,id);}
  removeUpload(id){this.sql.exec('DELETE FROM chunks WHERE upload_id=?',id);this.sql.exec('DELETE FROM uploads WHERE id=?',id);}
  cleanup(){
    const old=this.rows('SELECT id FROM uploads WHERE id NOT IN (SELECT upload_id FROM entities WHERE upload_id IS NOT NULL)');
    this.storage.transactionSync(()=>{for(const row of old)if(!this.readers.has(row.id)&&!this.staging.has(row.id))this.removeUpload(row.id);});
  }
  async stage(request,{maximum=MAX_ENTITY+4096,select=satProjection}={}){
    this.cleanup();
    this.capacity(4*MiB);
    const occupied=this.one('SELECT COALESCE(SUM(size),0) AS bytes FROM uploads').bytes;
    const parser=new ProjectedJSON({select}),id=randomUUID();let size=0,sequence=0;
    this.staging.add(id);
    let buffer=new Uint8Array(CHUNK),used=0;
    this.sql.exec('INSERT INTO uploads(id,created_at) VALUES (?,?)',id,this.clock());
    const flush=()=>{if(used){this.capacity(used+4*MiB);this.sql.exec('INSERT INTO chunks VALUES (?,?,?)',id,sequence++,buffer.slice(0,used));buffer=new Uint8Array(CHUNK);used=0;}};
    try{
      if(!request.body)fail('请求不能为空。');
      for await(const bytes of request.body){
        size+=bytes.byteLength;if(occupied+size>MAX_PHYSICAL)fail('同步读取尚未结束或空间不足，请稍后重试。',413,'sat_storage_limit');if(size>maximum)fail('单条记录超过允许容量，请保留本机副本。',413,'sat_storage_limit');
        parser.write(bytes);
        for(let offset=0;offset<bytes.length;){const length=Math.min(CHUNK-used,bytes.length-offset);buffer.set(bytes.subarray(offset,offset+length),used);used+=length;offset+=length;if(used===CHUNK)flush();}
      }
      const body=parser.end();flush();
      if(!object(body))fail('请求需为 JSON 对象。');
      this.sql.exec('UPDATE uploads SET size=? WHERE id=?',size,id);
      return {id,body,start:parser.captureStart??0,end:parser.captureEnd??0,hash:parser.hash,valueHash:parser.captureHash??null,size};
    }catch(error){this.staging.delete(id);this.removeUpload(id);throw error;}
  }
  async *raw(row){
    if(!row?.upload_id){yield encoder.encode('null');return;}
    const id=row.upload_id;this.readers.set(id,(this.readers.get(id)||0)+1);
    try{
      for(let seq=Math.floor(row.start_byte/CHUNK);seq*CHUNK<row.end_byte;seq++){
        const chunk=this.one('SELECT body FROM chunks WHERE upload_id=? AND sequence=?',id,seq);
        if(!chunk)throw new Error('Incomplete committed data');
        const bytes=new Uint8Array(chunk.body);
        yield bytes.slice(Math.max(0,row.start_byte-seq*CHUNK),Math.min(bytes.length,row.end_byte-seq*CHUNK));
      }
    }finally{const count=this.readers.get(id)-1;if(count)this.readers.set(id,count);else this.readers.delete(id);}
  }
  stream(generator,rows=[]){
    // Pin the snapshot synchronously, before the first stream pull: a concurrent
    // write may replace these rows while the client is still reading them.
    const ids=[...new Set(rows.map(r=>r?.upload_id).filter(Boolean))],self=this;
    for(const id of ids)this.readers.set(id,(this.readers.get(id)||0)+1);
    let released=false;
    const release=()=>{if(released)return;released=true;for(const id of ids){const n=self.readers.get(id)-1;if(n)self.readers.set(id,n);else self.readers.delete(id);}self.cleanup();};
    const iterator=generator[Symbol.asyncIterator]();
    return new Response(new ReadableStream({async pull(controller){try{const next=await iterator.next();if(next.done){release();controller.close();}else controller.enqueue(typeof next.value==='string'?encoder.encode(next.value):next.value);}catch(error){await iterator.return?.();release();controller.error(error);}},async cancel(){try{await iterator.return?.();}finally{release();}}}),{headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
  }
  get(kind,id){
    identity(id);if(!['attempts','wrong-book','settings'].includes(kind)||kind==='settings'&&!settings.has(id))fail('SAT 数据类型不存在。',404);
    const row=this.row(kind,id),self=this;
    return this.stream((async function*(){yield JSON.stringify(self.meta(row,id)).slice(0,-1)+',"value":';yield* self.raw(row);yield '}';})(),[row]);
  }
  async load(row){
    if(!row?.upload_id)return null;
    // Small state/settings only. SAT snapshots are never materialized here.
    if(row.size>8*MiB)throw new Error('Large payload must use streaming');
    const parser=new ProjectedJSON();for await(const chunk of this.raw(row))parser.write(chunk);return parser.end();
  }
  pin(rows){
    const ids=[...new Set(rows.map(r=>r?.upload_id).filter(Boolean))];
    for(const id of ids)this.readers.set(id,(this.readers.get(id)||0)+1);
    return ()=>{for(const id of ids){const n=this.readers.get(id)-1;if(n)this.readers.set(id,n);else this.readers.delete(id);}this.cleanup();};
  }
  capacity(additional=0){
    // Include SQLite tables/indexes/mutation metadata, not only payload blobs.
    // Keep generous room below the Free 1GB object ceiling for page overhead.
    if(typeof this.sql.databaseSize==='number'&&this.sql.databaseSize+additional>896*MiB)fail('账号存储空间已接近服务上限，请先导出并整理记录。',413,'sat_storage_limit');
  }
  async bootstrap(cursor){
    let after=['',''];
    if(cursor){try{after=JSON.parse(Buffer.from(cursor,'base64url').toString());if(!Array.isArray(after)||after.length!==2||!['attempts','wrong-book'].includes(after[0])||cursor.length>4096)throw new Error();identity(after[1]);}catch{fail('SAT 同步分页位置无效。');}}
    const rows=this.rows("SELECT * FROM entities WHERE kind IN ('attempts','wrong-book') AND (kind>? OR (kind=? AND id>?)) ORDER BY kind,id LIMIT 501",after[0],after[0],after[1]),page=rows.slice(0,500);
    const preferences=this.rows("SELECT * FROM entities WHERE kind='settings' ORDER BY id"),release=this.pin(preferences),pref=[];
    try{
      for(const row of preferences)pref.push({key:row.id,value:await this.load(row),revision:row.revision});
      return json({attempts:page.filter(r=>r.kind==='attempts').map(r=>this.meta(r)),wrongBook:page.filter(r=>r.kind==='wrong-book').map(r=>this.meta(r)),settings:pref,nextCursor:rows.length>500?Buffer.from(JSON.stringify([page.at(-1).kind,page.at(-1).id])).toString('base64url'):null});
    }finally{release();}
  }
  summary(){return json({attempts:this.rows("SELECT summary FROM entities WHERE kind='attempts' AND deleted=0 ORDER BY updated_at DESC").map(r=>JSON.parse(r.summary))});}
  async putSAT(kind,id,request,verify=async()=>{}){
    const staged=await this.stage(request,{maximum:(kind==='settings'?MAX_SETTINGS:MAX_ENTITY)+4096});let committed=false;
    try{
      const {body}=staged,size=body.deleted?0:staged.end-staged.start,summary=validateSAT(kind,id,body,size);
      await verify();
      const result=this.storage.transactionSync(()=>{
        const replay=this.one('SELECT * FROM mutations WHERE kind=? AND id=? AND mutation_id=?',kind,id,body.mutationId);
        if(replay){if(replay.request_hash!==staged.hash)fail('同一操作编号不能用于不同内容。',409,'mutation_reused');return JSON.parse(replay.result);}
        const row=this.row(kind,id),revision=row?.revision||0,deleted=Boolean(row?.deleted);
        if(revision!==body.revision)fail('记录已在其他页面更新，请刷新后处理冲突。',409,'revision_conflict',{revision,deleted});
        if(deleted&&!body.deleted&&(kind==='attempts'||!body.restore))fail('记录已删除，不能由旧页面恢复。',409,'entity_deleted',{revision,deleted:true});
        if(body.restore&&(kind!=='wrong-book'||!deleted))fail('只有已删除的错题记录可以显式重新加入。');
        let result;
        if(row&&!deleted&&kind==='attempts'&&!body.deleted&&JSON.parse(row.summary).status==='completed'){
          if(row.value_hash!==staged.valueHash)fail('已完成的练习不能覆盖或改回未完成。',409,'attempt_completed',{revision,deleted:false});
          result=this.meta(row);
        }else{
          const quota=this.one("SELECT COUNT(*) AS count,COALESCE(SUM(size),0) AS bytes FROM entities WHERE kind IN ('attempts','wrong-book','settings')");
          if(!row&&quota.count>=20000||quota.bytes-(row?.size||0)+size>MAX_ACCOUNT)fail('SAT 账号同步空间已满，请先导出并整理记录。',413,'sat_storage_limit');
          result={id,revision:revision+1,deleted:!!body.deleted,updatedAt:this.clock()};
          this.sql.exec(`INSERT INTO entities VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET upload_id=excluded.upload_id,start_byte=excluded.start_byte,end_byte=excluded.end_byte,summary=excluded.summary,value_hash=excluded.value_hash,revision=excluded.revision,deleted=excluded.deleted,size=excluded.size,updated_at=excluded.updated_at`,kind,id,body.deleted?null:staged.id,staged.start,staged.end,JSON.stringify(summary),staged.valueHash,result.revision,Number(result.deleted),size,result.updatedAt);
          committed=!body.deleted;
        }
        this.sql.exec('INSERT INTO mutations(kind,id,mutation_id,request_hash,result) VALUES (?,?,?,?,?)',kind,id,body.mutationId,staged.hash,JSON.stringify(result));
        this.sql.exec('DELETE FROM mutations WHERE sequence IN (SELECT sequence FROM mutations WHERE kind=? AND id=? ORDER BY sequence DESC LIMIT -1 OFFSET 16)',kind,id);
        return result;
      });
      return json(result);
    }finally{this.staging.delete(staged.id);if(!committed)this.removeUpload(staged.id);this.cleanup();}
  }
  state(namespace,user=null,ai={enabled:false,preview:false,provider:'Cloudflare Workers AI'}){
    const rows=this.rows('SELECT * FROM entities WHERE kind=? ORDER BY id',namespace),self=this;
    if(namespace==='home')return this.stateItem('home','settings');
    return this.stream((async function*(){
      if(user)yield '{"me":'+JSON.stringify({...user,aiReady:ai.enabled===true,aiDemo:ai.preview===true,aiProvider:ai.provider})+',"state":';
      yield '{"items":[';for(let i=0;i<rows.length;i++){const row=rows[i];if(i)yield ',';yield '{"key":'+JSON.stringify(row.id)+',"revision":'+row.revision+',"value":';yield* self.raw(row);yield '}';}yield ']}';
      if(user)yield '}';
    })(),rows);
  }
  stateItem(kind,id){
    const row=this.row(kind,id),self=this;
    return this.stream((async function*(){yield '{"revision":'+(row?.revision||0)+',"value":';if(row)yield* self.raw(row);else yield 'null';yield '}';})(),[row]);
  }
  saveJSON(kind,id,value,revision){
    const text=JSON.stringify(value),buffer=encoder.encode(text),upload=randomUUID(),now=this.clock();
    this.capacity(buffer.length+4*MiB);
    if(this.one('SELECT COALESCE(SUM(size),0) AS bytes FROM uploads').bytes+buffer.length>MAX_PHYSICAL)fail('账号存储空间不足，请稍后重试。',413,'storage_limit');
    this.sql.exec('INSERT INTO uploads VALUES (?,?,?)',upload,now,buffer.length);
    for(let i=0;i<buffer.length;i+=CHUNK)this.sql.exec('INSERT INTO chunks VALUES (?,?,?)',upload,i/CHUNK,buffer.slice(i,i+CHUNK));
    this.sql.exec(`INSERT INTO entities VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET upload_id=excluded.upload_id,start_byte=excluded.start_byte,end_byte=excluded.end_byte,revision=excluded.revision,size=excluded.size,updated_at=excluded.updated_at`,kind,id,upload,0,buffer.length,'{}',null,revision,0,buffer.length,now);
  }
  async putState(namespace,request,verify=async()=>{}){
    this.cleanup();
    const body=await readJSON(request,8*MiB);
    if(!fields(body,namespace==='home'?['value','revision']:['key','value','revision'])||!Object.hasOwn(body,'value')||!integer(body.revision))fail('请提供记录内容与版本。');
    const key=namespace==='home'?'settings':body.key;
    if(namespace==='toefl'&&(!toeflKeys.has(key)||(key==='four.words.v1'?!object(body.value):!Array.isArray(body.value))))fail('记录类型或内容不受支持。');
    let value=namespace==='home'?validateHome(body.value):body.value;
    const row=this.row(namespace,key);
    if((row?.revision||0)!==body.revision){
      const self=this;return this.streamErrorConflict(row,self);
    }
    if(namespace==='toefl'){
      if(Buffer.byteLength(JSON.stringify(value))>8*MiB-1024)fail('记录内容过大，请先整理历史记录。',413);
      if(['four.drafts.v2','four.history.v1'].includes(key)){
        const stored=await this.load(row)||[],drafts=key==='four.history.v1'?await this.load(this.row('toefl','four.drafts.v2'))||[]:[];
        value=mergeTOEFL(key,value,stored,drafts);
      }
      if(Buffer.byteLength(JSON.stringify(value))>8*MiB-1024)fail('记录内容过大，请先整理历史记录。',413);
    }
    await verify();
    // No await inside this atomic compare-and-swap and chunk replacement.
    this.storage.transactionSync(()=>{
      if((this.row(namespace,key)?.revision||0)!==body.revision)fail('记录已更新，请刷新后重试。',409,'revision_conflict');
      this.saveJSON(namespace,key,value,body.revision+1);
    });
    return this.stateItem(namespace,key);
  }
  streamErrorConflict(row){
    const self=this,response=this.stream((async function*(){yield '{"error":"记录已在其他页面更新，请重新加载后再试。","code":"revision_conflict","revision":'+(row?.revision||0)+',"value":';if(row)yield* self.raw(row);else yield 'null';yield '}';})(),[row]);
    return new Response(response.body,{status:409,headers:response.headers});
  }
}
export class PlatformAccountStore {
  constructor(ctx,env){this.ctx=ctx;this.env=env;this.store=new AccountStore(ctx.storage);this.busy=false;}
  async verify(request){
    const token=request.headers.get('X-Platform-Token'),owner=request.headers.get('X-Platform-User');
    const response=await this.env.AUTH.getByName('platform-auth-v1').fetch('https://internal/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})});
    const session=await response.json();
    if(!response.ok||!session.authenticated)fail('登录已失效，请重新登录。',401,'session_expired');
    if(session.user.id!==owner)fail('当前账号已切换。',409,'account_changed');
    this.store.bind(owner);return session.user;
  }
  async fetch(request){
    try{
      const user=await this.verify(request),url=new URL(request.url),path=url.pathname;
      const mutating=!['GET','HEAD'].includes(request.method);
      if(mutating&&this.busy)fail('正在同步其他记录，请稍后重试。',429,'sat_sync_busy',{retryAfter:2});
      if(mutating)this.busy=true;
      try{
        const match=path.match(/^\/api\/sat\/(attempts|wrong-book|settings)\/(.+)$/);
        if(match){const id=decodeURIComponent(match[2]);if(request.method==='GET')return this.store.get(match[1],id);if(request.method==='PUT')return await this.store.putSAT(match[1],id,request,()=>this.verify(request));}
        if(path==='/api/sat/bootstrap'&&request.method==='GET'){
          if([...url.searchParams.keys()].some(k=>k!=='cursor')||url.searchParams.getAll('cursor').length>1)fail('SAT 同步分页请求无效。');
          return await this.store.bootstrap(url.searchParams.get('cursor'));
        }
        if(path==='/api/sat/summary'&&request.method==='GET')return this.store.summary();
        if(path==='/api/toefl/bootstrap'&&request.method==='GET')return this.store.state('toefl',user,request.headers.has('X-Platform-AI-Config')?JSON.parse(request.headers.get('X-Platform-AI-Config')):undefined);
        if(path.startsWith('/internal/toefl-ai/')&&request.method==='POST'){
          this.ai??=new AccountAIStore(this.store);
          return json(await this.ai.handle(path.slice('/internal/toefl-ai/'.length),await readJSON(request,128*1024),()=>this.verify(request)));
        }
        if(['/api/me/home','/api/toefl/state'].includes(path)){
          const namespace=path==='/api/me/home'?'home':'toefl';
          if(request.method==='GET')return this.store.state(namespace);
          if(request.method==='PUT')return await this.store.putState(namespace,request,()=>this.verify(request));
        }
        return json({error:'接口不支持此操作。',code:'method_not_allowed'},405);
      }finally{
        if(mutating){this.busy=false;await this.ctx.storage.setAlarm(Date.now()+3600_000);}
      }
    }catch(error){return errorResponse(error);}
  }
  async alarm(){this.store.cleanup();if(this.store.one('SELECT id FROM uploads WHERE id NOT IN (SELECT upload_id FROM entities WHERE upload_id IS NOT NULL) LIMIT 1'))await this.ctx.storage.setAlarm(Date.now()+3600_000);}
}
