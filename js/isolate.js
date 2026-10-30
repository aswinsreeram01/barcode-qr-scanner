/* Registers isolate-sw.js so the price reader can use several threads. The headers only
 * apply to pages the worker controls, so the first visit reloads itself once. Without
 * support the app simply stays single-threaded. */
(function () {
  'use strict';
  if (window.crossOriginIsolated || !window.isSecureContext || !navigator.serviceWorker) return;
  var KEY = 'scan.isolate.reloaded';
  function reloadOnce() {
    try {
      if (window.sessionStorage.getItem(KEY)) return;
      window.sessionStorage.setItem(KEY, '1');
    } catch (e) { return; }
    window.location.reload();
  }
  navigator.serviceWorker.addEventListener('controllerchange', reloadOnce);
  navigator.serviceWorker.register('isolate-sw.js').then(function () {
    if (navigator.serviceWorker.controller) reloadOnce();
  }).catch(function () {});
})();
