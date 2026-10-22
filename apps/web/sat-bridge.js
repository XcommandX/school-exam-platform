'use strict';
// Integration lives outside apps/sat so the original SAT interface stays intact.
(() => {
  if(!location.pathname.startsWith('/sat/'))return;

  const DB_NAME='SchoolExamPlatform:sat:v1';
  const keys=new Map([
    ['sat-reading-practice-v1','school-exam-platform:sat:runtime:v1'],
    ['sat-ui-preferences-v1','school-exam-platform:sat:ui:v1']
  ]);
  const params=new URLSearchParams(location.search);
  const view=params.get('view');
  const linked=['dashboard','practiceBuilder','questionLibrary','wrongBook','timingSettings'].includes(view);
  let skipInitialRuntime=linked;

  // Rewrite names before the unmodified engine opens storage. Never inspect or
  // migrate the old database or old localStorage values.
  const factory=window.indexedDB;
  const nativeOpen=factory.open;
  factory.open=function(name,...args){
    return Reflect.apply(nativeOpen,this,[name==='SATPracticeDB'?DB_NAME:name,...args]);
  };
  let local;
  try{local=window.localStorage;}catch{}
  for(const method of ['getItem','setItem','removeItem']){
    const nativeMethod=Storage.prototype[method];
    Storage.prototype[method]=function(key,...args){
      if(this===local){
        key=String(key);
        if(method==='getItem'&&key==='sat-reading-practice-v1'&&skipInitialRuntime){
          skipInitialRuntime=false;
          return null; // Keep the saved new-platform runtime on disk.
        }
        key=keys.get(key)||key;
      }
      return Reflect.apply(nativeMethod,this,[key,...args]);
    };
  }

  function intercept(name,wrap){
    let current=window[name];
    if(current)current=wrap(current);
    Object.defineProperty(window,name,{configurable:true,enumerable:true,
      get:()=>current,set:value=>{current=wrap(value);}});
  }

  intercept('SATImporter',api=>{
    if(!api)return api;
    const preview=api.preview.bind(api);
    api.preview=async(file,knownHashes)=>{
      let data;
      try{data=JSON.parse(await file.text());}catch{return preview(file,knownHashes);}
      const invalid=message=>({fileName:file.name,count:Array.isArray(data?.questions)?data.questions.length:0,errors:[message],questions:[]});
      if(data?.exam!==undefined&&data.exam!=='sat')return invalid('This practice engine only imports SAT question sets.');
      if(data?.schemaVersion!==undefined){
        if(data.schemaVersion!==1||data.exam!=='sat')return invalid('Shared question sets require schemaVersion 1 and exam "sat".');
        if(typeof data.id!=='string'||!/^sat:[a-zA-Z0-9._-]+$/.test(data.id))return invalid('Shared SAT question sets require a valid sat: source ID.');
        if(!Number.isInteger(data.defaultDurationSeconds)||data.defaultDurationSeconds<1)return invalid('defaultDurationSeconds must be a positive integer.');
        if(!Array.isArray(data.questions))return invalid('questions must be a non-empty array.');
        data={...data,sourceId:data.id,durationSeconds:data.defaultDurationSeconds,
          questions:data.questions.map(q=>q&&typeof q==='object'&&!Array.isArray(q)?{...q,answer:q.correctOption}:q)};
        // The server accepts the shared format. Validate a legacy projection in
        // the original importer, retaining the original JSON for disk saving.
        const adapted=await preview(new File([JSON.stringify(data)],file.name,{type:'application/json',lastModified:file.lastModified}),knownHashes);
        adapted.rawText=await file.text();
        return adapted;
      }
      return preview(file,knownHashes);
    };
    return api;
  });

  intercept('SATBank',api=>{
    if(!api)return api;
    const saveFile=api.saveFile.bind(api);
    api.saveFile=async preview=>{
      const saved=await saveFile(preview);
      const bank=preview.bankFile;
      if(saved&&typeof bank?.text==='string'){
        const normalized=await window.SATImporter.preview(new File([bank.text],preview.fileName,{type:'application/json',lastModified:bank.lastModified}),new Set());
        if(normalized.errors.length)throw new Error('The saved question set is invalid: '+normalized.errors.join(' '));
        Object.assign(preview,normalized);
        preview.bankFile={name:bank.name,lastModified:bank.lastModified,folderName:bank.folderName};
        preview.savedToBank=true;
      }
      return saved;
    };
    return api;
  });

  const click=action=>{
    const button=document.querySelector(`[data-action="${action}"]`);
    if(!button)throw new Error('The requested SAT page is unavailable.');
    button.click();
  };
  async function findSource(sourceId){
    const sources=(await window.SATStorage.all('sources')).filter(source=>!source.deleted).sort((a,b)=>b.importedAt-a.importedAt);
    const direct=sources.find(source=>source.platformSourceId===sourceId||source.id===sourceId);
    if(direct)return direct;
    const response=await fetch('/api/question-bank',{cache:'no-store'});
    if(!response.ok)throw new Error('Could not load the selected question set.');
    const bank=await response.json();
    const names=new Set((bank.files||[]).filter(file=>{
      try{const data=JSON.parse(file.text);return data.sourceId===sourceId||data.id===sourceId;}catch{return false;}
    }).map(file=>file.name));
    return sources.find(source=>names.has(source.fileName)||source.fileName===sourceId+'.json');
  }
  async function route(){
    if(!linked)return;
    await window.SATApp.ready;
    if(view!=='dashboard')click(view);
    if(view==='practiceBuilder'&&params.get('mode')==='source')click('builder-source');
    const sourceId=params.get('source');
    if(sourceId&&['practiceBuilder','questionLibrary','wrongBook'].includes(view)){
      const source=await findSource(sourceId);
      if(source){
        const input=view==='practiceBuilder'&&params.get('mode')==='source'
          ?[...document.querySelectorAll('input[name="practice-source"]')].find(input=>input.value===source.id)
          :document.querySelector('select[data-filter="sourceId"]');
        if(input){input.value=source.id;if(input.type==='radio')input.checked=true;input.dispatchEvent(new Event('change',{bubbles:true}));}
      }
    }
    ['view','mode','source'].forEach(key=>params.delete(key));
    const query=params.toString();
    history.replaceState(null,'',location.pathname+(query?'?'+query:'')+location.hash);
  }
  const ready=new Promise(resolve=>{
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',resolve,{once:true});
    else resolve();
  }).then(route).catch(error=>console.warn('SAT homepage integration:',error.message));
  window.SATPlatformBridge=Object.freeze({ready,dbName:DB_NAME,runtimeKey:keys.get('sat-reading-practice-v1')});
})();
