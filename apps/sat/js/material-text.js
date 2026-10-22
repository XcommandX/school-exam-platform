'use strict';
window.SATText=(()=>{
 const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 function markdown(source){
  source=source.replace(/^[-+] /gm,'• ');
  let text='',spans=[],stack=[];
  const pattern=/(<u>|<\/u>|\*\*|\*)/g;let last=0,match;
  while((match=pattern.exec(source))){text+=source.slice(last,match.index);last=pattern.lastIndex;const token=match[0],kind=token.includes('u>')?'underline':token==='**'?'bold':'italic';
   const top=stack.at(-1);
   if(top?.kind===kind){spans.push({start:top.start,end:text.length,kind});stack.pop();}
   else if(token!=='</u>')stack.push({kind,start:text.length});
  }
  text+=source.slice(last);if(stack.length)throw new Error('Unclosed passage Markdown emphasis.');return {text,spans};
 }
 function validate(spans,text){
  if(spans===undefined)return [];
  if(!Array.isArray(spans)||spans.some(s=>!s||!['underline','italic','bold'].includes(s.kind)||!Number.isInteger(s.start)||!Number.isInteger(s.end)||s.start<0||s.end<=s.start||s.end>text.length))throw new Error('Invalid passageFormatting ranges.');
  return spans.map(s=>({start:s.start,end:s.end,kind:s.kind}));
 }
 function html(q){const text=q.passage||'',spans=q.passageFormatting||[],bounds=[...new Set([0,text.length,...spans.flatMap(s=>[s.start,s.end])])].sort((a,b)=>a-b);const root=document.createElement('div');root.innerHTML=bounds.slice(0,-1).map((start,i)=>{const end=bounds[i+1],classes=spans.filter(s=>s.start<=start&&s.end>=end).map(s=>'source-'+s.kind).join(' ');return `<span class="${classes}">${escape(text.slice(start,end))}</span>`;}).join('');layout(root,q);return root.innerHTML;}
 // Move existing text nodes, preserving every character and highlight offset.
 function layout(root,q){
  const text=root.textContent;
  const attribution=/^\s*(?:©|copyright\b|source\s*[:：]|来源\s*[:：]|出处\s*[:：]|(?:adapted|excerpted|reprinted|reproduced) from\b|used (?:by|with) permission\b)/i;
  const slice=(start,end)=>{const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let node,offset=0,a,b;while((node=walker.nextNode())){const next=offset+node.length;if(!a&&start>=offset&&start<next)a=[node,start-offset];if(end>offset&&end<=next){b=[node,end-offset];break;}offset=next;}if(!a||!b)return document.createDocumentFragment();const r=document.createRange();r.setStart(...a);r.setEnd(...b);const fragment=r.cloneContents();
   // cloneContents omits its common ancestor. Restore those wrappers so a
   // whole-line highlight (including its source formatting) survives layout.
   let ancestor=r.commonAncestorContainer.nodeType===Node.TEXT_NODE?r.commonAncestorContainer.parentElement:r.commonAncestorContainer;
   while(ancestor&&ancestor!==root){const wrapper=ancestor.cloneNode(false);wrapper.append(...fragment.childNodes);fragment.append(wrapper);ancestor=ancestor.parentElement;}
   return fragment;};
  if(/^• /m.test(text)){
   const out=document.createDocumentFragment();let pos=0,list=null;
   for(const line of text.match(/[^\n]*(?:\n|$)/g).filter(Boolean)){
    if(line.startsWith('• ')){if(!list){list=document.createElement('ul');list.className='source-notes';out.append(list);}const li=document.createElement('li'),marker=document.createElement('span');marker.className='source-list-token';marker.append(slice(pos,pos+2));li.append(marker,slice(pos+2,pos+line.length));list.append(li);}
    else{list=null;if(attribution.test(line)){const credit=document.createElement('div');credit.className='source-attribution';credit.append(slice(pos,pos+line.length));out.append(credit);}else out.append(slice(pos,pos+line.length));}pos+=line.length;
   }root.replaceChildren(out);
  }else if(q.passageStyle==='literary'){
   const out=document.createDocumentFragment();let pos=0,index=0;
   const cuts=new Set([0,text.length]);let offset=0;
   for(const line of text.match(/[^\n]*(?:\n|$)/g).filter(Boolean)){if(attribution.test(line)){cuts.add(offset);cuts.add(offset+line.length);}offset+=line.length;}
   for(const m of text.matchAll(/\n\n/g))cuts.add(m.index+2);
   const boundaries=[...cuts].sort((a,b)=>a-b);
   for(const end of boundaries.slice(1)){const part=text.slice(pos,end),p=document.createElement('div');p.className=attribution.test(part)?'source-attribution':index===0?'source-introduction':'source-excerpt';index++;p.append(slice(pos,end));out.append(p);pos=end;}root.replaceChildren(out);
  }else{
   const out=document.createDocumentFragment();let pos=0;
   for(const line of text.match(/[^\n]*(?:\n|$)/g).filter(Boolean)){if(attribution.test(line)){const credit=document.createElement('div');credit.className='source-attribution';credit.append(slice(pos,pos+line.length));out.append(credit);}else out.append(slice(pos,pos+line.length));pos+=line.length;}root.replaceChildren(out);
  }
 }
 return {markdown,validate,html,layout};
})();
