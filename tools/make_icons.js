#!/usr/bin/env node
/* Make the page's icons from the figure in data/body.json.

       npm run icons
       node tools/make_icons.js --svg-only [--out DIR]

   The icon is the figure's front silhouette in the page's cyan on its
   background (docs/specs/glassbody-v1.md, section 2.2):

     1. project every triangle onto the front plane (x across, y up) and fill
        it into a 1024 x 1024 mask
     2. scale and centre the figure inside the maskable safe zone, a circle of
        radius 40% of the icon, and stop if any vertex falls outside it
     3. trace the mask's outline (marching squares), simplify it
        (Ramer-Douglas-Peucker, 1 px) and write icon.svg
     4. render icon.svg in Playwright's Chromium to the four PNGs

   Steps 1 to 3 use no browser and no arithmetic but + - * / and one square
   root, which IEEE 754 rounds one way everywhere (so no ** and no Math.sin),
   so icon.svg comes out byte for byte the same on any machine; CI
   checks that. The PNGs come out the same on one machine with one Playwright
   version. --svg-only stops after step 3; --out writes to DIR, not icons/. */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SIZE = 1024;
const SAFE_RADIUS = 0.4 * SIZE;
// the traced edge can sit half a pixel past a vertex, so fit the figure a little inside
const FIT_RADIUS = SAFE_RADIUS - 2;
const TOLERANCE = 1;   // px at 1024
const BG = '#04060c';  // --bg in css/style.css
const FG = '#34e0ff';  // --cy
const PNGS = [['icon-192.png', 192], ['icon-512.png', 512],
  ['icon-maskable-512.png', 512], ['apple-touch-icon.png', 180]];

/** A failure the script reports in one line: bad arguments, a bad figure file, or a figure outside the safe zone. */
class IconError extends Error {}

/**
 * Read the command line.
 * @param {string[]} args the arguments after the script name
 * @returns {{svgOnly: boolean, out: string}} what to make and where
 */
function parseArgs(args) {
  const opts = { svgOnly: false, out: path.join(ROOT, 'icons') };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--svg-only') opts.svgOnly = true;
    else if (args[i] === '--out' && i + 1 < args.length && !args[i + 1].startsWith('--')) {
      opts.out = path.resolve(args[++i]);
    } else throw new IconError('usage: node tools/make_icons.js [--svg-only] [--out DIR]');
  }
  return opts;
}

/**
 * Stop unless data/body.json has the shape docs/architecture.md section 5 gives.
 * @param {object} body data/body.json, parsed
 * @throws {IconError} naming the first region that does not
 */
function checkBody(body) {
  const regions = body && body.regions;
  if (!regions || typeof regions !== 'object' || Object.keys(regions).length === 0) {
    throw new IconError('data/body.json has no regions');
  }
  for (const [name, r] of Object.entries(regions)) {
    const ok = r && Array.isArray(r.pos) && Array.isArray(r.idx)
      && r.pos.length % 3 === 0 && r.idx.length % 3 === 0 && r.pos.every(Number.isFinite)
      && r.idx.every((k) => Number.isInteger(k) && k >= 0 && k < r.pos.length / 3);
    if (!ok) {
      throw new IconError(`data/body.json: region ${name} needs pos as x, y, z numbers `
        + 'and idx as three indexes into them per triangle');
    }
  }
}

/**
 * Project the figure onto its front plane.
 * @param {object} body data/body.json, parsed
 * @returns {{xy: number[], tris: number[]}} x, y pairs in centimetres, and
 *   three indexes into those pairs for every triangle of the five regions
 */
function projectFront(body) {
  const xy = [], tris = [];
  for (const name of Object.keys(body.regions).sort()) {
    const { pos, idx } = body.regions[name];
    const base = xy.length / 2;
    for (let i = 0; i < pos.length; i += 3) xy.push(pos[i], pos[i + 1]);
    for (const k of idx) tris.push(base + k);
  }
  return { xy, tris };
}

/**
 * Scale and centre the figure in the icon, y down, so the vertex farthest from
 * the centre of its bounding box lands on FIT_RADIUS.
 * @param {number[]} xy x, y pairs in centimetres, y up
 * @returns {number[]} x, y pairs in pixels of the 1024 icon
 */
function fitToIcon(xy) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < xy.length; i += 2) {
    x0 = Math.min(x0, xy[i]); x1 = Math.max(x1, xy[i]);
    y0 = Math.min(y0, xy[i + 1]); y1 = Math.max(y1, xy[i + 1]);
  }
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  let far2 = 0;   // squared distance of the farthest vertex
  for (let i = 0; i < xy.length; i += 2) {
    const dx = xy[i] - mx, dy = xy[i + 1] - my;
    far2 = Math.max(far2, dx * dx + dy * dy);
  }
  const scale = FIT_RADIUS / Math.sqrt(far2);
  return xy.map((v, i) => (i % 2 === 0 ? SIZE / 2 + (v - mx) * scale : SIZE / 2 - (v - my) * scale));
}

/**
 * Stop unless every vertex lies inside the maskable safe zone. fitToIcon
 * already fits them inside, so this fails only if that fit is broken.
 * @param {number[]} px x, y pairs in pixels
 * @throws {IconError} naming the first vertex outside, and how far out it is
 */
function checkSafeZone(px) {
  for (let i = 0; i < px.length; i += 2) {
    const dx = px[i] - SIZE / 2, dy = px[i + 1] - SIZE / 2;
    if (dx * dx + dy * dy > SAFE_RADIUS * SAFE_RADIUS) {
      throw new IconError(`vertex ${i / 2} at (${px[i]}, ${px[i + 1]}) is ${Math.sqrt(dx * dx + dy * dy)} px `
        + `from the centre, outside the safe zone of ${SAFE_RADIUS} px`);
    }
  }
}

/**
 * Which side of the line from a to b the point (x, y) is on, times twice the
 * triangle's area. The two ends are put in one order first, so the triangles
 * on either side of a shared edge get exactly opposite values and no pixel
 * centre on the seam falls through both.
 * @param {number} ax one end of the line
 * @param {number} ay
 * @param {number} bx the other end
 * @param {number} by
 * @param {number} x the point
 * @param {number} y
 * @returns {number} the signed value, 0 on the line
 */
function sideOf(ax, ay, bx, by, x, y) {
  if (ax > bx || (ax === bx && ay > by)) return -sideOf(bx, by, ax, ay, x, y);
  return (bx - ax) * (y - ay) - (by - ay) * (x - ax);
}

/**
 * Fill every triangle into a mask, a pixel being in when its centre is.
 * @param {number[]} px x, y pairs in pixels
 * @param {number[]} tris three indexes into px per triangle
 * @returns {Uint8Array} SIZE * SIZE cells, row by row, 1 inside the figure
 */
function fillMask(px, tris) {
  const mask = new Uint8Array(SIZE * SIZE);
  for (let t = 0; t < tris.length; t += 3) {
    const ax = px[2 * tris[t]], ay = px[2 * tris[t] + 1];
    const bx = px[2 * tris[t + 1]], by = px[2 * tris[t + 1] + 1];
    const cx = px[2 * tris[t + 2]], cy = px[2 * tris[t + 2] + 1];
    const turn = sideOf(ax, ay, bx, by, cx, cy);
    if (turn === 0) continue;   // seen edge-on
    const sign = turn > 0 ? 1 : -1;
    const i0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx) - 0.5));
    const i1 = Math.min(SIZE - 1, Math.floor(Math.max(ax, bx, cx) - 0.5));
    const j0 = Math.max(0, Math.ceil(Math.min(ay, by, cy) - 0.5));
    const j1 = Math.min(SIZE - 1, Math.floor(Math.max(ay, by, cy) - 0.5));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = i + 0.5, y = j + 0.5;
        if (sign * sideOf(ax, ay, bx, by, x, y) >= 0 && sign * sideOf(bx, by, cx, cy, x, y) >= 0
            && sign * sideOf(cx, cy, ax, ay, x, y) >= 0) mask[j * SIZE + i] = 1;
      }
    }
  }
  return mask;
}

/**
 * The marching-squares table. A cell's corners are four pixel centres, a b c d
 * clockwise from the top left, and its case is a*8 + b*4 + c*2 + d. Each entry
 * lists segments as [x0, y0, x1, y1] between edge midpoints, in half pixels from
 * corner a, turned so the inside is always on the same side; that is what lets
 * them chain into closed loops. In the two saddle cases the inside corners stay
 * apart.
 * @returns {number[][][]} 16 lists of segments
 */
function buildCaseTable() {
  const corners = [[0, 0], [2, 0], [2, 2], [0, 2]];
  // [corner, corner, midpoint] for the top, right, bottom and left edges
  const edges = [[0, 1, [1, 0]], [1, 2, [2, 1]], [2, 3, [1, 2]], [3, 0, [0, 1]]];
  const table = [];
  for (let c = 0; c < 16; c++) {
    const inside = [c & 8, c & 4, c & 2, c & 1].map(Boolean);
    const crossed = edges.filter(([p, q]) => inside[p] !== inside[q]);
    // each pair: two crossed edges, and an inside corner to orient them by
    let pairs = [];
    if (crossed.length === 2) pairs = [[crossed[0], crossed[1], corners[inside.indexOf(true)]]];
    else if (c === 10) pairs = [[edges[3], edges[0], corners[0]], [edges[1], edges[2], corners[2]]];
    else if (c === 5) pairs = [[edges[0], edges[1], corners[1]], [edges[2], edges[3], corners[3]]];
    table.push(pairs.map(([e, f, k]) => {
      const [p, q] = [e[2], f[2]];
      const turn = (q[0] - p[0]) * (k[1] - p[1]) - (q[1] - p[1]) * (k[0] - p[0]);
      return turn < 0 ? [p[0], p[1], q[0], q[1]] : [q[0], q[1], p[0], p[1]];
    }));
  }
  return table;
}

/**
 * Trace every boundary of the mask, outer edges and holes alike.
 * @param {Uint8Array} mask from fillMask
 * @returns {number[][]} closed loops of x, y pairs in half pixels, so pixel
 *   i's centre is at 2i + 1 and its right edge at 2i + 2
 */
function traceContours(mask) {
  const table = buildCaseTable();
  const at = (i, j) => (i >= 0 && j >= 0 && i < SIZE && j < SIZE ? mask[j * SIZE + i] : 0);
  const width = 2 * SIZE + 4;
  const key = (x, y) => (y + 1) * width + (x + 1);
  const next = new Map();   // segment start -> end, in the order cells are visited
  for (let j = -1; j < SIZE; j++) {
    for (let i = -1; i < SIZE; i++) {
      const c = at(i, j) * 8 + at(i + 1, j) * 4 + at(i + 1, j + 1) * 2 + at(i, j + 1);
      for (const [x0, y0, x1, y1] of table[c]) {
        const ox = 2 * i + 1, oy = 2 * j + 1;
        next.set(key(ox + x0, oy + y0), [key(ox + x1, oy + y1), ox + x1, oy + y1]);
      }
    }
  }
  const loops = [], seen = new Set();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop = [];
    for (let k = start; !seen.has(k);) {
      seen.add(k);
      const [to, x, y] = next.get(k);
      loop.push(x, y);
      k = to;
    }
    loops.push(loop);
  }
  return loops;
}

/**
 * Squared distance from the point (x, y) to the segment from a to b.
 * @param {number} ax one end of the segment
 * @param {number} ay
 * @param {number} bx the other end
 * @param {number} by
 * @param {number} x the point
 * @param {number} y
 * @returns {number} in the units of the arguments, squared
 */
function segmentDistance2(ax, ay, bx, by, x, y) {
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((x - ax) * dx + (y - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const ex = ax + t * dx - x, ey = ay + t * dy - y;
  return ex * ex + ey * ey;
}

/**
 * Ramer-Douglas-Peucker on a closed loop: split it at its first point and the
 * point farthest from that, and simplify both halves.
 * @param {number[]} loop x, y pairs in half pixels
 * @param {number} tolerance the largest distance a dropped point may lie from
 *   the simplified loop, in half pixels
 * @returns {number[]} the points kept, in loop order
 */
function simplifyLoop(loop, tolerance) {
  const n = loop.length / 2;
  let split = 0, split2 = -1;
  for (let i = 1; i < n; i++) {
    const dx = loop[2 * i] - loop[0], dy = loop[2 * i + 1] - loop[1], d2 = dx * dx + dy * dy;
    if (d2 > split2) { split = i; split2 = d2; }
  }
  const keep = new Uint8Array(n + 1);
  keep[0] = keep[split] = keep[n] = 1;
  const x = (i) => loop[2 * (i % n)], y = (i) => loop[2 * (i % n) + 1];
  const stack = [[0, split], [split, n]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let worst = -1, worstD = tolerance * tolerance;
    for (let i = a + 1; i < b; i++) {
      const d = segmentDistance2(x(a), y(a), x(b), y(b), x(i), y(i));
      if (d > worstD) { worst = i; worstD = d; }
    }
    if (worst >= 0) { keep[worst] = 1; stack.push([a, worst], [worst, b]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(loop[2 * i], loop[2 * i + 1]);
  return out;
}

/**
 * Build the icon's SVG: the background square and one even-odd path, a line
 * of path data per loop.
 * @param {number[][]} loops simplified loops in half pixels
 * @returns {string} the file's text
 */
function buildSvg(loops) {
  const d = loops.map((l) => {
    const pairs = [];
    for (let i = 0; i < l.length; i += 2) pairs.push(l[i] / 2 + ' ' + l[i + 1] / 2);
    return 'M' + pairs.join(' ') + 'Z';
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}">\n`
    + `<rect width="${SIZE}" height="${SIZE}" fill="${BG}"/>\n`
    + `<path fill="${FG}" fill-rule="evenodd" d="${d.join('\n')}"/>\n`
    + '</svg>\n';
}

/**
 * Render the SVG at each PNG size in Playwright's Chromium.
 * @param {string} svg the icon's text
 * @param {string} outDir where the PNGs go
 * @returns {Promise<void>}
 */
async function renderPngs(svg, outDir) {
  // only here, so --svg-only works without a browser installed
  const { chromium } = require('@playwright/test');
  const browser = await chromium.launch();
  try {
    for (const [name, size] of PNGS) {
      const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
      await page.setContent('<!doctype html><style>html,body{margin:0}'
        + 'svg{display:block;width:100vw;height:100vh}</style>' + svg);
      await page.screenshot({ path: path.join(outDir, name) });
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

/**
 * Make icon.svg, then the PNGs unless --svg-only is given.
 * @returns {Promise<void>}
 */
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const body = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/body.json'), 'utf8'));
  checkBody(body);
  const { xy, tris } = projectFront(body);
  const px = fitToIcon(xy);
  checkSafeZone(px);
  const loops = traceContours(fillMask(px, tris)).map((l) => simplifyLoop(l, 2 * TOLERANCE))
    .filter((l) => l.length >= 6);   // a speck simplified to two points encloses nothing
  const svg = buildSvg(loops);
  fs.mkdirSync(opts.out, { recursive: true });
  fs.writeFileSync(path.join(opts.out, 'icon.svg'), svg);
  console.log(`icon.svg: ${loops.length} loops, ${svg.length} bytes`);
  if (opts.svgOnly) return;
  await renderPngs(svg, opts.out);
  console.log(PNGS.map(([name]) => name).join(', '));
}

main().catch((e) => {
  // an IconError says all it needs to; anything else is unexpected and needs its stack
  console.error(e instanceof IconError ? e.message : e.stack);
  process.exit(1);
});
