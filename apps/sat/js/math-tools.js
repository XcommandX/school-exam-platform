/* SAT-only tools. No calculator, network requests, or question data are created here. */
(function (global) {
  'use strict';

  const icons = {
    expand: '<path d="M9 3H3v6m0-6 7 7m5-7h6v6m0-6-7 7M3 15v6h6m-6 0 7-7m11 1v6h-6m6 0-7-7"/>',
    restore: '<path d="M3 9h6V3m0 6L2 2m13 1v6h6m-6 0 7-7M9 21v-6H3m6 0-7 7m19-7h-6v6m0-6 7 7"/>',
    referenceExpand: '<path d="M14 3h7v7m0-7-7 7M10 21H3v-7m0 7 7-7"/>',
    referenceRestore: '<path d="M21 10h-7V3m0 7 7-7M3 14h7v7m0-7-7 7"/>',
    close: '<path d="m4 4 16 16M20 4 4 20"/>',
    plus: '<circle cx="10" cy="10" r="7.5"/><path d="m15.5 15.5 6 6M6 10h8m-4-4v8"/>',
    minus: '<circle cx="10" cy="10" r="7.5"/><path d="m15.5 15.5 6 6M6 10h8"/>'
  };
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  let nextId = 0;

  function svgIcon(name) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + icons[name] + '</svg>';
  }

  function control(label, icon, tooltip) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sat-math-tool-button';
    button.setAttribute('aria-label', label);
    if (tooltip) button.dataset.satTooltip = tooltip;
    if (icon) button.innerHTML = svgIcon(icon);
    else button.textContent = label;
    return button;
  }

  function diagram(paths, label) {
    return '<svg class="sat-reference-diagram" viewBox="0 0 180 120" role="img" aria-label="' + label + '"><g fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round">' + paths + '</g></svg>';
  }

  const text = (x, y, value, extra) => '<text x="' + x + '" y="' + y + '"' + (extra || '') + '>' + value + '</text>';
  const fraction = (top, bottom) => '<span class="sat-reference-fraction"><span>' + top + '</span><span>' + bottom + '</span></span>';
  const referenceCards = [
    {
      name: 'Circle',
      image: diagram('<circle cx="83" cy="56" r="39"/><circle cx="83" cy="56" r="3" fill="currentColor"/><path d="M83 56h39"/>' + text(99, 50, 'r'), 'Circle with radius r'),
      formula: 'A = πr<sup>2</sup><br>C = 2πr'
    },
    {
      name: 'Rectangle',
      image: diagram('<path d="M43 39h85v45H43Z"/>' + text(81, 29, 'ℓ') + text(132, 65, 'w'), 'Rectangle with length l and width w'),
      formula: 'A = ℓw'
    },
    {
      name: 'Triangle',
      image: diagram('<path d="m33 95 31-72 80 72Z"/><path d="M64 23v72" stroke-dasharray="4 3"/><path d="M64 84h11v11"/>' + text(73, 67, 'h') + text(85, 113, 'b'), 'Triangle with base b and perpendicular height h'),
      formula: 'A = ' + fraction('1', '2') + 'bh'
    },
    {
      name: 'Right triangle',
      image: diagram('<path d="M44 20v77h90Z"/><path d="M44 86h11v11"/>' + text(34, 65, 'b') + text(92, 114, 'a') + text(94, 59, 'c'), 'Right triangle with legs a and b and hypotenuse c'),
      formula: 'c<sup>2</sup> = a<sup>2</sup> + b<sup>2</sup>'
    },
    {
      name: 'Special Right Triangles',
      special: true,
      image: '<div class="sat-reference-special-diagrams">' +
        diagram('<path d="M16 93h129V18Z"/><path d="M134 93V82h11"/>' + text(50, 61, '2x') + text(151, 64, 'x') + text(64, 116, 'x√3') + text(100, 44, '60°', ' class="sat-reference-angle"') + text(40, 88, '30°', ' class="sat-reference-angle"'), '30, 60, 90 degree triangle with sides x, x square root of 3, and 2x') +
        diagram('<path d="M37 14v83h83Z"/><path d="M37 86h11v11"/>' + text(25, 66, 's') + text(78, 116, 's') + text(95, 58, 's√2') + text(41, 43, '45°', ' class="sat-reference-angle"') + text(86, 92, '45°', ' class="sat-reference-angle"'), '45, 45, 90 degree triangle with sides s, s, and s square root of 2') + '</div>',
      formula: ''
    },
    {
      name: 'Rectangular prism',
      image: diagram('<path d="M31 49h75v49H31Zm0 0 29-19h75l-29 19m0 49 29-20V30"/>' + text(63, 117, 'ℓ') + text(125, 98, 'w') + text(143, 57, 'h'), 'Rectangular prism with dimensions l, w, and h'),
      formula: 'V = ℓwh'
    },
    {
      name: 'Cylinder',
      image: diagram('<ellipse cx="82" cy="36" rx="42" ry="14"/><path d="M40 36v52c0 18 84 18 84 0V36M82 36l34-7"/><circle cx="82" cy="36" r="3" fill="currentColor"/>' + text(99, 31, 'r') + text(131, 72, 'h'), 'Cylinder with radius r and height h'),
      formula: 'V = πr<sup>2</sup>h'
    },
    {
      name: 'Sphere',
      image: diagram('<circle cx="83" cy="58" r="40"/><path d="M43 58c0 21 80 21 80 0M43 58c0-21 80-21 80 0"/><path d="M83 58h40"/><circle cx="83" cy="58" r="3" fill="currentColor"/>' + text(99, 51, 'r'), 'Sphere with radius r'),
      formula: 'V = ' + fraction('4', '3') + 'πr<sup>3</sup>'
    },
    {
      name: 'Cone',
      image: diagram('<path d="m41 94 42-85 42 85M83 9v85h42"/><ellipse cx="83" cy="94" rx="42" ry="13"/><path d="M83 84h10v10"/>' + text(89, 55, 'h') + text(106, 87, 'r'), 'Cone with radius r and perpendicular height h'),
      formula: 'V = ' + fraction('1', '3') + 'πr<sup>2</sup>h'
    },
    {
      name: 'Rectangular pyramid',
      image: diagram('<path d="m29 98 52-86 57 68-32 25Zm0 0 77 7-25-93m25 93 32-25"/><path d="M81 12v70M29 98l52-16 57-2" stroke-dasharray="4 3"/><path d="M81 72h9v10"/>' + text(90, 65, 'h') + text(67, 119, 'ℓ') + text(127, 105, 'w'), 'Rectangular pyramid with base dimensions l and w and perpendicular height h'),
      formula: 'V = ' + fraction('1', '3') + 'ℓwh'
    }
  ];

  function referenceContent() {
    const body = document.createElement('div');
    body.className = 'sat-reference-body';
    body.tabIndex = 0;
    body.setAttribute('aria-label', 'Reference formulas');
    body.innerHTML = '<div class="sat-reference-grid">' + referenceCards.map(card =>
      '<figure class="sat-reference-card' + (card.special ? ' sat-reference-special' : '') + '">' + card.image +
      (card.formula ? '<figcaption class="sat-reference-formula">' + card.formula + '</figcaption>' : '<figcaption class="sat-reference-special-title">' + card.name + '</figcaption>') + '</figure>'
    ).join('') + '</div><div class="sat-reference-facts"><p>The number of degrees of arc in a circle is 360.</p><p>The number of radians of arc in a circle is 2π.</p><p>The sum of the measures in degrees of the angles of a triangle is 180.</p></div>';
    return body;
  }

  function mountReference(host, onChange) {
    if (!host || !host.append) throw new TypeError('Reference needs a content host.');
    const panel = document.createElement('section');
    panel.className = 'sat-reference-panel';
    panel.id = 'sat-reference-' + (++nextId);
    panel.setAttribute('aria-label', 'Reference');
    panel.hidden = true;
    host.setAttribute('data-sat-math-tools-host', '');
    const header = document.createElement('header');
    header.className = 'sat-reference-header';
    const title = document.createElement('strong');
    title.textContent = 'Reference';
    const expand = control('Full Screen Reference', 'referenceExpand');
    const close = control('Close Reference', 'close');
    header.append(title, expand, close);
    panel.append(header, referenceContent());
    panel.addEventListener('keydown', event => {if (event.key !== 'Escape') event.stopPropagation();});
    host.append(panel);
    let open = false;
    let full = false;
    let returnFocus = null;
    function notify() {
      panel.hidden = !open;
      panel.classList.toggle('sat-reference-fullscreen', full);
      host.toggleAttribute('data-sat-reference-open', open);
      host.toggleAttribute('data-sat-reference-fullscreen', open && full);
      host.style.setProperty('--sat-reference-width', open && !full ? 'max(230px, var(--sat-reference-panel-width, 33%))' : '0px');
      expand.innerHTML = svgIcon(full ? 'referenceRestore' : 'referenceExpand');
      expand.setAttribute('aria-label', full ? 'Exit Full Screen Reference' : 'Full Screen Reference');
      expand.setAttribute('aria-pressed', String(full));
      if (typeof onChange === 'function') onChange({open, fullscreen: full, panel});
      host.dispatchEvent(new CustomEvent('sat-reference-change', {detail: {open, fullscreen: full}}));
    }
    function setOpen(value, options) {
      value = Boolean(value);
      if (value === open) return;
      if (value) returnFocus = document.activeElement;
      open = value;
      if (!open) full = false;
      notify();
      if (open && options && options.focus) expand.focus();
      if (!open && returnFocus && returnFocus.isConnected && panel.contains(document.activeElement)) returnFocus.focus();
    }
    function setFullscreen(value) {
      if (!open) setOpen(true);
      full = Boolean(value);
      notify();
    }
    expand.addEventListener('click', () => setFullscreen(!full));
    close.addEventListener('click', () => setOpen(false));
    const onKeydown = event => {
      if (!open || event.key !== 'Escape' || host.querySelector('.sat-image-overlay')) return;
      if (full) setFullscreen(false);
      else setOpen(false);
      event.preventDefault();
    };
    document.addEventListener('keydown', onKeydown);
    return {
      panel,
      toggle(options) { setOpen(!open, options); },
      close() { setOpen(false); },
      setOpen,
      setFullscreen,
      isOpen() { return open; },
      isFullscreen() { return full; },
      destroy() {
        document.removeEventListener('keydown', onKeydown);
        open = full = false;
        notify();
        panel.remove();
      }
    };
  }

  function makeImageView(image, fullscreen, baseSize) {
    const wrapper = document.createElement('div');
    wrapper.className = fullscreen ? 'sat-image-overlay' : 'sat-image-viewer';
    wrapper.addEventListener('keydown', event => {if (event.key !== 'Escape') event.stopPropagation();});
    const toolbar = document.createElement('div');
    toolbar.className = 'sat-image-toolbar';
    toolbar.setAttribute('role', 'group');
    toolbar.setAttribute('aria-label', 'Image controls');
    const zoomIn = control('Zoom In', 'plus', 'Zoom In');
    const zoomOut = control('Zoom Out', 'minus', 'Zoom Out');
    const percent = document.createElement('output');
    percent.className = 'sat-image-percent';
    percent.setAttribute('aria-label', 'Image size');
    const reset = control('Reset');
    const separator = document.createElement('span');
    separator.className = 'sat-image-toolbar-separator';
    separator.setAttribute('aria-hidden', 'true');
    const expand = control(fullscreen ? 'Close Full Screen Image' : 'Full Screen', fullscreen ? 'close' : 'expand', fullscreen ? 'Close' : 'Full Screen');
    toolbar.append(zoomIn, zoomOut, percent, reset, separator, expand);
    const viewport = document.createElement('div');
    viewport.className = 'sat-image-viewport';
    viewport.tabIndex = 0;
    viewport.setAttribute('aria-label', image.alt ? image.alt + '. Image viewer' : 'Image viewer');
    const bitmap = image.cloneNode(false);
    bitmap.className = 'sat-image-bitmap';
    bitmap.removeAttribute('style');
    bitmap.removeAttribute('width');
    bitmap.removeAttribute('height');
    bitmap.removeAttribute('id');
    bitmap.draggable = false;
    viewport.append(bitmap);
    wrapper.append(toolbar, viewport);
    if (fullscreen && baseSize) {
      wrapper.style.setProperty('--sat-image-base-width', baseSize.width + 'px');
      wrapper.style.setProperty('--sat-image-base-height', baseSize.height + 'px');
      wrapper.setAttribute('role', 'dialog');
      wrapper.setAttribute('aria-label', 'Full Screen Image');
    }
    let zoom = 100;
    let panX = 0;
    let panY = 0;
    let drag = null;
    let pinch = null;
    let destroyed = false;
    const touches = new Map();

    function dimensions() {
      if (fullscreen && baseSize) return baseSize;
      return {width: viewport.clientWidth, height: viewport.clientHeight};
    }
    function draw() {
      const size = dimensions();
      const extraX = fullscreen ? Math.max(0, (size.width * zoom / 100 + viewport.clientWidth) / 2 - 40) : Math.max(0, (size.width * zoom / 100 - viewport.clientWidth) / 2);
      const extraY = fullscreen ? Math.max(0, (size.height * zoom / 100 + viewport.clientHeight) / 2 - 40) : Math.max(0, (size.height * zoom / 100 - viewport.clientHeight) / 2);
      panX = clamp(panX, -extraX, extraX);
      panY = clamp(panY, -extraY, extraY);
      if (zoom <= 100) panX = panY = 0;
      bitmap.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + zoom / 100 + ')';
      percent.value = Math.round(zoom) + '%';
      percent.textContent = percent.value;
      wrapper.dataset.zoom = String(zoom);
      viewport.classList.toggle('sat-image-can-pan', zoom > 100);
      zoomIn.disabled = zoom <= 25;
      zoomOut.disabled = zoom >= 300;
    }
    function setZoom(value) {
      if (!Number.isFinite(Number(value))) return;
      zoom = clamp(Number(value), 25, 300);
      draw();
    }
    // These labels and directions deliberately follow the supplied specification.
    zoomIn.addEventListener('click', () => setZoom(zoom - 25));
    zoomOut.addEventListener('click', () => setZoom(zoom + 25));
    reset.addEventListener('click', () => {panX = panY = 0; setZoom(100);});
    viewport.addEventListener('wheel', event => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      setZoom(zoom * Math.exp(-event.deltaY * 0.008));
    }, {passive: false});
    const distance = () => {
      const points = Array.from(touches.values());
      return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
    };
    viewport.addEventListener('pointerdown', event => {
      if (event.pointerType === 'touch') {
        touches.set(event.pointerId, {x: event.clientX, y: event.clientY});
        viewport.setPointerCapture(event.pointerId);
        event.preventDefault();
        if (touches.size === 2) {
          pinch = {distance: distance(), zoom};
          drag = null;
        }
      }
      if (zoom > 100 && (event.button === 0 || event.pointerType === 'touch')) {
        if (touches.size < 2) drag = {id: event.pointerId, x: event.clientX, y: event.clientY, panX, panY};
        viewport.setPointerCapture(event.pointerId);
        viewport.classList.add('sat-image-is-panning');
        event.preventDefault();
      }
    });
    viewport.addEventListener('pointermove', event => {
      if (touches.has(event.pointerId)) touches.set(event.pointerId, {x: event.clientX, y: event.clientY});
      if (pinch && touches.size === 2) {
        setZoom(pinch.zoom * distance() / Math.max(1, pinch.distance));
        event.preventDefault();
      } else if (drag && drag.id === event.pointerId && zoom > 100) {
        panX = drag.panX + event.clientX - drag.x;
        panY = drag.panY + event.clientY - drag.y;
        draw();
      }
    });
    function endPointer(event) {
      touches.delete(event.pointerId);
      if (touches.size < 2) pinch = null;
      if (drag && drag.id === event.pointerId) drag = null;
      viewport.classList.remove('sat-image-is-panning');
    }
    viewport.addEventListener('pointerup', endPointer);
    viewport.addEventListener('pointercancel', endPointer);
    viewport.addEventListener('lostpointercapture', endPointer);
    viewport.addEventListener('keydown', event => {
      if (event.key === '+' || event.key === '=') {setZoom(zoom - 25); event.preventDefault();}
      else if (event.key === '-') {setZoom(zoom + 25); event.preventDefault();}
      else if (event.key === '0') {panX = panY = 0; setZoom(100); event.preventDefault();}
      else if (zoom > 100 && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        panX += event.key === 'ArrowLeft' ? 20 : event.key === 'ArrowRight' ? -20 : 0;
        panY += event.key === 'ArrowUp' ? 20 : event.key === 'ArrowDown' ? -20 : 0;
        draw();
        event.preventDefault();
      }
    });
    // Safari's trackpad pinch is exposed as a gesture event instead of ctrl+wheel.
    let gestureZoom = 100;
    viewport.addEventListener('gesturestart', event => {gestureZoom = zoom; event.preventDefault();});
    viewport.addEventListener('gesturechange', event => {if (Number.isFinite(event.scale)) setZoom(gestureZoom * event.scale); event.preventDefault();});
    viewport.addEventListener('gestureend', event => event.preventDefault());
    const onLoad = () => {
      const ratio = bitmap.naturalWidth / bitmap.naturalHeight;
      if (Number.isFinite(ratio) && ratio > 0) viewport.style.setProperty('--sat-image-ratio', String(ratio));
      draw();
    };
    bitmap.addEventListener('load', onLoad);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(draw) : null;
    if (observer) observer.observe(viewport);
    if (bitmap.complete) onLoad();
    draw();
    return {
      wrapper, viewport, bitmap, expand, setZoom,
      getZoom() {return zoom;},
      getPan() {return {x: panX, y: panY};},
      destroy() {
        if (destroyed) return;
        destroyed = true;
        if (observer) observer.disconnect();
        wrapper.remove();
      }
    };
  }

  function createImage(options) {
    options = options || {};
    const original = options.image || document.createElement('img');
    if (!options.image) {
      original.src = String(options.src || '');
      original.alt = String(options.alt || '');
    }
    const figure = document.createElement('figure');
    figure.className = 'sat-question-figure';
    const inline = makeImageView(original, false);
    figure.append(inline.wrapper);
    if (options.caption) {
      const caption = document.createElement('figcaption');
      caption.textContent = String(options.caption);
      figure.append(caption);
    }
    let full = null;
    let observer = null;
    function closeFullscreen() {
      if (!full) return;
      full.destroy();
      full = null;
      document.removeEventListener('keydown', onEscape, true);
      if (observer) observer.disconnect();
      observer = null;
      if (figure.isConnected) inline.expand.focus();
    }
    function onEscape(event) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      closeFullscreen();
    }
    function openFullscreen() {
      if (full) return;
      const host = options.overlayHost || figure.closest('[data-sat-math-content]') || figure.closest('#questionView') || figure.parentElement;
      if (!host) return;
      // Only one question image is expanded at a time, even when a prompt has several.
      host.querySelectorAll('.sat-image-overlay').forEach(element => {if (element.satImageClose) element.satImageClose();});
      const rect = inline.viewport.getBoundingClientRect();
      full = makeImageView(original, true, {width: Math.max(1, rect.width), height: Math.max(1, rect.height)});
      full.wrapper.satImageClose = closeFullscreen;
      host.append(full.wrapper);
      full.expand.addEventListener('click', closeFullscreen);
      document.addEventListener('keydown', onEscape, true);
      full.expand.focus();
      if (typeof MutationObserver === 'function') {
        observer = new MutationObserver(() => {if (!figure.isConnected) closeFullscreen();});
        observer.observe(document.body, {childList: true, subtree: true});
      }
    }
    inline.expand.addEventListener('click', openFullscreen);
    figure.satImageViewer = {
      getZoom: inline.getZoom,
      setZoom: inline.setZoom,
      getPan: inline.getPan,
      openFullscreen,
      closeFullscreen,
      isFullscreen() {return Boolean(full);},
      destroy() {closeFullscreen(); inline.destroy(); figure.remove();}
    };
    return figure;
  }

  function attachImages(root, options) {
    if (!root) return [];
    const viewers = [];
    root.querySelectorAll('img').forEach(img => {
      if (img.closest('.sat-question-figure, .sat-reference-panel')) return;
      const figure = createImage(Object.assign({}, options || {}, {image: img}));
      img.replaceWith(figure);
      viewers.push(figure.satImageViewer);
    });
    return viewers;
  }

  function destroyImages(root) {
    if (root) root.querySelectorAll('.sat-question-figure').forEach(figure => figure.satImageViewer && figure.satImageViewer.destroy());
  }

  function mountBattery(host) {
    if (!host || !host.append) throw new TypeError('Battery status needs a host.');
    const display = document.createElement('span');
    display.className = 'sat-battery-status';
    display.setAttribute('role', 'img');
    display.innerHTML = '<span class="sat-battery-percent"></span><svg viewBox="0 0 29 16" aria-hidden="true"><rect x="1" y="2" width="24" height="12" rx="1.6"/><path d="M27 6v4"/><rect class="sat-battery-fill" x="3" y="4" width="0" height="8" rx=".5"/><path class="sat-battery-bolt" d="m15 1-6 8h5l-1 6 7-9h-6Z"/><text class="sat-battery-unknown" x="13" y="12" text-anchor="middle">?</text></svg>';
    host.append(display);
    let battery = null;
    let destroyed = false;
    function render() {
      if (destroyed) return;
      const known = battery && Number.isFinite(battery.level);
      const percent = known ? Math.round(clamp(battery.level, 0, 1) * 100) : null;
      const charging = Boolean(known && battery.charging);
      display.classList.toggle('sat-battery-known', Boolean(known));
      display.classList.toggle('sat-battery-charging', charging);
      display.querySelector('.sat-battery-percent').textContent = known ? percent + '%' : '';
      display.querySelector('.sat-battery-fill').setAttribute('width', known ? String(20 * percent / 100) : '0');
      const label = known ? 'Battery ' + percent + '%' + (charging ? ', charging' : ', not charging') : 'Battery status unavailable';
      display.setAttribute('aria-label', label);
      display.title = label;
    }
    render();
    if (global.navigator && typeof global.navigator.getBattery === 'function') {
      Promise.resolve().then(() => global.navigator.getBattery()).then(value => {
        if (destroyed) return;
        battery = value;
        battery.addEventListener('levelchange', render);
        battery.addEventListener('chargingchange', render);
        render();
      }).catch(() => {battery = null; render();});
    }
    return {
      element: display,
      destroy() {
        destroyed = true;
        if (battery) {battery.removeEventListener('levelchange', render); battery.removeEventListener('chargingchange', render);}
        display.remove();
      }
    };
  }

  global.SATMathTools = {mountReference, createImage, attachImages, destroyImages, mountBattery};
})(typeof window !== 'undefined' ? window : globalThis);
