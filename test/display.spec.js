// Display checks for the colour and type tokens, the narrow-screen layout and the
// chart formats, run against index.local.html with data/sample.json loaded.
const { test, expect } = require('@playwright/test');

const PAGES = ['move', 'heart', 'sleep', 'sound', 'fuel'];

/** Open the page with the sample stored, the Data panel shut and the range on `range`. */
async function openWithSample(page, range = 'All') {
  await page.route('**/favicon.ico', (r) => r.fulfill({ status: 204 }));
  await page.goto('index.local.html');
  await page.click('.sh-sample');
  await expect(page.locator('#dn')).toHaveText('45');
  await page.keyboard.press('Escape');
  await page.click(`#range button:has-text("${range}")`);
}

/** Show one region page and wait for its cards. */
async function showPage(page, id) {
  await page.evaluate((x) => { location.hash = x; }, id);
  await expect(page.locator('.page.on')).toBeVisible();
}

/** Every visible element with text of its own: size, weight, and contrast against what is behind it. */
function textReport() {
  const parse = (s) => (s.match(/[\d.]+/g) || []).map(Number);
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  const page = parse(getComputedStyle(document.body).backgroundColor);
  // what is behind an element: its backgrounds, outermost first, laid over the page colour
  const behind = (el) => {
    const layers = [];
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      const c = parse(getComputedStyle(e).backgroundColor);
      if (c.length === 4 && c[3] === 0) continue;
      layers.unshift(c);
      if (c.length === 3) break;
    }
    return layers.reduce((acc, c) => {
      const a = c.length === 4 ? c[3] : 1;
      return acc.map((v, i) => c[i] * a + v * (1 - a));
    }, page);
  };
  const out = [];
  document.querySelectorAll('body *').forEach((el) => {
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!own || !el.getClientRects().length) return;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || el.closest('[hidden]')) return;
    if (el.disabled || el.closest(':disabled') || el.querySelector(':disabled')) return;
    const svg = el instanceof SVGElement;
    const fg = parse(svg ? cs.fill : cs.color);
    out.push({
      what: (el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className)
        + ' ' + el.tagName + ' "' + el.textContent.trim().slice(0, 24) + '"',
      size: parseFloat(cs.fontSize),
      weight: Number(cs.fontWeight),
      contrast: Math.round(ratio(fg, behind(el)) * 100) / 100,
    });
  });
  return out;
}

/** Fail with the list of elements that break the size, weight or contrast floor. */
async function expectReadableText(page, where) {
  const bad = (await page.evaluate(textReport)).filter((t) =>
    t.size < 12 || (t.size < 13 && t.weight < 500) || t.contrast < 4.5);
  expect(bad, where).toEqual([]);
}

test.describe('colour and type', () => {
  test('text is 12px or larger, 500 weight under 13px, and 4.5:1 against its background', async ({ page }) => {
    await openWithSample(page);
    await page.focus('.zone[data-id="heart"]');
    await expect(page.locator('.callout')).toBeVisible();
    await expectReadableText(page, 'hologram with the callout');
    for (const id of PAGES) {
      await showPage(page, id);
      await expectReadableText(page, id);
    }
    await page.evaluate(() => { location.hash = ''; window.GlassbodyPanel.open(); });
    await page.click('.sh-erase');
    await expectReadableText(page, 'Data panel with the Erase question');
  });

  test('the font size follows the browser setting', async ({ page }) => {
    await openWithSample(page);
    await page.addStyleTag({ content: 'html { font-size: 20px; }' });
    await showPage(page, 'fuel');
    expect(await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.card .note')).fontSize)))
      .toBe(17.5);
  });

  test('the focus ring on the pressed range button stands out from its fill', async ({ page }) => {
    await openWithSample(page, '7 days');
    // a key press first, so focus() counts as keyboard focus
    await page.keyboard.press('Shift');
    await page.locator('#range button[aria-pressed="true"]').focus();
    const s = await page.evaluate(() => {
      const cs = getComputedStyle(document.activeElement);
      return { visible: document.activeElement.matches(':focus-visible'),
        ring: cs.outlineColor, fill: cs.backgroundColor, width: parseFloat(cs.outlineWidth) };
    });
    expect(s.visible).toBe(true);
    expect(s.width).toBeGreaterThanOrEqual(2);
    const rgb = (x) => x.match(/[\d.]+/g).slice(0, 3).map(Number);
    const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
    const [a, b] = [lum(rgb(s.ring)), lum(rgb(s.fill))];
    // WCAG 1.4.11: 3:1 for the parts of a control that show its state
    expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toBeGreaterThanOrEqual(3);
  });
});

/** Rectangles of the elements matching a selector, as plain objects. */
const boxes = (page, sel) => page.$$eval(sel, (els) => els.map((e) => {
  const r = e.getBoundingClientRect();
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height };
}));
const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

for (const [w, h] of [[390, 844], [320, 640], [320, 568], [640, 400]]) {
  test.describe(`at ${w}x${h}`, () => {
    test.use({ viewport: { width: w, height: h } });

    test('the range buttons sit on one line each, inside the screen, clear of the Data button', async ({ page }) => {
      await openWithSample(page, '7 days');
      const range = await boxes(page, '#range button');
      const data = (await boxes(page, '.datab'))[0];
      for (const b of range) {
        expect(b.right).toBeLessThanOrEqual(w);
        expect(b.height).toBeLessThan(40);
        expect(overlaps(b, data)).toBe(false);
      }
      expect(data.right).toBeLessThanOrEqual(w);
    });

    test('the hint and the callout stay off the chips, off their region and on screen', async ({ page }) => {
      await openWithSample(page, '7 days');
      const chips = await boxes(page, '.zone');
      const hint = (await boxes(page, '.hint'))[0];
      chips.forEach((c) => expect(overlaps(c, hint)).toBe(false));
      for (const id of ['move', 'heart', 'sleep', 'sound', 'fuel']) {
        await page.focus(`.zone[data-id="${id}"]`);
        await expect(page.locator('.callout')).toBeVisible();
        // place the box now rather than wait for the figure's next animation frame
        await page.evaluate(() => window.HOLOUI.frame());
        const co = (await boxes(page, '.callout'))[0];
        // focusing a chip can scroll the page, so measure the chips again
        const at = (b) => `${Math.round(b.left)},${Math.round(b.top)}-${Math.round(b.right)},${Math.round(b.bottom)}`;
        (await boxes(page, '.zone')).forEach((c) =>
          expect(overlaps(c, co), `${id}: callout ${at(co)} over chip ${at(c)}`).toBe(false));
        expect(co.right, id).toBeLessThanOrEqual(w);
        expect(co.top, id).toBeGreaterThanOrEqual(0);
        expect(co.bottom, id).toBeLessThanOrEqual(h);
        const a = await page.evaluate((x) => {
          const p = window.HOLO.anchor(x), s = document.getElementById('stage').getBoundingClientRect();
          return { x: p.x + s.left, y: p.y + s.top };
        }, id);
        const inside = a.x > co.left && a.x < co.right && a.y > co.top && a.y < co.bottom;
        // under 640 tall (320x568, and 1280 at 200% zoom) the band between header and
        // chips can be too short for the box on either side of a mid-body region, so
        // there only the chips and the screen edge are checked
        if (h >= 640) {
          expect(inside, `${id} anchor ${Math.round(a.x)},${Math.round(a.y)} under the callout ${at(co)}`)
            .toBe(false);
        }
      }
    });

    test('no page is wider than the screen, and a clipped table fades at its edge', async ({ page }) => {
      await openWithSample(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(w);
      for (const id of PAGES) {
        await showPage(page, id);
        expect(await page.evaluate(() => document.documentElement.scrollWidth), id).toBeLessThanOrEqual(w);
      }
      await showPage(page, 'move');
      await expect(page.locator('.tblbox')).toHaveClass(/\bmore\b/);
      await page.$eval('.tbl', (t) => { t.scrollLeft = t.scrollWidth; });
      await expect(page.locator('.tblbox')).not.toHaveClass(/\bmore\b/);
    });

    test('date labels under the charts never touch, and no y axis goes below zero', async ({ page }) => {
      await openWithSample(page);
      for (const id of PAGES) {
        await showPage(page, id);
        const gaps = await page.$$eval('.page .plot svg', (svgs) => svgs.map((svg) => {
          // bottom axes only; the medication names run down the left side
          const r = [...svg.querySelectorAll('.axis[transform] .tick text')]
            .map((t) => t.getBoundingClientRect()).filter((b) => b.width).sort((a, b) => a.left - b.left);
          return Math.min(Infinity, ...r.slice(1).map((b, i) => b.left - r[i].right));
        }));
        gaps.forEach((g) => expect(g, id).toBeGreaterThanOrEqual(4));
        const neg = await page.$$eval('.page .grid .tick text', (t) => t.map((x) => x.textContent)
          .filter((x) => /^[-−]/.test(x)));
        expect(neg, id).toEqual([]);
      }
    });
  });
}

test('at 1440 wide the grid has two columns and no card sits alone in a row', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWithSample(page);
  for (const id of PAGES) {
    await showPage(page, id);
    const cards = await boxes(page, '.page .cards > .card');
    const rows = {};
    cards.forEach((c) => { (rows[Math.round(c.top)] = rows[Math.round(c.top)] || []).push(c); });
    Object.values(rows).forEach((r) => {
      expect(r.length, id).toBeLessThanOrEqual(2);
      // one card in a row spans the row
      if (r.length === 1) expect(r[0].right - r[0].left, id).toBeGreaterThan(1000);
    });
  }
});

test.describe('chart and number formats', () => {
  test('the medication axis counts in whole numbers, each once', async ({ page }) => {
    await openWithSample(page, '7 days');
    await showPage(page, 'fuel');
    const ticks = await page.$$eval('.page .card .grid .tick text', (t) => t.map((x) => x.textContent));
    expect(ticks.length).toBeGreaterThan(1);
    expect(ticks.every((t) => /^\d+$/.test(t))).toBe(true);
    expect(new Set(ticks).size).toBe(ticks.length);
  });

  test('hours are written one way, and sleep tooltips name the stage', async ({ page }) => {
    await openWithSample(page, '7 days');
    await showPage(page, 'sleep');
    const kpis = await page.$$eval('.kpi .v', (v) => v.map((x) => x.textContent));
    [kpis[0], kpis[2], kpis[3]].forEach((k) => expect(k).toMatch(/^(\d+h )?\d{1,2}m$/));
    const tips = await page.$$eval('.page .card .plot rect title', (t) => t.map((x) => x.textContent));
    expect(tips.length).toBeGreaterThan(0);
    tips.forEach((t) => {
      expect(t).toMatch(/^[A-Z][a-z]{2} \d{1,2} · ((Deep|Core|REM|Awake) )?(\d+h )?\d{1,2}m$/);
      expect(t).not.toMatch(/60m$/);
    });
    expect(tips.filter((t) => / Deep /.test(t)).length).toBe(7);
    const axis = await page.$$eval('.page .card .grid .tick text', (t) => t.map((x) => x.textContent));
    axis.forEach((a) => expect(a).toMatch(/^[\d.]+h$/));
  });

  test('tables use the page date format, separators, one reading, and food newest first', async ({ page }) => {
    await openWithSample(page);
    await showPage(page, 'heart');
    const when = await page.$$eval('.page tbody tr td:first-child', (t) => t.map((x) => x.textContent));
    when.forEach((w) => expect(w).toMatch(/^[A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}$/));
    await expect(page.locator('.page td.n', { hasText: '@' }).first()).toHaveText(/^\d{1,3}(,\d{3})* @ \d+ Hz$/);
    // the range control is on the hologram screen
    await page.evaluate(() => { location.hash = ''; });
    await page.click('#range button:has-text("7 days")');
    await showPage(page, 'heart');
    await expect(page.locator('.dl2')).not.toContainText(/\b1 readings\b/);
    await showPage(page, 'fuel');
    const food = page.locator('.card', { hasText: 'Food logged' });
    const dates = await food.locator('tbody td:first-child').allTextContents();
    const ms = dates.map((d) => Date.parse(d + ' 2026'));
    expect(ms).toEqual([...ms].sort((a, b) => b - a));
    expect(await food.locator('tbody td.n').first().evaluate((td) => getComputedStyle(td).textAlign)).toBe('right');
    expect(await page.locator('.card', { hasText: 'Every logged dose' }).locator('tbody td').nth(2)
      .evaluate((td) => getComputedStyle(td).textAlign)).toBe('left');
  });

  test('the last import date is the local calendar day', async ({ browser }) => {
    const ctx = await browser.newContext({ timezoneId: 'America/New_York' });
    const page = await ctx.newPage();
    await openWithSample(page);
    // 21:00 on Oct 28 in New York is 01:00Z on Oct 29
    await page.evaluate(() => window.HealthStore.load().then((s) => {
      s.meta.updated = '2026-10-29 01:00Z'; window.Glassbody.setData(s);
    }));
    await expect(page.locator('#upd')).toHaveText(' · last import Oct 28');
    await ctx.close();
  });
});
