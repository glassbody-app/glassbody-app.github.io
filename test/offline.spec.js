// The service worker (docs/specs/glassbody-v1.md, sections 2.3 and 2.6). This is the
// only file that lets the page register a service worker. It does not use the suite's Python
// server: test/serve.js serves a copy of the site and a stand-in for cdnjs, so a test
// can change a file, serve a tampered library, or stop both servers to go offline.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { serveFolder } = require('./serve');

const ROOT = path.join(__dirname, '..');
const SUMMED = path.join(ROOT, 'test/fixtures/sample-summed.zip');
const CDN_ORIGIN = 'https://cdnjs.cloudflare.com';
// what .github/workflows/pages.yml copies into the site (docs/specs/glassbody-v1.md,
// section 5.5); a test below compares the two. The page loads nothing from img/.
const SITE_FILES = ['index.html', 'manifest.webmanifest', 'sw.js', 'css', 'js', 'fonts', 'icons',
  'img', 'data/body.json', 'data/sample.json'];

test.use({ serviceWorkers: 'allow' });

/**
 * Read the cache name and the two precache lists from a copy of sw.js, run in
 * Node's vm with a `self` that ignores its listeners.
 *
 * @param {string} file the sw.js to read
 * @returns {{CACHE: string, SHELL: string[], CDN: {url: string, integrity: string}[]}}
 */
function readWorkerLists(file) {
  const context = vm.createContext({ self: { addEventListener() {} } });
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  return JSON.parse(vm.runInContext('JSON.stringify({ CACHE: CACHE, SHELL: SHELL, CDN: CDN })', context));
}

/**
 * Replace text in a file, and fail if the text is not there.
 *
 * @param {string} file the file to change
 * @param {string} from the text to find
 * @param {string} to what replaces every copy of it
 */
function editFile(file, from, to) {
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes(from)) throw new Error(`${file} does not contain ${from}`);
  fs.writeFileSync(file, text.split(from).join(to));
}

const started = [];

/**
 * Copy the site into a temporary folder with cdnjs swapped for a stand-in, and
 * serve both. The stand-in serves a copy of vendor/.
 *
 * @param {object} [options]
 * @param {function(string): void} [options.tamper] changes the stand-in's folder
 *   before it is served
 * @param {boolean} [options.cdnNoStore] the stand-in sends `Cache-Control: no-store`,
 *   so every request for a library reaches it
 * @returns {Promise<{url: string, dir: string, tmp: string, cdnRequests: object[],
 *   stop: function(): Promise<void>}>} the site's address, the folder it is served
 *   from, the temporary folder that holds both copies, every request the stand-in
 *   for cdnjs received (see serveFolder), and a stop for both servers
 */
async function startSite({ tamper, cdnNoStore = false } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glassbody-offline-'));
  const libs = path.join(tmp, 'cdn'), dir = path.join(tmp, 'site');
  const servers = [];
  const site = {
    url: null,
    dir,
    tmp,
    stop: () => Promise.all(servers.map((s) => s.stop())).then(() => {}),
  };
  // listed first, so afterEach stops what started and removes tmp even if a step below throws
  started.push(site);
  fs.cpSync(path.join(ROOT, 'vendor'), libs, { recursive: true });
  if (tamper) tamper(libs);
  for (const f of SITE_FILES) fs.cpSync(path.join(ROOT, f), path.join(dir, f), { recursive: true });
  const cdn = await serveFolder(libs, { cors: true, flat: true, noStore: cdnNoStore });
  servers.push(cdn);
  site.cdnRequests = cdn.requests;
  const web = await serveFolder(dir);
  servers.push(web);
  site.url = web.origin + '/';
  // the script tags, the CSP's script-src and the worker's CDN list all name cdnjs
  for (const f of ['index.html', 'sw.js']) editFile(path.join(dir, f), CDN_ORIGIN, cdn.origin);
  return site;
}

test.afterEach(async () => {
  for (const site of started.splice(0)) {
    await site.stop();
    fs.rmSync(site.tmp, { recursive: true, force: true });
  }
});

/**
 * Wait until the page's service worker is active.
 *
 * @param {import('@playwright/test').Page} page a page that has registered sw.js
 */
async function waitForWorker(page) {
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
}

test('after one visit, the page works with both servers stopped', async ({ page }) => {
  const site = await startSite();
  await page.goto(site.url);
  await waitForWorker(page);
  await site.stop();
  await expect(fetch(site.url)).rejects.toThrow();
  await page.reload();
  await page.waitForFunction(() => window.HOLO && window.HOLO.ready);
  await expect(page.locator('#pause')).toBeVisible();
  await page.click('.sh-sample');
  await expect(page.locator('#dn')).toHaveText('45');
  await page.setInputFiles('.sh-zip', SUMMED);
  await expect(page.locator('.sh-msg')).toHaveText(/^Replaced the sample\. Added 31 days, 12 walks/);
  await expect(page.locator('#dn')).toHaveText('31');
  await page.keyboard.press('Escape');
  await page.click('#range button:has-text("All")');
  await page.evaluate(() => { location.hash = 'move'; });
  await expect(page.locator('.page .card .plot svg')).toHaveCount(7);
});

test('the next online load shows a changed file', async ({ page }) => {
  const site = await startSite();
  await page.goto(site.url);
  await waitForWorker(page);
  editFile(path.join(site.dir, 'index.html'), '<h1>Glassbody</h1>', '<h1>Glassbody, changed</h1>');
  // going to the page again, not reloading: a reload revalidates by itself, and the
  // test would pass without the worker's no-cache past the server's max-age=600
  await page.goto(site.url);
  await expect(page.locator('#stage h1')).toHaveText('Glassbody, changed');
  // the worker answered that load, rather than the browser on its own
  expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
});

test('a new CACHE name in sw.js leaves only the new cache', async ({ page }) => {
  const site = await startSite();
  await page.goto(site.url);
  await waitForWorker(page);
  const { CACHE } = readWorkerLists(path.join(site.dir, 'sw.js'));
  expect(await page.evaluate(() => caches.keys())).toEqual([CACHE]);
  editFile(path.join(site.dir, 'sw.js'), `'${CACHE}'`, '\'glassbody-test-2\'');
  await page.reload();
  // the new worker downloads every file before it takes over: 4 to 6 seconds after
  // the reload on Linux, past expect.poll's 5-second default
  await expect.poll(() => page.evaluate(() => caches.keys()), { timeout: 20000 })
    .toEqual(['glassbody-test-2']);
});

test('every request the page makes is in SHELL or CDN, but favicon.ico', async ({ page }) => {
  const site = await startSite();
  const asked = new Set();
  page.on('request', (r) => { if (!/^(data|blob):/.test(r.url())) asked.add(r.url()); });
  await page.goto(site.url);
  await page.click('.sh-sample');
  await expect(page.locator('#dn')).toHaveText('45');
  const saved = page.waitForEvent('download');
  await page.click('.sh-down');
  await saved;
  await page.setInputFiles('.sh-zip', SUMMED);
  await expect(page.locator('#dn')).toHaveText('31');
  await page.keyboard.press('Escape');
  await page.click('#range button:has-text("All")');
  for (const h of ['move', 'heart', 'sleep', 'sound', 'fuel']) {
    await page.evaluate((x) => { location.hash = x; }, h);
    await expect(page.locator('.page.on')).toBeVisible();
  }
  await page.evaluate(() => { location.hash = ''; window.GlassbodyPanel.open(); });
  await expect(page.locator('.sheet')).toBeVisible();

  const { SHELL, CDN } = readWorkerLists(path.join(site.dir, 'sw.js'));
  const listed = new Set(SHELL.map((p) => new URL(p, site.url).href).concat(CDN.map((c) => c.url)));
  expect([...asked]).toEqual(expect.arrayContaining(CDN.map((c) => c.url)));
  expect([...asked].filter((u) => !listed.has(u) && new URL(u).pathname !== '/favicon.ico')).toEqual([]);
});

test('the worker\'s requests to cdnjs carry no Referer, like the page\'s own', async ({ page }) => {
  // no-store, or the browser answers the worker from the copies the script tags fetched
  const site = await startSite({ cdnNoStore: true });
  await page.goto(site.url);
  await waitForWorker(page);
  // the script tags ask with Sec-Fetch-Dest: script, the worker's precache with empty;
  // without the worker's own requests here, the test would pass on the page's alone
  const fromWorker = site.cdnRequests.filter((r) => r.headers['sec-fetch-dest'] === 'empty');
  const { CDN } = readWorkerLists(path.join(ROOT, 'sw.js'));
  expect(fromWorker.map((r) => r.path).sort()).toEqual(CDN.map((c) => new URL(c.url).pathname).sort());
  expect(site.cdnRequests.filter((r) => 'referer' in r.headers)
    .map((r) => r.path + ' ' + r.headers.referer)).toEqual([]);
});

test('the CDN list in sw.js has the URLs and integrity hashes of index.html\'s script tags', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const tags = [...html.matchAll(/<script src="(https:[^"]+)"\s+integrity="([^"]+)"/g)]
    .map(([, url, integrity]) => ({ url, integrity }));
  expect(tags).toHaveLength(3);
  expect(readWorkerLists(path.join(ROOT, 'sw.js')).CDN).toEqual(tags);
});

test('SITE_FILES is what .github/workflows/pages.yml copies into _site, each file at its own path', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/pages.yml'), 'utf8');
  const lines = [...workflow.matchAll(/^\s*cp (?:-R )?(.+) (_site\/\S*)$/gm)];
  expect(lines.length).toBeGreaterThan(0);
  const copied = [];
  for (const [, sources, dest] of lines) {
    for (const src of sources.split(' ')) {
      expect(dest, src).toBe(path.posix.join('_site', path.posix.dirname(src), '/'));
      copied.push(src);
    }
  }
  expect(copied.sort()).toEqual([...SITE_FILES].sort());
});

test('a three.js with one byte changed never enters the cache, and the worker never activates', async ({ page }) => {
  const site = await startSite({
    tamper: (libs) => {
      const file = path.join(libs, 'three.min.js');
      const bytes = fs.readFileSync(file);
      bytes[100] ^= 1;
      fs.writeFileSync(file, bytes);
    },
  });
  // workerSettled resolves with the state the page's worker ends in: 'activated',
  // or 'redundant' when its install fails
  await page.addInitScript(() => {
    const register = ServiceWorkerContainer.prototype.register;
    ServiceWorkerContainer.prototype.register = function (...args) {
      const registered = register.apply(this, args);
      window.workerSettled = registered.then((reg) => new Promise((ok) => {
        const worker = reg.installing || reg.waiting || reg.active;
        const check = () => { if (worker.state === 'activated' || worker.state === 'redundant') ok(worker.state); };
        worker.addEventListener('statechange', check);
        check();
      }));
      return registered;
    };
  });
  await page.goto(site.url);
  await page.waitForFunction(() => window.workerSettled);
  expect(await page.evaluate(() => window.workerSettled)).toBe('redundant');
  expect(await page.evaluate(() => navigator.serviceWorker.getRegistration()
    .then((reg) => reg === undefined || reg.active === null))).toBe(true);
  const cached = await page.evaluate(async () => {
    const urls = [];
    for (const name of await caches.keys()) {
      for (const r of await (await caches.open(name)).keys()) urls.push(r.url);
    }
    return urls;
  });
  expect(cached.filter((u) => u.endsWith('/three.min.js'))).toEqual([]);
});
