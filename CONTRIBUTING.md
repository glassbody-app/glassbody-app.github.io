# Contributing to Glassbody

How to run the tests, the rules a change has to follow, and how to rebuild
the files that scripts generate. How the page works inside is in
[docs/architecture.md](docs/architecture.md); the decisions behind it are in
[docs/decisions.md](docs/decisions.md).

## Setup

You need Node.js 22, Python 3.13, and `sh`, `curl` and `sed`, so macOS, Linux
or WSL on Windows. From the repository root:

```bash
npm ci
npx playwright install chromium
npm test
```

`npm test` first runs `test/vendor.sh`, which downloads the three libraries
into `vendor/` and writes `index.local.html` to load them from there. Both are
gitignored. The suite then starts `python3 -m http.server` on port 8765 and
stops if something else already holds that port; set `GLASSBODY_TEST_PORT` to
use another. The tests run in Chromium and draw WebGL through SwiftShader, so
they need no GPU. `python3` is also needed for the tests that run
`tools/ingest.py`.

## What the suites check

`test/regression.spec.js` drives Chromium through eight checks, in order: an
empty store opens the Data panel; the sample loads 45 days; erase leaves
nothing; the summed fixture imports 31 days, 12 walks, 25 doses, 10 days of
food, 4 alerts and 1 ECG; importing it again adds nothing; the averaged
fixture is refused; a reload keeps the data; the Movement page shows 7
charts, 12 walks and 11 routes. Further tests cover bad backups; check that
the Python and JavaScript ingesters build the same store from the same zip;
keep two same-minute doses of one medicine as two; check `--out` and
`--fresh` in `tools/ingest.py`; refuse oversized and unreadable zips in both
ingesters; load `index.html` and `index.local.html`, use every page and the
Data panel, and fail on a Content-Security-Policy violation, a request to
any other host or a cookie; check that no service worker registers while
the config blocks them; open the page at `glassbody.localhost`; and fail on
the old project name in any tracked file, outside the two names the browser
has already stored and the history in `docs/decisions.md` and `docs/specs/`.

`test/display.spec.js` checks that text on every screen is at least 12px and
4.5:1 against its background, that font sizes follow the browser setting,
that the pressed range button shows its focus ring, that at 390, 320 and 640
wide nothing runs off the screen and the hint and callout stay off the
region buttons, that at 1440 wide no card sits alone in a grid row, and that the
medication axis, hours, table numbers and dates, plurals and the last import
date are written one way.

`test/access.spec.js` checks keyboard use and screen readers: focus after
the Data panel closes and on each page, every control reached by Tab, chart
names and summaries, and the callout's wording. It also checks that reduced
motion and the Pause motion button stop the figure, and that Pause motion is
remembered.

`test/install.spec.js` checks that `manifest.webmanifest` has the fields the
spec names, that each icon is the size the manifest says (read from the PNG
header), that Chromium reads the manifest with no errors, and that
`tools/make_icons.js --svg-only` writes the committed `icons/icon.svg` byte for
byte.

`test/offline.spec.js` tests the service worker and is the only file that
lets one register. It does not use the suite's Python server: `test/serve.js`
serves a copy of the site and a stand-in for cdnjs, so a test can change a
file, serve a tampered library, or stop both servers to go offline. It checks
that the page works with both servers stopped after one visit; that the next
online load shows a changed file; that a new `CACHE` name leaves only the new
cache; that every request the page makes is in `SHELL` or `CDN` in `sw.js`;
that the `CDN` list matches the script tags in `index.html`; that the copy
holds exactly the files `.github/workflows/pages.yml` publishes; and that a
three.js with one byte changed never enters the cache.

`test/storage.spec.js` checks when the page asks for persistent storage (after
an import that adds records and after a restore, never on load or for the
sample), the Safari note for each kind of browser, the last-backup line, the
backup file name in the reader's own day, and the reminder after an import.

`test/docs.spec.js` checks the Open Graph tags in `index.html` and the size of
`img/og.png`, and that every relative link and image in `README.md`,
`CONTRIBUTING.md`, `SECURITY.md` and `docs/*.md` points at a file that exists.

CI runs `.github/workflows/test.yml` on every pull request and on every push
to a branch other than `main`: it compiles `tools/ingest.py` and
`tools/make_sample.py`, checks that the sample, the fixtures and `icons/icon.svg` regenerate byte for byte, and runs
`npm test`. A push to `main` runs the same workflow from
`.github/workflows/pages.yml`, which publishes the site only after it passes.

## Rules

- `tools/ingest.py` and `js/ingest.js` are the same parser twice. Change both
  or neither ([docs/architecture.md](docs/architecture.md), section 2). A test
  checks that they build the same store from the summed fixture.
- The page is classic scripts with no build step: no ES modules, no bundler,
  and no npm package loaded by the page. npm is for the tests and the tools.
- The three libraries are pinned cdnjs versions with integrity hashes.
  Bumping one means changing `index.html`, `test/vendor.sh` and the `CDN` list
  in `sw.js` together; a test compares `sw.js` with `index.html`. The README's
  Dependencies table and `docs/architecture.md`, section 1, name the versions
  too. three.js stays at 0.160.1, the last release with the UMD build.
- A new file the page loads from its own origin goes in `SHELL` in `sw.js`. A
  new file or folder the site publishes goes in the `cp` lines of
  `.github/workflows/pages.yml` and in `SITE_FILES` in `test/offline.spec.js`.
  Tests fail when these lists drift apart.
- No real health data in commits, issues or pull requests: no export, no
  backup, no screenshot of your own records. Use `data/sample.json` and the
  zips in `test/fixtures/`, which are invented.
- One change per commit, with a plain message that says what changed and
  why.

## Rebuilding the generated files

The sample and the test fixtures come from a seeded generator. Running it
again writes the same bytes, and CI checks that:

```bash
python3 tools/make_sample.py
```

The icons in `icons/` come from `data/body.json`. `tools/make_icons.js` traces
`icons/icon.svg` without a browser, then renders the four PNGs in Playwright's
Chromium:

```bash
npm run icons
```

CI runs `node tools/make_icons.js --svg-only` and fails if `icons/icon.svg`
changes. The PNGs come out the same on one machine with one Playwright
version; CI does not compare them.

The README screenshot, `docs/img/hero.png`, and the link-preview image,
`img/og.png`, come from the sample with the figure held still:

```bash
npm run screenshots
```

Like the PNG icons, they come out the same on one machine with one Playwright
version, not across machines. Rebuild them when the look changes.

The figure needs Blender 5.2.3. From the repository root, these two commands
rebuild `data/body.json` byte for byte from `data/raw/astra_figure.stl`:

```bash
/Applications/Blender.app/Contents/MacOS/Blender -b -P tools/refine_figure.py -- data/raw/astra_figure.stl figure/refined.stl
/Applications/Blender.app/Contents/MacOS/Blender -b -P tools/body_from_stl.py -- figure/refined.stl
```

That is the macOS path to Blender; elsewhere, use your Blender binary.
Adding `--preview` to the second command also renders `data/prev_front.png`
and `data/prev_three.png`, which are gitignored, after `data/body.json` is
written.
`figure/` is gitignored scratch space. `tools/make_body.py` builds a plainer
figure from Blender metaballs, with no source mesh. After the figure changes,
rebuild the icons and the screenshots, which are drawn from it.

## Reporting

Bugs go in the repository's issues, through the bug report form. Security
problems go through private reporting; see [SECURITY.md](SECURITY.md).
