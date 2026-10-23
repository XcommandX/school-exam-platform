'use strict';
// New SAT packs only. The legacy plain-text renderer remains independent.
(function (root) {
  const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const forbiddenMath = /\\(?:def|gdef|edef|xdef|let|futurelet|global|newcommand|renewcommand|providecommand|newenvironment|renewenvironment|csname|catcode|includegraphics|href|url|htmlClass|htmlId|htmlStyle|htmlData|html@mathml)(?![A-Za-z])/;
  let parser;

  function dependencies() {
    if (!root.marked?.Marked || !root.DOMPurify?.sanitize || !root.katex?.renderToString) {
      throw new Error('The local SAT Markdown, sanitizer, and math libraries must load before SATContent.');
    }
  }

  function mathHTML(text, displayMode) {
    if (forbiddenMath.test(text)) return `<span class="sat-formula-error">${escapeHTML(text)}</span>`;
    try {
      const warnings = new Set();
      const html = root.katex.renderToString(text, {
        displayMode, throwOnError:true, trust:false,
        strict(code) {
          // Imported formulas sometimes contain Unicode text or an unrecognized
          // Unicode glyph. Keep that exact character visible with KaTeX's text
          // fallback, while exposing the diagnostic for source-content review.
          // All other strict checks, parse errors, and resource/macro restrictions
          // remain enabled; this does not infer a replacement mathematical symbol.
          if (code === 'unicodeTextInMathMode' || code === 'unknownSymbol') {
            warnings.add(code);
            return 'ignore';
          }
          return 'error';
        },
        macros:{}, globalGroup:false, maxExpand:100, maxSize:20, output:'htmlAndMathml'
      });
      const diagnostic = warnings.size ? ` data-latex-warnings="${escapeHTML([...warnings].join(' '))}"` : '';
      return `<span class="sat-formula${displayMode ? ' sat-formula-display' : ''}" data-latex="${escapeHTML(text)}"${diagnostic}>${html}</span>`;
    } catch {
      return `<span class="sat-formula-error" role="status">${escapeHTML(text)}</span>`;
    }
  }

  // Called by Marked only outside code spans/fences. Escaped dollars are handled
  // by its escape tokenizer; the closing-dollar rule avoids "$5 and $10".
  function mathToken(source, displayOnly = false) {
    if (source[0] !== '$') return;
    const display = source.startsWith('$$');
    if (displayOnly && !display) return;
    const size = display ? 2 : 1;
    if (!display && /\s/.test(source[size] || '')) return;
    for (let end = size; end < source.length; end++) {
      if (!display && source[end] === '\n') return;
      if (!display && source[end] === '`') return;
      if (source[end] === '\\') { end++; continue; }
      if (!source.startsWith(display ? '$$' : '$', end)) continue;
      // In "$x$$y$", the first dollar closes x and the second opens y.
      // Rejecting a following dollar would instead swallow the next formula
      // (or prose) into this token. A leading "$$" still opens display math.
      // Formulas can abut plain digits, as in "x$\\ge$2". The whitespace
      // before the closer still keeps ordinary "$5 and $10" literal;
      // authored currency is escaped by the pack contract.
      if (!display && /\s/.test(source[end-1])) return;
      const text = source.slice(size, end);
      if (!text.trim()) return;
      return {type:displayOnly ? 'satBlockMath' : 'satInlineMath', raw:source.slice(0,end+size), text, display};
    }
  }

  function getParser() {
    dependencies();
    if (parser) return parser;
    parser = new root.marked.Marked({gfm:true, breaks:false, async:false});
    parser.use({
      extensions:[
        // A "$$" pair in the middle of a paragraph can be two adjacent
        // inline delimiters. Only a new line can start a display block;
        // display formulas embedded in prose are handled by the inline rule.
        {name:'satBlockMath', level:'block', start:src => { const match = /(?:^|\n)\$\$/.exec(src); return match ? match.index + (match[0][0] === '\n' ? 1 : 0) : undefined; },
          tokenizer:src => mathToken(src,true), renderer:token => mathHTML(token.text,true)},
        {name:'satInlineMath', level:'inline', start:src => src.indexOf('$'),
          tokenizer:src => mathToken(src), renderer:token => mathHTML(token.text,token.display)}
      ],
      renderer:{
        html({text}) { return /^<\/?u>$/.test(text) ? text : escapeHTML(text); },
        image({text}) { return escapeHTML(text); },
        link({href,tokens}) {
          const label = this.parser.parseInline(tokens);
          const safe = /^(?:https?:\/\/|mailto:|#)/i.test(href || '') && !/[\u0000-\u0020\u007f]/.test(href);
          return safe ? `<a href="${escapeHTML(href)}" rel="noopener noreferrer" target="_blank">${label}</a>` : label;
        }
      }
    });
    return parser;
  }

  function markdownHTML(text) {
    const html = getParser().parse(String(text ?? ''));
    return root.DOMPurify.sanitize(html, {
      USE_PROFILES:{html:true, mathMl:true},
      // KaTeX draws radicals, stretchy accents/arrows, and cancellation marks
      // with these inert SVG shapes. Keep this smaller than the SVG profile:
      // source HTML is escaped by Marked above, so only trust:false KaTeX output
      // can produce them. No SVG images, use/href links, or active nodes enter.
      ADD_TAGS:['svg','path','line'],
      FORBID_TAGS:['img','video','audio','iframe','object','embed','style','script','form','input','button'],
      FORBID_ATTR:['src','srcset','poster'],
      ADD_ATTR:['target','viewBox','preserveAspectRatio','d','x1','x2','y1','y2','stroke-width'], ALLOW_DATA_ATTR:true
    });
  }

  function assetFor(assets, id) { return assets instanceof Map ? assets.get(id) : assets?.[id]; }
  function localImageSource(src) {
    if (typeof src !== 'string' || !src || /[\u0000-\u001f\\]/.test(src) || src.startsWith('//')) return false;
    // SATPack validates bytes, MIME, digest, and static SVG before producing
    // persistent data URLs. Blocks cannot provide their own source URL.
    if (/^data:image\/(?:png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/.test(src)) return true;
    if (src.startsWith('blob:')) return true;
    if (/^[a-z][a-z\d+.-]*:/i.test(src)) {
      try { const url = new URL(src,root.location?.href); return ['http:','https:'].includes(url.protocol) && url.origin === root.location?.origin; }
      catch { return false; }
    }
    return !src.split(/[/?#]/).includes('..');
  }

  /** Render ordered content blocks. imageFactory receives block fields + src.
   * annotations are UTF-16 offsets in annotationText()/the returned `text`.
   * Formula, code, and image-control subtrees do not contribute to offsets.
   */
  function render(container, blocks, options = {}) {
    const doc = container.ownerDocument;
    const fragment = doc.createDocumentFragment();
    for (const block of blocks || []) {
      if (block?.type === 'markdown') {
        const section = doc.createElement('div');
        section.className = 'sat-markdown';
        section.innerHTML = markdownHTML(block.text);
        fragment.append(section);
      } else if (block?.type === 'image') {
        const asset = assetFor(options.assets,block.assetId);
        if (!asset || !localImageSource(asset.src)) throw new Error(`Missing or unsafe SAT image asset: ${block.assetId}`);
        const image = options.imageFactory?.({...block,src:asset.src}) || doc.createElement('img');
        if (image.tagName === 'IMG') {
          image.src = asset.src;
          image.alt = block.alt || '';
          image.draggable = false;
        }
        const figure = doc.createElement('figure');
        figure.className = 'sat-content-image';
        figure.dataset.assetId = block.assetId;
        if (block.role) figure.dataset.imageRole = block.role;
        figure.append(image);
        if (block.caption) {
          const caption = doc.createElement('figcaption');
          caption.className = 'sat-markdown';
          caption.innerHTML = markdownHTML(block.caption);
          figure.append(caption);
        }
        fragment.append(figure);
      } else throw new Error(`Unsupported SAT content block: ${block?.type}`);
    }
    container.replaceChildren(fragment);
    container.classList.add('sat-content');
    if (options.annotations?.length) applyAnnotations(container, options.annotations, options.styleAnnotation);
    return {text:annotationText(container), container};
  }

  // A source-oriented readable summary for lists/search. It is intentionally
  // separate from render().text, which excludes formulas and image controls.
  function plainText(blocks, options = {}) {
    const holder = root.document.createElement('div');
    const texts = [];
    for (const block of blocks || []) {
      if (block.type === 'image') { texts.push([block.alt,block.caption].filter(Boolean).join(' ')); continue; }
      if (block.type !== 'markdown') continue;
      holder.innerHTML = markdownHTML(block.text);
      holder.querySelectorAll('.sat-formula').forEach(formula => formula.replaceWith(root.document.createTextNode(formula.dataset.latex)));
      holder.querySelectorAll('br').forEach(br => br.replaceWith(root.document.createTextNode('\n')));
      holder.querySelectorAll('p,li,blockquote,h1,h2,h3,h4,h5,h6,pre,tr').forEach(el => el.append(root.document.createTextNode('\n')));
      texts.push(holder.textContent.trim());
    }
    return texts.join('\n\n');
  }

  function textIndex(container) {
    const doc = container.ownerDocument;
    const walker = doc.createTreeWalker(container, root.NodeFilter.SHOW_TEXT);
    const result = []; let offset = 0, node;
    while ((node = walker.nextNode())) {
      if (node.parentElement?.closest('.sat-formula,.sat-formula-error,.sat-content-image,code,pre')) continue;
      const start = offset; offset += node.textContent.length;
      result.push({node,start,end:offset});
    }
    return result;
  }

  function annotationText(container) { return textIndex(container).map(part => part.node.textContent).join(''); }

  function selectionOffset(container, node, offset) {
    if (!container.contains(node) && container !== node) throw new Error('Selection is outside the SAT content block.');
    const range = container.ownerDocument.createRange();
    range.selectNodeContents(container);
    range.setEnd(node, offset);
    return annotationText(range.cloneContents()).length;
  }

  function applyAnnotations(container, annotations, styleAnnotation) {
    // Reapplying is safe, including when a caller has updated an existing note.
    container.querySelectorAll('[data-sat-annotation]').forEach(mark => mark.replaceWith(...mark.childNodes));
    container.normalize();
    for (const {node,start,end} of textIndex(container)) {
      const overlaps = annotations.filter(a => Number.isInteger(a.start) && Number.isInteger(a.end) && a.start < end && a.end > start && a.end > a.start);
      if (!overlaps.length) continue;
      const cuts = [...new Set([start,end,...overlaps.flatMap(a => [Math.max(start,a.start),Math.min(end,a.end)])])].sort((a,b) => a-b);
      const fragment = container.ownerDocument.createDocumentFragment();
      for (let i=0; i<cuts.length-1; i++) {
        const a = cuts[i], b = cuts[i+1], layers = overlaps.filter(h => h.start <= a && h.end >= b);
        const text = container.ownerDocument.createTextNode(node.textContent.slice(a-start,b-start));
        if (!layers.length) { fragment.append(text); continue; }
        const annotation = layers.at(-1), mark = container.ownerDocument.createElement('span');
        mark.className = 'text-highlight';
        mark.dataset.satAnnotation = '';
        mark.dataset.highlightId = annotation.id;
        mark.dataset.highlightIds = layers.map(h => h.id).join(' ');
        mark.tabIndex = 0;
        mark.setAttribute('role','button');
        mark.setAttribute('aria-label',`Edit highlight: ${text.textContent}`);
        if (styleAnnotation) styleAnnotation(mark,layers);
        else {
          mark.style.backgroundColor = ({yellow:'#fff09a',blue:'#a9ddff',pink:'#ffc2df'})[annotation.color] || '#fff09a';
          if (annotation.underline && annotation.underline !== 'none') {
            mark.style.textDecorationLine = 'underline';
            mark.style.textDecorationStyle = ['solid','dotted','dashed'].includes(annotation.underline) ? annotation.underline : 'solid';
          }
        }
        mark.append(text); fragment.append(mark);
      }
      node.replaceWith(fragment);
    }
    return container;
  }

  root.SATContent = {render,plainText,markdownHTML,textIndex,annotationText,selectionOffset,textOffset:selectionOffset,applyAnnotations};
})(typeof window !== 'undefined' ? window : globalThis);
