import {initializeCloud} from './cloud-client.js';
try{
 const logic=Promise.all([import('./four-logic.js'),import('./four-learning.js')]);const initial=await initializeCloud();
 const get=async path=>{const r=await fetch('/'+path);if(!r.ok)throw Error('加载失败');return r.json()};
 const {manifest,catalog}=initial;
 catalog.records=catalog.records.map(r=>({...r,items:r.items||Array.from({length:r.itemCount},()=>({}))}));
 const lookup=manifest.lookup||Object.fromEntries(catalog.records.map(r=>[r.module+':'+r.id,manifest.records[r.chunk]]));
 const raw=new Map(catalog.records.map(r=>[r.module+':'+r.id,r])),chunks=new Map();let words;
 window.FOUR_DATA={records:catalog.records,vocab:[],coverage:catalog.coverage};
 window.PracticeContent={async records(keys){await Promise.all([...new Set(keys.map(k=>lookup[k]).filter(Boolean))].map(path=>{if(!chunks.has(path))chunks.set(path,get(path).then(rs=>{for(const r of rs)raw.set(r.module+':'+r.id,r)}).catch(e=>{chunks.delete(path);throw e}));return chunks.get(path)}));return keys.map(k=>raw.get(k))},async vocab(){words||=get(manifest.vocab).catch(e=>{words=null;throw e});const v=await words;window.FOUR_DATA.vocab=v.vocab;window.FOUR_DATA.vocabGroups=v.groups;window.FOUR_DATA.vocabularyMetadata=v.metadata;window.FOUR_DATA.coverage=v.coverage;return v}};
 await logic;await import('./four-app.js');
}catch(e){document.querySelector('#app').textContent='暂时无法加载，请刷新重试。'}
