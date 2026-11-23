// Keyboard, screen reader and motion checks, run against index.local.html with
// data/sample.json loaded.
const { test, expect } = require('@playwright/test');

const PAGES = { move: 'Movement', heart: 'Heart and lungs', sleep: 'Sleep',
  sound: 'Sound exposure', fuel: 'Medication and food' };

/** Open the page with the sample stored, the Data panel shut and the range on `range`. */
async function openWithSample(page, range = 'All') {
  await page.route('**/favicon.ico', (r) => r.fulfill({ status: 204 }));
  await page.goto('index.local.html');
  await page.click('.sh-sample');
  await expect(page.locator('#dn')).toHaveText('45');
  await page.keyboard.press('Escape');
  await page.click(`#range button:has-text("${range}")`);
}

/** Press Tab until `locator` has focus; fail after `max` presses. */
async function tabTo(page, locator, max = 60) {
  for (let i = 0; i < max; i++) {
    if (await locator.evaluate((e) => e === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('Tab never reached ' + locator);
}

const focused = (page) => page.evaluate(() => {
  const a = document.activeElement;
  return a.tagName + (a.dataset.id ? '#' + a.dataset.id : '') + ' ' + a.textContent.trim().slice(0, 30);
});

test.describe('navigation and screen readers', () => {
  test('closing the first-visit Data panel puts focus on the Data button, not the page', async ({ page }) => {
    await page.goto('index.local.html');
    await expect(page.locator('.sheet')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.datab')).toBeFocused();
  });

  test('a page opened from its chip gets the focus, a title and an h1; going back focuses the chip', async ({ page }) => {
    await openWithSample(page);
    for (const [id, name] of Object.entries(PAGES)) {
      const chip = page.locator(`.zone[data-id="${id}"]`);
      await tabTo(page, chip);
      await page.keyboard.press('Enter');
      const h1 = page.locator('.page.on h1');
      await expect(h1).toHaveText(name);
      await expect(h1).toBeFocused();
      await expect(page).toHaveTitle(`${name} · Glassbody`);
      // the hologram's own h1 is hidden with the stage, so one h1 is exposed
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      // card headings sit one level below, with no level skipped
      expect(await page.locator('.page.on .card h3').count()).toBe(0);
      expect(await page.locator('.page.on .card h2').count()).toBeGreaterThan(0);
      // the back link comes just before the heading
      await page.keyboard.press('Shift+Tab');
      await expect(page.locator('.page.on .backlink')).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(chip).toBeFocused();
      await expect(page).toHaveTitle('Glassbody');
    }
  });

  test('a region page has the range group and the Data button, and keeps focus on the range button', async ({ page }) => {
    await openWithSample(page, '7 days');
    await page.evaluate(() => { location.hash = 'heart'; });
    const head = page.locator('.page.on .pagehead');
    await expect(head.locator('#range button')).toHaveCount(3);
    await expect(head.locator('.datab')).toBeVisible();
    const thirty = head.locator('#range button', { hasText: '30 days' });
    await tabTo(page, thirty);
    await page.keyboard.press('Enter');
    await expect(page.locator('.page.on .sub')).toHaveText('Chest and arms · last 30 days');
    await expect(thirty).toHaveAttribute('aria-pressed', 'true');
    await expect(thirty).toBeFocused();
    expect(await head.ariaSnapshot()).toMatch(/- group "Date range":[\s\S]*button "30 days" \[pressed\]/);
    // the Data panel opens from here and gives the focus back on close
    await tabTo(page, head.locator('.datab'));
    await page.keyboard.press('Enter');
    await expect(page.locator('.sheet')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(head.locator('.datab')).toBeFocused();
    // home again, the range group is back in the top bar
    await page.evaluate(() => { location.hash = ''; });
    await expect(page.locator('.topbar #range')).toBeVisible();
  });

  test('every walk can be picked from the keyboard, including one without GPS', async ({ page }) => {
    await openWithSample(page);
    await page.evaluate(() => { location.hash = 'move'; });
    const rows = page.locator('.page.on tbody tr');
    const n = await rows.count();
    expect(n).toBe(14);
    // the sample has one walk with no route, so it has no route tile
    await expect(page.locator('.page.on .routes .rt')).toHaveCount(13);
    for (let i = 0; i < n; i++) {
      const btn = rows.nth(i).locator('button.rowpick');
      await tabTo(page, btn, 200);
      await page.keyboard.press('Enter');
      await expect(rows.nth(i)).toHaveAttribute('aria-current', 'true');
      await expect(rows.nth(i).locator('button.rowpick')).toBeFocused();
      await expect(page.locator('.page.on tbody tr[aria-current]')).toHaveCount(1);
    }
    const walk = page.locator('.card', { hasText: 'Every tracked walk' });
    expect(await walk.ariaSnapshot()).toMatch(/- row "Walk on [A-Z][a-z]{2} \d{1,2} at \d{2}:\d{2} /);
  });

  test('route tiles say which one is selected, and keep focus when picked', async ({ page }) => {
    await openWithSample(page);
    await page.evaluate(() => { location.hash = 'move'; });
    await expect(page.locator('.page.on .rt[aria-pressed="true"]')).toHaveCount(1);
    const tile = page.locator('.page.on .rt').first();
    await tabTo(page, tile, 200);
    await page.keyboard.press('Enter');
    await expect(page.locator('.page.on .rt').first()).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.page.on .rt').first()).toBeFocused();
    await expect(page.locator('.page.on .rt[aria-pressed="true"]')).toHaveCount(1);
  });

  test('every chart is named by its card heading and described by a summary', async ({ page }) => {
    await openWithSample(page, '7 days');
    for (const id of Object.keys(PAGES)) {
      await page.evaluate((x) => { location.hash = x; }, id);
      await expect(page.locator('.page.on')).toBeVisible();
      const charts = await page.$$eval('.page.on .plot svg[role="img"]', (svgs) => svgs.map((s) => ({
        name: document.getElementById(s.getAttribute('aria-labelledby')).textContent,
        heading: s.closest('.card').querySelector('h2').textContent,
        summary: (document.getElementById(s.getAttribute('aria-describedby')) || {}).textContent,
      })));
      expect(charts.length, id).toBeGreaterThan(0);
      for (const c of charts) {
        expect(c.name).toBe(c.heading);
        expect(c.summary, c.heading).toMatch(/\.$/);
      }
    }
    await page.evaluate(() => { location.hash = 'move'; });
    const steps = page.locator('.card', { hasText: 'Steps per day' }).first();
    expect(await steps.ariaSnapshot()).toContain('- img "Steps per day"');
    // the selected route map is described by its card note, so it is hidden as a picture
    await expect(page.locator('.card', { hasText: 'Selected route' }).locator('svg'))
      .toHaveAttribute('aria-hidden', 'true');
    await expect(steps.locator('.vh')).toHaveText(
      /^7 days, Oct 20 to Oct 26: lowest [\d,]+ steps, highest [\d,]+ steps, average [\d,]+ steps\.$/);
  });

  test('the KPIs are a list of names and values', async ({ page }) => {
    await openWithSample(page, '7 days');
    await page.evaluate(() => { location.hash = 'move'; });
    const kpis = page.locator('.page.on dl.kpis');
    await expect(kpis.locator('dt')).toHaveText(['Steps per day', 'Miles walked', 'Tracked walks', 'Flights climbed']);
    await expect(kpis.locator('dd')).toHaveCount(4);
  });

  test('a focused chip is described by the callout, which says how to open it by keyboard', async ({ page }) => {
    await openWithSample(page, '7 days');
    const chip = page.locator('.zone[data-id="sleep"]');
    // the description is painted by the time focus arrives, not a frame later
    await page.evaluate(() => {
      window.atFocus = {};
      document.querySelectorAll('.zone').forEach((z) => z.addEventListener('focus', () => {
        window.atFocus[z.dataset.id] = document.getElementById('callout').textContent; }));
    });
    await tabTo(page, chip);
    expect(await page.evaluate(() => window.atFocus.move)).toMatch(/^Legs and feetMovement/);
    expect(await page.evaluate(() => window.atFocus.sleep)).toMatch(/^HeadSleep/);
    await expect(page.locator('.callout')).toBeVisible();
    await expect(chip).toHaveAttribute('aria-describedby', 'callout');
    await expect(page.locator('#callout .co-name')).toHaveText('Sleep');
    await expect(page.locator('#callout .co-go')).toHaveText('Press Enter to open');
    await expect(page.locator('.hint')).toHaveAttribute('aria-hidden', 'true');
  });

  test('keyboard only: every control on the hologram and on each page is reached by Tab', async ({ page }) => {
    await openWithSample(page);
    const seen = [];
    await page.locator('body').focus();
    for (let i = 0; i < 14; i++) { await page.keyboard.press('Tab'); seen.push(await focused(page)); }
    for (const id of Object.keys(PAGES)) expect(seen.join('|')).toContain('BUTTON#' + id);
    expect(seen.join('|')).toContain('BUTTON Data');
    ['7 days', '30 days', 'All'].forEach((t) => expect(seen.join('|')).toContain('BUTTON ' + t));
  });
});

/** Read the figure's motion state twice, `ms` apart. */
async function motionOver(page, ms) {
  const a = await page.evaluate(() => window.HOLO.motion());
  await page.waitForTimeout(ms);
  const b = await page.evaluate(() => window.HOLO.motion());
  return [a, b];
}

/** Drag across the figure from its centre, `dx` pixels to the right. */
async function dragFigure(page, dx) {
  const box = await page.locator('#gl').boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(x + dx * i / 10, y, { steps: 1 });
  await page.mouse.up();
}

test.describe('motion', () => {
  test('with reduced motion the figure starts still: time, stripes, sweep and spin stop', async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await openWithSample(page);
    await expect(page.locator('#pause')).toHaveAttribute('aria-pressed', 'true');
    const [a, b] = await motionOver(page, 1200);
    expect(b.still).toBe(true);
    expect(b.clock).toBe(a.clock);
    expect(b.az).toBe(a.az);
    // two frames a second apart are the same picture
    const s1 = await page.locator('#gl').screenshot();
    await page.waitForTimeout(1000);
    const s2 = await page.locator('#gl').screenshot();
    expect(s1.equals(s2)).toBe(true);
    // a drag turns the figure, and it stops when the pointer lets go
    await dragFigure(page, 160);
    const [c, d] = await motionOver(page, 1500);
    expect(c.az).not.toBe(a.az);
    expect(d.az).toBe(c.az);
    expect(d.vaz).toBe(0);
    await ctx.close();
  });

  test('turning reduced motion on while the page is open stops the figure', async ({ page }) => {
    await openWithSample(page);
    const [a, b] = await motionOver(page, 500);
    expect(b.clock).toBeGreaterThan(a.clock);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page.locator('#pause')).toHaveAttribute('aria-pressed', 'true');
    const [c, d] = await motionOver(page, 800);
    expect(d.clock).toBe(c.clock);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect(page.locator('#pause')).toHaveAttribute('aria-pressed', 'false');
  });

  test('Pause motion is reached by keyboard, toggles the motion, and is remembered', async ({ page }) => {
    await openWithSample(page);
    const pause = page.locator('#pause');
    await expect(pause).toHaveAttribute('aria-pressed', 'false');
    await tabTo(page, pause);
    expect(await page.locator('.topbar').ariaSnapshot()).toContain('button "Pause motion"');
    await page.keyboard.press('Enter');
    await expect(pause).toHaveAttribute('aria-pressed', 'true');
    const [a, b] = await motionOver(page, 1000);
    expect(b.clock).toBe(a.clock);
    expect(b.az).toBe(a.az);
    // paused, the callout still follows a focused chip
    await page.focus('.zone[data-id="heart"]');
    await expect(page.locator('.callout')).toBeVisible();
    await page.reload();
    await expect(page.locator('#pause')).toHaveAttribute('aria-pressed', 'true');
    // the saved choice outlasts a change of the system setting
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect(page.locator('#pause')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#pause').click();
    await expect(page.locator('#pause')).toHaveAttribute('aria-pressed', 'false');
    const [c, d] = await motionOver(page, 500);
    expect(d.clock).toBeGreaterThan(c.clock);
  });

  test('still, the body sweep band is parked off the figure', async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await openWithSample(page);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.HOLO.motion().sweep)).toBeLessThan(-1000);
    await ctx.close();
  });

  test('Pause motion is not shown on a region page', async ({ page }) => {
    await openWithSample(page);
    await page.evaluate(() => { location.hash = 'sleep'; });
    await expect(page.locator('.page.on #range')).toBeVisible();
    await expect(page.locator('#pause')).toBeHidden();
  });
});

test.describe('copy', () => {
  test('chips name the data first, then the body part, and drop the body part on a phone', async ({ page }) => {
    await openWithSample(page);
    await expect(page.locator('.zone')).toHaveText(['Movement · legs and feet',
      'Heart and lungs · chest and arms', 'Sleep · head', 'Sound exposure · ears',
      'Medication and food · abdomen']);
    expect(await page.locator('#zones').ariaSnapshot()).toContain('- button "Sleep · head"');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('.zone .zn').first()).toBeHidden();
    await expect(page.locator('.zone').first()).toHaveText(/^Movement/);
  });

  test('the dead Back out control and the Rendering note are gone', async ({ page }) => {
    await openWithSample(page);
    await expect(page.locator('#back')).toHaveCount(0);
    await expect(page.locator('.below')).not.toContainText('Rendering');
    await expect(page.locator('.below h2')).toHaveText(['What this is', 'The record']);
  });

  test('the callout says Tap after a touch, Click after a mouse and Press Enter after a key', async ({ page }) => {
    await openWithSample(page);
    const chip = page.locator('.zone[data-id="move"]');
    const go = page.locator('.callout .co-go');
    for (const [type, text] of [['touch', 'Tap to open'], ['mouse', 'Click to open']]) {
      await page.evaluate((t) => document.dispatchEvent(
        new PointerEvent('pointerdown', { pointerType: t, bubbles: true })), type);
      await chip.focus();
      await page.evaluate(() => window.HOLOUI.frame());
      await expect(go).toHaveText(text);
      await chip.blur();
    }
    await page.keyboard.press('Shift');
    await chip.focus();
    await page.evaluate(() => window.HOLOUI.frame());
    await expect(go).toHaveText('Press Enter to open');
  });
});
