'use strict';
(() => {
let examQuestions=[], running=false, timerHandle=null, finishing=null, onFinish=null;
const $ = id => document.getElementById(id);
const STORAGE_KEY = 'sat-reading-practice-v1';
const duration = 32 * 60 * 1000;
const emptyQuestionState = () => ({selectedOption:null,eliminatedOptions:[],markedForReview:false,highlights:[],timeSpentMs:0,materialScrollTop:0});
const initialState = () => ({currentQuestion:0,view:'question',questionStates:examQuestions.map(emptyQuestionState),endTimestamp:Date.now()+duration,remainingSeconds:1920,highlightMode:false,highlightColor:'yellow',timerHidden:false,eliminationVisible:true,split:50,completed:false,activePractice:null,questionEnterTimestamp:null,phase:'active',elapsedMs:0,segmentStartedAt:null,lineReaderState:{enabled:false,y:0},directionsShown:false});
let state=initialState();
let activeHighlightId=null, suppressClickUntil=0, readingFontSize=null;
const currentState=()=>state.questionStates[state.currentQuestion];
const isUntimed=()=>state.activePractice?.untimed===true;
const allowsOvertime=()=>state.activePractice?.allowOvertime===true;
const countedNow=(now=Date.now())=>isUntimed()||allowsOvertime()?now:Math.min(now,state.endTimestamp);
const currentModule=()=>state.activePractice?.modules?.[state.moduleIndex||0]||{start:0,end:examQuestions.length,durationSeconds:SATModel.durationSeconds(state.activePractice)};
function showModuleBreak(){
 $('modal').close();hideToolbar();hideTooltips();
 window.dispatchEvent(new CustomEvent('sat-module-over',{detail:{continue:()=>{
  if(state.phase!=='module_break')return;
  state.moduleIndex++;state.phase='active';state.view='question';state.currentQuestion=currentModule().start;
  state.endTimestamp=Date.now()+currentModule().durationSeconds*1000;state.segmentStartedAt=Date.now();state.questionEnterTimestamp=Date.now();
  timerHandle=setInterval(updateTimer,1000);render();save();showDirections();
 }}}));
}
$('modal').addEventListener('cancel',event=>{if(state.phase==='module_break')event.preventDefault();});
const save=()=>{if(!running)return;try{localStorage.setItem(STORAGE_KEY,JSON.stringify(state));localStorage.setItem('sat-ui-preferences-v1',JSON.stringify({highlightColor:state.highlightColor,fontSize:readingFontSize}));}catch(error){console.warn('Practice storage is unavailable.',error);}};
function commitMaterialScroll(){if(running&&state.view==='question'&&!restoringMaterial)currentState().materialScrollTop=$('passagePane').scrollTop;}
let restoringMaterial=false,materialRender=0;
function restoreMaterialScroll(){const generation=++materialRender,pane=$('passagePane'),top=currentState().materialScrollTop||0;restoringMaterial=true;const apply=()=>{if(generation!==materialRender)return;pane.scrollTop=top;requestAnimationFrame(()=>{if(generation===materialRender)restoringMaterial=false;});};const img=pane.querySelector('img');if(img&&!img.complete){img.addEventListener('load',apply,{once:true});img.addEventListener('error',apply,{once:true});}apply();}
function commitQuestionTime(now=Date.now()){
 commitMaterialScroll();
 if(state.questionEnterTimestamp!==null && currentState()){
  currentState().timeSpentMs=(currentState().timeSpentMs||0)+Math.max(0,countedNow(now)-state.questionEnterTimestamp);
  state.questionEnterTimestamp=null;
 }
}
function startExam(loadedQuestions,practice,finishHandler,saved=null){
 clearInterval(timerHandle);examQuestions=loadedQuestions;onFinish=finishHandler;finishing=null;
 let preferences={};try{preferences=JSON.parse(localStorage.getItem('sat-ui-preferences-v1'))||{};}catch{}
 readingFontSize=Number.isInteger(preferences.fontSize)&&preferences.fontSize>=14&&preferences.fontSize<=28?preferences.fontSize:null;
 applyReadingFontSize();
 state={...initialState(),highlightColor:preferences.highlightColor||'yellow',activePractice:practice,...(saved||{})};
 SATModel.normalizePractice(state.activePractice);
 state.questionTimerPanelState??={visible:SATSettings.timer.enabled,x:null,y:null};
 const now=Date.now();
 if(!saved){state.moduleIndex=0;state.endTimestamp=now+currentModule().durationSeconds*1000;state.segmentStartedAt=now;}
 if(saved?.phase==='module_break'){running=true;document.querySelector('.exam-shell').hidden=false;SATLineReader.bind(state.lineReaderState,save);showModuleBreak();return;}
 if(saved?.phase==='paused'){
  state.endTimestamp=now+saved.remainingTimeMs;state.completed=false;state.finishPending=null;state.finishedAt=null;state.questionEnterTimestamp=null;state.segmentStartedAt=now;
 }
 state.phase='active';state.segmentStartedAt=state.segmentStartedAt??now;
 state.questionStates.forEach(q=>{q.timeSpentMs=q.timeSpentMs||0;if(q.eliminatedOptions.includes(q.selectedOption))q.selectedOption=null;});
 running=true;document.querySelector('.exam-shell').hidden=false;SATLineReader.bind(state.lineReaderState,save);
 if(saved)commitQuestionTime();
 if(state.view==='question'&&!state.completed)state.questionEnterTimestamp=Date.now();
 timerHandle=setInterval(updateTimer,1000);render();
 if(state.finishPending)finishAttempt(state.finishPending);
 else if(!state.directionsShown){state.directionsShown=true;save();showDirections();}
}
async function finishAttempt({status,reason}){
 if(finishing)return finishing;if(!running)return;
 if(state.phase==='module_break')return;
 if(status==='completed' && (state.moduleIndex||0)+1<(state.activePractice.modules?.length||1)){
  clearInterval(timerHandle);commitQuestionTime();const now=countedNow();
  if(state.segmentStartedAt!==null)state.elapsedMs+=Math.max(0,now-state.segmentStartedAt);
  state.segmentStartedAt=null;state.phase='module_break';state.moduleResults??=[];
  state.moduleResults.push({moduleIndex:state.moduleIndex||0,reason,finishedAt:now});
  closeNavigator();save();showModuleBreak();return;
 }
 clearInterval(timerHandle);commitQuestionTime();state.completed=true;
 if(status==='completed'){
  state.moduleResults??=[];
  if(!state.moduleResults.some(m=>m.moduleIndex===(state.moduleIndex||0)))state.moduleResults.push({moduleIndex:state.moduleIndex||0,reason,finishedAt:countedNow()});
 }
 const now=countedNow();
 state.finishedAt=state.finishedAt||now;
 if(state.segmentStartedAt!==null){state.elapsedMs+=Math.max(0,now-state.segmentStartedAt);state.segmentStartedAt=null;}
 state.remainingTimeMs=isUntimed()?0:Math.max(0,state.endTimestamp-now);state.phase=status==='completed'?'completed':'paused';
 state.finishPending={status,reason};save();hideToolbar();hideTooltips();
 document.querySelector('.exam-shell').inert=true;
 finishing=(async()=>{
  try{
   await onFinish({status,reason,runtime:structuredClone(state),examQuestions:structuredClone(examQuestions)});
   running=false;localStorage.removeItem(STORAGE_KEY);$('modal').close();closeNavigator();document.querySelector('.exam-shell').hidden=true;
   window.dispatchEvent(new CustomEvent('sat-attempt-finished',{detail:{status}}));
  }catch(error){
   openModal('Could not save your practice','<p>Your answers are still saved in this browser. Please retry saving before leaving.</p>',[{text:'Retry saving',action:()=>{$('modal').close();finishAttempt({status,reason});}}]);
   console.error(error);
  }finally{document.querySelector('.exam-shell').inert=false;finishing=null;}
 })();return finishing;
}

function renderBlock(block,text){
 const ranges=currentState().highlights.filter(h=>h.block===block.dataset.block);
 const q=examQuestions[state.currentQuestion];
 const formatting=block.dataset.block==='passage'?(q.passageFormatting||[]):block.dataset.block==='prompt'?(q.promptFormatting||[]):block.dataset.block.startsWith('option-')?(q.optionsFormatting?.[Number(block.dataset.block.split('-')[1])]||[]):[];
 block.classList.toggle('source-literary',block.dataset.block==='passage'&&['poetry','literary'].includes(examQuestions[state.currentQuestion].passageStyle));
 const boundaries=[...new Set([0,text.length,...formatting.flatMap(s=>[s.start,s.end]),...ranges.flatMap(h=>[Math.max(0,h.start),Math.min(text.length,h.end)])])].sort((a,b)=>a-b);
 const fragment=document.createDocumentFragment();
 for(let i=0;i<boundaries.length-1;i++){
  const start=boundaries[i],end=boundaries[i+1];if(end<=start)continue;
  const h=ranges.findLast(r=>r.start<=start && r.end>=end);
  let node=document.createTextNode(text.slice(start,end));
  const styles=formatting.filter(s=>s.start<=start&&s.end>=end).map(s=>'source-'+s.kind);
  if(styles.length){const span=document.createElement('span');span.className=styles.join(' ');span.append(node);node=span;}
  if(h){const mark=document.createElement('span');mark.className=`text-highlight highlight-${h.color}${h.underline?' underlined':''}${h.id===activeHighlightId?' is-active':''}`;mark.dataset.highlightId=h.id;mark.append(node);fragment.append(mark);}else fragment.append(node);
 }
 block.replaceChildren(fragment);
 if(block.dataset.block==='passage')SATText.layout(block,examQuestions[state.currentQuestion]);
}
function blockText(key){const q=examQuestions[state.currentQuestion];return key==='passage'?q.passage:key==='prompt'?q.prompt:q.options[Number(key.split('-')[1])];}
function render(){
 closeMore();hideToolbar();hideTooltips();const review=state.view==='review';$('questionView').hidden=review;$('reviewView').hidden=!review;$('navigatorToggle').hidden=review;
 const module=currentModule();
 document.querySelector('.section-info h1').textContent=`Section 1, Module ${(state.moduleIndex||0)+1}: Reading and Writing`;
 document.querySelectorAll('#navigator h3,.review-card-heading h3').forEach(e=>e.textContent=`Section 1, Module ${(state.moduleIndex||0)+1}: Reading and Writing Questions`);
 $('questionNumber').textContent=state.currentQuestion-module.start+1;
 $('navigatorToggle').firstChild.textContent=`Question ${state.currentQuestion-module.start+1} of ${module.end-module.start} `;
 $('studentName').textContent=studentName;
 $('reviewToggle').setAttribute('aria-pressed',currentState().markedForReview);
 $('highlightToggle').setAttribute('aria-pressed',state.highlightMode);$('highlightToggle').classList.toggle('is-enabled',state.highlightMode);
 $('eliminationToggle').setAttribute('aria-pressed',state.eliminationVisible);
 $('backButton').hidden=!review && state.currentQuestion===module.start;
 document.documentElement.style.setProperty('--left',`${state.split}%`);$('divider').setAttribute('aria-valuenow',Math.round(state.split));
 if(review){renderGrid($('reviewGrid'),false);}else{
 $('passagePane').querySelectorAll('.question-visual,.visual-fallback').forEach(e=>e.remove());
 const visualQuestion=examQuestions[state.currentQuestion];$('passagePane').classList.toggle('has-visual',!!visualQuestion.visualStimulus);$('passagePane').classList.add('material-scroll-region');$('passage').insertAdjacentHTML('beforebegin',SATModel.visualHTML(visualQuestion,'before-passage'));$('passage').insertAdjacentHTML('afterend',SATModel.visualHTML(visualQuestion,'after-passage'));
 renderBlock($('passage'),examQuestions[state.currentQuestion].passage);renderBlock($('prompt'),examQuestions[state.currentQuestion].prompt);
 $('options').replaceChildren();
 examQuestions[state.currentQuestion].options.forEach((text,index)=>{
  const row=document.createElement('div');row.className='option-row';
  const option=document.createElement('div');option.className='option';option.tabIndex=0;option.role='radio';option.dataset.option=index;option.setAttribute('aria-label',`${'ABCD'[index]}. ${text}`);
  const letter=document.createElement('span');letter.className='letter';letter.textContent='ABCD'[index];
  const content=document.createElement('span');content.className='reading';content.dataset.block=`option-${index}`;renderBlock(content,text);option.append(letter,content);
  const eliminate=document.createElement('button');eliminate.className='eliminate';eliminate.dataset.eliminate=index;
  row.append(option,eliminate);$('options').append(row);
 });restoreMaterialScroll();$('options').role='radiogroup';$('options').setAttribute('aria-label','Answer choices');updateOptions();
 }
 if(!$('navigator').hidden)renderGrid($('navigatorGrid'),true);SATLineReader.render();renderQuestionTimerPanel();updateTimer();save();
}
function updateOptions(){document.querySelectorAll('.option').forEach(option=>{
 const index=Number(option.dataset.option),selected=currentState().selectedOption===index,eliminated=currentState().eliminatedOptions.includes(index);
 option.classList.toggle('selected',selected);option.classList.toggle('eliminated',eliminated);option.setAttribute('aria-checked',selected);
 const button=option.nextElementSibling;button.hidden=!state.eliminationVisible;button.classList.toggle('undo',eliminated);button.setAttribute('aria-label',`${eliminated?'Undo elimination of':'Eliminate'} ${'ABCD'[index]}`);button.setAttribute('aria-pressed',eliminated);
 button.replaceChildren();if(eliminated)button.textContent='Undo';else{const letter=document.createElement('span');letter.className='letter';letter.textContent='ABCD'[index];button.append(letter);}
});}
function renderGrid(container,showCurrent){container.replaceChildren();examQuestions.forEach((q,index)=>{
 if(index<currentModule().start||index>=currentModule().end)return;
 const qs=state.questionStates[index],button=document.createElement('button');button.className=`question-link${qs.selectedOption!==null?' answered':''}${showCurrent&&index===state.currentQuestion?' current':''}`;button.textContent=index-currentModule().start+1;
 button.setAttribute('aria-label',`Question ${index+1}, ${qs.selectedOption===null?'unanswered':'answered'}${qs.markedForReview?', marked for review':''}`);if(showCurrent&&index===state.currentQuestion)button.setAttribute('aria-current','true');
 if(qs.markedForReview){const flag=document.createElement('i');flag.className='flag';button.append(flag);}button.addEventListener('click',()=>navigate(index));container.append(button);
});}
function closeNavigator(){$('navigator').hidden=true;$('navigatorToggle').setAttribute('aria-expanded','false');}
function navigate(index){commitQuestionTime();state.questionEnterTimestamp=Date.now();state.currentQuestion=Math.max(currentModule().start,Math.min(currentModule().end-1,index));state.view='question';closeNavigator();render();document.querySelector('.question-pane').scrollTop=0;}
function showReview(){commitQuestionTime();state.view='review';closeNavigator();render();}
function next(){if(state.view==='review'){showCompleteConfirmation();return;}if(state.currentQuestion===currentModule().end-1)showReview();else navigate(state.currentQuestion+1);}
function back(){if(state.view==='review')navigate(state.currentQuestion);else navigate(state.currentQuestion-1);}
function selectOption(index){if(state.completed)return;currentState().eliminatedOptions=currentState().eliminatedOptions.filter(i=>i!==index);currentState().selectedOption=index;updateOptions();save();if(!$('navigator').hidden)renderGrid($('navigatorGrid'),true);}
$('options').addEventListener('click',event=>{
 if(Date.now()<suppressClickUntil || window.getSelection()?.toString() || event.target.closest('.text-highlight'))return;
 const elimination=event.target.closest('[data-eliminate]');if(elimination){toggleCross(Number(elimination.dataset.eliminate));return;}
 const option=event.target.closest('[data-option]');if(option)selectOption(Number(option.dataset.option));
});
$('options').addEventListener('keydown',event=>{const option=event.target.closest('[data-option]');if(option && (event.key==='Enter'||event.key===' ')){event.preventDefault();selectOption(Number(option.dataset.option));}});
function toggleCross(index){if(state.completed)return;const qs=currentState(),on=!qs.eliminatedOptions.includes(index);qs.eliminatedOptions=on?[...qs.eliminatedOptions,index]:qs.eliminatedOptions.filter(i=>i!==index);if(on&&qs.selectedOption===index)qs.selectedOption=null;updateOptions();if(!$('navigator').hidden)renderGrid($('navigatorGrid'),true);save();}
function toggleMarkedForReview(){currentState().markedForReview=!currentState().markedForReview;$('reviewToggle').setAttribute('aria-pressed',currentState().markedForReview);if(!$('navigator').hidden)renderGrid($('navigatorGrid'),true);save();}
$('reviewToggle').onclick=toggleMarkedForReview;
$('eliminationToggle').onclick=()=>{state.eliminationVisible=!state.eliminationVisible;$('eliminationToggle').setAttribute('aria-pressed',state.eliminationVisible);updateOptions();save();};
$('nextButton').onclick=next;$('backButton').onclick=back;
$('navigatorToggle').onclick=()=>{const open=$('navigator').hidden;$('navigator').hidden=!open;$('navigatorToggle').setAttribute('aria-expanded',open);if(open)renderGrid($('navigatorGrid'),true);hideToolbar();};
$('closeNavigator').onclick=closeNavigator;$('goReview').onclick=showReview;
function renderQuestionTimerPanel(){
 const panel=$('questionTimerPanel'),position=state.questionTimerPanelState;
 panel.hidden=!running||!position?.visible||state.view!=='question';
 document.querySelector('[data-more="timer"]').setAttribute('aria-expanded',!panel.hidden);
 if(panel.hidden)return;
 const minY=Math.min(128,Math.max(8,innerHeight-panel.offsetHeight-63));
 position.x=Math.max(8,Math.min(Number.isFinite(position.x)?position.x:innerWidth-panel.offsetWidth-36,innerWidth-panel.offsetWidth-8));
 position.y=Math.max(minY,Math.min(Number.isFinite(position.y)?position.y:minY,innerHeight-panel.offsetHeight-63));
 panel.style.left=position.x+'px';panel.style.top=position.y+'px';
}
let timerDragOffset=null;
$('questionTimerGrip').onpointerdown=e=>{if(e.button!==0)return;e.preventDefault();const r=$('questionTimerPanel').getBoundingClientRect();timerDragOffset={x:e.clientX-r.left,y:e.clientY-r.top};e.currentTarget.setPointerCapture(e.pointerId);};
$('questionTimerGrip').onpointermove=e=>{if(!e.currentTarget.hasPointerCapture(e.pointerId)||!timerDragOffset)return;state.questionTimerPanelState.x=e.clientX-timerDragOffset.x;state.questionTimerPanelState.y=e.clientY-timerDragOffset.y;renderQuestionTimerPanel();};
$('questionTimerGrip').onlostpointercapture=()=>{timerDragOffset=null;save();};
$('questionTimerGrip').onkeydown=e=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();e.stopPropagation();const p=state.questionTimerPanelState;p.x+=(e.key==='ArrowLeft'?-10:e.key==='ArrowRight'?10:0);p.y+=(e.key==='ArrowUp'?-10:e.key==='ArrowDown'?10:0);renderQuestionTimerPanel();save();};
$('questionTimerClose').onclick=()=>{state.questionTimerPanelState.visible=false;renderQuestionTimerPanel();save();$('exitButton').focus();};
window.addEventListener('resize',()=>{if(running){renderQuestionTimerPanel();if($('modal').open&&$('modal').classList.contains('font-size-dialog'))syncFontSizeControls();save();}});
function updateQuestionTimer(){
 const prefs=SATSettings.timer,qs=currentState();if(!qs)return;
 const spent=Math.floor(((qs.timeSpentMs||0)+(state.questionEnterTimestamp!==null?Math.max(0,countedNow()-state.questionEnterTimestamp):0))/1000);
 const target=SATSettings.target(examQuestions[state.currentQuestion]?.questionType),remaining=Math.max(0,target-spent);
 $('questionTimerEnabled').checked=prefs.enabled;$('questionTimerStatus').textContent=prefs.enabled?'ON':'OFF';$('questionTimerMode').value=prefs.mode;
 $('questionTimerCurrent').textContent=prefs.enabled?SATModel.formatDuration(prefs.mode==='down'?remaining:spent):'Off';$('questionTimerCurrent').classList.toggle('timer-urgent',prefs.enabled&&prefs.mode==='down'&&remaining<=10);$('questionTimerTarget').textContent=SATModel.formatDuration(target);
}
async function changeQuestionTimer(){try{await SATSettings.setTimer({enabled:$('questionTimerEnabled').checked,mode:$('questionTimerMode').value});$('questionTimerError').textContent='';updateQuestionTimer();save();}catch(error){$('questionTimerError').textContent=error.message;updateQuestionTimer();}}
$('questionTimerEnabled').onchange=changeQuestionTimer;$('questionTimerMode').onchange=changeQuestionTimer;
function updateTimer(){
 updateQuestionTimer();
 if(!running)return;
 const untimed=isUntimed(),hidden=untimed||state.timerHidden;
 if(!state.completed&&!untimed)state.remainingSeconds=Math.max(0,Math.ceil((state.endTimestamp-Date.now())/1000));
 $('time').textContent=hidden?'':`${String(Math.floor(state.remainingSeconds/60)).padStart(2,'0')}:${String(state.remainingSeconds%60).padStart(2,'0')}`;
 $('timerToggle').hidden=untimed;
 $('timerToggle').closest('.timer').setAttribute('aria-label',untimed?'Untimed practice':'Exam countdown');
 $('timerToggle').textContent=state.timerHidden?'Show':'Hide';
 $('timerToggle').closest('.timer').classList.toggle('timer-hidden',hidden);
 const overtime=!untimed&&allowsOvertime()&&state.remainingSeconds===0;
 const warningSeconds=SATSettings.config.examTimerWarning==='fixed'?300:currentModule().durationSeconds*5/32;
 $('time').classList.toggle('timer-urgent',!untimed&&state.remainingSeconds<warningSeconds);
 const status=overtime?'TIME IS UP · You can continue working and submit when ready.':'THIS IS A PRACTICE TEST';
 if($('practiceStatus').textContent!==status)$('practiceStatus').textContent=status;
 $('practiceStatus').classList.toggle('overtime-status',overtime);
 if(!untimed&&!allowsOvertime()&&state.remainingSeconds===0 && !state.completed){finishAttempt({status:'completed',reason:'timer_expired'});return;}save();
}
$('timerToggle').onclick=()=>{if(isUntimed())return;state.timerHidden=!state.timerHidden;updateTimer();};
$('highlightToggle').onclick=()=>{state.highlightMode=!state.highlightMode;$('highlightToggle').setAttribute('aria-pressed',state.highlightMode);$('highlightToggle').classList.toggle('is-enabled',state.highlightMode);updateHighlightTip();hideToolbar();save();};

// Tooltip positioning is geometry only; all visual and hover states stay in CSS.
function positionTooltip(button,tooltip,above=false){
 tooltip.hidden=false;
 const rect=button.getBoundingClientRect();
 const left=Math.max(8,Math.min(window.innerWidth-tooltip.offsetWidth-8,above?rect.right-tooltip.offsetWidth+20:rect.left+(rect.width-tooltip.offsetWidth)/2));
 tooltip.style.left=left+'px';
 tooltip.style.top=(above?rect.top-tooltip.offsetHeight-10:rect.bottom+12)+'px';
 tooltip.style.setProperty('--pointer-left',(rect.left+rect.width/2-left)+'px');
}
function updateHighlightTip(){
 const button=$('highlightToggle');
 if(state.highlightMode && (button.matches(':hover') || button.matches(':focus-visible')))positionTooltip(button,$('highlightTip'));
 else $('highlightTip').hidden=true;
}
$('highlightToggle').addEventListener('mouseenter',updateHighlightTip);
$('highlightToggle').addEventListener('mouseleave',()=>$('highlightTip').hidden=true);
$('highlightToggle').addEventListener('focus',updateHighlightTip);
$('highlightToggle').addEventListener('blur',()=>$('highlightTip').hidden=true);
$('eliminationToggle').addEventListener('mouseenter',()=>positionTooltip($('eliminationToggle'),$('crossoutTip'),true));
$('eliminationToggle').addEventListener('mouseleave',()=>$('crossoutTip').hidden=true);
$('eliminationToggle').addEventListener('focus',()=>{if($('eliminationToggle').matches(':focus-visible'))positionTooltip($('eliminationToggle'),$('crossoutTip'),true);});
$('eliminationToggle').addEventListener('blur',()=>$('crossoutTip').hidden=true);
function hideTooltips(){$('highlightTip').hidden=true;$('crossoutTip').hidden=true;}
window.addEventListener('resize',hideTooltips);
document.querySelectorAll('.pane').forEach(p=>p.addEventListener('scroll',hideTooltips));

function selectionOffset(block,node,offset){const range=document.createRange();range.selectNodeContents(block);range.setEnd(node,offset);return range.toString().length;}
function setActiveHighlight(id){
 activeHighlightId=id;
 document.querySelectorAll('.text-highlight').forEach(mark=>mark.classList.toggle('is-active',mark.dataset.highlightId===id));
}
function hideToolbar(){$('highlightToolbar').hidden=true;setActiveHighlight(null);}
function updateHighlightSwatches(color){
 document.querySelectorAll('#highlightToolbar [data-color]').forEach(button=>{
  const selected=button.dataset.color===color;
  button.classList.toggle('is-selected',selected);
  button.setAttribute('aria-pressed',selected);
 });
}
function showToolbar(id,rect){setActiveHighlight(id);const toolbar=$('highlightToolbar');toolbar.hidden=false;const width=toolbar.offsetWidth;toolbar.style.left=`${Math.max(8,Math.min(window.innerWidth-width-8,rect.left))}px`;toolbar.style.top=`${Math.max(8,rect.top-toolbar.offsetHeight-7)}px`;const h=currentState().highlights.find(h=>h.id===id);$('underlineHighlight').setAttribute('aria-pressed',!!h?.underline);updateHighlightSwatches(h?.color || state.highlightColor);}
// Range offsets refer to immutable block text. Rebuilding only text spans preserves option controls.
document.addEventListener('mouseup',event=>{
 if(!running || state.completed || !state.highlightMode || state.view!=='question' || event.target.closest('#highlightToolbar'))return;
 const selection=window.getSelection();if(!selection || selection.isCollapsed || !selection.rangeCount)return;
 const range=selection.getRangeAt(0),startElement=range.startContainer.nodeType===3?range.startContainer.parentElement:range.startContainer;
 const block=startElement.closest?.('[data-block]');if(!block || !block.contains(range.endContainer))return;
 const start=selectionOffset(block,range.startContainer,range.startOffset),end=selectionOffset(block,range.endContainer,range.endOffset);if(start===end)return;
 const rect=range.getBoundingClientRect();const h={id:`h-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,block:block.dataset.block,start,end,color:state.highlightColor,underline:false};
 // Split intersecting highlights to avoid nesting and retain unaffected portions.
 currentState().highlights=currentState().highlights.flatMap(old=>{if(old.block!==h.block||old.end<=start||old.start>=end)return[old];const pieces=[];if(old.start<start)pieces.push({...old,end:start});if(old.end>end)pieces.push({...old,id:old.id+'r',start:end});return pieces;});
 currentState().highlights.push(h);selection.removeAllRanges();renderBlock(block,blockText(h.block));suppressClickUntil=Date.now()+200;showToolbar(h.id,rect);save();
});
document.addEventListener('click',event=>{if(Date.now()<suppressClickUntil)return;const mark=event.target.closest('.text-highlight');if(mark){showToolbar(mark.dataset.highlightId,mark.getBoundingClientRect());return;}if(!event.target.closest('#highlightToolbar'))hideToolbar();if(!event.target.closest('#navigator')&&!event.target.closest('#navigatorToggle'))closeNavigator();});
$('highlightToolbar').addEventListener('mousedown',event=>event.preventDefault());
$('highlightToolbar').addEventListener('click',event=>{event.stopPropagation();const button=event.target.closest('button');if(!button||!activeHighlightId)return;const h=currentState().highlights.find(h=>h.id===activeHighlightId);if(!h)return;
 const block=document.querySelector(`[data-block="${h.block}"]`);if(button.dataset.color){h.color=button.dataset.color;state.highlightColor=button.dataset.color;updateHighlightSwatches(h.color);}else if(button.id==='underlineHighlight')h.underline=!h.underline;else if(button.id==='deleteHighlight'){currentState().highlights=currentState().highlights.filter(item=>item.id!==h.id);hideToolbar();}
 renderBlock(block,blockText(h.block));$('underlineHighlight').setAttribute('aria-pressed',h.underline);save();
});
$('passagePane').addEventListener('scroll',()=>{commitMaterialScroll();save();});
document.querySelectorAll('.pane').forEach(p=>p.addEventListener('scroll',hideToolbar));window.addEventListener('resize',hideToolbar);
let modalTrigger=null;
function openModal(title,body,actions,kind=''){
 modalTrigger=$('modal').open?modalTrigger:document.activeElement;
 closeNavigator();closeMore();hideToolbar();hideTooltips();$('modal').className=kind;
 $('modalTitle').textContent=title;$('modalBody').innerHTML=body;$('modalActions').replaceChildren();
 actions.forEach(({text,action})=>{const button=document.createElement('button');button.textContent=text;button.className=['Cancel','Continue Practice Test'].includes(text)?'outline':'primary';button.onclick=action;$('modalActions').append(button);});
 if(!$('modal').open)$('modal').showModal();$('modal').querySelector('button:not([hidden])').focus();
}
$('modal').addEventListener('close',()=>{$('directionsButton').setAttribute('aria-expanded','false');if(modalTrigger?.isConnected)modalTrigger.focus();});
$('closeModal').onclick=()=>$('modal').close();
function applyReadingFontSize(){
 const shell=document.querySelector('.exam-shell');
 if(readingFontSize===null)shell.style.removeProperty('--reading-font-size');
 else shell.style.setProperty('--reading-font-size',readingFontSize+'px');
}
function syncFontSizeControls(){
 const size=readingFontSize??parseFloat(getComputedStyle($('passage')).fontSize);
 $('fontSizeRange').value=size;$('fontSizeRange').setAttribute('aria-valuetext',size+' pixels');$('fontSizeSelect').value=size;
}
function showFontSize(){
 openModal('Font Size',`<p id="fontSizeHelp">Adjust the passage, question, and answer text. Changes apply immediately and are saved in this browser.</p><div class="font-size-controls"><div class="font-size-slider"><label for="fontSizeRange">Text size</label><input id="fontSizeRange" type="range" min="14" max="28" step="1" aria-describedby="fontSizeHelp"><div class="font-size-limits" aria-hidden="true"><span>14 px</span><span>28 px</span></div></div><div><label for="fontSizeSelect">Font size</label><select id="fontSizeSelect">${Array.from({length:15},(_,i)=>`<option value="${i+14}">${i+14} px</option>`).join('')}</select></div></div><h3 class="font-size-preview-title">Live preview</h3><div class="font-size-preview" role="region" aria-label="Font size preview"><div id="fontSizePreviewPassage" class="reading"></div><div id="fontSizePreviewPrompt" class="reading"></div><div class="font-size-preview-option"><span class="letter">A</span><span id="fontSizePreviewOption" class="reading"></span></div></div><button id="fontSizeReset" class="outline">Reset to Default</button>`,[{text:'Done',action:()=>$('modal').close()}],'font-size-dialog');
 const q=examQuestions[state.currentQuestion];
 $('fontSizePreviewPassage').textContent=q.passage.length>420?q.passage.slice(0,420)+'…':q.passage;
 $('fontSizePreviewPrompt').textContent=q.prompt;
 $('fontSizePreviewOption').textContent=q.options[0];
 const change=e=>{readingFontSize=Number(e.target.value);applyReadingFontSize();syncFontSizeControls();SATLineReader.render();save();};
 $('fontSizeRange').oninput=change;$('fontSizeSelect').onchange=change;
 $('fontSizeReset').onclick=()=>{readingFontSize=null;applyReadingFontSize();syncFontSizeControls();SATLineReader.render();save();};
 syncFontSizeControls();$('fontSizeRange').focus();
}
function closeMore(restore=false){$('moreMenu').hidden=true;$('exitButton').setAttribute('aria-expanded','false');if(restore)$('exitButton').focus();}
$('exitButton').onclick=()=>{const opening=$('moreMenu').hidden;closeMore();if(opening){hideToolbar();hideTooltips();$('moreMenu').hidden=false;$('exitButton').setAttribute('aria-expanded','true');$('moreMenu').querySelector('[data-more="reader"]').setAttribute('aria-checked',state.lineReaderState.enabled);$('moreMenu').querySelector('button').focus();}};
document.addEventListener('click',e=>{if(!e.target.closest('#moreMenu,#exitButton'))closeMore();});
$('moreMenu').addEventListener('keydown',e=>{const buttons=[...$('moreMenu').querySelectorAll(':scope > button')];if(e.target.matches('input,select'))return;if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();e.stopPropagation();const i=buttons.indexOf(document.activeElement);buttons[e.key==='Home'?0:e.key==='End'?buttons.length-1:(i+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length].focus();}});
$('moreMenu').onclick=e=>{
 const item=e.target.closest('[data-more]');if(!item)return;if(item.dataset.more==='timer'){state.questionTimerPanelState.visible=!state.questionTimerPanelState.visible;closeMore();renderQuestionTimerPanel();updateQuestionTimer();save();if(!$('questionTimerPanel').hidden)$('questionTimerGrip').focus();else $('exitButton').focus();return;}closeMore(true);
 if(item.dataset.more==='reader'){SATLineReader.toggle();return;}
 if(item.dataset.more==='font-size'){showFontSize();return;}
 if(item.dataset.more==='help')openModal('Help','<h3>Answer & review</h3><p>Choose an answer, cross out choices, and mark questions for review. Use the question navigator to jump between questions and check your work.</p><h3>Reading tools</h3><p>Turn on Highlights &amp; Notes, then select text to highlight it. Choose a color or underline in the toolbar. Use Line Reader to follow a line of text, or Font Size to adjust the reading text with a live preview.</p><h3>Time & progress</h3><p>Hide or show the timer. Use keyboard shortcuts from More → Shortcuts. Save and Exit pauses the timer and saves your progress; choose Resume on Dashboard to continue.</p>',[{text:'Close',action:()=>$('modal').close()}]);
 if(item.dataset.more==='shortcuts')openModal('Keyboard Shortcuts',`<dl class="shortcuts-list">${SATShortcuts.map(s=>`<dt>${s.description}</dt><dd><kbd>${s.label}</kbd></dd>`).join('')}</dl>`,[{text:'Close',action:()=>$('modal').close()}]);
 if(item.dataset.more==='exit')openModal('Do You Want to Exit this Practice Test?','<p>If you exit now, we’ll save your progress and pause the timer. You can resume this practice test from Dashboard in this browser.</p>',[{text:'Continue Practice Test',action:()=>$('modal').close()},{text:'Save and Exit',action:()=>finishAttempt({status:'incomplete',reason:'exit'})}],'exit-dialog');
};
function resetTest(){if(!running)return;$('modal').close();const practice={...state.activePractice,id:crypto.randomUUID(),createdAt:Date.now()};startExam(examQuestions,practice,onFinish);}
window.resetTest=resetTest;
function showCompleteConfirmation(){const unanswered=state.questionStates.slice(currentModule().start,currentModule().end).filter(q=>q.selectedOption===null).length;openModal('Finish this practice module?',`<p>${unanswered?`You have ${unanswered} unanswered question${unanswered===1?'':'s'}. `:''}Your answers will be saved. You will move to the next module, or see your completion page after the final module.</p>`,[{text:'Cancel',action:()=>$('modal').close()},{text:'Finish',action:()=>finishAttempt({status:'completed',reason:'submitted'})}]);}
function showDirections(){
 if($('modal').open&&$('modal').classList.contains('directions-dialog')){$('modal').close();return;}
 openModal('Reading and Writing — Directions','<p>The questions in this section address a number of important reading and writing skills. Each question includes one or more passages, which may include a table or graph. Read each passage and question carefully, and then choose the best answer to the question based on the passage(s).</p><p>All questions in this section are multiple-choice with four answer choices. Each question has a single best answer.</p>',[{text:'Close',action:()=>$('modal').close()}],'directions-dialog');
 modalTrigger=$('directionsButton');$('directionsButton').setAttribute('aria-expanded','true');$('modalActions').querySelector('button').focus();
}
$('directionsButton').onclick=showDirections;
// A modal dialog makes the header inert, so handle clicks on its visible trigger through the backdrop.
$('modal').addEventListener('click',event=>{
 if(event.target!==$('modal')||!$('modal').classList.contains('directions-dialog'))return;
 const rect=$('directionsButton').getBoundingClientRect();
 if(event.clientX>=rect.left&&event.clientX<=rect.right&&event.clientY>=rect.top&&event.clientY<=rect.bottom)$('modal').close();
});
document.addEventListener('keydown',event=>{
 if(!running||state.completed||state.phase==='module_break')return;
 const shortcut=SATShortcuts.find(s=>s.key.toLowerCase()===event.key.toLowerCase());if(!shortcut)return;
 if(shortcut.action==='close'){closeNavigator();hideToolbar();hideTooltips();if(!$('moreMenu').hidden){event.preventDefault();closeMore(true);}return;}
 if($('modal').open||!$('moreMenu').hidden||event.target.closest('#questionTimerPanel,input,textarea,select,[contenteditable]:not([contenteditable=false])')||window.getSelection()?.toString()||!$('highlightToolbar').hidden||event.ctrlKey||event.metaKey||event.altKey)return;
 if(state.view!=='question')return;event.preventDefault();
 ({next,back,select:()=>selectOption(shortcut.index),cross:()=>toggleCross(shortcut.index),mark:toggleMarkedForReview})[shortcut.action]();
});
$('divider').addEventListener('pointerdown',event=>{event.preventDefault();$('divider').setPointerCapture(event.pointerId);});
$('divider').addEventListener('pointermove',event=>{if(!$('divider').hasPointerCapture(event.pointerId))return;const rect=$('questionView').getBoundingClientRect();state.split=Math.max(30,Math.min(70,(event.clientX-rect.left)/rect.width*100));document.documentElement.style.setProperty('--left',`${state.split}%`);$('divider').setAttribute('aria-valuenow',Math.round(state.split));hideToolbar();});
$('divider').addEventListener('pointerup',save);
$('divider').addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight'].includes(event.key))return;event.stopPropagation();event.preventDefault();state.split=Math.max(30,Math.min(70,state.split+(event.key==='ArrowLeft'?-2:2)));document.documentElement.style.setProperty('--left',`${state.split}%`);$('divider').setAttribute('aria-valuenow',Math.round(state.split));save();});
window.addEventListener('pagehide',()=>{if(running){commitQuestionTime();save();}});
window.ExamEngine={start:startExam,finishAttempt,isRunning:()=>running};
})();
