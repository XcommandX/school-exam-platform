/* Optional component browser checks; only original SVG data and a mocked battery are used. */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '../../front-end/sat');
const server = http.createServer(async (req, res) => {
  try {
    const relative = new URL(req.url, 'http://localhost').pathname;
    if (relative === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/css/math-tools.css"><style>body{margin:0;font-family:Arial}#host{position:relative;height:700px;margin-top:100px;background:white}#question{padding:30px;width:55%}#battery{position:absolute;right:20px;top:20px}#ref{margin:20px}</style><div id="battery"></div><button id="ref">Reference</button><main id="host" data-sat-math-content><div id="question"></div></main><script src="/js/math-tools.js"></script>');
      return;
    }
    const absolute = path.resolve(root, '.' + relative);
    if (!absolute.startsWith(root + path.sep)) throw new Error('invalid path');
    const bytes = await fs.readFile(absolute);
    res.setHeader('Content-Type', absolute.endsWith('.js') ? 'text/javascript' : 'text/css');
    res.end(bytes);
  } catch {
    res.statusCode = 404;
    res.end('missing');
  }
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? {executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE} : {channel: 'chrome'})});
  try {
    const context = await browser.newContext({viewport: {width: 1440, height: 900}});
    await context.addInitScript(() => {
      const battery = new EventTarget();
      battery.level = 0.73;
      battery.charging = true;
      window.syntheticBattery = battery;
      Object.defineProperty(navigator, 'getBattery', {configurable: true, value: () => Promise.resolve(battery)});
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.evaluate(() => {
      window.changes = [];
      window.reference = SATMathTools.mountReference(document.querySelector('#host'), state => changes.push({open: state.open, fullscreen: state.fullscreen}));
      document.querySelector('#ref').addEventListener('click', () => reference.toggle());
      window.battery = SATMathTools.mountBattery(document.querySelector('#battery'));
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300"><rect width="300" height="300" fill="white"/><path d="M30 150h240M150 30v240M30 240l240-180" stroke="black" fill="none" stroke-width="2"/><text x="265" y="170">x</text><text x="160" y="40">y</text></svg>';
      const image = SATMathTools.createImage({src: 'data:image/svg+xml,' + encodeURIComponent(svg), alt: 'Original synthetic coordinate graph', overlayHost: document.querySelector('#host')});
      document.querySelector('#question').append(image);
      window.viewer = image.satImageViewer;
    });
    const inline = page.locator('.sat-image-viewer');
    await page.locator('.sat-image-bitmap').evaluate(image => image.decode());
    assert.equal(await page.locator('.sat-battery-percent').innerText(), '73%');
    assert.equal(await page.locator('.sat-battery-status').getAttribute('aria-label'), 'Battery 73%, charging');
    await page.evaluate(() => {syntheticBattery.level = 0.54; syntheticBattery.charging = false; syntheticBattery.dispatchEvent(new Event('levelchange')); syntheticBattery.dispatchEvent(new Event('chargingchange'));});
    assert.equal(await page.locator('.sat-battery-percent').innerText(), '54%');
    assert.equal(await page.locator('.sat-battery-status').getAttribute('aria-label'), 'Battery 54%, not charging');

    await page.locator('#ref').click();
    assert.equal(await page.locator('.sat-reference-panel').isVisible(), true);
    assert.equal(await page.locator('.sat-reference-card').count(), 10);
    assert.match(await page.locator('.sat-reference-facts').innerText(), /circle is 360/);
    const panel = await page.locator('.sat-reference-panel').boundingBox();
    assert.ok(Math.abs(panel.width - 1440 * 0.33) < 2);
    await page.getByRole('button', {name: 'Full Screen Reference', exact: true}).click();
    assert.equal(await page.evaluate(() => reference.isFullscreen()), true);
    assert.equal(Math.round((await page.locator('.sat-reference-panel').boundingBox()).width), 1440);
    await page.screenshot({path: path.join(os.tmpdir(), 'sat-math-reference-full.png')});
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => reference.isFullscreen()), false);
    assert.equal(await page.evaluate(() => reference.isOpen()), true);

    // The requested button behavior is intentionally reversed from usual zoom naming.
    await inline.getByRole('button', {name: 'Zoom In', exact: true}).click();
    assert.equal(await inline.locator('output').innerText(), '75%');
    await inline.getByRole('button', {name: 'Zoom Out', exact: true}).click();
    await inline.getByRole('button', {name: 'Zoom Out', exact: true}).click();
    assert.equal(await inline.locator('output').innerText(), '125%');
    const viewport = inline.locator('.sat-image-viewport');
    assert.equal(await viewport.evaluate(element => getComputedStyle(element).cursor), 'grab');
    const box = await viewport.boundingBox();
    await page.mouse.move(box.x + 90, box.y + 90);
    await page.mouse.down();
    assert.equal(await viewport.evaluate(element => getComputedStyle(element).cursor), 'grabbing');
    await page.mouse.move(box.x + 115, box.y + 105);
    await page.mouse.up();
    assert.ok((await page.evaluate(() => viewer.getPan())).x > 0);
    await inline.getByRole('button', {name: 'Reset', exact: true}).click();
    assert.equal(await inline.locator('output').innerText(), '100%');
    assert.deepEqual(await page.evaluate(() => viewer.getPan()), {x: 0, y: 0});
    assert.equal(await inline.getByRole('button', {name: 'Reset', exact: true}).getAttribute('data-sat-tooltip'), null);
    await page.evaluate(() => viewer.setZoom(999));
    assert.equal(await inline.locator('output').innerText(), '300%');
    assert.equal(await inline.getByRole('button', {name: 'Zoom Out', exact: true}).isDisabled(), true);
    await page.evaluate(() => viewer.setZoom(-999));
    assert.equal(await inline.locator('output').innerText(), '25%');
    assert.equal(await inline.getByRole('button', {name: 'Zoom In', exact: true}).isDisabled(), true);
    await inline.getByRole('button', {name: 'Reset', exact: true}).click();
    await viewport.dispatchEvent('wheel', {deltaY: -10, ctrlKey: true, cancelable: true});
    const gestureZoom = await page.evaluate(() => viewer.getZoom());
    assert.ok(gestureZoom > 100 && gestureZoom < 125);
    await inline.getByRole('button', {name: 'Full Screen', exact: true}).click();
    const overlay = page.locator('.sat-image-overlay');
    assert.equal(await overlay.locator('output').innerText(), '100%');
    const overlayBox = await overlay.boundingBox();
    assert.ok(Math.abs(overlayBox.width + panel.width - 1440) < 2);
    assert.equal(await page.locator('.sat-reference-panel').isVisible(), true);
    await overlay.getByRole('button', {name: 'Zoom Out', exact: true}).click();
    const fullViewport = overlay.locator('.sat-image-viewport');
    const fullBox = await fullViewport.boundingBox();
    await page.mouse.move(fullBox.x + fullBox.width / 2, fullBox.y + 200);
    await page.mouse.down();
    await page.mouse.move(fullBox.x + fullBox.width / 2 + 50, fullBox.y + 225);
    await page.mouse.up();
    assert.match(await overlay.locator('.sat-image-bitmap').getAttribute('style'), /translate\(50px,\s*25px\)/);
    await page.screenshot({path: path.join(os.tmpdir(), 'sat-math-tools-desktop.png')});
    await page.keyboard.press('Escape');
    assert.equal(await overlay.count(), 0);
    assert.equal(await page.evaluate(() => viewer.getZoom()), gestureZoom);
    assert.equal(await page.evaluate(() => reference.isOpen()), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => reference.isOpen()), false);
    await page.setViewportSize({width: 390, height: 850});
    await page.locator('#ref').click();
    assert.equal(Math.round((await page.locator('.sat-reference-panel').boundingBox()).width), 390);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({path: path.join(os.tmpdir(), 'sat-math-tools-narrow.png')});
    await page.evaluate(() => {battery.destroy(); Object.defineProperty(navigator, 'getBattery', {configurable: true, value: undefined}); window.battery = SATMathTools.mountBattery(document.querySelector('#battery'));});
    assert.equal(await page.locator('.sat-battery-status').getAttribute('aria-label'), 'Battery status unavailable');
    assert.equal(await page.locator('.sat-battery-percent').innerText(), '');
    await page.evaluate(() => {reference.close(); viewer.openFullscreen(); document.querySelector('.sat-question-figure').remove();});
    await page.waitForFunction(() => !document.querySelector('.sat-image-overlay'));
    assert.deepEqual(errors, []);
    console.log('PASS: Reference contents, layouts and Escape; zoom limits, exact steps, reset, pan and trackpad wheel; independent full-screen image and reference; battery updates/unavailable; narrow layout and cleanup.');
    await context.close();
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
