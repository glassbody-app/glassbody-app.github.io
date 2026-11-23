// Checks that the page can be installed as a web app: the manifest, the icon
// files it names, and Chromium's reading of it (docs/specs/glassbody-v1.md,
// section 2.6).
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readPngSize } = require('./png');

const ROOT = path.join(__dirname, '..');

/** The committed manifest, parsed. */
function readManifest() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8'));
}

test('manifest.webmanifest has the spec\'s fields, and each icon is the size it says', () => {
  const manifest = readManifest();
  expect(manifest).toEqual({
    name: 'Glassbody',
    short_name: 'Glassbody',
    description: 'Your Apple Health export on a rotating figure, read and kept in this browser.',
    id: './',
    start_url: './',
    scope: './',
    display: 'standalone',
    background_color: '#04060c',
    theme_color: '#04060c',
    icons: [
      { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
    ]
  });
  for (const icon of manifest.icons) {
    const [width, height] = icon.sizes.split('x').map(Number);
    expect(readPngSize(icon.src), icon.src).toEqual({ width, height });
  }
});

test('icons/apple-touch-icon.png is 180 × 180', () => {
  expect(readPngSize('icons/apple-touch-icon.png')).toEqual({ width: 180, height: 180 });
});

test('Chromium reads the manifest with no errors', async ({ page }) => {
  await page.goto('index.local.html');
  const devtools = await page.context().newCDPSession(page);
  const { url, data, errors } = await devtools.send('Page.getAppManifest');
  // a missing link or a manifest that fails to load also reports no errors,
  // so check that Chromium found the file and read what is committed
  expect(url).toMatch(/\/manifest\.webmanifest$/);
  expect(JSON.parse(data)).toEqual(readManifest());
  expect(errors).toEqual([]);
});

test('tools/make_icons.js --svg-only writes the committed icons/icon.svg byte for byte', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glassbody-icons-'));
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'tools/make_icons.js'), '--svg-only', '--out', dir],
      { stdio: 'pipe' });
    const committed = fs.readFileSync(path.join(ROOT, 'icons/icon.svg'));
    expect(fs.readFileSync(path.join(dir, 'icon.svg'), 'utf8')).toBe(committed.toString('utf8'));
    expect(fs.readdirSync(dir)).toEqual(['icon.svg']);
    expect(committed.length).toBeLessThan(10 * 1024);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
