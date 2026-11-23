#!/usr/bin/env node
/* Make the README screenshot and the link-preview image from the sample.

       npm run screenshots

   npm runs test/vendor.sh first, which writes index.local.html and vendor/.
   Then, for each image (docs/specs/glassbody-v1.md, section 5.1):

     1. serve the repository with Python's http.server on a port the system
        picks, and open index.local.html in Playwright's Chromium at the
        image's size, with the SwiftShader flags from playwright.config.js
     2. load the sample, close the Data panel and press Pause motion
     3. reload, so the figure starts still: Pause holds the figure's clock
        wherever it had got to, and the saved choice holds it at 0 from the
        first frame, with the camera where the page puts it
     4. screenshot the page

   The time zone is UTC, so the "last import" date reads the same on every
   machine, and Math.random is seeded, so the background motes land in the
   same places. The images come out byte for byte the same on one machine with
   one Playwright version, not everywhere; they are committed and rebuilt when
   the look changes. */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');
// the SwiftShader flags the tests use, so WebGL draws without a GPU
const LAUNCH_ARGS = require('../playwright.config.js').use.launchOptions.args;

const ROOT = path.join(__dirname, '..');
const SHOTS = [
  { file: 'docs/img/hero.png', width: 1280, height: 800 },   // the README's screenshot
  { file: 'img/og.png', width: 1200, height: 630 },          // og:image in index.html
];
const SERVER_TIMEOUT_MS = 10000;
const SAMPLE_DAYS = '45';   // what #dn shows with data/sample.json loaded
const RANDOM_SEED = 1;

/** A failure the script reports in one line: no server, no page, or a page that misbehaved. */
class ShotError extends Error {}

/**
 * Serve the repository with Python's http.server on 127.0.0.1, on a port the
 * system picks, and wait until it says which.
 *
 * @returns {Promise<{origin: string, stop: function(): void}>} the server's
 *   origin, and a stop that ends it
 * @throws {ShotError} when python3 cannot start, exits, or names no port in time
 */
function startServer() {
  // -u: unbuffered, so the line naming the port arrives at once
  const child = spawn('python3', ['-u', '-m', 'http.server', '0', '--bind', '127.0.0.1'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  // the server logs every request to stderr; read it so the pipe never fills and blocks it
  child.stderr.on('data', (b) => { err = (err + b).slice(-2000); });
  return new Promise((ok, fail) => {
    const failWith = (why) => {
      clearTimeout(timer);
      child.kill();
      fail(new ShotError(`python3 -m http.server ${why}${err ? ': ' + err.trim() : ''}`));
    };
    const timer = setTimeout(() => failWith(`named no port within ${SERVER_TIMEOUT_MS / 1000} s`),
      SERVER_TIMEOUT_MS);
    child.on('error', (e) => failWith(`did not start (${e.message})`));
    child.on('exit', (code) => failWith(`exited with code ${code}`));
    child.stdout.on('data', (b) => {
      out += b;
      // up to the space after the number, so output cut off mid-number does not match
      const m = /port (\d+) /.exec(out);
      if (!m) return;
      clearTimeout(timer);
      child.removeAllListeners('exit');
      ok({ origin: 'http://127.0.0.1:' + m[1], stop: () => child.kill() });
    });
  });
}

/**
 * Open the page at one image's size with the sample loaded, the Data panel
 * shut and the figure still, and save a screenshot of it.
 *
 * @param {import('@playwright/test').Browser} browser Chromium, launched
 * @param {string} origin where the repository is served
 * @param {{file: string, width: number, height: number}} shot where the image
 *   goes, from the repository root, and its size in pixels
 * @returns {Promise<number>} the size of the file written, in bytes
 * @throws {ShotError} on a page error, a panel left open or a clock that moved
 */
async function takeShot(browser, origin, shot) {
  const out = path.join(ROOT, shot.file);
  const context = await browser.newContext({
    viewport: { width: shot.width, height: shot.height },
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'UTC',
    // with reduced motion the page starts still, and pressing Pause would start it moving
    reducedMotion: 'no-preference',
  });
  // js/holo.js scatters the motes with Math.random; a seeded one (mulberry32) puts
  // them in the same places on every load, so a rebuild with no change in the look
  // writes the same files
  await context.addInitScript((seed) => {
    let s = seed;
    Math.random = () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }, RANDOM_SEED);
  const errors = [];
  try {
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(origin + '/index.local.html');
    await page.locator('.sh-sample').click();
    await page.waitForFunction((days) => document.getElementById('dn').textContent === days, SAMPLE_DAYS);
    await page.keyboard.press('Escape');
    await page.locator('.sheet').waitFor({ state: 'hidden' });
    await page.locator('#pause').click();
    await page.waitForFunction(() => document.getElementById('pause').getAttribute('aria-pressed') === 'true');
    await page.reload();
    await page.waitForFunction(() => window.HOLO && window.HOLO.ready);
    await page.locator('#pause').waitFor({ state: 'visible' });
    // off the button, so it shows no hover; the corner hovers no region
    await page.mouse.move(0, 0);
    // two frames, so the canvas has drawn since the figure was ready
    await page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok))));
    if (await page.locator('.sheet').isVisible()) throw new ShotError(`${shot.file}: the Data panel opened after the reload`);
    const motion = await page.evaluate(() => window.HOLO.motion());
    if (!motion.still || motion.clock !== 0) {
      throw new ShotError(`${shot.file}: the figure is not still from the start (still ${motion.still}, clock ${motion.clock})`);
    }
    if (errors.length) throw new ShotError(`${shot.file}: the page logged errors: ${errors.join('; ')}`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await page.screenshot({ path: out });
    return fs.statSync(out).size;
  } finally {
    await context.close();
  }
}

/**
 * Make every image in SHOTS.
 *
 * @returns {Promise<void>}
 */
async function main() {
  if (!fs.existsSync(path.join(ROOT, 'index.local.html'))) {
    throw new ShotError('index.local.html is missing; run npm run screenshots, which writes it first');
  }
  const server = await startServer();
  let browser;
  try {
    browser = await chromium.launch({ args: LAUNCH_ARGS });
    for (const shot of SHOTS) {
      const bytes = await takeShot(browser, server.origin, shot);
      console.log(`${shot.file}: ${shot.width} x ${shot.height}, ${bytes} bytes`);
    }
  } finally {
    if (browser) await browser.close();
    server.stop();
  }
}

main().catch((e) => {
  // a ShotError says all it needs to; anything else is unexpected and needs its stack
  console.error(e instanceof ShotError ? e.message : e.stack);
  process.exit(1);
});
