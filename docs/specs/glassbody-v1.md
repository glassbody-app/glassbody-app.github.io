# Glassbody v1 spec

Status: approved 2026-11-05. Nothing in it is built yet.

v1 renames Body Scan to Glassbody, makes the hosted page installable and
usable offline, adds storage safeguards, documents importing on an iPhone,
and rewrites the README for people who want to see their own data, with the
developer material further down. The decisions behind it are in `docs/decisions.md`, in the two entries
dated 2026-11-05.

The page today: a static site with no build step and no backend. Five classic
scripts read a Health Auto Export zip in the browser and keep the records in
IndexedDB (`docs/architecture.md`). `npm test` runs 76 Playwright tests in
Chromium, and CI runs them on every push.

The site will be `https://glassbody.github.io/`, published from the
repository `glassbody/glassbody.github.io`.

## Contents

1. Rename to Glassbody
2. Installable web app
3. Storage safeguards
4. iPhone
5. README, community files and meta tags
6. Pre-publish check and publish steps
7. Test seams
8. Slices
9. Risks
10. Rollback

## 1. Rename to Glassbody

Every name a person sees, and every name in the code, becomes Glassbody. Two
names that browsers have already stored stay as they are, so data and
settings saved before the rename are still found:

- the IndexedDB database `body-scan` (`js/store.js:8`)
- the localStorage key `body-scan-motion`, which holds the Pause motion
  choice (`js/holo.js:9`)

`docs/architecture.md` gets a sentence saying why these two keep the old name.

What changes, with line numbers as they stood before the rename:

| File | Line | Change |
| --- | --- | --- |
| `index.html` | 10, 23 | `<title>` and `<h1>` become Glassbody |
| `js/ui.js` | 626 | back link `← Body scan` becomes `← Glassbody` |
| `js/ui.js` | 900 | `document.title`: `<page> · Glassbody` and `Glassbody` |
| `js/ui.js` | 935, 939 | globals `BodyScan` and `BodyScanPanel` become `Glassbody` and `GlassbodyPanel` |
| `js/data-panel.js` | 1, 117, 317 | same two globals, and the file comment |
| `js/data-panel.js` | 198 | backup file name `glassbody-backup-<YYYY-MM-DD>.json` |
| `js/data-panel.js` | 218 | `Glassbody is open in another tab. Close it to finish erasing.` |
| `js/store.js` | 65 | `This file is not a Glassbody backup.` |
| `tools/ingest.py` | 9, 23 | default output `~/glassbody/health.json` |
| `playwright.config.js` | 5, 6 | `BODY_SCAN_TEST_PORT` becomes `GLASSBODY_TEST_PORT` |
| `package.json` | 2, 4 | name `glassbody`, description |
| `CITATION.md` | 3, 5, 11, 13 | title `Glassbody: a browser-only viewer for Apple Health exports`, BibTeX key `nasser_glassbody_2026` |
| `README.md` | 1, 50, 51, 75, 118 | the name, `glassbody.localhost`, the ingester path, the port variable |
| `docs/architecture.md` | 12, 13 | the two globals |
| `.gitignore` | 5 | add `glassbody-backup-*.json`; keep `body-scan-backup-*.json`, since older backups may still sit in a working copy |

Restoring a backup made before the rename keeps working: restore reads the
file's contents and ignores its name.

Anyone who ran `tools/ingest.py` before the rename has a store at
`~/body-scan/health.json`. They move it to `~/glassbody/` or pass `--out`.
The README's local-serving section changes `body-scan.localhost` to
`glassbody.localhost`; data kept at the old address stays there until a
backup moves it, as the README already says for any change of address.

Tests to update:

- `test/access.spec.js:49, 60`: the page titles
- `test/display.spec.js:81, 267` and `test/regression.spec.js:46, 139`: the globals
- `test/regression.spec.js:316-320`: the ingester's default path
- `test/regression.spec.js:518-524`: the test of `glassbody.localhost`
- `test/regression.spec.js:598`: the erase-blocked message
- the temporary-directory prefixes `body-scan-` in `test/regression.spec.js`
  become `glassbody-`

The checks for the database name (`test/regression.spec.js:92, 96, 593`)
stay, because the name stays.

New test, in `test/regression.spec.js`: run `git grep -n -i -E "body.?scan"`
over the tracked files and fail on any hit outside this allowlist:

- `'body-scan'` as the database name, in `js/store.js` and the tests
- `body-scan-motion`, in `js/holo.js` and the tests
- `body-scan-backup-*.json` in `.gitignore`
- the sentence about the kept names in `docs/architecture.md`
- anything in `docs/decisions.md` and `docs/specs/`, which record history
- the new test itself

## 2. Installable web app

### 2.1 Manifest

`manifest.webmanifest` at the site root:

```json
{
  "name": "Glassbody",
  "short_name": "Glassbody",
  "description": "Your Apple Health export on a rotating figure, read and kept in this browser.",
  "id": "./",
  "start_url": "./",
  "scope": "./",
  "display": "standalone",
  "background_color": "#04060c",
  "theme_color": "#04060c",
  "icons": [
    { "src": "icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "icons/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

The colours are `--bg` from `css/style.css`. Relative URLs keep the manifest
correct on any host, including the local server.

New tags in the `<head>` of `index.html`:

```html
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" href="icons/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
<meta name="theme-color" content="#04060c">
```

The tests answer `favicon.ico` with a 204 because the page had no icon. That
route stays and stops mattering once the page names its icon.

### 2.2 Icons

The icon is the figure's front silhouette in the page's cyan (`--cy`,
`#34e0ff`) on its background (`#04060c`). `tools/make_icons.js`, a Node
script, makes every icon file from `data/body.json`:

1. Project every triangle of the five regions onto the front plane (x
   across, y up) and fill them into a 1024 × 1024 mask, in plain JavaScript.
2. Scale and centre the figure so that every vertex lies inside the maskable
   safe zone, a circle of radius 40% of the icon around its centre. Stop with
   an error if a vertex falls outside.
3. Trace the mask's contours (marching squares), simplify them
   (Ramer-Douglas-Peucker, tolerance 1 px at 1024), and write
   `icons/icon.svg`: a square background and one even-odd path, under 10 KB.
   Steps 1 to 3 use no browser, so the SVG comes out byte for byte the same
   on any machine.
4. Render the SVG in Playwright's Chromium (already a dev dependency) and
   write `icons/icon-192.png`, `icons/icon-512.png`,
   `icons/icon-maskable-512.png` and `icons/apple-touch-icon.png` (180 × 180).
   The figure fills the safe zone in all of them; the maskable file is the
   same art at the same size.

`npm run icons` runs the script. `node tools/make_icons.js --svg-only` stops
after step 3. The icon files are committed, because GitHub Pages serves the
repository as it is. CI runs the `--svg-only` form and fails on a diff, as it
already does for `tools/make_sample.py`. The PNGs come out the same on one
machine with one Playwright version; CI does not compare them.

If tracing the contour costs more than it is worth, the fallback is a PNG
favicon (`icons/icon-192.png`), recorded in `docs/decisions.md`.

### 2.3 Service worker

`sw.js` at the site root, so its scope is the whole site. It is a classic
worker script, like the page's scripts.

At the top it lists what it precaches:

- `SHELL`: `./`, `index.html`, `manifest.webmanifest`, `css/style.css`,
  `fonts/fonts.css`, the eight `.woff2` files in `fonts/`, the six files in
  `js/`, `data/body.json`, `data/sample.json` and the five files in `icons/`
- `CDN`: the three cdnjs URLs from `index.html`, each with its `integrity`
  hash

One cache, named by a constant `CACHE = 'glassbody-1'`. The number changes
only when what the cache holds changes shape; file updates do not need it.

On install, it fetches every `SHELL` entry with `cache: 'reload'` (past the
HTTP cache) and every `CDN` entry as
`new Request(url, { mode: 'cors', credentials: 'omit', integrity })`, then
puts them all in the cache. If any fetch fails, or a cdnjs file fails its
hash, the install fails and the browser tries again on a later visit. A
changed cdnjs file therefore never enters the cache. Then `skipWaiting()`.

On activate, it deletes every cache whose name is not `CACHE`, then calls
`clients.claim()`.

On fetch, it handles GET requests only:

- A `CDN` URL: answer from the cache; on a miss, fetch it with its integrity
  hash and cache it. These URLs are pinned versions and never change.
- A same-origin URL: fetch from the network with `cache: 'no-cache'`, so the
  browser revalidates even when GitHub Pages' `max-age=600` would let it
  reuse a copy. A 200 response goes into the cache and to the page. When the
  fetch fails (no network, server gone), answer from the cache, and for a
  navigation with no cached match, answer with the cached `index.html`.
  Error statuses and partial (206) responses are passed through and never
  cached.
- Anything else goes to the network untouched. The page's CSP allows no
  other host, so nothing should reach this branch.

Same-origin files fetched at run time are cached too, which is how
`index.local.html` and `vendor/` end up cached when someone serves the
repository locally with the worker on.

So: one online visit is enough to work offline, because everything is
precached at install. Every online load gets the server's current files, so
an update shows on the next load and the tests never see an old file. The
cost is that a connection that hangs, instead of failing, makes the page
wait for it, as it would without a worker.

When a new `sw.js` is published, the browser finds it on the next navigation
and the new worker takes over at once. The page needs no "update ready"
prompt, because the files it fetches are already fresh.

### 2.4 Registration

`js/sw-register.js`, a classic script loaded last, after `js/data-panel.js`:

```js
/* Registers sw.js, which keeps the page working offline after the first
   visit (docs/architecture.md, section 6). */
(function () {
  'use strict';
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js').catch(function (e) { console.debug(e); });
  });
})();
```

It registers after `load`, so the worker's precache doesn't compete with the
first visit's own downloads. A failed or blocked registration logs at debug
level only: the regression suite fails on any console error.

`test/vendor.sh` deletes this script tag from `index.local.html`, and fails
if the tag is still there afterwards. `index.local.html` is the page for
people who want no request to cdnjs; a worker registered from it would still
precache from cdnjs, because the worker's fetches are not bound by the page's
CSP. The README says `index.local.html` does not install offline support.

### 2.5 Content-Security-Policy

Two directives are added to the meta CSP in `index.html`:
`worker-src 'self'` and `manifest-src 'self'`. Both already fall back to
`default-src 'self'`; naming them shows the policy was written with a worker
and a manifest in mind. The `script-src 'self' https://cdnjs.cloudflare.com;`
segment stays character for character, because `test/vendor.sh` rewrites it
with `sed`.

The worker's own fetches to cdnjs are not governed by the page's CSP. The
`CDN` list and its integrity hashes limit what it fetches instead, and a test
checks that list against `index.html`.

### 2.6 Tests

`playwright.config.js` sets `serviceWorkers: 'block'` under `use`, so no
existing test can be answered by a worker. A test in
`test/regression.spec.js` loads `index.html` twice under that setting and
checks that `navigator.serviceWorker.controller` is still `null`.

`test/install.spec.js` (slice 2):

- `manifest.webmanifest` parses, has the fields above, and every icon it
  names exists with the width and height its `sizes` says, read from the
  PNG's IHDR chunk.
- `icons/apple-touch-icon.png` is 180 × 180.
- Chromium reports no manifest errors: a DevTools session
  (`page.context().newCDPSession(page)`) calls `Page.getAppManifest` and gets
  an empty `errors` list.
- Running `tools/make_icons.js --svg-only` into a temporary folder writes the
  same `icon.svg` as the committed one.

`test/offline.spec.js` (slice 3) is the only file that sets
`test.use({ serviceWorkers: 'allow' })`. It does not use the suite's Python
server. A small Node server in `test/serve.js` serves a temporary copy of the
site, and a second one, on another port, stands in for cdnjs, serving the
files in `vendor/` with `Access-Control-Allow-Origin: *`. The copy's
`index.html`, `sw.js` and CSP point at the stand-in instead of cdnjs. With
both servers in the test's hands it can change a file, serve a tampered
library, or stop serving altogether. That last one is how the tests go
offline: the browser sees refused connections. Nothing here relies on
Playwright routing a service worker's requests.

The tests:

- After one visit, once `navigator.serviceWorker.ready` resolves, stop both
  servers and reload. The figure draws, the sample loads 45 days, the summed
  fixture imports, and `#move` shows its charts.
- With the servers running, change the copy's `<h1>` and reload once. The
  new text shows.
- Change `CACHE` in the copy's `sw.js` and reload. `caches.keys()` lists the
  new cache only.
- Every request the page makes while each region page and the Data panel are
  used is a `SHELL` or `CDN` entry. `favicon.ico` is the one exception.
- The `CDN` list in `sw.js` has the same URLs and integrity hashes as the
  script tags in `index.html`. The test reads `sw.js` in Node's `vm` with a
  stub `self`.
- The stand-in serves a three.js file with one byte changed. The worker never
  activates, and the cache holds no copy of that file.

## 3. Storage safeguards

### 3.1 Persistent storage

After an import that adds at least one record, and after any restore,
`js/data-panel.js` asks for persistent storage:

```js
function keep() {
  var s = navigator.storage;
  if (!s || !s.persist || !s.persisted) return;
  s.persisted().then(function (p) { return p || s.persist(); }).catch(function () {});
}
```

It is never called on page load or for the sample. Firefox answers
`persist()` with a permission prompt, so the prompt should come once there is
something worth keeping. Chrome, Edge and Safari decide from the visitor's
history with the site and show no prompt ([MDN, "Storage quotas and eviction
criteria"](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)).
WebKit names one of its rules: whether the page runs from the Home Screen
([WebKit, "Updates to Storage
Policy"](https://webkit.org/blog/14403/updates-to-storage-policy/)). The
answer is not shown on the page.

### 3.2 The Safari note

Safari deletes what a site has stored (IndexedDB included) after 7 days of
Safari use without a visit to the site. Web apps added to the Home Screen
keep their own count of days, and WebKit does not expect their data to be
deleted ([WebKit, "Full Third-Party Cookie Blocking and
More"](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/)).

The Data panel shows one line, `<p class="sh-note sh-keep">`, under the
status line, when both of these hold:

- The browser is on iPhone or iPad: the user agent contains `iPhone`, `iPad`
  or `iPod`, or it contains `Macintosh` and `navigator.maxTouchPoints > 1`
  (iPadOS asks for desktop pages with a Mac user agent). Every browser on
  these devices uses WebKit, so the note does not try to tell them apart. Or
  the browser is Safari on a Mac: `Macintosh`, `Version/` and `Safari/` in the
  user agent, and none of `Chrome`, `Chromium`, `Edg`, `Firefox`.
- The page is not running as an installed app:
  `matchMedia('(display-mode: standalone)')` does not match and
  `navigator.standalone` is not `true`.

The wording on iPhone and iPad:

> Safari deletes what this page stores after 7 days of use without a visit.
> Add Glassbody to your Home Screen (Share, then Add to Home Screen), open it
> from there, and import your export there.

The wording on a Mac:

> Safari deletes what this page stores after 7 days of use without a visit.
> Download a backup after each import.

The Mac wording asks for backups because neither WebKit post says whether
web apps added to the Dock are exempt.

The note cannot be dismissed. The iPhone wording may change after the
Simulator check (section 4), which finds out whether a Home Screen app sees
what Safari stored. Forum reports and an old WebKit bug say it does not; no
Apple documentation says either way.

### 3.3 Last backup date and reminder

`js/store.js` keeps a second record in the same object store, under the key
`backup`, holding `{ at: <stamp> }`, the same UTC stamp format as
`meta.updated`. Two new functions on `HealthStore`:

- `markBackup()` writes the record with the current stamp.
- `lastBackup()` resolves to the stamp or `null`. Like `load()`, it never
  creates the database.

Erase deletes the database, and the record with it. Restore and the sample
leave it alone. `load()` reads only the `current` record, so code from before
this change ignores the new record.

`js/data-panel.js`:

- Clicking Download backup calls `markBackup()` after the download starts,
  then repaints. The page cannot tell whether the file was saved, so the line
  says "downloaded".
- A new line in the Backup section, `<p class="sh-note sh-last">`, shown only
  while something is stored: `Last backup downloaded Nov 5, 2026.` in the
  reader's own calendar day, or `No backup downloaded from this browser
  yet.`
- An import that adds records ends its message with
  `Download a backup to keep a copy outside this browser.` An import that adds
  nothing, a restore, and the sample get no reminder.

`SUMMED_ADDED` in `test/regression.spec.js` gains the reminder sentence.

### 3.4 Tests

`test/storage.spec.js` (slice 4):

- An init script replaces `navigator.storage.persisted` (resolving `false`)
  and `navigator.storage.persist` with versions that count calls. Then: page
  load, 0 calls. Sample, 0. Erase and import the summed fixture, 1. Import it
  again (nothing new), still 1. Restore a backup, 2.
- With the default Chromium user agent, no note. With an iPhone Safari user
  agent, the iPhone wording. The same with `navigator.standalone` stubbed
  `true`: no note. A Mac user agent with `maxTouchPoints` stubbed to 5: the
  iPhone wording. Mac Safari: the Mac wording. Mac Chrome and Mac Firefox: no
  note.
- With the sample loaded, `.sh-last` says `No backup downloaded from this
  browser yet.` After Download backup (waiting for Playwright's `download`
  event), it says `Last backup downloaded <today>.`, and still does after a
  reload. After Erase, the line is hidden. After the sample loads again, it
  says no backup again.
- Importing the summed fixture ends `.sh-msg` with the reminder. Importing it
  again does not.

## 4. iPhone

### 4.1 The Simulator check

The check runs in Xcode's iOS Simulator, against the repository served
locally with `python3 -m http.server 8000 --bind 127.0.0.1`. The Simulator
reaches the Mac's servers at `localhost`. The page is opened as
`http://localhost:8000/`, which counts as a secure origin under the W3C
Secure Contexts rules, so the service worker can register. Step 2 confirms
it does. Only the synthetic fixture
`test/fixtures/sample-summed.zip` is used.

A coding agent can run every step below with a tool that opens URLs, taps
and takes screenshots in the Simulator, working from one screenshot to the
next. That makes the check repeatable, but it is not a script and it is not
in CI.

1. In Safari, open `http://localhost:8000/test/fixtures/sample-summed.zip`
   and download it. It lands in Files, in Downloads.
2. Open `http://localhost:8000/`. The Data panel opens on an empty store, and
   the iPhone note shows.
3. Tap "choose a file", then Choose File, then Downloads, then
   `sample-summed.zip`. The message reads
   `Added 31 days, 12 walks, 25 doses, 10 days of food, 4 alerts and 1 ECG.`
   followed by the reminder.
4. Close the panel. Open Movement and Heart and lungs; record how they lay out
   at phone width.
5. Tap Download backup and record where the file goes. The last-backup line
   shows today's date.
6. Share, then Add to Home Screen. Open Glassbody from the Home Screen.
   Record whether it shows the records imported in Safari. The note is gone.
7. If the Home Screen app is empty, import the zip there, and restore the
   backup from step 5.
8. Stop the server, then close and reopen the Home Screen app. The page
   loads, the figure draws, and the stored records show.

Each step keeps a screenshot as evidence. The screenshots are not committed.
The results go into `docs/decisions.md` as a dated entry: the Xcode and iOS
versions, the device, what each step showed, and the answer to step 6.

Left to manual checks:

- An import of a real Health Auto Export export on a real iPhone, by the
  maintainer, on the hosted page after publishing. Nothing is uploaded, and a
  fix ships by pushing, so this check follows the publish and does not gate
  it.
- Whether Safari granted persistent storage. That needs Safari's Web
  Inspector, attached from a Mac; it is optional.
- The 7-day deletion itself. The Simulator cannot fast-forward a week of
  Safari use.

### 4.2 Changes that follow the check

- If step 6 shows the Home Screen app sharing Safari's records, the iPhone
  note drops "and import your export there". Its test changes to match.
- The README's iPhone section (section 5.2) is written from what the check
  found.

## 5. README, community files and meta tags

### 5.1 Screenshots

`tools/make_screenshots.js` uses Playwright to start the Python server on a
free port, load `index.local.html` in Chromium (with the SwiftShader flags
from `playwright.config.js`), load the sample, close the Data panel and press
Pause motion. Still mode holds the figure's clock, so the frame does not
depend on timing. It writes two files:

- `docs/img/hero.png`: the main screen at 1280 × 800, for the README
- `img/og.png`: 1200 × 630, published with the site for link previews

`npm run screenshots` runs `test/vendor.sh` and then the script. Both images
are committed and rebuilt when the look changes.

### 5.2 README

The README is rewritten for a person who wants to see their own data. The
developer material moves down or into `CONTRIBUTING.md`. In this order:

1. `# Glassbody`, one sentence on what it is, and the hero screenshot with
   alt text.
2. Try it, in three steps: open `https://glassbody.github.io/`; load the
   sample to look around, or import your Health Auto Export zip from the
   Data panel; install it (Add to Home Screen on iPhone and iPad, the install
   button in Chrome and Edge). It works offline after the first visit,
   installed or not.
3. Privacy, kept from the current README and updated: the service worker
   caches the page's files and the three libraries; GitHub, as the host, sees
   the visitor's IP address and the files requested, as any web host does;
   records never leave the browser.
4. Where the data comes from: a link to Health Auto Export on the App Store
   (https://apps.apple.com/us/app/health-auto-export-json-csv/id1115567069).
   Manual export needs its Basic tier, $2.99 one-time on the US App Store on
   2026-11-05; the free tier has widgets and charts only. Use Export All,
   CSV, aggregation Sum. The export steps are left to the app; no screenshot
   walkthrough.
5. On iPhone and iPad: add to the Home Screen, save the export zip to Files,
   then Data, choose a file, Choose File, and pick the zip. Backups land in
   Files, in Downloads. Written from the Simulator check.
6. Keeping your data: what the browser keeps; the persistent-storage request;
   Safari's 7 days and the Home Screen; backups and the last-backup line.
7. Running it locally: the current section, with `glassbody.localhost`, and a
   line saying `index.local.html` makes no request to cdnjs and does not
   install offline support.
8. Troubleshooting, as symptom then fix:
   - the export is refused, or step counts look a thousand times too small
     (aggregation set to Average)
   - "is not a zip file" (the zip was unpacked on the way)
   - no figure (WebGL off, or the page opened from disk)
   - data gone in Safari (the 7 days; restore a backup)
   - data imported in Safari missing from the Home Screen app, if the check
     confirms separate storage
   - an old version after an update (reload once while online)
   - the size limits for an export and a backup
   - Erase waiting on another tab
9. The figure: where the mesh came from, and its licence. The rebuild
   commands move to `CONTRIBUTING.md`.
10. Dependencies, Known gaps (adding: the automated tests run in Chromium
    only, and Safari is checked by hand in the iOS Simulator), Licence,
    Citation, Contact (the repository's issues).

### 5.3 Meta and Open Graph tags

In the `<head>` of `index.html`:

```html
<meta name="description" content="Your Apple Health export on a rotating figure. Read and kept in your browser; nothing is uploaded.">
<link rel="canonical" href="https://glassbody.github.io/">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Glassbody">
<meta property="og:title" content="Glassbody">
<meta property="og:description" content="Your Apple Health export on a rotating figure. Read and kept in your browser; nothing is uploaded.">
<meta property="og:url" content="https://glassbody.github.io/">
<meta property="og:image" content="https://glassbody.github.io/img/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="The Glassbody figure, a glowing body split into five regions, with the sample data loaded.">
<meta name="twitter:card" content="summary_large_image">
```

Open Graph needs an absolute image URL, so these tags name the hosted site
even when the page is served locally.

### 5.4 Community files

`CONTRIBUTING.md`:

- setup and `npm test`, and what the suites check (moved from the README)
- the rules: `tools/ingest.py` and `js/ingest.js` change together
  (`docs/architecture.md`, section 2); classic scripts and no build step;
  pinned cdnjs versions, so bumping one means changing `index.html`,
  `test/vendor.sh` and the `CDN` list in `sw.js` together; no real health
  data in commits, issues or pull requests
- rebuilding the sample (`tools/make_sample.py`), the icons
  (`npm run icons`), the screenshots (`npm run screenshots`) and the figure
  (the Blender commands from the current README)
- one change per commit, plain commit messages; CI runs the suite on every
  push and pull request

`SECURITY.md`:

- what counts: script injection through an export or backup file, records
  leaving the browser, a way around the CSP, the service worker serving
  something other than the site's files and the pinned libraries
- how to report: GitHub's private vulnerability reporting at
  `https://github.com/glassbody/glassbody.github.io/security/advisories/new`;
  no email address in the repository
- never attach real health data; reproduce with the sample or the fixtures
- the supported version is the hosted site and `main`; there is one
  maintainer and no promised response time

`.github/ISSUE_TEMPLATE/bug_report.yml`, an issue form:

- a notice at the top: do not attach an export, a backup, or a screenshot
  that shows your own health data
- fields: what happened, what you expected, steps, browser and version,
  device and OS, installed app or browser tab, Health Auto Export version and
  the export's format and aggregation
- a required checkbox: "This issue contains none of my own health data."

`.github/ISSUE_TEMPLATE/config.yml` sets `blank_issues_enabled: false` and
adds a contact link to the security reporting page.

### 5.5 Publishing workflow

`.github/workflows/pages.yml` publishes the site from GitHub Actions:

- on push to `main`, and by hand (`workflow_dispatch`)
- job `test`: calls `.github/workflows/test.yml`, which gains a
  `workflow_call` trigger. Its `push` trigger ignores `main`, so a push to
  `main` runs the suite once, inside this workflow.
- job `deploy`, which needs `test`: copy `index.html`,
  `manifest.webmanifest`, `sw.js`, `css/`, `js/`, `fonts/`, `icons/`, `img/`,
  `data/body.json` and `data/sample.json` into `_site/`, then
  `actions/configure-pages`, `actions/upload-pages-artifact` and
  `actions/deploy-pages`, at their current major versions when the slice is
  built
- permissions: `contents: read`, `pages: write`, `id-token: write`;
  environment `github-pages`

Fixtures, tools, tests and the STL stay in the repository and off the site.

### 5.6 Tests

`test/docs.spec.js` (slices 6 and 7):

- `og:url` and `og:image` in `index.html` are absolute `https://` URLs on
  `glassbody.github.io`, and `img/og.png` is 1200 × 630.
- Every relative link and image in `README.md`, `CONTRIBUTING.md`,
  `SECURITY.md` and `docs/*.md` points at a file that exists.

## 6. Pre-publish check and publish steps

### 6.1 Leak scan

It runs over the whole history (`--all`), not only the latest commit:

1. Secrets: `gitleaks detect --source . --log-opts="--all"` if gitleaks is
   installed; otherwise
   `git log -p --all | grep -n -i -E "api[_-]?key|secret|token|passw|BEGIN [A-Z ]*PRIVATE KEY"`,
   with every hit read by a person. `.env` is not tracked.
2. Identity: `git log --all --format='%an <%ae>%n%cn <%ce>' | sort -u` shows
   only the maintainer's GitHub noreply address.
   `git grep -n -E "/(Users|home)/"` and the same pattern over
   `git log -p --all` find no machine paths.
3. Coordinates: every latitude and longitude in `data/sample.json` and in
   the route files inside `test/fixtures/*.zip` lies within 0.05° of
   `ORIGIN` in `tools/make_sample.py` (4.3172, −27.6240, a point in the
   Atlantic). Any other coordinate-like pair in a tracked file is read by a
   person. The PNGs carry no `eXIf` or `tEXt` chunks.
4. Medicine names: the `med` and `name` values in `data/sample.json` and in
   the fixtures' Medications files are exactly the invented ones in
   `tools/make_sample.py`. The med names are `Examplamine`, `Fictivol` and
   `Placebocin`.
5. Health data: `git log --all --name-only` shows no zip outside
   `test/fixtures/`, no backup JSON and no `health*.json`.
6. Size: no tracked file over 1 MB.

### 6.2 Launch check

The site collects nothing and charges nothing, so policies, consent banners
and payments do not apply. The check covers:

- Privacy: the README's list of network requests matches what the CSP test
  sees; no cookies, no analytics; the README says what GitHub, as host, sees.
- Deleting data: Erase and the browser's site-data setting are both
  documented.
- Claims: every claim in the README has a source or a test behind it, in
  particular offline use, "nothing is uploaded", and the Basic tier price
  with its date.
- Accessibility: the display and access suites pass; the hero image has alt
  text.
- Licences: the OFL files sit next to the fonts; the figure's provenance and
  MIT licence are stated; `LICENSE.md` and `CITATION.md` are current, with
  version 1.0.0 and the repository URL.
- Install: in desktop Chrome, DevTools' Application panel shows the manifest
  with no errors, the worker active, and the page reloading with the network
  set to offline.
- External links in the Markdown files (the App Store page, the WebKit posts)
  answer 200.

The results go into `docs/decisions.md`. Whatever fails is fixed before
publishing.

### 6.3 Publish steps

These are not a slice. They run after slice 8, and each step that touches
GitHub waits for the maintainer's go-ahead.

1. The maintainer creates the free GitHub organization `glassbody`, in the
   browser.
2. The maintainer runs the USPTO search for GLASSBODY. It does not block
   publishing.
3. Create the public repository `glassbody/glassbody.github.io`, empty (no
   README or licence from GitHub).
4. Tag the last commit `v1.0.0` (`git tag -a v1.0.0 -m "Glassbody 1.0.0"`;
   no signing), add the remote, push `main` and the tag.
5. In the repository settings: Pages source "GitHub Actions"; turn on
   private vulnerability reporting; set the description and the website URL.
   No other repository in the organization turns on Pages, because every
   Pages site in it shares the origin `glassbody.github.io`, and with it the
   browser storage and the service worker scope.
6. When `pages.yml` has passed, open `https://glassbody.github.io/`: the
   sample loads, Chrome offers to install, the page works offline after one
   visit, and a link preview shows `og.png`.
7. The maintainer imports a real export on an iPhone, on the hosted page
   (section 4.1).
8. Optional, by the maintainer: connect Zenodo to the repository, publish a
   GitHub release for `v1.0.0`, and add the DOI to `CITATION.md`.

## 7. Test seams

Where the tests reach each feature:

| Feature | Seam |
| --- | --- |
| Rename | the rendered page (title, h1, back link, panel messages), and one `git grep` test with an allowlist |
| Manifest and icons | `manifest.webmanifest` and the PNG headers read in Node; Chromium's `Page.getAppManifest` errors |
| Service worker | `test/offline.spec.js`, the only file with workers allowed, against its own servers that it can change or stop |
| Persistent storage | an init script that replaces `navigator.storage.persist` and counts calls |
| Safari note | the context's user agent, and stubs for `navigator.standalone` and `navigator.maxTouchPoints`, read back from the Data panel |
| Last backup and reminder | the Data panel's text after a real download and a real import |
| README and meta tags | link resolution in Node; the `og:` tags in `index.html` |
| iPhone | the iOS Simulator, by hand or by an agent; not CI |

## 8. Slices

Each slice fits one fresh coding session of about 150K tokens of context.
They run in order, each starting from the commit the previous one left. Each
ends with a cold `npm ci && npm test` passing, its commits made (one change
each, unsigned), and its diff reviewed against this spec by someone who did
not write it.

### Slice 1: rename

Section 1. About 60K tokens.

Done when no visible text says Body Scan; the `git grep` allowlist test
passes; the two kept storage names are explained in `docs/architecture.md`;
and the suite passes with the updated tests.

### Slice 2: manifest and icons

Sections 2.1, 2.2 and 2.5, and the `install.spec.js` part of 2.6. Adds
`tools/make_icons.js`, `icons/`, `manifest.webmanifest`, the head tags, the
two CSP directives, `npm run icons` and the CI drift check for `icon.svg`.
About 100K tokens.

Done when `npm run icons` rebuilds `icon.svg` byte for byte;
`test/install.spec.js` passes; Chromium reports no manifest errors; and the
existing CSP test still passes for both pages.

### Slice 3: service worker

Sections 2.3 and 2.4, and the rest of 2.6. Adds `sw.js`,
`js/sw-register.js`, `test/serve.js` and `test/offline.spec.js`; changes
`index.html`, `test/vendor.sh` and `playwright.config.js`; adds section 6 to
`docs/architecture.md` (offline and install, including the kill switch from
section 10 of this spec) and the new script to its section 1. About 130K
tokens, the largest slice.

Done when the offline, update, precache-coverage, CDN-list and tampered-file
tests pass; `index.local.html` has no registration tag; and the controller
check passes under the default config.

### Slice 4: storage safeguards

Section 3. Changes `js/store.js`, `js/data-panel.js`, `css/style.css` if the
note needs a style, `test/regression.spec.js` (`SUMMED_ADDED`) and
`docs/architecture.md` section 2 (the `backup` record). Adds
`test/storage.spec.js`. About 100K tokens.

Done when every case in section 3.4 passes, and erasing leaves no `backup`
record behind.

### Slice 5: iPhone check

Section 4. Needs slices 3 and 4. Runs the Simulator check, records it in
`docs/decisions.md`, adjusts the iPhone note and its test if step 6 calls for
it, and drafts the README's iPhone section. About 100K tokens, most of it
screenshots.

Done when the eight steps have been run with a screenshot each; the results
entry is in `docs/decisions.md`; and the note's wording matches what step 6
found.

### Slice 6: screenshots, meta tags, publishing workflow

Sections 5.1, 5.3 and 5.5, and the meta-tag half of 5.6. About 90K tokens.

Done when `npm run screenshots` writes both images; the `og:` test passes;
`pages.yml` passes `actionlint` if it is installed (otherwise a careful
read); and `test.yml` still runs on pull requests and on pushes to other
branches.

### Slice 7: README and community files

Sections 5.2 and 5.4, the link half of 5.6, and version `1.0.0` in
`package.json` and `CITATION.md`, with the repository and site URLs in
`CITATION.md`. About 100K tokens.

Done when the README follows section 5.2 in that order; `CONTRIBUTING.md`,
`SECURITY.md` and both issue-template files exist; the link test passes; and
someone who has not seen the project can get from the README to the sample
on the page, served locally, without help.

### Slice 8: pre-publish check

Sections 6.1 and 6.2, run by a session that built none of the slices. About
60K tokens. It fixes what it finds only when the fix is small and plain;
anything else goes back to the maintainer.

Done when every item in 6.1 and 6.2 has a recorded result in
`docs/decisions.md` and nothing is left failing.

## 9. Risks

- Installed workers outlive the files that installed them. A broken `sw.js`
  keeps running in visitors' browsers until a new one replaces it. The
  network-first rule limits the damage, and section 10 has a kill switch.
- A connection that hangs instead of failing makes the page wait. There is
  no timeout, on purpose: a timeout would serve old files on a slow network.
- Every Pages site in the `glassbody` organization shares one origin. A
  second one would share the visitor's stored records and could register a
  worker over this one.
- Whether a Home Screen app on iPhone sees what Safari stored is not
  documented by Apple. Slice 5 settles it for the iOS version it runs on.
- The Safari note guesses the browser from the user agent. A wrong guess
  shows or hides one line of text; it changes nothing stored.
- Firefox shows a permission prompt after the first import. That is the
  point of asking then, but some readers will find it surprising.
- Playwright's `serviceWorkers: 'block'` decides how blocked registration
  fails. Registration has to fail quietly, and the suite's console-error
  check catches it if it doesn't.
- Only Chromium is tested automatically. Safari and WebKit behaviour rests on
  the Simulator check and on the maintainer's iPhone.
- The service worker repeats the three integrity hashes from `index.html`. A
  test compares them, so a library bump that misses `sw.js` fails CI.
- The contour tracing in `tools/make_icons.js` is the most code for the
  smallest feature. Its fallback is in section 2.2.
- Python's `http.server` may serve `.webmanifest` with a generic MIME type,
  depending on the Python version. The manifest test runs against that
  server, so a problem shows up in CI.
- Link previews cache `og:image`. A new image may take days to appear on
  sites that have already fetched the old one.
- Moving the ingester's default path to `~/glassbody/` leaves an older store
  at `~/body-scan/health.json` until its owner moves it.

## 10. Rollback

Each slice is its own commits, so `git revert` of a slice's commits undoes
it before publishing. After publishing:

- Rename: revert and push. Stored records are untouched, since the database
  name never changed.
- Storage safeguards: revert and push. The leftover `backup` record is
  ignored by the older code. A persistent-storage grant cannot be withdrawn by
  the page, and it does no harm.
- Service worker: deleting `sw.js` from the site is not enough, because a
  browser that fails to fetch the new worker keeps the old one. Publish this
  `sw.js` in its place, and remove the registration script:

  ```js
  /* Kill switch: delete every cache and unregister. */
  self.addEventListener('install', function () { self.skipWaiting(); });
  self.addEventListener('activate', function (e) {
    e.waitUntil(caches.keys()
      .then(function (ks) { return Promise.all(ks.map(function (k) { return caches.delete(k); })); })
      .then(function () { return self.registration.unregister(); }));
  });
  ```

  Each visitor's browser picks it up on their next online visit. IndexedDB is
  not touched.
- The whole site: publish the kill switch first and leave it up for a few
  weeks, then turn Pages off in the repository settings or make the
  repository private. Once the site is gone, online visitors get GitHub's
  404, because the worker passes error responses through, while a browser the
  kill switch never reached still opens the cached page offline. Visitors'
  records stay in their browsers either way.
