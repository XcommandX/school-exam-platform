/* Pinned MathJax is installed locally by scripts/setup_contest_mathjax.py. */
(function () {
  'use strict';
  let resolveReady;
  window.contestMathReady = new Promise(resolve => { resolveReady = resolve; });
  let started = false;
  window.startContestMath = function (available) {
    if (started) return window.contestMathReady;
    started = true;
    if (!available) { resolveReady(false); return window.contestMathReady; }
    let settled = false;
    const finish = ok => { if (!settled) { settled = true; resolveReady(ok); } };
    window.MathJax = {
      tex: {inlineMath: [['$', '$'], ['\\(', '\\)']], displayMath: [['$$', '$$'], ['\\[', '\\]']], processEscapes: true, maxBuffer: 100000, packages: {'[-]': ['require', 'autoload']}},
      svg: {fontCache: 'local'},
      loader: {load: ['ui/safe'], failed: () => finish(false)},
      options: {skipHtmlTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'], safeOptions: {allow: {URLs: 'none', classes: 'none', cssIDs: 'none', styles: 'none'}}},
      startup: {typeset: false, pageReady() { return MathJax.startup.defaultPageReady().then(() => finish(true)).catch(() => finish(false)); }}
    };
    const script = document.createElement('script');
    script.src = '/contest-vendor/mathjax/es5/tex-svg.js';
    script.onerror = () => finish(false);
    document.head.append(script);
    setTimeout(() => finish(false), 20000);
    return window.contestMathReady;
  };
})();
