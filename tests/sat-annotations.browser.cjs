const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const fs=require('node:fs/promises'),http=require('node:http'),path=require('node:path'),os=require('node:os');
// Optional browser regression: Node.js + Playwright and Chrome. No real bank or existing browser profile is used.
const root=path.resolve(__dirname,'../apps/sat');
const server=http.createServer(async(req,res)=>{try{
 if(req.url.startsWith('/api/question-bank')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url.endsWith('status')?{service:'sat-question-bank-v1',token:'synthetic-test'}:{files:[],errors:[]}));return;}
 const p=path.join(root,decodeURIComponent(new URL(req.url,'http://localhost').pathname));
 if(!p.startsWith(root+path.sep))throw Error();
 const bytes=await fs.readFile(p);res.setHeader('Content-Type',p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':p.endsWith('.html')?'text/html':'application/json');res.end(bytes);
 }catch{res.statusCode=404;res.end('missing');}});
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{channel:'chrome'})});const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 const url=process.env.SAT_BROWSER_TEST_URL||`http://127.0.0.1:${server.address().port}/html/index.html`;
 const runtime=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('sat-reading-practice-v1')));
 const highlight=async(start,end,blockId='passage')=>{await page.evaluate(({start,end,blockId})=>{const block=document.getElementById(blockId),walker=document.createTreeWalker(block,NodeFilter.SHOW_TEXT);let pos=0,node,sn,so,en,eo;while(node=walker.nextNode()){const n=node.textContent.length;if(sn===undefined&&start<pos+n){sn=node;so=start-pos;}if(end<=pos+n){en=node;eo=end-pos;break;}pos+=n;}const r=document.createRange();r.setStart(sn,so);r.setEnd(en,eo);const s=getSelection();s.removeAllRanges();s.addRange(r);block.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));},{start,end,blockId});};
 try{
 await page.goto(url);await page.locator('[data-action=practiceBuilder]').first().waitFor();
 if(new URL(url).pathname.startsWith('/sat/')){
  const databases=await page.evaluate(async()=> (await indexedDB.databases()).map(d=>d.name));assert.ok(databases.includes('SchoolExamPlatform:sat:v1'));assert.ok(!databases.includes('SATPracticeDB'));
 }
 const synthetic=JSON.parse(await fs.readFile(path.join(root,'data/examples/synthetic-practice.json'),'utf8'));
 // Long anonymous text also exercises scroll-following and multiline annotations.
 synthetic.questions[0].passage+=' '+Array(12).fill('The volunteers compared observations and discussed their original findings.').join(' ');
 await page.evaluate(async d=>{const p=await SATImporter.preview(new File([JSON.stringify(d)],'synthetic-notes.json',{type:'application/json'}),new Set());if(p.errors.length)throw Error(p.errors.join(','));await SATImporter.commit(p);},synthetic);
 await page.reload();await page.locator('[data-action=practiceBuilder]').first().click();await page.locator('[data-action=select-all]').click();await page.locator('[data-action=start]').click();
 await page.locator('[data-action=begin]').click();await page.locator('#transitionTitle').waitFor();assert.match(await page.locator('#transitionTitle').innerText(),/Preparing Your Practice Test/);
 await page.locator('#modal[open]').waitFor();await page.locator('#modalActions button').click();await page.locator('#highlightToggle').click();
 await highlight(0,45);await page.locator('[data-color=pink]').click();let rt=await runtime();assert.equal(rt.questionStates[0].highlights.length,1);
 await highlight(25,70);await page.locator('[data-color=blue]').click();await page.locator('#underlineHighlight').click();await page.locator('[data-underline=dashed]').click();
 for(const style of ['solid','dotted','dashed']){await page.locator('#underlineHighlight').click();await page.locator(`[data-underline=${style}]`).click();assert.equal((await runtime()).questionStates[0].highlights[1].underline,style);}
 await page.locator('#underlineHighlight').click();await page.screenshot({path:path.join(os.tmpdir(),'sat-highlight-menu.png')});await page.keyboard.press('Escape');
 rt=await runtime();assert.equal(rt.questionStates[0].highlights.length,2);assert.equal(rt.questionStates[0].highlights[0].end,45);assert.equal(rt.questionStates[0].highlights[1].underline,'dashed');
 const colors=await page.locator('#passage .text-highlight').evaluateAll(es=>es.map(e=>({ids:e.dataset.highlightIds.split(' ').length,color:e.style.backgroundColor,line:e.style.textDecorationStyle})));
 assert.ok(colors.some(c=>c.ids===2));assert.notEqual(colors.find(c=>c.ids===2).color,colors.find(c=>c.ids===1).color);
 await page.locator('#addHighlightNote').click();await page.locator('.note-body').fill('First <b>plain text</b> note');assert.equal(await page.locator('.note-card').count(),1);assert.equal(await page.locator('.note-body b').count(),0);
 rt=await runtime();assert.equal(rt.questionStates[0].highlights[1].note,'First <b>plain text</b> note');assert.equal(await page.locator('#divider').getAttribute('aria-valuenow'),'67');
 await page.locator('#collapseNotes').click();assert.equal(await page.locator('#notesPanel').isVisible(),false);assert.equal(await page.locator('#divider').getAttribute('aria-valuenow'),'50');await page.locator('#expandNotes').click();
 // Create a second note; it must keep its own range/color and an 8px card gap.
 await highlight(85,125);await page.locator('[data-color=yellow]').click();await page.locator('#addHighlightNote').click();await page.locator('.note-body').nth(1).fill('Second note');assert.equal(await page.locator('.note-card').count(),2);
 await page.screenshot({path:path.join(os.tmpdir(),'sat-multiple-notes.png')});
 await page.locator('.note-delete').first().click();await page.screenshot({path:path.join(os.tmpdir(),'sat-delete-note.png')});await page.locator('[data-note-action=cancel]').click();assert.equal(await page.locator('.note-card').count(),2);
 await page.locator('.note-delete').first().click();await page.locator('[data-note-action=confirm]').click();assert.equal(await page.locator('.note-card').count(),1);assert.equal((await runtime()).questionStates[0].highlights.length,3);
 // Notes cannot trigger answer shortcuts while typing.
 await page.locator('.note-body').fill('abcd remain a note');assert.equal((await runtime()).questionStates[0].selectedOption,null);
 await page.locator('#options [data-option="0"]').click();assert.equal((await runtime()).questionStates[0].selectedOption,0);
 await page.locator('#nextButton').click();assert.equal(await page.locator('#notesPanel').isVisible(),false);await page.locator('#backButton').click();assert.equal(await page.locator('.note-body').inputValue(),'abcd remain a note');
 await page.locator('#exitButton').click();await page.locator('[data-more=exit]').click();await page.getByRole('button',{name:'Save and Exit',exact:true}).click();
 await page.locator('[data-action=resume]').waitFor();await page.reload();await page.locator('[data-action=resume]').click();
 assert.equal(await page.locator('.note-body').inputValue(),'abcd remain a note');assert.equal((await runtime()).questionStates[0].highlights.length,3);assert.equal((await runtime()).questionStates[0].selectedOption,0);
 // Capture real rendered UI and exercise keyboard resizing, focus and narrow screens.
 await page.screenshot({path:path.join(os.tmpdir(),'sat-notes-desktop.png')});
 await page.locator('#divider').focus();await page.keyboard.press('ArrowLeft');assert.equal(await page.locator('#divider').getAttribute('aria-valuenow'),'65');
 await page.setViewportSize({width:700,height:900});
 await page.locator('#divider').focus();for(let i=0;i<30;i++)await page.keyboard.press('ArrowLeft');
 assert.ok((await page.locator('#passagePane').boundingBox()).width>=139);
 await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
 await page.screenshot({path:path.join(os.tmpdir(),'sat-notes-narrow.png')});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.setViewportSize({width:375,height:820});await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 assert.ok((await page.locator('#passagePane').boundingBox()).width>=110);
 assert.ok((await page.locator('#notesPanel').boundingBox()).width>=170);
 await page.screenshot({path:path.join(os.tmpdir(),'sat-notes-mobile.png')});
 await page.setViewportSize({width:1440,height:1000});
 await page.locator('.note-body').focus();await page.keyboard.press('Escape');assert.equal(await page.locator('#notesPanel').isVisible(),false);
 await page.locator('#passage .text-highlight').first().focus();await page.keyboard.press('Enter');assert.equal(await page.locator('#highlightToolbar').isVisible(),true);
 await page.locator('#underlineHighlight').click();await page.keyboard.press('End');await page.keyboard.press('Enter');assert.equal(await page.locator('#underlineMenu').isVisible(),false);
 // An Enter/Space on an annotation inside a radio answer must not select that answer.
 await highlight(0,18,'prompt');await page.locator('#addHighlightNote').click();await page.locator('.note-body').last().fill('Prompt note');await page.locator('#collapseNotes').click();
 await page.evaluate(()=>document.querySelector('[data-block=option-1]').id='synthetic-option');
 await highlight(0,15,'synthetic-option');await page.locator('#deleteHighlight').focus();await page.keyboard.press('Escape');
 await page.locator('#synthetic-option .text-highlight').focus();await page.keyboard.press('Enter');assert.equal((await runtime()).questionStates[0].selectedOption,0);
 await page.locator('#addHighlightNote').click();await page.locator('.note-body').last().fill('Option note');
 await page.locator('#collapseNotes').click();await page.locator('#synthetic-option .text-highlight').focus();await page.keyboard.press('Enter');await page.locator('#deleteHighlight').click();
 assert.equal((await runtime()).questionStates[0].highlights.some(h=>h.note==='Option note'),false);
 // Old underline:true snapshots remain readable after a real reload.
 await page.evaluate(()=>{const s=JSON.parse(localStorage.getItem('sat-reading-practice-v1'));s.questionStates[0].highlights[0].underline=true;localStorage.setItem('sat-reading-practice-v1',JSON.stringify(s));});
 await page.reload();await page.locator('#passage .text-highlight').first().waitFor();
 assert.equal(await page.locator('#passage .text-highlight').first().evaluate(e=>getComputedStyle(e).textDecorationStyle),'solid');
 // Complete the real practice and inspect the saved attempt, not a test stub.
 const attemptId=(await runtime()).activePractice.id;
 await page.locator('#nextButton').click();
 const fullLength=await page.locator('#passage').evaluate(e=>e.textContent.length);await highlight(0,fullLength);
 assert.equal(await page.locator('#passage .text-highlight').count(),1);assert.equal(await page.locator('#passage .text-highlight').innerText(),await page.locator('#passage').innerText());
 await page.locator('#deleteHighlight').focus();await page.keyboard.press('Escape');await page.mouse.move(1400,980);
 const baseColor=await page.locator('#passage .text-highlight').evaluate(e=>e.style.backgroundColor);await page.locator('#passage .text-highlight').hover();
 assert.notEqual(await page.locator('#passage .text-highlight').evaluate(e=>e.style.backgroundColor),baseColor);
 await page.evaluate(()=>{
  for(const [text,style] of [['First verse.\n\nSecond verse.','literary'],['• First note.\n• Second note.','prose']]){
   const root=document.createElement('div'),mark=document.createElement('span');mark.className='text-highlight';const format=document.createElement('span');format.className='source-underline';format.textContent=text;mark.append(format);root.append(mark);SATText.layout(root,{passageStyle:style});
   if(root.textContent!==text||!root.querySelector('.text-highlight .source-underline'))throw Error('Whole-material highlight formatting was lost');
  }
 });
 await page.locator('#options [data-option="1"]').focus();await page.keyboard.press('Space');await page.locator('#nextButton').click();await page.locator('#nextButton').click();
 assert.equal(await page.getByRole('heading',{name:'Finish this practice module?',exact:true}).isVisible(),false);
 await page.locator('[data-action=attempt]').waitFor();
 const saved=await page.evaluate(id=>SATStorage.get('attempts',id),attemptId);assert.equal(saved.status,'completed');assert.equal(saved.correctCount,2);
 assert.ok(Object.values(saved.answers).some(a=>a.highlights.some(h=>h.note==='Prompt note')));
 assert.deepEqual(errors,[]);console.log('PASS: overlap, underline, multiple notes, plain text, delete/cancel, collapse, cross-question, answers, Save & Exit/Resume, keyboard, 375/700px layouts, option keyboard, legacy underline, completed results, no page errors.');
 }finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;server.close();});
