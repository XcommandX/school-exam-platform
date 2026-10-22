'use strict';
window.SATBank=(()=>{
 let handle=null,token='',writing=false;
 const state={connected:false,writable:false,mode:'browser',name:'',message:'Connect question-bank to load and save JSON files. Browser-only import is still available.',busy:false,updates:[],errors:[]};
 async function api(path='',options={}){
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),5000);
  try{const response=await fetch('/api/question-bank'+path,{...options,signal:controller.signal,cache:'no-store'});const data=await response.json();if(!response.ok)throw new Error(data.error||'Question bank request failed.');return data;}
  finally{clearTimeout(timeout);}
 }
 async function init(){
  handle=null;token='';Object.assign(state,{connected:false,writable:false,mode:'browser',name:'',updates:[],errors:[]});
  if(location.protocol==='http:'&&location.hostname==='127.0.0.1'){
   try{const info=await api('/status');if(info.service==='sat-question-bank-v1'){token=info.token;Object.assign(state,{mode:'local',connected:true,writable:true,name:'question-bank',message:'Project question-bank connected. Imports are saved to this folder.'});return;}}catch{}
  }
  if(!window.showDirectoryPicker){state.message='Folder access is unavailable here. Open Start SAT Practice.command for automatic project-folder storage. Choose Files still imports into this browser only.';return;}
  try{handle=(await SATStorage.get('settings','questionBankFolder'))?.value||null;if(handle){state.mode='folder';state.name=handle.name;state.connected=(await handle.queryPermission({mode:'read'}))==='granted';state.writable=(await handle.queryPermission({mode:'readwrite'}))==='granted';state.message=state.connected?'Folder connected. Enable write access when importing to save JSON files.':'Click Sync Folder to reconnect.';}else state.message='Direct html/index.html opening cannot read its neighboring folder automatically. Choose question-bank once and allow access, or use Start SAT Practice.command.';}
  catch{state.message='Folder access unavailable. Choose the folder again; browser-only import remains available.';}
 }
 async function choose(){
  if(state.mode==='local')return;
  if(!window.showDirectoryPicker){state.message='Folder access unavailable. Use Start SAT Practice.command or browser-only import.';return;}
  try{const selected=await window.showDirectoryPicker({id:'sat-question-bank',mode:'readwrite'});await SATStorage.setSetting('questionBankFolder',selected);handle=selected;Object.assign(state,{name:handle.name,mode:'folder',connected:true,writable:true});}
  catch(e){state.message=e.name==='AbortError'?'Folder selection cancelled. No files were written.':'Could not connect: '+e.message;}
 }
 async function sync(interactive=false){
  if((state.mode!=='local'&&!handle)||state.busy||writing)return;state.busy=true;state.errors=[];state.updates=[];
  try{
   let files=[];
   if(state.mode==='local'){const data=await api();files=data.files.map(f=>new File([f.text],f.name,{type:'application/json',lastModified:f.lastModified}));state.errors.push(...data.errors);state.connected=true;}
   else{
    let permission=await handle.queryPermission({mode:'read'});if(permission!=='granted'&&interactive)permission=await handle.requestPermission({mode:'read'});
    state.connected=permission==='granted';if(!state.connected){state.message='Permission needed. Click Sync Folder to reconnect.';return;}
    for await(const entry of handle.values())if(entry.kind==='file'&&entry.name.toLowerCase().endsWith('.json')){try{files.push(await entry.getFile());}catch(e){state.errors.push(`${entry.name}: ${e.message}`);}}
   }
   const sources=await SATStorage.all('sources'),known=new Set(sources.map(s=>s.contentHash));let imported=0,unchanged=0;
   for(const file of files){
    try{const p=await SATImporter.preview(file,new Set());
     if(p.errors.length){state.errors.push(`${file.name}: ${p.errors.join(' ')}`);continue;}
     if(known.has(p.contentHash)){unchanged++;continue;}
     p.bankFile={name:file.name,lastModified:file.lastModified,folderName:state.name};
     const previous=sources.filter(s=>s.fileName===file.name).sort((a,b)=>b.importedAt-a.importedAt)[0];
     if(previous){p.previousSourceId=previous.id;state.updates.push(p);continue;}
     imported+=await SATImporter.commit(p);known.add(p.contentHash);
     if(p.warnings?.length)state.errors.push(...p.warnings.map(w=>file.name+': '+w));
    }catch(e){state.errors.push(`${file.name}: ${e.message}`);}
   }
   state.message=`${imported} questions imported · ${unchanged} unchanged files · ${state.updates.length} updates awaiting review.`;
  }catch(e){state.connected=false;state.message='Could not read question bank: '+e.message+' Previously imported questions are still available.';}finally{state.busy=false;}
 }
 // Called from Import before unrelated async work to retain the user gesture.
 async function prepareWrite(){
  if(state.mode==='local'||!handle)return;
  let permission=await handle.queryPermission({mode:'readwrite'});
  if(permission!=='granted')permission=await handle.requestPermission({mode:'readwrite'});
  state.writable=permission==='granted';if(!state.writable)throw new Error('Write access was not granted. No questions were imported. Allow write access to save into the connected folder.');
 }
 async function saveFile(preview){
  if(state.mode==='browser')return false;
  if(typeof preview.rawText!=='string')throw new Error('Select the original JSON file again before saving.');
  if(!/\.json$/i.test(preview.fileName)||/[\\/\x00-\x1f]/.test(preview.fileName))throw new Error('Use a plain JSON filename.');
  writing=true;
  try{
   let result;
   if(state.mode==='local')result=await api('',{method:'POST',headers:{'Content-Type':'application/json','X-SAT-Bank-Token':token},body:JSON.stringify({name:preview.fileName,text:preview.rawText})});
   else{
    if(!state.writable)throw new Error('Connect the folder with write access before importing.');
    let name=preview.fileName,counter=1,existing;
    while(true){
     try{existing=await handle.getFileHandle(name);const file=await existing.getFile();if(await file.text()===preview.rawText){result={name,lastModified:file.lastModified};break;}}
     catch(e){if(e.name!=='NotFoundError')throw e;existing=null;}
     if(!existing){const target=await handle.getFileHandle(name,{create:true});const stream=await target.createWritable();try{await stream.write(preview.rawText);await stream.close();}catch(e){try{await stream.abort();}catch{}throw e;}const file=await target.getFile();result={name,lastModified:file.lastModified};break;}
     name=preview.fileName.replace(/\.json$/i,`-${++counter}.json`);
    }
   }
   preview.fileName=result.name;preview.bankFile={...result,folderName:state.name};preview.savedToBank=true;return true;
  }finally{writing=false;}
 }
 return {state,init,choose,sync,prepareWrite,saveFile};
})();
