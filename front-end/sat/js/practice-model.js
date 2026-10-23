'use strict';
window.SATModel=(()=>{
 // JSON asset paths are relative to the project root, regardless of the page URL.
 const assetBase=new URL('../',document.currentScript.src);
 const categories=SATCategoryData.categories;
 const category=id=>categories.find(c=>c.id===id);
 const valid=n=>typeof n==='number'&&Number.isFinite(n)&&n>0;
 const durationSeconds=o=>Math.max(1,Math.round(valid(o?.durationSeconds)?o.durationSeconds:valid(o?.durationMinutes)?o.durationMinutes*60:1920));
 const clampDuration=n=>Math.max(60,Math.min(3840,Math.round(Number(n)||60)));
 const formatDuration=n=>{n=Math.max(0,Math.floor(Number(n)||0));return `${Math.floor(n/60)} min ${n%60} s`;};
 const normalizePractice=p=>{if(p){p.durationSeconds=durationSeconds(p);p.allowOvertime=p.allowOvertime===true;delete p.durationMinutes;}return p;};
 const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const assetPath=s=>typeof s==='string'&&/^question-assets\/(?:[^/\\\x00-\x1f?#%:]+\/)*[^/\\\x00-\x1f?#%:]+\.(png|jpe?g|webp|gif|svg)$/i.test(s)&&!s.split('/').some(p=>p==='.'||p==='..');
 function validateVisual(v){
  if(v==null)return null;
  if(typeof v!=='object'||Array.isArray(v)||!['table','chart','image'].includes(v.type))throw new Error('visualStimulus.type must be table, chart, or image.');
  const position=v.position??'before-passage';if(!['before-passage','after-passage'].includes(position))throw new Error('visualStimulus.position must be before-passage or after-passage.');
  for(const k of ['title','note','alt','caption'])if(v[k]!==undefined&&typeof v[k]!=='string')throw new Error(`visualStimulus.${k} must be text.`);
  if(v.type==='table'){
   if(!Array.isArray(v.columns)||!v.columns.length||v.columns.some(c=>typeof c!=='string')||!Array.isArray(v.rows)||!v.rows.length||v.rows.some(r=>!Array.isArray(r)||r.length!==v.columns.length||r.some(c=>typeof c!=='string')))throw new Error('Table requires text columns and non-empty rows with matching cell counts.');
   return {type:'table',title:v.title||'',columns:v.columns,rows:v.rows,note:v.note||'',position};
  }
  if(!assetPath(v.src))throw new Error('Image src must be a relative image path inside question-assets/.');
  if(!v.alt?.trim())throw new Error('Image alt text is required.');
  return {type:v.type,src:v.src,alt:v.alt,caption:v.caption||'',position};
 }
 function visualHTML(q,position){const v=q.visualStimulus;if(!v||(v.position||'before-passage')!==position)return '';try{validateVisual(v);}catch{return '<p class="visual-fallback">Visual unavailable: invalid asset data.</p>';}
  if(v.type==='table')return `<figure class="question-visual"><div class="stimulus-table-scroll"><table class="stimulus-table">${v.title?`<caption>${escape(v.title)}</caption>`:''}<thead><tr>${v.columns.map(c=>`<th scope="col">${escape(c)}</th>`).join('')}</tr></thead><tbody>${v.rows.map(r=>`<tr>${r.map(c=>`<td>${escape(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>${v.note?`<figcaption>${escape(v.note)}</figcaption>`:''}</figure>`;
  return `<figure class="question-visual"><img src="${escape(new URL(v.src,assetBase).href)}" alt="${escape(v.alt)}" data-question-asset><p class="visual-fallback" hidden>Image unavailable. Check ${escape(v.src)}.</p>${v.caption?`<figcaption>${escape(v.caption)}</figcaption>`:''}</figure>`;
 }
 document.addEventListener('error',e=>{if(e.target.matches?.('[data-question-asset]')){e.target.hidden=true;e.target.nextElementSibling.hidden=false;}},true);
 return {categories,category,categoryLabel:id=>category(id)?.labelEn||'Uncategorized',durationSeconds,clampDuration,formatDuration,normalizePractice,validateVisual,visualHTML};
})();
window.SATSettings=(()=>{
 const normalizeConfig=value=>({...value,moduleQuestionLimit:Math.max(1,Math.min(100,Math.round(Number(value?.moduleQuestionLimit)||30))),examTimerWarning:value?.examTimerWarning==='fixed'?'fixed':'proportional'});
 let config=normalizeConfig();
 async function loadConfig(){config=normalizeConfig((await SATStorage.get('settings','appConfig'))?.value);}
 async function setConfig(value){const next=normalizeConfig({...config,...value});await SATStorage.setSetting('appConfig',next);config=next;}
 let durationPreferences={},customDuration=1920,durationWrites=Promise.resolve();
 let targets={},timer={enabled:false,mode:'up'},targetWrites=Promise.resolve();
 async function load(){durationPreferences=(await SATStorage.get('settings','practiceDurationPreferences'))?.value||{};customDuration=SATModel.clampDuration((await SATStorage.get('settings','customPracticeDurationSeconds'))?.value??1920);const saved=(await SATStorage.get('settings','timingTargets'))?.value||{};targets={...Object.fromEntries([...SATModel.categories.map(c=>c.id),'__uncategorized__'].map(id=>[id,90])),...saved};if(Object.keys(targets).some(k=>saved[k]===undefined))await SATStorage.setSetting('timingTargets',targets);const preference=await SATStorage.get('settings','questionTimer');timer={enabled:false,mode:'up',...preference?.value};if(!preference)await SATStorage.setSetting('questionTimer',timer);}
 const target=id=>targets[SATModel.category(id)?id:'__uncategorized__']??90;
 function setTarget(id,value){const work=async()=>{if(id!=='__uncategorized__'&&!SATModel.category(id))throw new Error('Unknown category.');const stored=(await SATStorage.get('settings','timingTargets'))?.value||{};const next={...stored,[id]:Math.max(0,Math.min(300,Math.round(Number(value)||0)))};await SATStorage.setSetting('timingTargets',next);targets=next;};targetWrites=targetWrites.then(work,work);return targetWrites;}
 async function setTimer(value){const next={...timer,...value};await SATStorage.setSetting('questionTimer',next);timer=next;}
 function setDuration(key,value){value=SATModel.clampDuration(value);if(key==='custom')customDuration=value;else durationPreferences[key]=value;const snapshot={...durationPreferences};const work=()=>SATStorage.setSetting(key==='custom'?'customPracticeDurationSeconds':'practiceDurationPreferences',key==='custom'?value:snapshot);durationWrites=durationWrites.then(work,work);return durationWrites;}
 return {load:async()=>{await load();await loadConfig();},target,setTarget,setTimer,setDuration,setConfig,get config(){return {...config};},get durationPreferences(){return {...durationPreferences};},get customDuration(){return customDuration;},get timer(){return {...timer};}};
})();
