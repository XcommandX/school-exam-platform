#!/usr/bin/env node
/* Local, offline SVG derivatives. Source bytes are validated and never rewritten. */
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {chromium} = require('playwright');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function rasterize(page, bytes) {
  if (bytes.length > 4 * 1024 * 1024) throw Error('SVG exceeds local raster limit');
  const svg = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(svg)) throw Error('XML entities and doctypes are forbidden');
  const withoutXmlHeader = svg.replace(/^\s*<\?xml\s[^?]*\?>/i, '');
  if (/<\?/.test(withoutXmlHeader)) throw Error('Unsupported XML processing instruction');
  return page.evaluate(async svg => {
    const fail = message => { throw Error(message); };
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    if (doc.querySelector('parsererror')) fail('Invalid SVG XML');
    const root = doc.documentElement;
    if (root.namespaceURI !== 'http://www.w3.org/2000/svg' || root.localName !== 'svg') fail('Expected SVG root');
    const tags = new Set(['svg', 'g', 'defs', 'style', 'text', 'tspan', 'path', 'line', 'polyline', 'polygon', 'rect', 'circle', 'ellipse', 'title', 'desc', 'image']);
    const attrs = new Set(['xmlns', 'xmlns:xlink', 'xmlns:wrs', 'id', 'data-name', 'class', 'version', 'xml:space', 'style', 'wrs:baseline',
      'viewBox', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points',
      'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin',
      'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'opacity', 'transform', 'font-family', 'font-size',
      'font-weight', 'font-style', 'text-anchor', 'dominant-baseline', 'dx', 'dy', 'preserveAspectRatio', 'vector-effect', 'type', 'href', 'xlink:href']);
    const cssProperties = new Set(['fill', 'stroke', 'stroke-width', 'stroke-miterlimit', 'font-family', 'font-weight', 'font-style',
      'isolation', 'enable-background', 'font-size', 'opacity', 'fill-opacity', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin']);
    const embedded = [];
    const inspectData = (value, kind) => {
      const pattern = kind === 'font'
        ? /^data:font\/truetype;charset=utf-8;base64,([A-Za-z0-9+/]+={0,2})$/i
        : /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/i;
      const match = pattern.exec(value);
      if (!match) fail('Only explicit embedded PNG/TrueType resources are supported');
      let decoded;
      try { decoded = atob(match[1]); } catch { fail('Invalid embedded base64'); }
      if (decoded.length > 2 * 1024 * 1024 || decoded.length < 8) fail('Embedded resource size outside limits');
      if (kind === 'image' && !decoded.startsWith('\x89PNG\r\n\x1a\n')) fail('Embedded PNG signature mismatch');
      if (kind === 'font' && decoded.slice(0, 4) !== '\x00\x01\x00\x00') fail('Embedded TrueType signature mismatch');
      embedded.push({kind, byteLength: decoded.length});
    };
    const checkDeclaration = (declaration, fontFace = false) => {
      for (const property of declaration) {
        const value = declaration.getPropertyValue(property);
        if (fontFace && property === 'src') {
          const source = /^url\(["']?(data:font\/truetype;charset=utf-8;base64,[A-Za-z0-9+/]+={0,2})["']?\)\s*format\(["']truetype["']\)$/i.exec(value);
          if (!source) fail('Unsupported embedded font source');
          inspectData(source[1], 'font');
        } else {
          if (!cssProperties.has(property)) fail('Unsupported CSS property: ' + property);
          if (/url\s*\(|(?:javascript|data|https?|file):|@|expression\s*\(|\\/i.test(value)) fail('External or active CSS value');
        }
      }
    };
    let cssRuleCount = 0;
    for (const element of doc.querySelectorAll('*')) {
      if (element.namespaceURI !== 'http://www.w3.org/2000/svg' || !tags.has(element.localName)) fail('Unsupported SVG element: ' + element.localName);
      for (const attr of element.attributes) {
        if (/^on/i.test(attr.name) || !attrs.has(attr.name)) fail('Unsupported SVG attribute: ' + attr.name);
        if (attr.name.startsWith('xmlns')) continue;
        if (attr.localName === 'href') {
          if (element.localName !== 'image') fail('SVG links are not supported');
          inspectData(attr.value, 'image');
        } else if (attr.name === 'style') {
          if (/\\|@import|expression\s*\(|(?:javascript|https?|file):/i.test(attr.value)) fail('Active inline CSS');
          const test = document.createElement('span'); test.setAttribute('style', attr.value); checkDeclaration(test.style);
        } else if (/url\s*\(|(?:javascript|data|https?|file):|\\/i.test(attr.value)) fail('External or active SVG value');
      }
      if (element.localName === 'style') {
        const css = element.textContent;
        if (/\\|@import|expression\s*\(|(?:javascript|https?|file):/i.test(css)) fail('Active stylesheet');
        const sheet = new CSSStyleSheet(); sheet.replaceSync(css);
        for (const rule of sheet.cssRules) {
          cssRuleCount++;
          if (rule.type === CSSRule.STYLE_RULE) {
            if (!/^\.[A-Za-z][A-Za-z0-9_-]*(?:\s*,\s*\.[A-Za-z][A-Za-z0-9_-]*)*$/.test(rule.selectorText)) fail('Unsupported source CSS selector');
            checkDeclaration(rule.style);
          } else if (rule.type === CSSRule.FONT_FACE_RULE) checkDeclaration(rule.style, true);
          else fail('Unsupported CSS rule');
        }
      }
    }
    const viewBox = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    const dimension = (name, fallback) => {
      const value = root.getAttribute(name);
      const result = value && /^\d+(?:\.\d+)?(?:px)?$/.test(value) ? parseFloat(value) : fallback;
      if (!(result > 0 && result <= 4096)) fail('Unsupported SVG dimensions');
      return Math.ceil(result);
    };
    const width = dimension('width', viewBox.length === 4 ? viewBox[2] : NaN);
    const height = dimension('height', viewBox.length === 4 ? viewBox[3] : NaN);
    if (width * height > 12 * 1024 * 1024) fail('SVG raster area exceeds limit');
    const image = new Image();
    image.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
    await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data;
    let visiblePixels = 0, darkPixels = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] > 16) {
      visiblePixels++;
      if (pixels[i] + pixels[i + 1] + pixels[i + 2] < 650) darkPixels++;
    }
    if (!visiblePixels || !darkPixels) fail('Raster is empty or has no visible dark content');
    return {base64: canvas.toDataURL('image/png').split(',')[1], width, height, visiblePixels, darkPixels, cssRuleCount, embedded};
  }, svg);
}

async function launchBrowser() {
  return chromium.launch({headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? {executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE} : {channel: 'chrome'})});
}

async function isolatedPage(browser) {
  const context = await browser.newContext({serviceWorkers: 'block', offline: true});
  const requests = [];
  await context.route('**/*', route => { requests.push(route.request().url()); return route.abort('blockedbyclient'); });
  const page = await context.newPage();
  await page.setContent('<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data: blob:; font-src data:; style-src \'unsafe-inline\'">');
  return {context, page, requests};
}

async function prepare(archive, output) {
  archive = path.resolve(archive); output = path.resolve(output);
  const inventory = JSON.parse(await fs.readFile(path.join(archive, '图片清单.json'), 'utf8'));
  const originals = inventory.images.filter(item => item.local_path && item.local_path.endsWith('.svg'));
  const browser = await launchBrowser();
  const {context, page, requests} = await isolatedPage(browser);
  const entries = [];
  try {
    await fs.mkdir(output, {recursive: true});
    for (const item of originals) {
      if (!/^assets\/[a-f0-9]{64}\.svg$/.test(item.local_path)) throw Error('Unsafe declared SVG path');
      const sourceFile = path.join(archive, item.local_path);
      const sourceBytes = await fs.readFile(sourceFile);
      const originalSha256 = digest(sourceBytes);
      if (originalSha256 !== item.sha256) throw Error('Original SVG digest mismatch');
      const result = await rasterize(page, sourceBytes);
      const bytes = Buffer.from(result.base64, 'base64');
      const pngPath = originalSha256 + '.png';
      await fs.writeFile(path.join(output, pngPath), bytes);
      const {base64, ...validation} = result;
      entries.push({originalSha256, originalSourceUrls: [item.source_url], originalPath: item.local_path,
        pngPath, sha256: digest(bytes), byteLength: bytes.length, mediaType: 'image/png',
        method: 'validated-svg-image-context-to-canvas-png', ...validation});
    }
    if (requests.length) throw Error('Unexpected attempted network request: ' + requests.join(', '));
    const manifest = {schemaVersion: 'gengdu-svg-raster-cache/1', generatedAt: new Date().toISOString(),
      browserVersion: browser.version(), sourceModified: false, networkRequests: requests, entries};
    await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    return manifest;
  } finally { await context.close(); await browser.close(); }
}

module.exports = {rasterize, isolatedPage, launchBrowser, prepare};
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args.includes('--help')) {
    console.log('Usage: node back-end/tools/sat/prepare_gengdu_svg_assets.cjs <archive-directory> <output-cache-directory>');
    process.exit(args.includes('--help') ? 0 : 2);
  }
  prepare(...args).then(result => console.log(JSON.stringify({svgCount: result.entries.length, output: path.resolve(args[1]), networkRequests: result.networkRequests.length})))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
