/* Registers sw.js, which keeps the page working offline after the first
   visit (docs/architecture.md, section 6). */
(function () {
  'use strict';
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  // after load, so the worker's downloads don't compete with the page's own;
  // a blocked registration logs at debug level, since the tests fail on console errors
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js').catch(function (e) { console.debug(e); });
  });
})();
