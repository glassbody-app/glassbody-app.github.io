// Storage safeguards (docs/specs/glassbody-v1.md, section 3): the request for
// persistent storage, the Safari note, and the last backup line with the reminder
// after an import. Each test gets a fresh browser context, so an empty IndexedDB.
const { test, expect } = require('@playwright/test');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SUMMED = path.join(ROOT, 'test/fixtures/sample-summed.zip');

const REMINDER = 'Download a backup to keep a copy outside this browser.';
const NO_BACKUP = 'No backup downloaded from this browser yet.';
const SAFARI_LEAD = 'Safari deletes what this page stores after 7 days of use without a visit. ';
const IPHONE_NOTE = SAFARI_LEAD + 'Add Glassbody to your Home Screen (Share, then Add to Home Screen), '
  + 'open it from there, and import your export there.';
const MAC_NOTE = SAFARI_LEAD + 'Download a backup after each import.';

const UA = {
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 '
    + '(KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 '
    + '(KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  macFirefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0',
};

const idle = (page) => page.waitForFunction(
  () => !document.querySelector('.sheet').hasAttribute('aria-busy'));
const message = (page) => page.textContent('.sh-msg');
const databases = (page) => page.evaluate(() => indexedDB.databases().then((d) => d.map((x) => x.name)));

/** Open the page on a first visit, which opens the Data panel because nothing is stored. */
async function openEmpty(page) {
  await page.route('**/favicon.ico', (r) => r.fulfill({ status: 204 }));
  await page.goto('index.local.html');
  await expect(page.locator('.sheet')).toBeVisible();
}

/** Erase everything through the Data panel and wait for it to finish. */
async function erase(page) {
  await page.click('.sh-erase');
  await page.click('.sh-yes');
  await idle(page);
}

test('persistent storage is asked for after an import that adds records and after a restore, '
  + 'never on load or for the sample', async ({ page }) => {
  await page.addInitScript(() => {
    window.storageCalls = { persisted: 0, persist: 0 };
    navigator.storage.persisted = () => { window.storageCalls.persisted++; return Promise.resolve(false); };
    navigator.storage.persist = () => { window.storageCalls.persist++; return Promise.resolve(true); };
  });
  const calls = () => page.evaluate(() => window.storageCalls);
  const asked = (n) => ({ persisted: n, persist: n });

  await openEmpty(page);
  expect(await calls()).toEqual(asked(0));
  await page.click('.sh-sample');
  await idle(page);
  expect(await calls()).toEqual(asked(0));

  await erase(page);
  await page.setInputFiles('.sh-zip', SUMMED);
  await idle(page);
  await expect.poll(calls).toEqual(asked(1));

  // the same export again stores nothing new
  await page.setInputFiles('.sh-zip', SUMMED);
  await idle(page);
  expect(await message(page)).toMatch(/^Nothing new\./);
  expect(await calls()).toEqual(asked(1));

  const backup = await page.evaluate(() => window.HealthStore.load());
  await page.setInputFiles('.sh-json', {
    name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup))
  });
  await page.click('.sh-ryes');
  await idle(page);
  expect(await message(page)).toMatch(/^Restored 31 days from backup\.json\.$/);
  await expect.poll(calls).toEqual(asked(2));
});

/** Stub navigator.standalone and navigator.maxTouchPoints before the page's scripts run. */
function stubNavigator({ standalone, maxTouchPoints }) {
  if (standalone !== undefined) {
    Object.defineProperty(navigator, 'standalone', { value: standalone, configurable: true });
  }
  if (maxTouchPoints !== undefined) {
    Object.defineProperty(navigator, 'maxTouchPoints', { value: maxTouchPoints, configurable: true });
  }
}

const NOTE_CASES = [
  { name: 'the default Chromium user agent', note: null },
  { name: 'iPhone Safari', userAgent: UA.iphoneSafari, note: IPHONE_NOTE, wording: 'iPhone' },
  { name: 'iPhone Safari opened from the Home Screen', userAgent: UA.iphoneSafari,
    stubs: { standalone: true }, note: null },
  // iPadOS asks for desktop pages with a Mac user agent
  { name: 'a Mac user agent with 5 touch points', userAgent: UA.macSafari,
    stubs: { maxTouchPoints: 5 }, note: IPHONE_NOTE, wording: 'iPhone' },
  { name: 'Mac Safari', userAgent: UA.macSafari, note: MAC_NOTE, wording: 'Mac' },
  { name: 'Mac Chrome', userAgent: UA.macChrome, note: null },
  { name: 'Mac Firefox', userAgent: UA.macFirefox, note: null },
];

for (const c of NOTE_CASES) {
  test(`the Safari note with ${c.name}: ${c.wording ? `the ${c.wording} wording` : 'none'}`,
    async ({ browser }) => {
      const ctx = await browser.newContext(c.userAgent ? { userAgent: c.userAgent } : {});
      const page = await ctx.newPage();
      if (c.stubs) await page.addInitScript(stubNavigator, c.stubs);
      await openEmpty(page);
      const note = page.locator('.sh-keep');
      if (c.note) await expect(note).toHaveText(c.note);
      else await expect(note).toBeHidden();
      await ctx.close();
    });
}

test('the last backup line: none for the sample, today after a download and a reload, '
  + 'hidden after Erase, none again for the sample', async ({ page }) => {
  const last = page.locator('.sh-last');
  await openEmpty(page);
  await page.click('.sh-sample');
  await idle(page);
  await expect(last).toHaveText(NO_BACKUP);

  const saved = page.waitForEvent('download');
  await page.click('.sh-down');
  await saved;
  // the reader's own calendar day, as the page writes it
  const today = await page.evaluate(() => new Date().toLocaleDateString('en-US',
    { month: 'short', day: 'numeric', year: 'numeric' }));
  await expect(last).toHaveText(`Last backup downloaded ${today}.`);

  await page.reload();
  await page.click('.datab');
  await expect(last).toHaveText(`Last backup downloaded ${today}.`);

  await erase(page);
  await expect(last).toBeHidden();
  // the record went with the database, and reading it does not create the database again
  expect(await databases(page)).not.toContain('body-scan');
  expect(await page.evaluate(() => window.HealthStore.lastBackup())).toBeNull();
  expect(await databases(page)).not.toContain('body-scan');

  await page.click('.sh-sample');
  await idle(page);
  await expect(last).toHaveText(NO_BACKUP);
});

test('Download backup in a tab whose records another tab erased does not create the database again',
  async ({ context }) => {
    const a = await context.newPage();
    await openEmpty(a);
    await a.click('.sh-sample');
    await idle(a);
    const b = await context.newPage();
    await b.goto('index.local.html');
    await b.click('.datab');
    await erase(b);
    // tab a still shows the sample, so its Download button is enabled
    const saved = a.waitForEvent('download');
    await a.click('.sh-down');
    await saved;
    // lastBackup() waits on the open that markBackup() started
    expect(await a.evaluate(() => window.HealthStore.lastBackup())).toBeNull();
    expect(await databases(a)).not.toContain('body-scan');
    await expect(a.locator('.sh-last')).toHaveText(NO_BACKUP);
  });

test('the last backup date is the calendar day where the reader is', async ({ browser }) => {
  const ctx = await browser.newContext({ timezoneId: 'America/New_York' });
  const page = await ctx.newPage();
  await openEmpty(page);
  await page.click('.sh-sample');
  await idle(page);
  // 21:00 on Oct 28 in New York is 01:00Z on Oct 29
  await page.evaluate(() => new Promise((resolve, reject) => {
    const rq = indexedDB.open('body-scan', 1);
    rq.onerror = () => reject(rq.error);
    rq.onsuccess = () => {
      const t = rq.result.transaction('store', 'readwrite');
      t.objectStore('store').put({ at: '2026-10-29 01:00Z' }, 'backup');
      t.oncomplete = () => { rq.result.close(); resolve(); };
      t.onerror = () => reject(t.error);
    };
  }));
  await page.reload();
  await page.click('.datab');
  await expect(page.locator('.sh-last')).toHaveText('Last backup downloaded Oct 28, 2026.');
  await ctx.close();
});

test('the backup file is named with the reader\'s own calendar day, as the last backup line is',
  async ({ browser }) => {
    const ctx = await browser.newContext({ timezoneId: 'America/New_York' });
    const page = await ctx.newPage();
    // 19:10 on Nov 10 in New York is 00:10Z on Nov 11: the UTC date is a day ahead
    await page.clock.setFixedTime(new Date('2026-11-11T00:10:00Z'));
    await openEmpty(page);
    await page.click('.sh-sample');
    await idle(page);
    const saved = page.waitForEvent('download');
    await page.click('.sh-down');
    expect((await saved).suggestedFilename()).toBe('glassbody-backup-2026-11-10.json');
    await expect(page.locator('.sh-last')).toHaveText('Last backup downloaded Nov 10, 2026.');
    await ctx.close();
  });

test('an import that adds records ends with the backup reminder; the same import again does not',
  async ({ page }) => {
    await openEmpty(page);
    await page.setInputFiles('.sh-zip', SUMMED);
    await idle(page);
    expect(await message(page)).toMatch(/^Added 31 days, /);
    expect((await message(page)).endsWith(' ' + REMINDER)).toBe(true);

    await page.setInputFiles('.sh-zip', SUMMED);
    await idle(page);
    expect(await message(page)).toMatch(/^Nothing new\./);
    expect(await message(page)).not.toContain(REMINDER);
  });
