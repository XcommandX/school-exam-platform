'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const {chromium} = require('playwright');
const base = path.resolve(__dirname,'../../front-end/sat');
const scripts = ['vendor/marked/marked.umd.js','vendor/dompurify/purify.min.js','vendor/katex/katex.min.js','js/sat-pack.js','js/content-renderer.js'];
const fixture = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/vendor/katex/katex.min.css"><link rel="stylesheet" href="/css/content-renderer.css">${scripts.map(src => `<script defer src="/${src}"></script>`).join('')}</head><body><div id="content"></div></body></html>`;

test('SAT Markdown and LaTeX render safely using local dependencies', async t => {
  const server = http.createServer(async (req,res) => {
    if(req.url === '/') {res.setHeader('Content-Type','text/html');res.end(fixture);return;}
    try {
      const pathname = new URL(req.url,'http://localhost').pathname;
      assert.ok(/^\/(?:vendor\/|js\/(?:content-renderer|sat-pack)\.js$|css\/content-renderer\.css$)/.test(pathname));
      const file = path.resolve(base,'.'+pathname);
      assert.ok(file.startsWith(base+path.sep));
      res.setHeader('Content-Type',file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream');
      res.end(await fs.readFile(file));
    } catch {res.statusCode=404;res.end('missing');}
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    browser = await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE} : {channel:'chrome'})});
    const page = await browser.newPage();
    const requests=[], errors=[];
    page.on('request',request => requests.push(request.url()));
    page.on('pageerror',error => errors.push(error.message));
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.route('**/*',route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    await page.goto(origin);
    await page.waitForFunction(() => !!window.SATContent);
    const render = text => page.evaluate(text => SATContent.render(document.getElementById('content'),[{type:'markdown',text}]).text,text);

    await t.test('real Markdown structure, underline, explicit breaks and pipe table', async () => {
      await render('# Heading\n\n**Bold** and *italic* <u>underlined</u>.  \nNext line\n\n- one\n- two\n\n| A | B |\n| - | - |\n| 1 | 2 |');
      for(const tag of ['h1','strong','em','u','br','ul','table','th','td']) assert.ok(await page.locator('#content '+tag).count(),tag);
      assert.equal(await page.locator('#content u').textContent(),'underlined');
    });

    await t.test('JSON LaTeX fractions and display formulas use preserved backslashes', async () => {
      const text=JSON.parse('{"text":"Inline $\\\\frac{2}{3}$ and \\n\\n$$3x=2$$"}').text;
      await render(text);
      assert.equal(await page.locator('#content .katex').count(),2);
      assert.equal(await page.locator('#content .sat-formula-display').count(),1);
      assert.equal(await page.locator('#content .sat-formula').first().getAttribute('data-latex'),'\\frac{2}{3}');
      assert.equal(await page.locator('#content .sat-formula-error').count(),0);
    });

    await t.test('radicals retain visible SVG paths, sizing, and long overbars after sanitizing', async () => {
      await render('Short $7\\sqrt{3}$ and tall $\\sqrt{\\frac{x^2+5}{x+1}}$. Also $\\sqrt{x^2+2x+1+\\frac{2}{7}}$.');
      await page.evaluate(() => document.fonts.ready);
      const roots=await page.locator('#content .sat-formula .sqrt').evaluateAll(nodes => nodes.map(node => {
        const svg=node.querySelector('svg'), path=svg?.querySelector('path'), stem=node.querySelector('.mord');
        const box=svg?.getBoundingClientRect(), stemBox=stem?.getBoundingClientRect(), pathBox=path?.getBBox();
        return {namespace:svg?.namespaceURI,viewBox:svg?.getAttribute('viewBox'),aspect:svg?.getAttribute('preserveAspectRatio'),
          path:path?.getAttribute('d'),width:box?.width,height:box?.height,stemWidth:stemBox?.width,
          paintedWidth:pathBox?.width,paintedHeight:pathBox?.height};
      }));
      assert.equal(roots.length,3);
      for(const radical of roots) {
        assert.equal(radical.namespace,'http://www.w3.org/2000/svg');
        assert.match(radical.viewBox,/^0 0 400000 \d+$/);
        assert.equal(radical.aspect,'xMinYMin slice');
        assert.ok(radical.path.length>100 && radical.path.includes('400000'));
        assert.ok(radical.width>0 && radical.height>0 && radical.paintedWidth>0 && radical.paintedHeight>0);
        assert.ok(radical.width>=radical.stemWidth,'radical overbar must span its contents');
      }
      assert.ok(roots[1].height>roots[0].height,'fraction requires a taller radical');
      assert.equal(await page.locator('#content .katex .mfrac').count(),2);
      assert.equal(await page.locator('#content .katex .msupsub').count(),2);
      assert.equal(await page.locator('#content .sat-formula-error').count(),0);
    });

    await t.test('only generated safe math shapes survive, source SVG remains inert text', async () => {
      await render('<svg onload="window.injected=true"><script>window.injected=true</script><foreignObject><img src="https://invalid.example/pixel" onerror="window.injected=true"></foreignObject><use href="https://invalid.example/symbol"></use><path d="M0 0L1 1"></path></svg>\n\n<math href="javascript:alert(1)"><annotation-xml encoding="text/html"><img src="https://invalid.example/math" onerror="window.injected=true"></annotation-xml></math>\n\n$\\sqrt{5}$ $\\xrightarrow{n}$ $\\cancel{x}$');
      assert.equal(await page.locator('#content svg').count(),3);
      assert.equal(await page.locator('#content svg:not(.sat-formula svg)').count(),0);
      assert.equal(await page.locator('#content svg path').count(),2);
      assert.equal(await page.locator('#content svg line').count(),1);
      assert.equal(await page.locator('#content svg line').getAttribute('x2'),'100%');
      assert.equal(await page.locator('#content svg line').getAttribute('stroke-width'),'0.046em');
      assert.equal(await page.locator('#content img,#content script,#content foreignObject,#content use,#content [onload],#content [onerror],#content svg [href],#content svg [xlink\\:href]').count(),0);
      assert.equal(await page.locator('#content math:not(.sat-formula math),#content annotation-xml').count(),0);
      assert.ok((await page.locator('#content').textContent()).includes('<svg onload='));
      assert.equal(await page.evaluate(() => !!window.injected),false);
    });

    await t.test('formula families retain KaTeX visible structure and every generated SVG drawing', async () => {
      const formulas=[
        String.raw`\frac{a^2+b_1}{\dfrac{c}{d}}`,
        String.raw`\sqrt[3]{x^2+\sqrt{y}}`,
        String.raw`\left\lVert\frac{x^2}{y_1}\right\rVert+\left(\frac{1}{2}\right)`,
        String.raw`\begin{pmatrix}1&2\\3&4\end{pmatrix}`,
        String.raw`f(x)=\begin{cases}x^2 & x\ge 0\\-x & x<0\end{cases}`,
        String.raw`\begin{aligned}x+y&=4\\x-y&=2\end{aligned}`,
        String.raw`\sum_{n=1}^{m}n+\prod_{k=1}^r k+\int_0^1 x^2\,dx`,
        String.raw`\overline{AB}+\underline{x+y}+\vec{v}+\overrightarrow{PQ}+\widehat{ABC}`,
        String.raw`\overbrace{a+b+c}^{n}+\underbrace{x+y}_{m}`,
        String.raw`a\xleftrightarrow[n]{m}b\xrightarrow{p}c`,
        String.raw`\cancel{x}+\bcancel{y}+\xcancel{z}`,
        String.raw`\begin{array}{c|c}x&y\\1&2\end{array}`
      ];
      await render(formulas.map(tex => '$$'+tex+'$$').join('\n\n'));
      await page.evaluate(() => document.fonts.ready);
      const result=await page.evaluate(formulas => {
        const holder=document.createElement('div');
        const drawing=node => [...node.querySelectorAll('svg,path,line')].map(shape => ({
          tag:shape.tagName,namespace:shape.namespaceURI,
          attrs:[...shape.attributes].map(attr => [attr.name,attr.value]).sort((a,b) => a[0].localeCompare(b[0]))
        }));
        return formulas.map((tex,index) => {
          holder.innerHTML=katex.renderToString(tex,{displayMode:true,throwOnError:true,trust:false,strict:'error',macros:{},globalGroup:false,maxExpand:100,maxSize:20,output:'htmlAndMathml'});
          const raw=holder.querySelector('.katex-html'), actual=document.querySelectorAll('#content .sat-formula')[index]?.querySelector('.katex-html');
          const box=actual?.getBoundingClientRect();
          return {tex,before:drawing(raw),after:actual ? drawing(actual) : null,
            beforeElements:[...raw.querySelectorAll('*')].map(node => node.tagName),
            afterElements:actual ? [...actual.querySelectorAll('*')].map(node => node.tagName) : null,
            width:box?.width,height:box?.height,shapes:actual ? [...actual.querySelectorAll('path,line')].map(node => {const b=node.getBBox();return {width:b.width,height:b.height};}) : []};
        });
      },formulas);
      assert.equal(result.length,formulas.length);
      let shapes=0;
      for(const formula of result) {
        assert.deepEqual(formula.after,formula.before,formula.tex+' SVG geometry and attributes');
        assert.deepEqual(formula.afterElements,formula.beforeElements,formula.tex+' visible HTML structure');
        assert.ok(formula.width>0 && formula.height>0,formula.tex+' has visible bounds');
        for(const shape of formula.shapes) assert.ok(shape.width>0 || shape.height>0,formula.tex+' has painted geometry');
        shapes+=formula.shapes.length;
      }
      assert.ok(shapes>=15,'matrix, radicals, accents, braces, arrows and cancellation draw geometry');
      assert.equal(await page.locator('#content .sat-formula-error,#content .katex-error').count(),0);
    });

    await t.test('escaped dollars, currency, inline code and fences remain literal', async () => {
      const text = await render('Costs \\$5 and \\$10. Also $5 and $10. `Code $x$`\n\n```text\n$y$\n$$z$$\n```\n\nReal $x+1$');
      assert.ok(text.includes('Costs $5 and $10. Also $5 and $10.'));
      assert.equal(await page.locator('#content .katex').count(),1);
      assert.match(await page.locator('#content pre').textContent(),/\$y\$/);
      assert.equal(await page.locator('#content code').first().textContent(),'Code $x$');
    });

    await t.test('HTML, links, Markdown images, LaTeX resources and macros cannot execute', async () => {
      await render('<img src="https://invalid.example/image" onerror="window.injected=true">\n\n<u onclick="window.injected=true">bad</u> and <u>good</u>\n\n<script>window.injected=true</script>\n\n[bad](javascript:alert(1)) ![remote](https://invalid.example/pixel) [safe](https://example.com/)\n\n$\\includegraphics{https://invalid.example/pixel}$ $\\href{javascript:alert(1)}{x}$ $\\def\\x{hi}\\x$');
      assert.equal(await page.locator('#content img,#content script,#content [onclick],#content [onerror]').count(),0);
      assert.equal(await page.locator('#content a').count(),1);
      assert.equal(await page.locator('#content a').getAttribute('href'),'https://example.com/');
      assert.equal(await page.locator('#content u').count(),1);
      assert.equal(await page.locator('#content u').textContent(),'good');
      assert.equal(await page.locator('#content .sat-formula-error').count(),3);
      assert.equal(await page.evaluate(() => !!window.injected),false);
    });

    await t.test('explicit image blocks preserve order and use only local references', async () => {
      const result = await page.evaluate(() => {
        const blocks=[{type:'markdown',text:'First'},{type:'image',assetId:'graph',alt:'An original graph',role:'coordinate-plane',caption:'Figure 1'},{type:'markdown',text:'Last'}];
        const calls=[];
        SATContent.render(document.getElementById('content'),blocks,{assets:{graph:{src:'/synthetic.svg'}},imageFactory:obj => {calls.push(obj); const el=document.createElement('div');el.className='custom-image';return el;}});
        let missing=false,remote=false;
        try{SATContent.render(document.createElement('div'),blocks,{assets:{}});}catch{missing=true;}
        try{SATContent.render(document.createElement('div'),blocks,{assets:{graph:{src:'https://invalid.example/img'}}});}catch{remote=true;}
        return {calls,missing,remote,children:[...document.getElementById('content').children].map(el => el.className),text:document.getElementById('content').textContent};
      });
      assert.equal(result.calls[0].src,'/synthetic.svg');
      assert.equal(result.calls[0].assetId,'graph');
      assert.equal(result.calls[0].role,'coordinate-plane');
      assert.deepEqual(result.children,['sat-markdown','sat-content-image','sat-markdown']);
      assert.match(result.text,/First[\s\S]*Figure 1[\s\S]*Last/);
      assert.ok(result.missing && result.remote);
    });

    await t.test('annotations preserve Markdown, formulas and DOM range offsets', async () => {
      const result=await page.evaluate(() => {
        const el=document.getElementById('content');
        SATContent.render(el,[{type:'markdown',text:'First **bold** <u>source</u> $\\frac{2}{3}$ last.'}]);
        const text=el.textContent, formula=el.querySelector('.sat-formula').innerHTML, length=SATContent.annotationText(el).length;
        SATContent.applyAnnotations(el,[{start:0,end:length,id:'note-1',color:'pink',underline:'dotted'}]);
        SATContent.applyAnnotations(el,[{start:0,end:length,id:'note-1',color:'blue',underline:'solid'}]);
        return {sameText:el.textContent===text,sameFormula:el.querySelector('.sat-formula').innerHTML===formula,formulaMarks:el.querySelector('.sat-formula .text-highlight')===null,underlined:el.querySelector('u .text-highlight')?.textContent,bold:el.querySelector('strong .text-highlight')?.textContent,count:el.querySelectorAll('[data-highlight-id="note-1"]').length,summary:SATContent.plainText([{type:'markdown',text:'**Value** $\\frac{2}{3}$'}])};
      });
      assert.ok(result.sameText && result.sameFormula && result.formulaMarks);
      assert.equal(result.underlined,'source');assert.equal(result.bold,'bold');assert.ok(result.count>1);
      assert.match(result.summary,/Value \\frac\{2\}\{3\}/);
    });

    await t.test('image zoom controls and formula/code contents never shift note offsets', async () => {
      const result=await page.evaluate(() => {
        const el=document.getElementById('content');
        SATContent.render(el,[{type:'markdown',text:'Before $x+1$ `code`.'},{type:'image',assetId:'graph',alt:'Graph'},{type:'markdown',text:'After **bold**.'}],{assets:{graph:{src:'/safe-local.svg'}},imageFactory:() => {const viewer=document.createElement('div');viewer.textContent='Zoom In 100% Reset';return viewer;}});
        const text=SATContent.annotationText(el), last=SATContent.textIndex(el).find(part => part.node.textContent.includes('After'));
        const start=SATContent.selectionOffset(el,last.node,0), end=SATContent.selectionOffset(el,last.node,5);
        const formula=el.querySelector('.sat-formula'), math=el.ownerDocument.createTreeWalker(formula,NodeFilter.SHOW_TEXT).nextNode();
        const mathStart=SATContent.selectionOffset(el,math,0), mathEnd=SATContent.selectionOffset(el,math,math.textContent.length);
        el.querySelector('.sat-content-image > div').textContent='Zoom Out 300% Reset Full Screen';
        const after=SATContent.annotationText(el), updatedStart=SATContent.selectionOffset(el,last.node,0);
        SATContent.applyAnnotations(el,[{start,end,id:'after-image',color:'yellow'}]);
        return {text,after,start,updatedStart,mathStart,mathEnd,mark:el.querySelector('.text-highlight')?.textContent,formulaMarks:!!el.querySelector('.sat-formula .text-highlight')};
      });
      assert.equal(result.text,result.after);assert.equal(result.start,result.updatedStart);
      assert.equal(result.mathStart,result.mathEnd);assert.equal(result.mark,'After');assert.equal(result.formulaMarks,false);
      assert.ok(!result.text.includes('100%') && !result.text.includes('code') && !result.text.includes('x+1'));
    });

    await t.test('a validated original SATPack image renders from its persistent data URL', async () => {
      const folder=path.resolve(__dirname,'../../docs/drafts/sat-question-packs/math-single-choice');
      const files=await Promise.all(['pack.json','items.json','solutions.json','assets/line-graph.svg'].map(async relative => ({relative,bytes:[...await fs.readFile(path.join(folder,relative))]})));
      const result=await page.evaluate(async files => {
        const selected=files.map(({relative,bytes}) => {const file=new File([new Uint8Array(bytes)],relative.split('/').pop());Object.defineProperty(file,'webkitRelativePath',{value:'math-single-choice/'+relative});return file;});
        const [preview]=await SATPack.previewFiles(selected);
        if(preview.errors.length) throw Error(preview.errors.join('; '));
        const q=preview.questions[0], el=document.getElementById('content');
        SATContent.render(el,q.packContent.content,{assets:q.packAssets});
        const img=el.querySelector('img');
        await img.decode();
        return {src:img.src,width:img.naturalWidth,height:img.naturalHeight,alt:img.alt};
      },files);
      assert.match(result.src,/^data:image\/svg\+xml;base64,/);
      assert.ok(result.width>0 && result.height>0);
      assert.match(result.alt,/straight line/);
    });

    await t.test('all CSS font references exist and rendered formulas load offline', async () => {
      const css=await fs.readFile(path.join(base,'vendor/katex/katex.min.css'),'utf8');
      const fonts=[...css.matchAll(/url\(([^)]+)\)/g)].map(match => match[1].replace(/["']/g,''));
      assert.equal(fonts.length,60);
      for(const font of fonts) assert.ok((await fs.stat(path.join(base,'vendor/katex',font))).size>0);
      await render('$$\\frac{2}{3}+\\sqrt{x^2}+\\sum_{n=1}^{4} n+\\mathbb{R}$$');
      await page.evaluate(() => document.fonts.ready);
      assert.ok(await page.evaluate(() => document.fonts.check('20px KaTeX_Main')));
      assert.deepEqual(errors,[]);
      assert.ok(requests.every(url => url.startsWith(origin) || url.startsWith('data:image/')),'no remote resource requests');
    });
  } finally {
    if(browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
