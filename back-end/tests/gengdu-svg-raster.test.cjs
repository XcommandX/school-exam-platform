/* Original synthetic SVGs only; no question bank or existing browser profile. */
'use strict';
const assert = require('node:assert/strict');
const {rasterize, isolatedPage, launchBrowser} = require('../tools/sat/prepare_gengdu_svg_assets.cjs');

(async () => {
  const browser = await launchBrowser();
  const {context, page, requests} = await isolatedPage(browser);
  const svg = body => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60">' + body + '</svg>');
  try {
    const result = await rasterize(page, svg('<style>.line{fill:none;stroke:#000;stroke-width:2}</style><path class="line" d="M10 40L60 10"/><text x="10" y="55">x</text>'));
    assert.equal(result.width, 80); assert.equal(result.height, 60);
    assert.ok(result.visiblePixels > 0 && result.darkPixels > 0);
    assert.ok(Buffer.from(result.base64, 'base64').subarray(0, 8).equals(Buffer.from('\x89PNG\r\n\x1a\n', 'latin1')));
    const rejected = [
      ['script', '<script>alert(1)</script>'],
      ['event', '<rect width="60" height="40" onclick="alert(1)"/>'],
      ['remote image', '<image width="30" height="30" href="https://example.invalid/test.png"/>'],
      ['nested SVG data image', '<image href="data:image/svg+xml,%3Csvg%3E"/>'],
      ['foreign document', '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">unsafe</div></foreignObject>'],
      ['animation', '<animate attributeName="x" to="5"/>'],
      ['CSS import', '<style>@import url(https://example.invalid/a.css);</style>'],
      ['CSS remote paint', '<style>.x{fill:url(https://example.invalid/a.svg)}</style><rect class="x"/>'],
      ['CSS escaped identifier', '<style>.x{f\\69ll:red}</style><rect class="x"/>'],
      ['remote font', '<style>@font-face{font-family:test;src:url(https://example.invalid/a.ttf)}</style>'],
      ['invalid embedded PNG', '<image href="data:image/png;base64,AAAAAAAAAAAA"/>'],
      ['empty drawing', '<rect fill="white" width="80" height="60"/>'],
      ['transparent drawing', '<rect fill="none" width="80" height="60"/>']
    ];
    for (const [label, body] of rejected) await assert.rejects(rasterize(page, svg(body)), undefined, label);
    await assert.rejects(rasterize(page, Buffer.from('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///private/example">]><svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"/>')));
    await assert.rejects(rasterize(page, Buffer.from('<?unsafe processing?><svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"/>')));
    assert.deepEqual(requests, [], 'untrusted content must not attempt a network request');
    console.log('SVG raster: original rendering and 15 active/invalid/empty source rejections passed; no network requests.');
  } finally { await context.close(); await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
