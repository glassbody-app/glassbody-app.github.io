// Regression checks listed in README.md (Tests), run against index.local.html
// with the synthetic fixtures from tools/make_sample.py. The checks share one page and
// one IndexedDB, in order, because each starts from the state the last left.
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SUMMED = path.join(ROOT, 'test/fixtures/sample-summed.zip');
const AVERAGED = path.join(ROOT, 'test/fixtures/sample-averaged.zip');
const SAMPLE = path.join(ROOT, 'data/sample.json');

// expected counts, printed by tools/make_sample.py
const SAMPLE_STATUS = 'Stored here: 45 days, 14 walks, 60 doses, 15 days of food, '
  + '5 alerts and 2 ECGs, from Sep 12, 2026 to Oct 26, 2026.';
const SUMMED_ADDED = 'Added 31 days, 12 walks, 25 doses, 10 days of food, 4 alerts and 1 ECG. '
  + 'Download a backup to keep a copy outside this browser.';

/** Run tools/ingest.py on one zip into a temporary file; return its exit code and output path. */
function runPythonIngest(zip) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glassbody-'));
  const out = path.join(dir, 'store.json');
  try {
    execFileSync('python3', [path.join(ROOT, 'tools/ingest.py'), zip, '--out', out],
      { stdio: 'pipe' });
    return { status: 0, out };
  } catch (e) {
    if (typeof e.status !== 'number') throw e;
    return { status: e.status, out };
  }
}

test.describe('the eight checks, in order', () => {
  test.describe.configure({ mode: 'serial' });
  let page;
  const errors = [];

  const days = () => page.textContent('#dn');
  const message = () => page.textContent('.sh-msg');
  const idle = () => page.waitForFunction(
    () => !document.querySelector('.sheet').hasAttribute('aria-busy'));

  /** Restore a backup object over the stored records through the Data panel, confirm, and close the panel. */
  async function restore(backup) {
    await page.evaluate(() => { location.hash = ''; window.GlassbodyPanel.open(); });
    await page.setInputFiles('.sh-json', {
      name: 'backup.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(backup))
    });
    await expect(page.locator('.sh-rconfirm')).toBeVisible();
    await page.click('.sh-ryes');
    await idle();
    expect(await message()).toMatch(/^Restored \d+ days? from backup\.json\.$/);
    await page.keyboard.press('Escape');
  }

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    // from before the page named its icon; if favicon.ico is still asked for, keep its 404 out of the error list
    await page.route('**/favicon.ico', (r) => r.fulfill({ status: 204 }));
  });
  test.afterAll(async () => { await page.close(); });

  test('1 first visit with an empty store opens the Data panel', async () => {
    await page.goto('index.local.html');
    await expect(page.locator('.sheet')).toBeVisible();
    await expect(page.locator('.sh-status')).toHaveText(/^Nothing is stored in this browser yet/);
    await expect(page.locator('.sh-sample')).toBeEnabled();
  });

  test('2 load sample gives 45 days with invented medicines', async () => {
    await page.click('.sh-sample');
    await idle();
    expect(await days()).toBe('45');
    await expect(page.locator('.sh-status')).toHaveText(SAMPLE_STATUS);
    const meds = await page.evaluate(() => window.HealthStore.load()
      .then((s) => [...new Set(s.meds.map((m) => m.med))].sort()));
    expect(meds).toEqual(['Examplamine', 'Fictivol', 'Placebocin']);
  });

  test('3 erase gives nothing', async () => {
    await page.click('.sh-erase');
    await page.click('.sh-yes');
    await idle();
    expect(await days()).toBe('—');
    await expect(page.locator('.sh-status')).toHaveText(/^Nothing is stored/);
    // the database itself is gone, not only the record in it
    expect(await page.evaluate(() => indexedDB.databases().then((d) => d.map((x) => x.name))))
      .not.toContain('body-scan');
    expect(await page.evaluate(() => window.HealthStore.load())).toBeNull();
    // and reading the empty store does not create it again
    expect(await page.evaluate(() => indexedDB.databases().then((d) => d.map((x) => x.name))))
      .not.toContain('body-scan');
  });

  test('4 import the summed fixture', async () => {
    await page.setInputFiles('.sh-zip', SUMMED);
    await idle();
    expect(await message()).toBe(SUMMED_ADDED);
    expect(await days()).toBe('31');
  });

  test('5 import it again adds nothing', async () => {
    await page.setInputFiles('.sh-zip', SUMMED);
    await idle();
    expect(await message()).toMatch(/^Nothing new\. Every record in sample-summed\.zip/);
    expect(await days()).toBe('31');
  });

  test('6 the averaged fixture is refused', async () => {
    await page.setInputFiles('.sh-zip', AVERAGED);
    await idle();
    expect(await message()).toMatch(/averaged, not summed.*Nothing was stored\.$/);
    await expect(page.locator('.sh-msg')).toHaveClass(/\bbad\b/);
    expect(await days()).toBe('31');
  });

  test('7 reload keeps the data and leaves the panel shut', async () => {
    await page.reload();
    await expect(page.locator('#dn')).toHaveText('31');
    await expect(page.locator('.sheet')).toBeHidden();
  });

  test('8 #move shows 7 charts, the walk table and the routes', async () => {
    // the 7-day default window holds no fixture walks
    await page.click('#range button:has-text("All")');
    await page.evaluate(() => { location.hash = 'move'; });
    await expect(page.locator('.page.on')).toBeVisible();
    await expect(page.locator('.page .card .plot svg')).toHaveCount(7);
    await expect(page.locator('.page tbody tr')).toHaveCount(12);
    // walk 3 of the fixture has no GPS track
    await expect(page.locator('.page .routes .rt')).toHaveCount(11);
  });

  test('restore over stored records asks first, and Cancel keeps them', async () => {
    await page.evaluate(() => { window.GlassbodyPanel.open(); });
    await page.setInputFiles('.sh-json', { name: 'other.json', mimeType: 'application/json',
      buffer: fs.readFileSync(SAMPLE) });
    await expect(page.locator('.sh-rconfirm')).toHaveText(
      /^This replaces the 31 days stored here with other\.json\. Download a backup first/);
    await expect(page.locator('.sh-rno')).toBeFocused();
    await page.click('.sh-rno');
    await expect(page.locator('.sh-rconfirm')).toBeHidden();
    expect(await days()).toBe('31');
    await page.keyboard.press('Escape');
  });

  test('a walk with no ascent shows a dash, not 0', async () => {
    const backup = JSON.parse(fs.readFileSync(SAMPLE, 'utf8'));
    const last = backup.walks[backup.walks.length - 1];
    last.ascentFt = null;  // what the ingesters write for a blank cell
    await restore(backup);
    await page.evaluate(() => { location.hash = 'move'; });
    // newest walk first; the column order is fixed in ui.js
    const header = await page.locator('.page thead th').allTextContents();
    const col = header.indexOf('Ascent ft') + 1;
    await expect(page.locator(`.page tbody tr:first-child td:nth-child(${col})`)).toHaveText('—');
  });

  test('a backup with walks but no daily rows still opens #move', async () => {
    const backup = JSON.parse(fs.readFileSync(SAMPLE, 'utf8'));
    backup.daily = [];
    // a name from the user's file must not reach Object.prototype
    backup.meds[0].name = '__proto__';
    await restore(backup);
    await page.evaluate(() => { location.hash = 'move'; });
    // every walk is shown, whatever the range; one of the 14 has no GPS track
    await expect(page.locator('.page .routes .rt')).toHaveCount(13);
    await page.evaluate(() => { location.hash = 'fuel'; });
    await expect(page.locator('.page.on')).toBeVisible();
    expect(await page.evaluate(() => ({}).Taken)).toBeUndefined();
  });

  test('a backup row without a real date is dropped on restore', async () => {
    const backup = JSON.parse(fs.readFileSync(SAMPLE, 'utf8'));
    backup.daily.push({ date: 'zzzz' });
    backup.meta.updated = 5;
    await restore(backup);
    await expect(page.locator('#dn')).toHaveText('45');
    await page.evaluate(() => { location.hash = 'heart'; });
    await expect(page.locator('.page.on')).toBeVisible();
  });

  test('a backup with junk route points, hr values and repeated keys restores cleanly', async () => {
    const backup = JSON.parse(fs.readFileSync(SAMPLE, 'utf8'));
    const last = backup.walks[backup.walks.length - 1];
    last.route = last.route.concat([[null, null], ['a', 'b'], [1, 2, 3], 7]);
    last.hr = last.hr.concat(['x', null]);
    const first = backup.daily[0];
    backup.daily.push({ ...first, steps: 1 }, { ...first, steps: 2 });
    backup.meta.updated = 'yesterday';
    await restore(backup);
    await expect(page.locator('#dn')).toHaveText('45');
    const s = await page.evaluate(() => window.HealthStore.load());
    const w = s.walks[s.walks.length - 1];
    expect(w.route.every((p) => p.length === 2 && p.every(Number.isFinite))).toBe(true);
    expect(w.hr.every(Number.isFinite)).toBe(true);
    // the last of the repeated rows wins, as in a merge
    expect(s.daily[0].steps).toBe(2);
    expect(s.meta.updated).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}Z$/);
    await page.evaluate(() => { location.hash = 'move'; });
    await expect(page.locator('.page .card .plot svg')).toHaveCount(7);
  });

  test('#constructor and #__proto__ open no page', async () => {
    for (const h of ['constructor', '__proto__', 'toString']) {
      await page.evaluate((x) => { location.hash = x; }, h);
      await expect(page.locator('.page.on')).toHaveCount(0);
    }
    await page.evaluate(() => { location.hash = ''; });
  });

  test('no page errors along the way', async () => {
    expect(errors).toEqual([]);
  });
});

test('tools/ingest.py and js/ingest.js give the same store from the summed fixture', async ({ page }) => {
  const py = runPythonIngest(SUMMED);
  expect(py.status).toBe(0);
  const fromPython = JSON.parse(fs.readFileSync(py.out, 'utf8'));

  await page.goto('index.local.html');
  const fromJs = await page.evaluate(async () => {
    const buf = await (await fetch('test/fixtures/sample-summed.zip')).arrayBuffer();
    const parsed = await window.HealthIngest.parseZip(buf);
    return window.HealthStore.fold(null, parsed).store;
  });
  // the import time is the only field allowed to differ
  delete fromPython.meta.updated;
  delete fromJs.meta.updated;
  expect(fromJs).toEqual(fromPython);
});

test('tools/ingest.py refuses the averaged fixture and writes nothing', () => {
  const py = runPythonIngest(AVERAGED);
  expect(py.status).toBe(2);
  expect(fs.existsSync(py.out)).toBe(false);
});

/**
 * Copy the summed fixture with doses added to its first logged dose: a second one
 * later in the same minute, one at the same second but a different scheduled time,
 * an exact repeat, and an older Medications file holding that dose with another status.
 */
function makeDoubleDoseZip() {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'glassbody-')), 'double-dose.zip');
  const py = [
    'import sys, zipfile',
    'src, dst = sys.argv[1], sys.argv[2]',
    'with zipfile.ZipFile(src) as zi, zipfile.ZipFile(dst, "w") as zo:',
    '    for n in zi.namelist():',
    '        b = zi.read(n)',
    '        if n.startswith("Medications-"):',
    '            lines = b.decode().splitlines()',
    '            first = lines[1]',
    '            cols = first.split(",")',
    // columns: Date, Scheduled Date, Medication, Nickname, Dosage, ..., Status (7)
    '            rescheduled = cols[:]',
    '            rescheduled[1] = cols[1][:11] + "06:00:00"',
    '            later = first.replace(first[:19], first[:17] + "50", 1)',
    '            lines += [later, ",".join(rescheduled), first]',
    '            b = ("\\n".join(lines) + "\\n").encode()',
    '            older = cols[:]',
    '            older[7] = "Skipped" if cols[7] == "Taken" else "Taken"',
    '            zo.writestr("Medications-2026-07-01-2026-07-31.csv",',
    '                        lines[0] + "\\n" + ",".join(older) + "\\n")',
    '        zo.writestr(n, b)',
  ].join('\n');
  execFileSync('python3', ['-c', py, SUMMED, out]);
  return out;
}

test('two doses of one medicine in the same minute stay two, in both ingesters', async ({ page }) => {
  const zip = makeDoubleDoseZip();
  const py = runPythonIngest(zip);
  expect(py.status).toBe(0);
  const fromPython = JSON.parse(fs.readFileSync(py.out, 'utf8'));
  // 25 doses, plus the later same-minute one and the rescheduled one; the exact
  // repeat is one dose, and the newer file's status beats the older file's
  expect(fromPython.meds.length).toBe(27);
  const plain = JSON.parse(fs.readFileSync(runPythonIngest(SUMMED).out, 'utf8'));
  const same = (a, b) => a.date === b.date && a.time === b.time && a.med === b.med;
  plain.meds.forEach((p) => {
    const kept = fromPython.meds.find((m) => same(m, p) && !m.seq);
    expect(kept.status).toBe(p.status);
  });

  await page.goto('index.local.html');
  const js = await page.evaluate(async (b64) => {
    const buf = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
    const parsed = await window.HealthIngest.parseZip(buf);
    const once = window.HealthStore.fold(null, parsed);
    const twice = window.HealthStore.fold(once.store, parsed);
    return { store: once.store, againAdded: twice.added.meds };
  }, fs.readFileSync(zip).toString('base64'));
  expect(js.againAdded).toBe(0);
  delete fromPython.meta.updated;
  delete js.store.meta.updated;
  expect(js.store).toEqual(fromPython);
});

test('tools/ingest.py merges into an existing --out unless --fresh is given', () => {
  const py = runPythonIngest(SUMMED);
  const again = execFileSync('python3',
    [path.join(ROOT, 'tools/ingest.py'), SUMMED, '--out', py.out], { encoding: 'utf8' });
  expect(again).toMatch(/daily\s+31 total\s+\(\+0 new\)/);
  const fresh = execFileSync('python3',
    [path.join(ROOT, 'tools/ingest.py'), SUMMED, '--out', py.out, '--fresh'], { encoding: 'utf8' });
  expect(fresh).toMatch(/daily\s+31 total\s+\(\+31 new\)/);
});

test('tools/ingest.py writes to ~/glassbody/health.json when --out is left out', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'glassbody-home-'));
  const said = execFileSync('python3', [path.join(ROOT, 'tools/ingest.py'), SUMMED],
    { encoding: 'utf8', env: { ...process.env, HOME: home }, cwd: home });
  const out = path.join(home, 'glassbody', 'health.json');
  expect(said).toContain('wrote: ' + out);
  expect(JSON.parse(fs.readFileSync(out, 'utf8')).meta.days).toBe(31);
});

test('opened from disk, the page names the serve command instead of blaming WebGL', async ({ page }) => {
  await page.goto('file://' + path.join(ROOT, 'index.local.html'));
  await expect(page.locator('.nogl')).toHaveText(/^This page does not work opened from disk\. .*--bind 127\.0\.0\.1/);
});

/** Write a zip whose daily CSV unpacks to 51,000,000 bytes (about 50 KB packed); return its path. */
function makeOversizeZip() {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'glassbody-')), 'oversize.zip');
  execFileSync('python3', ['-c', [
    'import sys, zipfile',
    'with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as z:',
    '    z.writestr("HealthAutoExport-2026-01-01-2026-01-31.csv", b"Date/Time\\n" + b"a" * 50999990)',
  ].join('\n'), out]);
  return out;
}

test.describe('the Data panel refuses files it should not read', () => {
  const message = (page) => page.textContent('.sh-msg');
  const idle = (page) => page.waitForFunction(
    () => !document.querySelector('.sheet').hasAttribute('aria-busy'));

  test.beforeEach(async ({ page }) => {
    await page.goto('index.local.html');
    await expect(page.locator('.sheet')).toBeVisible();
  });

  test('a file inside the zip over 50 MB, before inflating it', async ({ page }) => {
    await page.setInputFiles('.sh-zip', makeOversizeZip());
    await idle(page);
    expect(await message(page)).toBe('HealthAutoExport-2026-01-01-2026-01-31.csv unpacks to 51 MB; '
      + 'the limit for one file is 50 MB. Nothing was stored.');
  });

  test('a zip over the size limit, and CSV files over the total', async ({ page }) => {
    await page.evaluate(() => { window.HealthIngest.limits.zipBytes = 1000; });
    await page.setInputFiles('.sh-zip', SUMMED);
    await idle(page);
    expect(await message(page)).toMatch(/^The zip is \d+ MB; the limit is 1 MB\. .*Nothing was stored\.$/);
    await page.evaluate(() => {
      window.HealthIngest.limits.zipBytes = 500e6;
      window.HealthIngest.limits.totalBytes = 1000;
    });
    await page.setInputFiles('.sh-zip', SUMMED);
    await idle(page);
    expect(await message(page)).toMatch(/^The CSV files in the zip unpack to \d+ MB; the limit is 1 MB\./);
    expect(await page.evaluate(() => window.HealthStore.load())).toBeNull();
  });

  test('a file that is not a zip, in plain words', async ({ page }) => {
    await page.setInputFiles('.sh-zip',
      { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
    await idle(page);
    expect(await message(page)).toBe('notes.txt is not a zip file. Export again from Health Auto Export.');
  });

  test('Download and Erase stay disabled while a dropped zip is read', async ({ page }) => {
    await page.click('.sh-sample');
    await idle(page);
    await page.keyboard.press('Escape');
    // hold the import open until the test lets go
    await page.evaluate(() => {
      window.HealthIngest.parseZip = () => new Promise((_, no) => { window.letGo = no; });
      const dt = new DataTransfer();
      dt.items.add(new File(['x'], 'export.zip', { type: 'application/zip' }));
      document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    // opening the sheet reloads the store; give that time to land
    await page.waitForTimeout(300);
    await expect(page.locator('.sheet')).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('.sh-down')).toBeDisabled();
    await expect(page.locator('.sh-erase')).toBeDisabled();
    await page.evaluate(() => window.letGo(new Error('stopped by the test')));
    await idle(page);
    await expect(page.locator('.sh-down')).toBeEnabled();
  });
});

/** Run tools/ingest.py on one zip into a temporary --out; return exit code, stdout and whether it wrote. */
function runPythonIngestOutput(zip) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'glassbody-')), 'store.json');
  let status = 0, stdout;
  try {
    stdout = execFileSync('python3', [path.join(ROOT, 'tools/ingest.py'), zip, '--out', out],
      { encoding: 'utf8' });
  } catch (e) {
    if (typeof e.status !== 'number') throw e;
    status = e.status; stdout = e.stdout;
  }
  return { status, stdout, wrote: fs.existsSync(out) };
}

test('tools/ingest.py refuses an oversized file inside a zip before reading it', () => {
  const py = runPythonIngestOutput(makeOversizeZip());
  expect(py.status).toBe(2);
  expect(py.stdout.trim()).toBe('refused oversize.zip: HealthAutoExport-2026-01-01-2026-01-31.csv '
    + 'unpacks to 51 MB; the limit for one file is 50 MB. Nothing was written.');
  expect(py.wrote).toBe(false);
});

test('tools/ingest.py refuses a file that is not a zip, without a traceback', () => {
  const notes = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'glassbody-')), 'notes.txt');
  fs.writeFileSync(notes, 'hello');
  const py = runPythonIngestOutput(notes);
  expect(py.status).toBe(2);
  expect(py.stdout.trim()).toBe('refused notes.txt: This is not a zip file. Nothing was written.');
  expect(py.wrote).toBe(false);
});

/** Copy the summed fixture with one medicine nickname that holds bytes that are not
 *  UTF-8 and is 200,000 characters long, past the csv module's default field limit. */
function makeOddTextZip() {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'glassbody-')), 'odd-text.zip');
  execFileSync('python3', ['-c', [
    'import sys, zipfile',
    'with zipfile.ZipFile(sys.argv[1]) as zi, zipfile.ZipFile(sys.argv[2], "w") as zo:',
    '    for n in zi.namelist():',
    '        b = zi.read(n)',
    '        if n.startswith("Medications-"):',
    '            lines = b.split(b"\\n")',
    '            cols = lines[1].split(b",")',
    // a lone 0xE9, a truncated four-byte lead, an overlong NUL and a surrogate
    '            cols[3] = b"N\\xe9xy \\xf0\\x9fA \\xc0\\x80A \\xed\\xa0\\x80A " + b"x" * 200000',
    '            lines[1] = b",".join(cols)',
    '            b = b"\\n".join(lines)',
    '        zo.writestr(n, b)',
  ].join('\n'), SUMMED, out]);
  return out;
}

test('both ingesters read a cell past 131072 characters and bytes that are not UTF-8 the same way', async ({ page }) => {
  const zip = makeOddTextZip();
  const py = runPythonIngest(zip);
  expect(py.status).toBe(0);
  const fromPython = JSON.parse(fs.readFileSync(py.out, 'utf8'));
  expect(fromPython.meds.some((m) => m.name.startsWith('N�xy �A ��A ���A x'))).toBe(true);

  await page.goto('index.local.html');
  const fromJs = await page.evaluate(async (b64) => {
    const buf = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
    return window.HealthStore.fold(null, await window.HealthIngest.parseZip(buf)).store;
  }, fs.readFileSync(zip).toString('base64'));
  delete fromPython.meta.updated;
  delete fromJs.meta.updated;
  expect(fromJs).toEqual(fromPython);
});

/**
 * Answer the page's cdnjs requests from vendor/, so index.html is tested without the
 * network.
 *
 * @param {import('@playwright/test').Page} page the page whose requests are answered
 * @param {function(object): void} [onRequest] gets each cdnjs request's headers
 */
async function answerCdnFromVendor(page, onRequest = () => {}) {
  await page.route('https://cdnjs.cloudflare.com/**', (route) => {
    onRequest(route.request().headers());
    route.fulfill({ path: path.join(ROOT, 'vendor', path.basename(new URL(route.request().url()).pathname)),
      headers: { 'access-control-allow-origin': '*', 'content-type': 'application/javascript' } });
  });
}

for (const [file, others] of [['index.html', ['cdnjs.cloudflare.com']], ['index.local.html', []]]) {
  test(`${file} breaks no Content-Security-Policy rule and asks only its own origin${
    others.map((h) => ' and ' + h).join('')}`, async ({ page, baseURL }) => {
    const hosts = [new URL(baseURL).host].concat(others);
    const asked = new Set(), cdnHeaders = [];
    page.on('request', (r) => { if (!/^(data|blob):/.test(r.url())) asked.add(new URL(r.url()).host); });
    await answerCdnFromVendor(page, (headers) => cdnHeaders.push(headers));
    await page.route('**/favicon.ico', (r) => r.fulfill({ status: 204 }));
    await page.addInitScript(() => {
      window.cspViolations = [];
      document.addEventListener('securitypolicyviolation',
        (e) => window.cspViolations.push(e.violatedDirective + ' ' + e.blockedURI));
    });
    await page.goto(file);
    await page.click('.sh-sample');
    await page.waitForFunction(() => !document.querySelector('.sheet').hasAttribute('aria-busy'));
    const saved = page.waitForEvent('download');
    await page.click('.sh-down');
    await saved;
    await page.setInputFiles('.sh-zip', SUMMED);
    await page.waitForFunction(() => !document.querySelector('.sheet').hasAttribute('aria-busy'));
    await page.keyboard.press('Escape');
    await page.click('#range button:has-text("All")');
    for (const h of ['move', 'heart', 'sleep', 'sound', 'fuel']) {
      await page.evaluate((x) => { location.hash = x; }, h);
      await expect(page.locator('.page.on')).toBeVisible();
    }
    await page.evaluate(() => { location.hash = ''; });
    // every face in fonts/fonts.css loads from this origin
    expect(await page.evaluate(() => Promise.all(['400', '500', '600'].map((w) => `${w} 12px "Chakra Petch"`)
      .concat(['400 12px "IBM Plex Sans"', '500 12px "IBM Plex Sans"'])
      .map((f) => document.fonts.load(f, 'Aé').then((faces) => faces.length > 0
        && faces.every((x) => x.status === 'loaded'))))))
      .toEqual([true, true, true, true, true]);
    expect(await page.evaluate(() => window.cspViolations)).toEqual([]);
    expect([...asked].sort()).toEqual([...hosts].sort());
    // no-referrer: cdnjs learns the page's origin from the CORS request, never its path
    cdnHeaders.forEach((h) => { expect(h.referer).toBeUndefined(); });
    if (cdnHeaders.length) console.log('cdnjs request origin header:', cdnHeaders[0].origin);
    // the README says the page sets no cookies
    expect(await page.context().cookies()).toEqual([]);
  });
}

// playwright.config.js blocks service workers, so an old one can never answer a test here
test('with service workers blocked, index.html loaded twice registers none', async ({ page }) => {
  await answerCdnFromVendor(page);
  await page.goto('index.html');
  await page.reload();
  expect(await page.evaluate(() => navigator.serviceWorker.controller)).toBeNull();
  expect(await page.evaluate(() => navigator.serviceWorker.getRegistrations()
    .then((all) => all.length))).toBe(0);
});

test('the page works at http://glassbody.localhost, an origin of its own', async ({ page, baseURL }) => {
  const port = new URL(baseURL).port;
  await page.goto(`http://glassbody.localhost:${port}/index.local.html`);
  await expect(page.locator('.sheet')).toBeVisible();
  await page.click('.sh-sample');
  await expect(page.locator('#dn')).toHaveText('45');
  expect(await page.evaluate(() => location.origin)).toBe(`http://glassbody.localhost:${port}`);
});

/** Copy the summed fixture and add to it with a Python snippet that gets zi, zo and zipfile. */
function makeZipFromSummed(name, snippet) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'glassbody-')), name);
  execFileSync('python3', ['-c', [
    'import sys, zipfile',
    'with zipfile.ZipFile(sys.argv[1]) as zi, zipfile.ZipFile(sys.argv[2], "w") as zo:',
    '    for n in zi.namelist():',
    '        zo.writestr(n, zi.read(n))',
    ...snippet.map((l) => '    ' + l),
  ].join('\n'), SUMMED, out], { stdio: 'pipe' });
  return out;
}

/** Import one zip with js/ingest.js in the page; return the refusal message, or null. */
async function jsRefusal(page, zip) {
  await page.goto('index.local.html');
  return page.evaluate(async (b64) => {
    const buf = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
    try { await window.HealthIngest.parseZip(buf); return null; } catch (e) { return e.message; }
  }, fs.readFileSync(zip).toString('base64'));
}

test('both ingesters check the copy they read when one path appears twice', async ({ page }) => {
  const zip = makeZipFromSummed('dup.zip', [
    'import warnings; warnings.simplefilter("ignore")',
    'zo.writestr("HealthAutoExport-2026-08-01-2026-08-31.csv", b"Date/Time\\n" + b"a" * 50999990, zipfile.ZIP_DEFLATED)',
  ]);
  const said = 'HealthAutoExport-2026-08-01-2026-08-31.csv unpacks to 51 MB; the limit for one file is 50 MB.';
  expect(await jsRefusal(page, zip)).toBe(said);
  expect(runPythonIngestOutput(zip).stdout.trim()).toBe(`refused dup.zip: ${said} Nothing was written.`);
});

test('both ingesters refuse a zip with a member packed some other way', async ({ page }) => {
  const zip = makeZipFromSummed('lzma.zip', ['zo.writestr("notes.txt", b"hello", zipfile.ZIP_LZMA)']);
  const said = 'The zip uses compression or encryption this page cannot read.';
  expect(await jsRefusal(page, zip)).toBe(said);
  const py = runPythonIngestOutput(zip);
  expect(py.status).toBe(2);
  expect(py.stdout.trim()).toBe(`refused lzma.zip: ${said} Nothing was written.`);
});

test('tools/ingest.py ends every refusal with a full stop, and a bad UTF-8 name is refused, not a traceback', () => {
  const missing = runPythonIngestOutput(path.join(os.tmpdir(), 'no-such-export.zip'));
  expect(missing.status).toBe(2);
  expect(missing.stdout.trim()).toMatch(/^refused no-such-export\.zip: \[Errno 2\] .*'\. Nothing was written\.$/);
  const zip = makeZipFromSummed('badname.zip', [
    'zo.writestr("readme-\\u00e9.txt", b"hi")',
  ]);
  // zipfile marks the name UTF-8; swap its two bytes for two that are not UTF-8
  const b = fs.readFileSync(zip).toString('latin1');
  fs.writeFileSync(zip, Buffer.from(b.split('readme-\xc3\xa9').join('readme-\xff\xff'), 'latin1'));
  const py = runPythonIngestOutput(zip);
  expect(py.status).toBe(2);
  expect(py.stdout.trim()).toBe('refused badname.zip: A file name in the zip is marked UTF-8 but is not. '
    + 'Nothing was written.');
});

test('Erase blocked by another tab says so, and finishes once that tab closes', async ({ context }) => {
  const a = await context.newPage();
  await a.goto('index.local.html');
  await a.click('.sh-sample');
  await expect(a.locator('#dn')).toHaveText('45');
  // a tab from before onversionchange existed: it holds the database and never lets go
  const b = await context.newPage();
  await b.goto('index.local.html');
  await b.evaluate(() => new Promise((ok) => {
    const rq = indexedDB.open('body-scan', 1);
    rq.onsuccess = () => { window.held = rq.result; ok(); };
  }));
  await a.click('.sh-erase');
  await a.click('.sh-yes');
  await expect(a.locator('.sh-msg')).toHaveText('Glassbody is open in another tab. Close it to finish erasing.');
  await b.close();
  await expect(a.locator('.sh-msg')).toHaveText('Erased. Nothing is stored in this browser.');
  expect(await a.evaluate(() => window.HealthStore.load())).toBeNull();
});

test('the page calls itself Glassbody: heading, backup refusal, backup file name and back link', async ({ page }) => {
  await page.goto('index.local.html');
  await expect(page.locator('#stage h1')).toHaveText('Glassbody');
  // the panel clears its message as it opens, so let it open before restoring;
  // nothing is stored yet, so restore refuses at once instead of asking first
  await expect(page.locator('.sheet')).toBeVisible();
  await page.setInputFiles('.sh-json',
    { name: 'other.json', mimeType: 'application/json', buffer: Buffer.from('{}') });
  await expect(page.locator('.sh-msg')).toHaveText('This file is not a Glassbody backup.');
  await page.click('.sh-sample');
  await expect(page.locator('#dn')).toHaveText('45');
  const saved = page.waitForEvent('download');
  await page.click('.sh-down');
  expect((await saved).suggestedFilename()).toMatch(/^glassbody-backup-\d{4}-\d{2}-\d{2}\.json$/);
  await page.keyboard.press('Escape');
  await page.evaluate(() => { location.hash = 'move'; });
  await expect(page.locator('.page.on .backlink')).toHaveText('← Glassbody');
});

// The name before the rename, split so this test is not a hit of its own search.
const OLD_NAME = 'body' + '-scan';
const OLD_NAME_SEARCH = 'body.?scan';
// how docs/architecture.md opens the sentence that says why two stored names stay
const KEPT_SENTENCE = 'The IndexedDB database `' + OLD_NAME + '` and the localStorage key `'
  + OLD_NAME + '-motion`';
// Where the old name may stay (docs/specs/glassbody-v1.md, section 1). Each token
// is cut from a hit line in the matching files; whatever still matches fails.
const KEPT_NAMES = [
  // the IndexedDB database, so records stored before the rename are found
  { files: /^js\/store\.js$/, token: `DB = '${OLD_NAME}'` },
  // the localStorage key that holds the Pause motion choice
  { files: /^js\/holo\.js$/, token: `MOTION_KEY = '${OLD_NAME}-motion'` },
  // the tests that check those two names
  { files: /^test\/.*\.spec\.js$/, token: `'${OLD_NAME}'` },
  { files: /^test\/.*\.spec\.js$/, token: `'${OLD_NAME}-motion'` },
  // backups downloaded before the rename may still sit in a working copy
  { files: /^\.gitignore$/, token: `${OLD_NAME}-backup-*.json` },
  { files: /^docs\/architecture\.md$/, token: KEPT_SENTENCE },
];
// these record history, so they keep the old name wherever it was written
const HISTORY_DOCS = /^docs\/(decisions\.md$|specs\/)/;

test('no tracked file uses the old name outside the kept storage names and the history docs', () => {
  // a downloaded or archived copy has no .git, so git grep has no tracked files to read
  test.skip(!fs.existsSync(path.join(ROOT, '.git')), 'needs a git checkout');
  let hits = '';
  try {
    hits = execFileSync('git', ['grep', '-n', '-i', '-E', OLD_NAME_SEARCH], { cwd: ROOT, encoding: 'utf8' });
  } catch (e) {
    if (e.status !== 1) throw e;   // git grep exits 1 when nothing matches
  }
  const search = new RegExp(OLD_NAME_SEARCH, 'i');
  const left = hits.split('\n').filter(Boolean).filter((hit) => {
    const m = /^(.*?):(\d+):(.*)$/.exec(hit);
    if (!m) return true;   // "Binary file … matches" has no line to check
    const [, file, , text] = m;
    if (HISTORY_DOCS.test(file)) return false;
    const rest = KEPT_NAMES.filter((k) => k.files.test(file))
      .reduce((t, k) => t.split(k.token).join(''), text);
    return search.test(rest);
  });
  expect(left).toEqual([]);
});

test('docs/architecture.md says why two stored names keep the old name', () => {
  expect(fs.readFileSync(path.join(ROOT, 'docs/architecture.md'), 'utf8')).toContain(KEPT_SENTENCE);
});
