/* Glassbody's service worker: the page works offline after one online visit
   (docs/architecture.md, section 6).

   The page's own files go network first, so every online load gets the
   server's current copy; the cache answers only when the network fails. The
   three cdnjs files are pinned versions, so they go cache first. Everything
   is precached at install.

   No wrapping function, unlike js/*.js: test/offline.spec.js reads CACHE,
   SHELL and CDN from the top level. */
'use strict';

// Change the number only when what the cache holds changes shape. A changed
// file needs no new number, because the page's own files are fetched first.
var CACHE = 'glassbody-1';

// every file the page loads from its own origin; test/offline.spec.js fails
// on a request the page makes that is in neither list
var SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/style.css',
  'fonts/fonts.css',
  'fonts/ChakraPetch-400-latin-ext.woff2',
  'fonts/ChakraPetch-400-latin.woff2',
  'fonts/ChakraPetch-500-latin-ext.woff2',
  'fonts/ChakraPetch-500-latin.woff2',
  'fonts/ChakraPetch-600-latin-ext.woff2',
  'fonts/ChakraPetch-600-latin.woff2',
  'fonts/IBMPlexSans-latin-ext.woff2',
  'fonts/IBMPlexSans-latin.woff2',
  'js/store.js',
  'js/ingest.js',
  'js/holo.js',
  'js/ui.js',
  'js/data-panel.js',
  'js/sw-register.js',
  'data/body.json',
  'data/sample.json',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png'
];

// the script tags in index.html, with the same integrity hashes; a test
// compares the two, so a library bump that misses this list fails
var CDN = [
  { url: 'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.160.1/three.min.js',
    integrity: 'sha512-vnmn/Qqn6aG0POAc9mIGzjq0IybrvxJXYDafNvp9JSnDGxeF3pbkSqLvf+YGd5ku63pT7sa/jxHn7/d0mU8+tA==' },
  { url: 'https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js',
    integrity: 'sha512-vc58qvvBdrDR4etbxMdlTt4GBQk1qjvyORR2nrsPsFPyrs+/u5c3+1Ct6upOgdZoIl7eq6k3a1UPDSNAQi/32A==' },
  { url: 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
    integrity: 'sha512-XMVd28F1oH/O71fzwBnV7HucLxVwtxf26XV8P4wPk26EDxuGZ91N8bsOttmnomcCD3CS5ZMRL50H0GgOHvegtg==' }
];

/**
 * Find the CDN entry for a URL.
 *
 * @param {string} url a request's URL
 * @returns {?{url: string, integrity: string}} its entry in CDN, or null
 */
function findCdn(url) {
  for (var i = 0; i < CDN.length; i++) if (CDN[i].url === url) return CDN[i];
  return null;
}

/**
 * Make the request for a CDN file, which the browser checks against its hash.
 *
 * @param {{url: string, integrity: string}} entry one entry of CDN
 * @returns {Request} a CORS request without cookies or a referrer, carrying the hash
 */
function makeCdnRequest(entry) {
  // the page's no-referrer meta tag does not reach the worker, which would
  // otherwise send the site's address to cdnjs
  return new Request(entry.url, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer',
    integrity: entry.integrity });
}

/**
 * Fetch one file for the precache and wait for its whole body, so a download
 * that breaks off fails here, before anything is stored.
 *
 * @param {Request} request the file to fetch
 * @returns {Promise<{request: Request, response: Response}>} rejects on a
 *   failed fetch, a failed hash or any status but 200, and so fails the install
 */
function fetchForCache(request) {
  return fetch(request).then(function (response) {
    if (response.status !== 200) throw new Error(request.url + ' answered ' + response.status);
    return response.clone().arrayBuffer().then(function () {
      return { request: request, response: response };
    });
  });
}

self.addEventListener('install', function (event) {
  var requests = SHELL.map(function (p) { return new Request(p, { cache: 'reload' }); })
    .concat(CDN.map(makeCdnRequest));
  // nothing is stored until every file has arrived in full, so a failed install
  // leaves the cache as it was, and a changed cdnjs file never enters it
  event.waitUntil(Promise.all(requests.map(fetchForCache)).then(function (fetched) {
    return caches.open(CACHE).then(function (cache) {
      return Promise.all(fetched.map(function (f) { return cache.put(f.request, f.response); }));
    });
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (names) {
    return Promise.all(names.filter(function (n) { return n !== CACHE; })
      .map(function (n) { return caches.delete(n); }));
  }).then(function () { return self.clients.claim(); }));
});

/**
 * Store a copy of a 200 response without holding up the page. Error statuses
 * and partial (206) responses are never stored.
 *
 * @param {FetchEvent} event the fetch being answered, kept alive until the copy is stored
 * @param {Request|string} key what the copy is stored under
 * @param {Response} response what the network answered
 * @returns {Response} the same response, for the page
 */
function keepCopy(event, key, response) {
  if (response.status === 200) {
    var copy = response.clone();
    event.waitUntil(caches.open(CACHE).then(function (cache) { return cache.put(key, copy); }));
  }
  return response;
}

/**
 * Answer a CDN file from the cache; on a miss, fetch it with its hash and
 * store it. These URLs are pinned versions and never change.
 *
 * @param {FetchEvent} event the page's request for the file
 * @param {{url: string, integrity: string}} entry the file's entry in CDN
 * @returns {Promise<Response>} the cached or fetched file
 */
function answerCacheFirst(event, entry) {
  return caches.match(entry.url).then(function (hit) {
    return hit || fetch(makeCdnRequest(entry)).then(function (response) {
      return keepCopy(event, entry.url, response);
    });
  });
}

/**
 * Answer a same-origin request from the server, revalidating even when GitHub
 * Pages' max-age=600 would let the browser reuse its copy. Only when the fetch
 * fails does the cache answer, and a navigation it has no copy of gets the
 * cached index.html.
 *
 * @param {FetchEvent} event the page's request
 * @returns {Promise<Response>} the server's answer, or the cached copy offline
 */
function answerNetworkFirst(event) {
  var request = event.request;
  return fetch(request, { cache: 'no-cache' }).then(function (response) {
    return keepCopy(event, request, response);
  }, function (err) {
    return caches.match(request).then(function (hit) {
      if (hit) return hit;
      if (request.mode === 'navigate') {
        return caches.match('index.html').then(function (page) {
          if (page) return page;
          throw err;
        });
      }
      throw err;
    });
  });
}

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;
  var entry = findCdn(request.url);
  if (entry) event.respondWith(answerCacheFirst(event, entry));
  else if (new URL(request.url).origin === self.location.origin) event.respondWith(answerNetworkFirst(event));
  // anything else goes to the network untouched; the page's CSP allows no other host
});
