// Static servers for test/offline.spec.js: one for a copy of the site, one standing
// in for cdnjs. The tests can change what they serve, and stop them: a stopped server
// refuses connections, which is how the tests go offline without Playwright routing
// the service worker's requests (docs/specs/glassbody-v1.md, section 2.6).
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

/**
 * Read the file a request path names inside dir.
 *
 * @param {string} dir the folder being served, an absolute path
 * @param {string} urlPath the request's path, still URL-encoded
 * @param {boolean} flat look up only the path's last segment
 * @returns {{file: string, body: Buffer}|null} the file and its bytes, or null when
 *   the path leaves dir or names no file
 */
function readServedFile(dir, urlPath, flat) {
  const decoded = decodeURIComponent(urlPath);
  const rel = flat ? path.basename(decoded) : decoded.replace(/\/$/, '/index.html');
  const file = path.join(dir, rel);
  if (!file.startsWith(dir + path.sep)) return null;
  try {
    return { file, body: fs.readFileSync(file) };
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'EISDIR') return null;
    throw e;
  }
}

/**
 * Serve the files in one folder on 127.0.0.1, on a port the system picks.
 *
 * Each file is read again on every request, so a test can change it between loads.
 * Responses carry `Cache-Control: max-age=600`, as GitHub Pages sends, and an ETag
 * that a matching If-None-Match turns into a 304, so the browser's HTTP cache would
 * hand back an old copy unless the service worker asks it to revalidate.
 *
 * @param {string} dir the folder to serve; `/` is its index.html
 * @param {object} [options]
 * @param {boolean} [options.cors] add `Access-Control-Allow-Origin: *`, as cdnjs does
 * @param {boolean} [options.flat] serve every path by its last segment, so
 *   `/ajax/libs/d3/7.9.0/d3.min.js` is `d3.min.js` in dir
 * @param {boolean} [options.noStore] send `Cache-Control: no-store` instead of
 *   max-age=600, so the browser asks the server every time
 * @returns {Promise<{origin: string, requests: {path: string, headers: object}[],
 *   stop: function(): Promise<void>}>} the server's origin, every request it received
 *   with its headers (names in lower case, as Node gives them), and a stop that closes
 *   it and every open connection
 */
async function serveFolder(dir, { cors = false, flat = false, noStore = false } = {}) {
  const root = path.resolve(dir);
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ path: req.url, headers: req.headers });
    let found;
    try {
      found = readServedFile(root, new URL(req.url, 'http://x').pathname, flat);
    } catch (e) {
      // a throw here would take down the test run; the page sees a 500 instead
      res.writeHead(500, { 'content-type': 'text/plain' }).end(String(e));
      return;
    }
    if (!found) {
      res.writeHead(404).end();
      return;
    }
    const { file, body } = found;
    const etag = '"' + crypto.createHash('sha1').update(body).digest('hex') + '"';
    const headers = {
      'cache-control': noStore ? 'no-store' : 'max-age=600',
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      etag,
    };
    if (cors) headers['access-control-allow-origin'] = '*';
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers).end();
      return;
    }
    res.writeHead(200, headers).end(body);
  });
  await new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', ok);
  });
  return {
    origin: 'http://127.0.0.1:' + server.address().port,
    requests,
    // a second stop finds the server closed already, and resolves all the same
    stop: () => new Promise((ok) => {
      server.close(() => ok());
      server.closeAllConnections();
    }),
  };
}

module.exports = { serveFolder };
