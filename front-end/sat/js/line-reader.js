'use strict';
// The guide is transparent to pointer input except its drag and close controls.
window.SATLineReader=(()=>{
 let state={enabled:false,y:0},save=()=>{},dragOffset=0;
 const guide=document.createElement('div');guide.id='lineReader';guide.hidden=true;
 guide.innerHTML='<div class="reader-top"><button class="reader-grip" aria-label="Move Line Reader" title="Drag to move; arrow keys to adjust">⠿</button><button class="reader-close" aria-label="Close Line Reader">×</button></div><div class="reader-shade"></div><div class="reader-window"></div><div class="reader-shade bottom">▾</div><div class="reader-bottom"></div>';
 document.querySelector('.exam-shell').append(guide);
 const grip=guide.querySelector('.reader-grip');
 function bounds(){const pane=document.getElementById('questionView');return pane.getBoundingClientRect();}
 function render(){guide.hidden=!state.enabled||document.getElementById('questionView').hidden;if(guide.hidden)return;const b=bounds(),height=Math.min(235,b.height);state.y=Math.max(0,Math.min(Number(state.y)||0,b.height-height));guide.style.top=(b.top+state.y)+'px';guide.style.height=height+'px';}
 grip.onpointerdown=e=>{e.preventDefault();dragOffset=e.clientY-bounds().top-state.y;grip.setPointerCapture(e.pointerId);};
 grip.onpointermove=e=>{if(grip.hasPointerCapture(e.pointerId)){state.y=e.clientY-bounds().top-dragOffset;render();}};
 grip.onpointerup=()=>save();grip.onpointercancel=()=>save();
 grip.onkeydown=e=>{if(!['ArrowUp','ArrowDown','Home','End'].includes(e.key))return;e.stopPropagation();e.preventDefault();state.y=e.key==='Home'?0:e.key==='End'?bounds().height:state.y+(e.key==='ArrowUp'?-10:10);render();save();};
 guide.querySelector('.reader-close').onclick=()=>{state.enabled=false;render();save();document.getElementById('exitButton').focus();};
 window.addEventListener('resize',render);
 return {bind(value,onSave){state=value;save=onSave;render();},render,toggle(){state.enabled=!state.enabled;render();save();}};
})();
