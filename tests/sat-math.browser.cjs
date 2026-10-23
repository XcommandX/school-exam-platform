'use strict';
// Optional end-to-end regression. Uses only original synthetic question packages,
// a fresh browser profile, a read-only local server, and temporary screenshots.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'), http=require('node:http'), path=require('node:path'), os=require('node:os');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'../apps/sat');
const fixturesRoot=path.resolve(__dirname,'../docs/drafts/sat-question-packs');
const names=['rw-single-choice','math-single-choice','math-spr'];
const mime={'.js':'application/javascript','.css':'text/css','.html':'text/html','.json':'application/json','.svg':'image/svg+xml','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf'};
const server=http.createServer(async(req,res)=>{try{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname.startsWith('/api/question-bank')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(url.pathname.endsWith('/status')?{service:'sat-question-bank-v1',token:'original-browser-regression'}:{files:[],errors:[]}));return;}
  assert.equal(req.method,'GET');
  const file=path.resolve(root,'.'+decodeURIComponent(url.pathname));
  assert.ok(file.startsWith(root+path.sep));
  res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');res.end(await fs.readFile(file));
}catch{res.statusCode=404;res.end('missing');}});

async function fixtureFiles(){
  const files=[];
  async function walk(folder,relative){for(const entry of await fs.readdir(folder,{withFileTypes:true})){const next=relative+'/'+entry.name;if(entry.isDirectory())await walk(path.join(folder,entry.name),next);else files.push({name:next,bytes:[...await fs.readFile(path.join(folder,entry.name))]});}}
  for(const name of names)await walk(path.join(fixturesRoot,name),name);
  return files;
}

(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{channel:'chrome'})});
  const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[];
  const screenshotPaths=[];
  page.on('pageerror',error=>errors.push(error.message));
  const runtime=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('sat-reading-practice-v1')));
  const screenshot=async name=>{const file=path.join(os.tmpdir(),'sat-math-'+name+'.png');await page.screenshot({path:file});screenshotPaths.push(file);};
  const waitPaint=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const directionClose=async()=>{await page.locator('#modal[open]').waitFor();await page.locator('#modalActions button').click();};
  const begin=async(ids,name,fullSAT=false)=>{
    await page.evaluate(async({ids,name,fullSAT})=>{SATApp.appState.practiceKind=fullSAT?'full-sat':'section';await SATApp.startPractice(ids,name,1920);},{ids,name,fullSAT});
    await page.locator('[data-action=begin]').click();
    await directionClose();
  };
  const finishModule=async()=>{
    if(await page.locator('#questionView').isVisible()){await page.locator('#navigatorToggle').click();await page.locator('#goReview').click();}
    await page.locator('#nextButton').click();
    assert.equal(await page.getByRole('heading',{name:'Finish this practice module?',exact:true}).isVisible(),false,'Check Your Work Next must not ask for another confirmation');
    assert.equal(await page.locator('.module-over').count(),0,'manual Next moves directly to the next module or section break');
  };
  const startMathAfterReady=async(capture=false)=>{
    await page.locator('.sat-math-ready').waitFor();
    assert.equal(await page.locator('.sat-math-ready h1').innerText(),'Resume Testing Now');
    assert.ok(await page.getByText('Your testing timer has not started counting down yet.',{exact:true}).isVisible());
    assert.equal(await page.locator('#startMathSection').innerText(),'Resume Testing');
    assert.equal(await page.locator('.sat-math-ready h1').evaluate(el=>getComputedStyle(el).outlineStyle),'none','the focused ready title must not show a blue outline');
    const readySnapshot=await runtime();assert.equal(readySnapshot.phase,'section_ready');assert.equal(readySnapshot.moduleIndex,1);
    await page.clock.fastForward(120000);
    const waiting=await runtime();assert.equal(waiting.phase,'section_ready');assert.equal(waiting.moduleIndex,1);assert.equal(waiting.endTimestamp,readySnapshot.endTimestamp);assert.equal(waiting.elapsedMs,readySnapshot.elapsedMs);
    const futureSPRIndex=await page.evaluate(async()=>{const saved=JSON.parse(localStorage.getItem('sat-reading-practice-v1'));for(let index=saved.currentQuestion+1;index<saved.activePractice.questionIds.length;index++){const q=await SATStorage.get('questions',saved.activePractice.questionIds[index]);if(SATSession.isSPR(q))return index;}throw Error('No future SPR fixture.');});
    await page.evaluate(index=>localStorage.setItem('sat-synthetic-malformed-response-once',JSON.stringify({index,value:'3 / 2'})),futureSPRIndex);
    await page.reload();await page.evaluate(()=>SATApp.ready);await page.locator('.sat-math-ready').waitFor();
    const reloaded=await runtime();assert.equal(reloaded.phase,'section_ready');assert.equal(reloaded.moduleIndex,1);assert.equal(reloaded.endTimestamp,readySnapshot.endTimestamp);assert.equal(reloaded.elapsedMs,readySnapshot.elapsedMs);
    assert.equal(reloaded.questionStates[futureSPRIndex].numericResponse,'','section-ready reload clears a future SPR legacy malformed response');
    if(capture)await screenshot('ready');
    await page.locator('#startMathSection').click();await directionClose();
    const active=await runtime();assert.equal(active.phase,'active');assert.equal(active.moduleIndex,2);assert.equal(active.elapsedMs,readySnapshot.elapsedMs);
    const remaining=await page.evaluate(end=>end-Date.now(),active.endTimestamp),duration=active.activePractice.modules[2].durationSeconds*1000;
    assert.ok(remaining>duration-3000&&remaining<=duration,'the Math timer starts only after the yellow ready-page button');
    assert.match(await page.locator('.section-info h1').innerText(),/Section 2, Module 1: Math/);
  };
  try{
    const readingSVG=await fs.readFile(path.join(fixturesRoot,'rw-single-choice/assets/garden-table.svg'),'utf8');
    const readingImageSize={width:Number(readingSVG.match(/\bwidth="([\d.]+)"/)[1]),height:Number(readingSVG.match(/\bheight="([\d.]+)"/)[1])};
    const assertReadingImage=async container=>{
      assert.equal(await container.locator('img').count(),1);
      const actual=await container.locator('img').evaluate(async img=>{await img.decode();const rect=img.getBoundingClientRect();return{width:rect.width,height:rect.height,naturalWidth:img.naturalWidth,naturalHeight:img.naturalHeight,reading:!!img.closest('.sat-reading-images'),plainImage:img.parentElement.classList.contains('sat-content-image')};});
      assert.equal(actual.naturalWidth,readingImageSize.width);assert.equal(actual.naturalHeight,readingImageSize.height);
      assert.equal(actual.width,readingImageSize.width);assert.equal(actual.height,readingImageSize.height);assert.ok(actual.reading&&actual.plainImage);
      assert.equal(await container.locator('.sat-image-viewer,.sat-image-overlay,.sat-image-toolbar').count(),0);
      for(const name of ['Zoom In','Zoom Out','Reset','Full Screen'])assert.equal(await container.getByRole('button',{name,exact:true}).count(),0);
    };
    await context.addInitScript(()=>{
      const battery=new EventTarget();battery.level=.76;battery.charging=true;
      Object.defineProperty(navigator,'getBattery',{configurable:true,value:()=>Promise.resolve(battery)});
      window.syntheticBattery=battery;
      // Seed an old snapshot only after pagehide saved the previous document.
      // This avoids fighting the application's normal progress-preservation hook.
      const seedKey='sat-synthetic-malformed-response-once',seed=localStorage.getItem(seedKey);
      if(seed){const update=JSON.parse(seed),key='sat-reading-practice-v1',saved=JSON.parse(localStorage.getItem(key));saved.questionStates[update.index??saved.currentQuestion].numericResponse=update.value;localStorage.setItem(key,JSON.stringify(saved));localStorage.removeItem(seedKey);}
    });
    const url=`http://127.0.0.1:${server.address().port}/html/index.html`;
    await page.goto(url);await page.evaluate(()=>SATApp.ready);
    await page.waitForFunction(()=>document.querySelector('#examBattery .sat-battery-status')?.getAttribute('aria-label')==='Battery 76%, charging');
    const inventory=await page.evaluate(async files=>{
      const selected=files.map(({name,bytes})=>{const file=new File([new Uint8Array(bytes)],name.split('/').pop());Object.defineProperty(file,'webkitRelativePath',{value:name});return file;});
      const previews=await SATPack.previewFiles(selected);
      for(const preview of previews){if(preview.errors.length)throw Error(preview.errors.join('; '));await SATImporter.commit(preview);}
      return (await SATStorage.all('questions')).map(q=>({id:q.id,itemId:q.itemId,section:q.section,responseType:q.responseType}));
    },await fixtureFiles());
    assert.equal(inventory.length,5);
    const questionId=itemId=>inventory.find(q=>q.itemId===itemId).id;
    const mc=questionId('sat:item:synthetic-math-line'),roots=questionId('sat:item:synthetic-math-roots'),fraction=questionId('sat:item:synthetic-math-fraction');
    await page.reload();await page.evaluate(()=>SATApp.ready);
    await begin([mc,roots,fraction],'Synthetic math integration');
    const mathAttempt=(await runtime()).activePractice.id;
    assert.match(await page.locator('.section-info h1').innerText(),/Section 2, Module 1: Math/);
    assert.equal(await page.locator('#highlightToggle').isVisible(),false);
    assert.equal(await page.locator('#calculatorToggle').isVisible(),true);
    assert.equal(await page.locator('#referenceToggle').isVisible(),true);
    assert.equal(await page.locator('#passagePane').isVisible(),false);
    assert.equal(await page.locator('#options .katex').count(),4);
    assert.ok(await page.locator('#mathContent img').evaluate(img=>img.complete&&img.naturalWidth>0));
    const geometry=()=>page.locator('.math-question-inner').evaluate(el=>{const r=el.getBoundingClientRect(),view=document.getElementById('questionView').getBoundingClientRect(),s=getComputedStyle(el);return{x:r.x,width:r.width,center:r.x+r.width/2,viewX:view.x,viewWidth:view.width,transition:s.transitionDuration,timing:s.transitionTimingFunction,transform:s.transform};});
    const none=await geometry();assert.ok(Math.abs(none.center-720)<3);
    await screenshot('none');
    await page.locator('#exitButton').click();assert.ok(await page.locator('#moreMenu').isVisible());assert.ok(await page.getByRole('menuitem',{name:'Save and Exit'}).isVisible());await page.keyboard.press('Escape');

    await page.locator('#calculatorToggle').click();
    const calculator=await geometry();assert.equal(calculator.transition,'0.48s');assert.equal(calculator.timing,'cubic-bezier(0.16, 0.78, 0.22, 1)');
    await page.waitForTimeout(550);assert.ok((await geometry()).center>none.center+150);
    assert.equal(await page.locator('iframe').count(),0);
    await page.locator('#referenceToggle').click();await waitPaint();
    const both=await geometry();assert.equal(both.transition,'0s');assert.ok(Math.abs(both.center-none.center)<40);assert.ok(both.width<none.width);const refBounds=await page.locator('.sat-reference-panel').boundingBox();assert.ok(both.x+both.width<=refBounds.x-10,'Both tools must leave the entire question and elimination buttons outside Reference');
    await screenshot('both');
    await page.locator('#calculatorToggle').click();await page.waitForTimeout(550);
    await page.locator('#referenceToggle').click();await page.locator('#referenceToggle').click();await waitPaint();
    const reference=await geometry();assert.equal(reference.transition,'0s');assert.ok(reference.center<none.center-150);assert.ok(reference.width<none.width);
    const body=page.locator('.sat-reference-body');assert.ok(await body.evaluate(el=>el.scrollHeight>el.clientHeight));await body.evaluate(el=>el.scrollTop=el.scrollHeight);assert.ok(await body.evaluate(el=>el.scrollTop>0));await body.evaluate(el=>el.scrollTop=0);
    await screenshot('reference');
    await page.getByRole('button',{name:'Full Screen Reference',exact:true}).click();
    assert.ok(await page.locator('.sat-reference-fullscreen').isVisible());
    const fullReference=await page.locator('.sat-reference-panel').boundingBox();assert.ok(fullReference.width>1400);
    await page.getByRole('button',{name:'Exit Full Screen Reference',exact:true}).click();

    const viewer=page.locator('#mathContent .sat-image-viewer'),percent=viewer.locator('.sat-image-percent');
    assert.equal(await percent.innerText(),'100%');
    const zoomIn=viewer.getByRole('button',{name:'Zoom In',exact:true}),zoomOut=viewer.getByRole('button',{name:'Zoom Out',exact:true});
    await zoomIn.click();assert.equal(await percent.innerText(),'75%');await zoomIn.click();await zoomIn.click();assert.equal(await percent.innerText(),'25%');assert.ok(await zoomIn.isDisabled());
    for(let i=0;i<11;i++)await zoomOut.click();assert.equal(await percent.innerText(),'300%');assert.ok(await zoomOut.isDisabled());
    await viewer.getByRole('button',{name:'Reset',exact:true}).click();await zoomOut.click();assert.equal(await percent.innerText(),'125%');
    const viewport=viewer.locator('.sat-image-viewport'),rect=await viewport.boundingBox();
    await page.mouse.move(rect.x+rect.width/2,rect.y+rect.height/2);await page.mouse.down();
    assert.equal(await viewport.evaluate(el=>getComputedStyle(el).cursor),'grabbing');await page.mouse.move(rect.x+rect.width/2+18,rect.y+rect.height/2+16);await page.mouse.up();
    assert.ok(await page.locator('#mathContent .sat-question-figure').evaluate(el=>{const p=el.satImageViewer.getPan();return p.x!==0||p.y!==0;}));
    await viewer.getByRole('button',{name:'Reset',exact:true}).click();
    assert.ok(await page.locator('#mathContent .sat-question-figure').evaluate(el=>{const p=el.satImageViewer.getPan();return p.x===0&&p.y===0;}));
    await viewport.dispatchEvent('wheel',{deltaY:-12,ctrlKey:true,bubbles:true,cancelable:true});assert.notEqual(await percent.innerText(),'100%');
    await viewer.getByRole('button',{name:'Reset',exact:true}).click();
    await viewport.evaluate(el=>{el.dispatchEvent(new Event('gesturestart',{cancelable:true}));const event=new Event('gesturechange',{cancelable:true});Object.defineProperty(event,'scale',{value:1.4});el.dispatchEvent(event);el.dispatchEvent(new Event('gestureend',{cancelable:true}));});assert.equal(await percent.innerText(),'140%');
    await viewer.getByRole('button',{name:'Full Screen',exact:true}).click();assert.ok(await page.locator('.sat-image-overlay').isVisible());assert.ok(await page.locator('.sat-reference-panel').isVisible());
    const overlayBox=await page.locator('.sat-image-overlay').boundingBox(),referenceBox=await page.locator('.sat-reference-panel').boundingBox();assert.ok(Math.abs(overlayBox.x+overlayBox.width-referenceBox.x)<3);
    assert.equal(await page.locator('.sat-image-overlay .sat-image-percent').innerText(),'100%');
    await page.locator('.sat-image-overlay').getByRole('button',{name:'Zoom In',exact:true}).hover();assert.equal(await page.locator('.sat-image-overlay').getByRole('button',{name:'Zoom In',exact:true}).getAttribute('data-sat-tooltip'),'Zoom In');
    await page.keyboard.press('Escape');assert.equal(await page.locator('.sat-image-overlay').count(),0);assert.ok(await page.locator('.sat-reference-panel').isVisible());
    await page.getByRole('button',{name:'Close Reference',exact:true}).click();
    await viewer.getByRole('button',{name:'Full Screen',exact:true}).click();assert.ok((await page.locator('.sat-image-overlay').boundingBox()).width>1400);
    await page.locator('#navigatorToggle').click();await page.locator('#goReview').click();
    assert.ok(await page.locator('#reviewView').isVisible());assert.equal(await page.locator('.sat-image-overlay').count(),0,'entering Check Your Work must remove an expanded question image');
    await page.locator('#backButton').click();assert.ok(await page.locator('#questionView').isVisible());
    await page.locator('#options [data-option="1"]').click();await page.locator('#nextButton').click();

    assert.ok(await page.locator('#questionView.spr-layout').isVisible());assert.ok(await page.locator('#divider').isVisible());assert.equal(await page.locator('#options').isVisible(),false);
    const directions=await page.locator('#passage').innerText();
    for(const phrase of ['Student-produced response directions','If you find more than one correct answer, enter only one answer.','You can enter up to 5 characters','up to 6 characters','truncating or rounding at the fourth digit.','Don’t enter symbols such as a percent sign, comma, or dollar sign.','Unacceptable: will NOT receive credit'])assert.ok(directions.includes(phrase),phrase);
    await page.locator('#divider').focus();const split=Number(await page.locator('#divider').getAttribute('aria-valuenow'));await page.keyboard.press('ArrowLeft');assert.equal(Number(await page.locator('#divider').getAttribute('aria-valuenow')),split-2);
    const numeric=page.locator('#numericResponse');
    const numericSelection=()=>numeric.evaluate(input=>({start:input.selectionStart,end:input.selectionEnd}));
    const selectNumeric=async(start,end=start)=>numeric.evaluate((input,{start,end})=>{input.focus();input.setSelectionRange(start,end);},{start,end});
    const pasteNumeric=async text=>numeric.evaluate((input,text)=>{const clipboardData=new DataTransfer();clipboardData.setData('text/plain',text);input.dispatchEvent(new ClipboardEvent('paste',{clipboardData,bubbles:true,cancelable:true}));},text);
    await numeric.fill('');assert.equal(await page.locator('#numericPreview').innerText(),'');
    await numeric.fill('2/3');assert.equal(await page.locator('#numericPreview .katex').count(),1);
    await numeric.press('End');const validCaret=await numericSelection();await numeric.pressSequentially('ab $./-');
    assert.equal(await numeric.inputValue(),'2/3','illegal keystrokes do not change the existing fraction');assert.deepEqual(await numericSelection(),validCaret);
    assert.equal(await page.locator('#numericError,.numeric-error').count(),0);assert.equal(await numeric.getAttribute('aria-invalid'),null);assert.equal(await numeric.getAttribute('aria-describedby'),null);
    for(const partial of ['-','.','-.','3.','3/','-3/']){await numeric.fill(partial);assert.equal(await numeric.inputValue(),partial);assert.equal(await page.locator('#numericPreview .katex').count(),0);}
    await numeric.pressSequentially('2');assert.equal(await numeric.inputValue(),'-3/2');assert.equal(await page.locator('#numericPreview .katex').count(),1);
    await numeric.fill('3.');await numeric.pressSequentially('5/');assert.equal(await numeric.inputValue(),'3.5','a slash cannot mix with a decimal');
    await numeric.fill('3');await numeric.press('Home');await numeric.pressSequentially('-');assert.equal(await numeric.inputValue(),'-3');await numeric.press('Home');await numeric.pressSequentially('-');assert.equal(await numeric.inputValue(),'-3','a second minus sign is ignored');
    for(const limit of ['12345','-12345','.1234','-.1234']){await numeric.fill(limit);await numeric.press('End');await numeric.pressSequentially('6');assert.equal(await numeric.inputValue(),limit);}
    await numeric.fill('2/3');await selectNumeric(0,3);await pasteNumeric('3 / 2');assert.equal(await numeric.inputValue(),'2/3','an invalid paste is rejected as a whole');assert.deepEqual(await numericSelection(),{start:0,end:3});
    await pasteNumeric('123456');assert.equal(await numeric.inputValue(),'2/3','an overlong paste is rejected as a whole');
    await pasteNumeric('-3');assert.equal(await numeric.inputValue(),'-3','a valid paste replaces the selected answer');assert.deepEqual(await numericSelection(),{start:2,end:2});
    await selectNumeric(0,2);await pasteNumeric('2/3');assert.equal(await numeric.inputValue(),'2/3');
    const fallback=await numeric.evaluate(input=>{input.setSelectionRange(1,1);input.dispatchEvent(new InputEvent('beforeinput',{inputType:'insertText',data:'q',bubbles:true,cancelable:true}));input.value='2/q3';input.dispatchEvent(new InputEvent('input',{inputType:'insertText',data:'q',bubbles:true}));return{value:input.value,start:input.selectionStart,end:input.selectionEnd};});
    assert.deepEqual(fallback,{value:'2/3',start:1,end:1},'an input-event fallback restores both the answer and caret');assert.equal((await runtime()).questionStates[1].numericResponse,'2/3');
    await numeric.fill('4');await screenshot('spr');
    await page.locator('#exitButton').click();await page.getByRole('menuitem',{name:'Save and Exit'}).click();await page.getByRole('button',{name:'Save and Exit',exact:true}).click();
    await page.locator('[data-action=resume]').waitFor();await page.reload();await page.evaluate(()=>SATApp.ready);await page.locator(`[data-action=resume][data-id="${mathAttempt}"]`).click();
    await page.locator('#numericResponse').waitFor({state:'visible'});
    assert.equal(await page.locator('#numericResponse').inputValue(),'4');assert.equal((await runtime()).questionStates[1].numericResponse,'4');
    await page.evaluate(()=>localStorage.setItem('sat-synthetic-malformed-response-once',JSON.stringify({value:'3 / 2'})));
    await page.reload();await page.evaluate(()=>SATApp.ready);await numeric.waitFor({state:'visible'});assert.equal(await numeric.inputValue(),'','a legacy malformed saved response is cleared on reload');assert.equal((await runtime()).questionStates[1].numericResponse,'');assert.equal(await page.locator('#numericError,.numeric-error').count(),0);await numeric.fill('4');
    await page.locator('#nextButton').click();await page.locator('#numericResponse').fill('2/3');await finishModule();
    await page.getByRole('button',{name:'View Your Score',exact:true}).waitFor();
    const saved=await page.evaluate(id=>SATStorage.get('attempts',id),mathAttempt);assert.equal(saved.status,'completed');assert.equal(saved.correctCount,1);assert.equal(saved.incorrectCount,2);assert.equal(saved.answers[fraction].numericResponse,'2/3');
    const wrong=await page.evaluate(()=>SATStorage.all('wrongBook'));assert.ok(wrong.some(row=>row.questionId===mc));assert.ok(wrong.some(row=>row.questionId===roots));assert.ok(!wrong.some(row=>row.questionId===fraction));
    await page.getByRole('button',{name:'View Your Score',exact:true}).click();
    await page.locator(`[data-action=review-question][data-id="${fraction}"]`).click();assert.ok(await page.locator('.explanation-panel .katex').count());assert.ok((await page.locator('.single-review').innerText()).includes('2/3'));

    // Exercise the real four-module planner and count down the ten-minute break
    // using Playwright's browser clock, with no real ten-minute wait.
    await page.clock.install({time:new Date('2026-10-23T07:30:00Z')});
    await begin([questionId('sat:item:synthetic-rw-purpose'),questionId('sat:item:synthetic-rw-table'),mc,roots,fraction],'Synthetic full SAT integration',true);
    const fullAttempt=(await runtime()).activePractice.id;assert.equal((await runtime()).activePractice.modules.length,4);
    await page.locator('#highlightToggle').click();
    await page.evaluate(()=>{const block=document.getElementById('passage'),part=SATContent.textIndex(block).find(part=>part.node.textContent.trim().length>12),range=document.createRange();range.setStart(part.node,0);range.setEnd(part.node,12);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);block.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));});
    await page.locator('#addHighlightNote').click();await page.locator('.note-body').fill('Original package reading note');await page.locator('#collapseNotes').click();
    assert.ok(await page.locator('#passage u').count());assert.ok(await page.locator('#passage .text-highlight').count());
    await page.waitForTimeout(220); // Let the deliberate selection-click guard expire.
    await page.locator('#options [data-option="0"]').click();await finishModule();
    assert.equal(await page.locator('#transitionTitle').isVisible(),false);await directionClose();assert.match(await page.locator('.section-info h1').innerText(),/Section 1, Module 2: Reading and Writing/);
    await assertReadingImage(page.locator('#passage'));await screenshot('reading-exam');
    await page.setViewportSize({width:700,height:900});await waitPaint();await assertReadingImage(page.locator('#passage'));
    await page.setViewportSize({width:1440,height:1000});await waitPaint();
    await page.locator('#options [data-option="1"]').click();await finishModule();
    await page.locator('.sat-break').waitFor();assert.equal(await page.locator('.module-over').count(),0);
    assert.equal((await runtime()).phase,'section_break');const breakEnd=(await runtime()).breakEndTimestamp;
    assert.ok(await page.locator('#resumeTesting').isEnabled());assert.match(await page.locator('#breakTime').innerText(),/^(10:00|9:5\d)$/);assert.equal(await page.locator('#transitionTitle').count(),0);
    const initialBreakRemaining=await page.evaluate(end=>end-Date.now(),breakEnd);assert.ok(initialBreakRemaining>598000&&initialBreakRemaining<=600000,'the break starts with a fixed ten-minute countdown');
    assert.match(await page.locator('#breakBattery .sat-battery-status').getAttribute('aria-label'),/76%, charging/);await screenshot('break');
    await page.clock.fastForward(30000);await page.reload();await page.evaluate(()=>SATApp.ready);await page.locator('.sat-break').waitFor();
    assert.equal((await runtime()).breakEndTimestamp,breakEnd);assert.ok(await page.locator('#resumeTesting').isEnabled());assert.match(await page.locator('#breakTime').innerText(),/^9:\d\d$/);
    await page.clock.fastForward(570001);assert.equal(await page.locator('#breakTime').innerText(),'0:00');assert.equal(await page.locator('#resumeTesting').isEnabled(),true);
    await page.clock.fastForward(60000);assert.equal(await page.locator('#breakTime').innerText(),'0:00');assert.equal((await runtime()).phase,'section_break');
    await page.locator('#resumeTesting').click();await startMathAfterReady(true);
    await page.locator('#options [data-option="0"]').click();await page.locator('#nextButton').click();await page.locator('#numericResponse').fill('3');await finishModule();assert.equal(await page.locator('#transitionTitle').isVisible(),false);await directionClose();assert.match(await page.locator('.section-info h1').innerText(),/Section 2, Module 2: Math/);
    await page.locator('#numericResponse').fill('2/3');await finishModule();
    await page.locator('#transitionTitle').waitFor();await page.clock.fastForward(600);await page.getByRole('button',{name:'View Your Score',exact:true}).waitFor();assert.match(await page.locator('#transitionTitle').innerText(),/All Finished/);
    const fullSaved=await page.evaluate(id=>SATStorage.get('attempts',id),fullAttempt);assert.equal(fullSaved.status,'completed');assert.equal(fullSaved.moduleResults.length,4);assert.equal(fullSaved.totalQuestions,5);assert.equal(fullSaved.correctCount,5,JSON.stringify(fullSaved.answers));assert.ok(fullSaved.answers[questionId('sat:item:synthetic-rw-purpose')].highlights.some(h=>h.note==='Original package reading note'));
    await page.getByRole('button',{name:'View Your Score',exact:true}).click();
    await page.locator(`[data-action=review-question][data-id="${questionId('sat:item:synthetic-rw-table')}"]`).click();
    await assertReadingImage(page.locator('.single-review'));await screenshot('reading-review');

    // A separate full SAT confirms the screenshot's early-resume behavior.
    // The two minutes spent on this break must not count as answering time.
    await begin([questionId('sat:item:synthetic-rw-purpose'),questionId('sat:item:synthetic-rw-table'),mc,roots,fraction],'Synthetic early break resume',true);
    const earlyAttempt=(await runtime()).activePractice.id;
    await finishModule();await directionClose();
    await finishModule();await page.locator('.sat-break').waitFor();
    const elapsedBeforeBreak=(await runtime()).elapsedMs;
    await page.clock.fastForward(120000);
    assert.equal((await runtime()).phase,'section_break');assert.equal((await runtime()).elapsedMs,elapsedBeforeBreak);assert.match(await page.locator('#breakTime').innerText(),/^[78]:\d\d$/);assert.ok(await page.locator('#resumeTesting').isEnabled());
    await page.locator('#resumeTesting').click();await startMathAfterReady();
    assert.equal((await runtime()).phase,'active');assert.equal((await runtime()).elapsedMs,elapsedBeforeBreak);assert.match(await page.locator('.section-info h1').innerText(),/Section 2, Module 1: Math/);
    await page.clock.fastForward(5000);
    await page.locator('#exitButton').click();await page.getByRole('menuitem',{name:'Save and Exit'}).click();await page.getByRole('button',{name:'Save and Exit',exact:true}).click();await page.locator(`[data-action=resume][data-id="${earlyAttempt}"]`).waitFor();
    const earlySaved=await page.evaluate(id=>SATStorage.get('attempts',id),earlyAttempt);assert.equal(earlySaved.status,'incomplete');assert.ok(earlySaved.elapsedMs-elapsedBeforeBreak>=5000&&earlySaved.elapsedMs-elapsedBeforeBreak<15000,'only the five active Math seconds are added, excluding the two-minute break');

    // An automatic timeout retains the module-over transition, unlike manual Next.
    await begin([questionId('sat:item:synthetic-rw-purpose'),questionId('sat:item:synthetic-rw-table'),mc,roots,fraction],'Synthetic automatic module timeout',true);
    const timeoutDuration=(await runtime()).activePractice.modules[0].durationSeconds*1000;
    await page.clock.fastForward(timeoutDuration+1);await page.locator('.module-over').waitFor();assert.match(await page.locator('.module-over h1').innerText(),/This Module Is Over/);assert.equal((await runtime()).phase,'module_break');
    await page.clock.fastForward(1900);await directionClose();assert.equal((await runtime()).moduleIndex,1);assert.match(await page.locator('.section-info h1').innerText(),/Section 1, Module 2: Reading and Writing/);

    const unsupported=await browser.newContext();await unsupported.addInitScript(()=>Object.defineProperty(navigator,'getBattery',{configurable:true,value:undefined}));const unsupportedPage=await unsupported.newPage();await unsupportedPage.goto(url);await unsupportedPage.evaluate(()=>SATApp.ready);assert.equal(await unsupportedPage.locator('#examBattery .sat-battery-status').getAttribute('aria-label'),'Battery status unavailable');assert.equal(await unsupportedPage.locator('#examBattery .sat-battery-percent').innerText(),'');await unsupported.close();
    assert.deepEqual(errors,[]);
    process.stdout.write('SAT math browser regression passed: package import, Math layout/tools, SPR save/resume/grading/wrong book/review, original-size plain Reading images in exam/narrow screen/review, Full SAT module flow, fixed 10-minute break with reload/zero/early resume and separate answering time, battery states.\n'+screenshotPaths.join('\n')+'\n');
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
