'use strict';
// SAT-only authoring packages. Imported image bytes stay inside the browser's
// question record; no resource URL from an authoring package is fetched.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SATPack = api;
})(typeof window === 'undefined' ? globalThis : window, () => {
  const protocol = 'sat-question-pack/0.1-draft';
  const formats = {svg:'image/svg+xml',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif'};
  const defaultProfile = {id:'sat-spr-input/0.1-draft',status:'requires-rule-review',maxNonnegativeCharacters:5,maxNegativeCharacters:6,allowedForms:['integer','decimal','fraction'],allowMixedNumber:false};
  const fail = (ok, message) => { if (!ok) throw new Error(message); };
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  function shape(value, required, optional = [], context = 'object') {
    fail(object(value), `${context}: expected an object.`);
    fail(required.every(key => Object.hasOwn(value, key)), `${context}: missing required fields.`);
    const unknown = Object.keys(value).filter(key => !required.includes(key) && !optional.includes(key));
    fail(!unknown.length, `${context}: unsupported fields ${unknown.join(', ')}.`);
  }
  function text(value, context) { fail(typeof value === 'string' && !!value.trim(), `${context}: expected nonempty text.`); }
  function identifier(value, prefix, context) { fail(typeof value === 'string' && value.startsWith(prefix) && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value.slice(prefix.length)), `${context}: invalid stable identifier.`); }
  function revision(value, context) { fail(Number.isSafeInteger(value) && value > 0, `${context}: revision must be a positive safe integer.`); }
  function source(value, context) {
    shape(value, ['kind'], ['url','sourceSetId','sourceQuestionId'], context);
    Object.entries(value).forEach(([key, val]) => text(val, `${context}.${key}`));
  }
  function safePath(value, asset = false) {
    text(value, 'path');
    const parts = value.split('/');
    fail(!/[\\\x00-\x1f:%?#]/.test(value) && parts.every(part => part && part !== '.' && part !== '..'), 'path: use a safe local relative path.');
    fail(!asset || (parts.length > 1 && parts[0] === 'assets'), 'asset path must be under assets/.');
    return value;
  }
  function parseJSON(raw, context) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw new Error(`${context}: invalid JSON.`); }
    // JSON.parse silently overwrites repeated keys, including answer/source
    // fields. Walk its already validated syntax to reject those ambiguities.
    let at = 0;
    const ws = () => { while (/\s/.test(raw[at] || '') && at < raw.length) at++; };
    const string = () => { const start = at++; while (at < raw.length) { if (raw[at++] === '"') break; if (raw[at - 1] === '\\') at++; } return JSON.parse(raw.slice(start, at)); };
    const value = () => {
      ws();
      if (raw[at] === '{') {
        at++; ws(); const keys = new Set();
        while (raw[at] !== '}') { const key = string(); fail(!keys.has(key), `${context}: duplicate JSON key ${key}.`); keys.add(key); ws(); at++; value(); ws(); if (raw[at] === ',') { at++; ws(); } else break; }
        at++;
      } else if (raw[at] === '[') { at++; ws(); while (raw[at] !== ']') { value(); ws(); if (raw[at] === ',') at++; else break; } at++; }
      else if (raw[at] === '"') string();
      else { while (at < raw.length && !/[\s,}\]]/.test(raw[at])) at++; }
    };
    value();
    return parsed;
  }
  function markdown(value) {
    text(value, 'Markdown');
    fail(!/!\s*\[/.test(value), 'Markdown: use image blocks for all images.');
    fail(!/<!--|<![A-Za-z]|<\?/.test(value), 'Markdown: HTML comments and declarations are unsupported.');
    let depth = 0;
    for (const match of value.matchAll(/<\s*\/?\s*[A-Za-z][^>]*>/g)) {
      fail(match[0] === '<u>' || match[0] === '</u>', 'Markdown: only literal <u> and </u> raw HTML is allowed.');
      depth += match[0] === '<u>' ? 1 : -1;
      fail(depth >= 0, 'Markdown: unbalanced underline.');
    }
    fail(depth === 0, 'Markdown: unclosed underline.');
    fail(!/\\(?:html[A-Za-z]*|href|url|includegraphics|def|gdef|edef|newcommand|renewcommand|require)\b/i.test(value), 'LaTeX: executable macros, HTML, and external resources are unsupported.');
    fail(!/\]\s*\(\s*(?:javascript|data|vbscript|file):/i.test(value), 'Markdown: unsafe link protocol.');
  }
  function blocks(value, assetIds, empty = false) {
    fail(Array.isArray(value) && (empty || value.length > 0), 'content: expected a nonempty block array.');
    value.forEach(block => {
      fail(object(block), 'content: expected a block object.');
      if (block.type === 'markdown') { shape(block, ['type','text'], [], 'Markdown block'); markdown(block.text); }
      else if (block.type === 'image') {
        shape(block, ['type','assetId','alt'], ['role','caption'], 'image block');
        fail(assetIds.has(block.assetId), 'image: unknown assetId.'); text(block.alt, 'image.alt');
        if (block.role !== undefined) fail(['illustration','table','chart','coordinate-plane','geometry'].includes(block.role), 'image: unsupported role.');
        if (block.caption !== undefined) { text(block.caption, 'image.caption'); markdown(block.caption); }
      } else throw new Error('content: only markdown and image blocks are supported.');
    });
  }
  function inputProfile(profile) {
    shape(profile, Object.keys(defaultProfile), [], 'inputProfile');
    for (const key of Object.keys(defaultProfile)) fail(JSON.stringify(profile[key]) === JSON.stringify(defaultProfile[key]), `inputProfile: unsupported ${key}.`);
  }
  function gcd(a,b) { a = a < 0n ? -a : a; while (b) { const t = a % b; a = b; b = t; } return a || 1n; }
  function rational(literal) {
    fail(typeof literal === 'string' && /^-?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+|[0-9]+\/[0-9]+)$/.test(literal), 'SPR: enter one integer, decimal, or fraction without spaces or units.');
    const negative = literal[0] === '-', unsigned = negative ? literal.slice(1) : literal;
    let numerator, denominator;
    if (unsigned.includes('/')) { const parts = unsigned.split('/'); numerator = BigInt(parts[0]); denominator = BigInt(parts[1]); }
    else if (unsigned.includes('.')) { const parts = unsigned.split('.'); numerator = BigInt((parts[0] || '0') + parts[1]); denominator = 10n ** BigInt(parts[1].length); }
    else { numerator = BigInt(unsigned); denominator = 1n; }
    fail(denominator !== 0n, 'SPR: denominator cannot be zero.');
    if (negative) numerator = -numerator;
    const divisor = gcd(numerator, denominator);
    return `${numerator / divisor}/${denominator / divisor}`;
  }
  function validInput(value, profile = defaultProfile) {
    try {
      inputProfile(profile);
      fail(typeof value === 'string', 'SPR: response must be text.');
      const limit = value.startsWith('-') ? profile.maxNegativeCharacters : profile.maxNonnegativeCharacters;
      fail(value.length > 0 && value.length <= limit, 'SPR: character limit exceeded.');
      rational(value); return true;
    } catch { return false; }
  }
  // Editing permits unfinished numbers so users can type a minus sign, decimal
  // point or fraction separator before the following digits. Grading remains strict.
  function canEditInput(value, profile = defaultProfile) {
    try {
      inputProfile(profile);
      fail(typeof value === 'string', 'SPR: response must be text.');
      const limit = value.startsWith('-') ? profile.maxNegativeCharacters : profile.maxNonnegativeCharacters;
      return value.length <= limit && /^-?(?:[0-9]*(?:\.[0-9]*)?|[0-9]+\/[0-9]*)$/.test(value);
    } catch { return false; }
  }
  function answerRule(answer, item, pack) {
    fail(object(answer) && ['verified','needs-review','missing'].includes(answer.status), 'answer: invalid review status.');
    const spr = pack.responseType === 'student-produced-response';
    shape(answer, ['status','type'].concat(answer.status === 'missing' ? [] : spr ? ['comparison','acceptedRationals','acceptedDecimalSpellings'] : ['optionId']), [], 'answer');
    fail(answer.type === pack.responseType, 'answer: responseType mismatch.');
    if (answer.status === 'missing') return;
    if (!spr) { fail(item.options.some(option => option.id === answer.optionId), 'answer: unknown optionId.'); return; }
    fail(answer.comparison === 'exact-rational-or-listed-decimal', 'SPR: unsupported comparison.');
    const accepted = answer.acceptedRationals, decimals = answer.acceptedDecimalSpellings;
    fail(Array.isArray(accepted) && Array.isArray(decimals) && accepted.length + decimals.length > 0, 'SPR: at least one accepted value is required.');
    const seen = new Set();
    accepted.forEach(literal => {
      fail(typeof literal === 'string' && /^-?[0-9]+(?:\/[0-9]+)?$/.test(literal), 'SPR: acceptedRationals must contain integer/fraction strings.');
      const normalized = rational(literal); fail(!seen.has(normalized), 'SPR: duplicate rational values.'); seen.add(normalized);
    });
    fail(new Set(decimals).size === decimals.length, 'SPR: duplicate decimal spellings.');
    decimals.forEach(literal => fail(typeof literal === 'string' && literal.includes('.') && validInput(literal, pack.inputProfile), 'SPR: invalid listed decimal spelling.'));
  }
  function isSPR(question) { return question?.responseType === 'student-produced-response'; }
  function grade(question, state) {
    if (!question || !state) return null;
    if (isSPR(question)) {
      const response = state.numericResponse;
      if (typeof response !== 'string' || !response.length || question.answerRule?.status !== 'verified') return null;
      if (!validInput(response, question.inputProfile)) return false;
      try { const exact = rational(response); return question.answerRule.acceptedRationals.some(value => rational(value) === exact) || question.answerRule.acceptedDecimalSpellings.includes(response); }
      catch { return null; }
    }
    if (state.selectedOption === null || state.selectedOption === undefined) return null;
    if (question.answerRule && question.answerRule.status !== 'verified') return null;
    if (!Number.isInteger(question.correctOption) || question.correctOption < 0 || question.correctOption > 3) return null;
    return state.selectedOption === question.correctOption;
  }
  function plainText(content) {
    return (content || []).map(block => block.type === 'markdown' ? block.text.replace(/<\/?u>/g, '') : block.alt || '').join('\n\n');
  }
  async function digest(bytes) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join(''); }
  async function bytes(file) { return new Uint8Array(await file.arrayBuffer()); }
  function base64(data) {
    let binary = '';
    for (let at = 0; at < data.length; at += 0x8000) binary += String.fromCharCode(...data.subarray(at, at + 0x8000));
    return btoa(binary);
  }
  function safeSVG(data) {
    const raw = new TextDecoder('utf-8', {fatal:true}).decode(data);
    // A conservative static subset is validated before storing the original
    // bytes. SVG is later used only as an img source, never inserted as markup.
    fail(!/<!|<\?|&(?!(?:amp|lt|gt|quot|apos);|#\d+;|#x[0-9a-f]+;)/i.test(raw), 'SVG: declarations, entities, and processing instructions are unsupported.');
    const tags = new Set(['svg','g','path','rect','line','polyline','polygon','circle','ellipse','text','tspan','title','desc','defs','clipPath','mask','linearGradient','radialGradient','stop']);
    const attributes = new Set(['xmlns','viewBox','width','height','x','y','x1','y1','x2','y2','cx','cy','r','rx','ry','d','points','fill','fill-opacity','fill-rule','stroke','stroke-width','stroke-opacity','stroke-linecap','stroke-linejoin','stroke-dasharray','stroke-dashoffset','opacity','transform','font-family','font-size','font-weight','font-style','text-anchor','dominant-baseline','dx','dy','id','clip-path','clip-rule','mask','gradientUnits','gradientTransform','offset','stop-color','stop-opacity','preserveAspectRatio','vector-effect']);
    let last = 0, rootSeen = false, rootClosed = false;
    const stack = [];
    for (const match of raw.matchAll(/<([^<>]+)>/g)) {
      const between = raw.slice(last, match.index);
      fail(!/[<>]/.test(between) && (stack.length || !between.trim()), 'SVG: malformed or outside-root content.');
      last = match.index + match[0].length;
      const closing = match[1][0] === '/', selfClosing = /\/\s*$/.test(match[1]);
      const token = match[1].replace(/^\//, '').replace(/\/\s*$/, '');
      const name = token.match(/^([A-Za-z][A-Za-z0-9]*)\b/)?.[1];
      fail(tags.has(name), 'SVG: unsupported element.');
      if (closing) { fail(token === name && stack.pop() === name, 'SVG: malformed closing element.'); if (!stack.length) rootClosed = true; continue; }
      fail(!rootClosed, 'SVG: multiple roots are unsupported.');
      if (!rootSeen) { fail(name === 'svg', 'SVG: expected svg root.'); rootSeen = true; }
      else fail(name !== 'svg', 'SVG: nested svg roots are unsupported.');
      let attrs = token.slice(name.length), consumed = 0;
      const names = new Set();
      for (const attr of attrs.matchAll(/\s+([A-Za-z][A-Za-z0-9:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        fail(!attrs.slice(consumed, attr.index).trim(), 'SVG: malformed attribute.');
        consumed = attr.index + attr[0].length;
        const key = attr[1], val = (attr[2] ?? attr[3]).replace(/&(?:#(x[0-9a-f]+|[0-9]+)|(amp|lt|gt|quot|apos));/gi, (entity, numeric, named) => {
          if (numeric) { const point = numeric[0].toLowerCase() === 'x' ? parseInt(numeric.slice(1),16) : parseInt(numeric,10); fail(point > 0 && point <= 0x10ffff, 'SVG: invalid entity.'); return String.fromCodePoint(point); }
          return {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}[named.toLowerCase()];
        });
        fail(attributes.has(key) && !names.has(key), 'SVG: unsupported or duplicate attribute.'); names.add(key);
        fail(!/[<>]/.test(val) && !/\\|(?:javascript|data|https?|file):|@import|expression\s*\(/i.test(key === 'xmlns' ? '' : val), 'SVG: unsafe attribute value.');
        fail(key !== 'xmlns' || val === 'http://www.w3.org/2000/svg', 'SVG: unsupported namespace.');
        fail(!/url\s*\(/i.test(val) || /^url\(#[A-Za-z][A-Za-z0-9_.:-]*\)$/.test(val), 'SVG: external resource reference.');
      }
      fail(!attrs.slice(consumed).trim(), 'SVG: malformed attributes.');
      if (!selfClosing) stack.push(name); else if (name === 'svg') rootClosed = true;
    }
    fail(rootSeen && !stack.length && !raw.slice(last).trim(), 'SVG: malformed document.');
  }
  function imageType(data, mediaType) {
    const ascii = (start, end) => String.fromCharCode(...data.subarray(start, end));
    if (mediaType === 'image/svg+xml') { safeSVG(data); return; }
    const valid = mediaType === 'image/png' ? data.length >= 8 && data.slice(0,8).every((byte, i) => byte === [137,80,78,71,13,10,26,10][i]) :
      mediaType === 'image/jpeg' ? data.length >= 4 && data[0] === 255 && data[1] === 216 && data[2] === 255 :
      mediaType === 'image/gif' ? data.length >= 6 && ['GIF87a','GIF89a'].includes(ascii(0,6)) :
      mediaType === 'image/webp' ? data.length >= 12 && ascii(0,4) === 'RIFF' && ascii(8,12) === 'WEBP' : false;
    fail(valid, 'asset: bytes do not match the declared image MIME type.');
  }
  function stable(value) {
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    if (object(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
    return JSON.stringify(value);
  }
  async function readPack(manifestFile, directory, allFiles, knownHashes) {
    const result = {fileName:directory ? directory + 'pack.json' : 'pack.json',count:0,errors:[],warnings:[],questions:[],isSATPack:true};
    try {
      const rawManifest = await manifestFile.text(), pack = parseJSON(rawManifest, 'pack.json');
      shape(pack, ['schemaVersion','documentType','status','exam','id','revision','title','section','responseType','contentFormat','files','assets'], ['inputProfile'], 'pack');
      fail(pack.schemaVersion === protocol && pack.documentType === 'sat-question-pack' && pack.status === 'draft' && pack.exam === 'sat', 'pack: expected SAT draft protocol.');
      fail(pack.contentFormat === 'markdown-latex/0.1-draft', 'pack: unsupported contentFormat.');
      identifier(pack.id, 'sat:pack:', 'pack.id'); revision(pack.revision, 'pack'); text(pack.title, 'pack.title');
      fail((pack.section === 'reading-writing' && pack.responseType === 'single-choice') || (pack.section === 'math' && ['single-choice','student-produced-response'].includes(pack.responseType)), 'pack: unsupported section/responseType combination.');
      const spr = pack.responseType === 'student-produced-response';
      fail(Object.hasOwn(pack, 'inputProfile') === spr, 'pack: inputProfile belongs only to SPR packs.');
      if (spr) inputProfile(pack.inputProfile);
      shape(pack.files, ['items','solutions'], [], 'files');
      const readDocument = async (name, label) => { safePath(name); const file = allFiles.get(directory + name); fail(file, `${label}: missing file ${name}.`); return parseJSON(await file.text(), label); };
      const itemDocument = await readDocument(pack.files.items, 'items'), solutionDocument = await readDocument(pack.files.solutions, 'solutions');
      shape(itemDocument, ['items'], [], 'items document'); shape(solutionDocument, ['visibility','solutions'], [], 'solutions document');
      fail(solutionDocument.visibility === 'authoring-only', 'solutions: expected authoring-only visibility.');
      fail(Array.isArray(pack.assets), 'assets: expected array.');
      const assets = Object.create(null), assetIds = new Set(), paths = new Set();
      for (const asset of pack.assets) {
        shape(asset, ['id','path','mediaType','sha256','byteLength','source'], [], 'asset'); identifier(asset.id, '', 'asset.id'); safePath(asset.path, true); source(asset.source, 'asset.source');
        fail(!assetIds.has(asset.id) && !paths.has(asset.path), 'assets: duplicate id or path.'); assetIds.add(asset.id); paths.add(asset.path);
        const extension = asset.path.split('.').pop().toLowerCase(); fail(formats[extension] === asset.mediaType, 'asset: unsupported image MIME type or extension.');
        const file = allFiles.get(directory + asset.path); fail(file, `asset: missing file ${asset.path}.`);
        fail(!file.type || file.type === asset.mediaType, 'asset: file MIME type mismatch.');
        const data = await bytes(file); fail(Number.isSafeInteger(asset.byteLength) && asset.byteLength > 0 && data.byteLength === asset.byteLength, 'asset: byteLength mismatch.');
        fail(typeof asset.sha256 === 'string' && /^[0-9a-f]{64}$/.test(asset.sha256) && await digest(data) === asset.sha256, 'asset: sha256 mismatch.');
        imageType(data, asset.mediaType);
        assets[asset.id] = {src:`data:${asset.mediaType};base64,${base64(data)}`,mediaType:asset.mediaType,sha256:asset.sha256,byteLength:asset.byteLength};
      }
      fail(Array.isArray(itemDocument.items) && itemDocument.items.length > 0, 'items: expected a nonempty array.');
      const itemIndex = new Map();
      for (const item of itemDocument.items) {
        shape(item, ['id','revision','classification','content','prompt','source'].concat(spr ? [] : ['options']), [], 'item');
        identifier(item.id, 'sat:item:', 'item.id'); revision(item.revision, 'item'); fail(!itemIndex.has(item.id), 'items: duplicate itemId.'); itemIndex.set(item.id, item);
        shape(item.classification, ['skill'], [], 'classification'); text(item.classification.skill, 'classification.skill'); source(item.source, 'item.source');
        blocks(item.content, assetIds, true); blocks(item.prompt, assetIds);
        if (!spr) {
          fail(Array.isArray(item.options) && item.options.length === 4, 'SAT: exactly four options are required.');
          const optionIds = new Set();
          item.options.forEach(option => { shape(option, ['id','content'], [], 'option'); identifier(option.id, '', 'option.id'); fail(!optionIds.has(option.id), 'option: duplicate id.'); optionIds.add(option.id); blocks(option.content, assetIds); });
        }
      }
      result.count = itemIndex.size;
      fail(Array.isArray(solutionDocument.solutions), 'solutions: expected an array.');
      const solutions = new Map();
      for (const solution of solutionDocument.solutions) {
        shape(solution, ['itemId','itemRevision','answer','explanation','provenance'], [], 'solution');
        const item = itemIndex.get(solution.itemId); fail(item && !solutions.has(solution.itemId), 'solution: unknown or duplicate itemId.');
        revision(solution.itemRevision, 'solution.itemRevision'); fail(solution.itemRevision === item.revision, 'solution: itemRevision mismatch.'); source(solution.provenance, 'solution.provenance');
        answerRule(solution.answer, item, pack); shape(solution.explanation, ['status','content'], [], 'explanation');
        fail(['provided','needs-review','missing'].includes(solution.explanation.status), 'explanation: invalid status.');
        if (solution.explanation.status === 'missing') fail(Array.isArray(solution.explanation.content) && solution.explanation.content.length === 0, 'explanation: missing content must be empty.');
        else blocks(solution.explanation.content, assetIds);
        solutions.set(solution.itemId, solution);
      }
      fail(solutions.size === itemIndex.size, 'solutions: every item needs exactly one matching solution.');
      result.title = pack.title; result.section = pack.section === 'math' ? 'Math' : 'Reading and Writing'; result.responseType = pack.responseType;
      result.defaultDurationSeconds = pack.section === 'math' ? 2100 : 1920;
      result.packIdentity = {id:pack.id,revision:pack.revision,section:pack.section,responseType:pack.responseType};
      result.sourceId = `pack:${encodeURIComponent(pack.id)}@${pack.revision}`;
      result.contentHash = await digest(new TextEncoder().encode(stable({pack,items:itemDocument,solutions:solutionDocument})));
      fail(!knownHashes.has(result.contentHash), 'This question set has already been imported.');
      result.itemVersions = [];
      for (const item of itemDocument.items) {
        const solution = solutions.get(item.id), answer = solution.answer, opts = item.options || [];
        const references = new Set();
        [item.content,item.prompt,...opts.map(o=>o.content),solution.explanation.content].flat().forEach(block => { if (block.type === 'image') references.add(block.assetId); });
        const usedAssets = Object.fromEntries([...references].sort().map(id => [id,assets[id]]));
        const content = {content:item.content,prompt:item.prompt,options:opts,explanation:solution.explanation.content};
        result.questions.push({passage:plainText(item.content),passageFormatting:[],passageStyle:'prose',prompt:plainText(item.prompt),promptFormatting:[],options:opts.map(o=>plainText(o.content)),optionsFormatting:opts.map(()=>[]),correctOption:!spr && answer.status === 'verified' ? opts.findIndex(o=>o.id === answer.optionId) : null,questionType:item.classification.skill,originalQuestionType:item.classification.skill,explanation:plainText(solution.explanation.content),aiExplanation:'',section:result.section,responseType:pack.responseType,answerRule:answer,...(spr ? {inputProfile:pack.inputProfile} : {}),packContent:content,packAssets:usedAssets,itemId:item.id,itemRevision:item.revision,packId:pack.id,packRevision:pack.revision,packSource:item.source,explanationStatus:solution.explanation.status});
        result.itemVersions.push({itemId:item.id,itemRevision:item.revision,sha256:await digest(new TextEncoder().encode(stable({section:pack.section,responseType:pack.responseType,item,solution,assets:Object.fromEntries([...references].sort().map(id => [id,assets[id].sha256]))})))});
      }
      const unverified = result.questions.filter(q => q.answerRule.status !== 'verified').length;
      if (unverified) result.warnings.push(`${unverified} question(s) have missing or unreviewed answers and will remain ungraded.`);
      if (spr) result.warnings.push('SPR input uses the draft 5/6-character profile; it is not an official score scale.');
      return result;
    } catch (error) { result.questions = []; result.errors.push(error.message); return result; }
  }
  async function previewFiles(files, knownHashes = new Set()) {
    const allFiles = new Map(), fileErrors = [];
    for (const file of Array.from(files || [])) {
      const name = file.webkitRelativePath || file.name;
      try { safePath(name); fail(!allFiles.has(name), `Duplicate selected file path: ${name}.`); allFiles.set(name, file); }
      catch (error) { fileErrors.push(error.message); }
    }
    const manifests = [...allFiles].filter(([name]) => name === 'pack.json' || name.endsWith('/pack.json'));
    if (fileErrors.length || !manifests.length) return [{fileName:'SAT question pack',count:0,errors:fileErrors.length ? fileErrors : ['No pack.json found. Select a SAT package directory.'],warnings:[],questions:[],isSATPack:true}];
    const previews = [];
    const hashes = new Set(knownHashes), versions = new Map(), identities = new Set();
    for (const [path, file] of manifests) {
      const preview = await readPack(file, path.slice(0, -'pack.json'.length), allFiles, hashes);
      if (!preview.errors.length) {
        if (identities.has(preview.sourceId)) preview.errors.push('The same package ID and revision appears more than once.');
        for (const version of preview.itemVersions) {
          const key = version.itemId + '@' + version.itemRevision;
          const previous = versions.get(key);
          if (previous && previous.hash !== version.sha256) { preview.errors.push('Conflicting content or answer for the same item ID and revision.'); previous.preview.errors.push('Conflicting content or answer for the same item ID and revision.'); }
          else versions.set(key, {hash:version.sha256,preview});
        }
        identities.add(preview.sourceId); hashes.add(preview.contentHash);
      }
      previews.push(preview);
    }
    previews.forEach(preview => { if (preview.errors.length) preview.questions = []; });
    return previews;
  }
  return {previewFiles,isSPR,grade,validInput,canEditInput,plainText};
});
