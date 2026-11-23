# Architecture and traps

How the data gets from a Health Auto Export zip onto the page, and the bugs
that already cost time once. Section numbers here are what code comments
refer to.

## 1. Files and load order

`index.html` loads three.js 0.160.1, d3 7.9.0 and JSZip 3.10.1 from cdnjs,
the typefaces from `fonts/fonts.css`, then six classic scripts in this order: `js/store.js`, `js/ingest.js`,
`js/holo.js`, `js/ui.js`, `js/data-panel.js`, `js/sw-register.js`. The first
five set the globals `HealthStore`, `HealthIngest`, `HOLO`, `HOLOUI`,
`Glassbody` and `GlassbodyPanel`; the last sets none and registers the service
worker (section 6). They are classic scripts, not ES modules. The page still
needs a web server: on `file://` the browser refuses `fetch('data/body.json')`
and, for `index.local.html`, the vendored scripts, so `js/holo.js` checks
`location.protocol` and shows the serve command instead of the figure. three.js stays at 0.160.1: its UMD build was removed after
r160, so a newer version means moving to modules.

`manifest.webmanifest` and the five files in `icons/` make the page
installable as a web app. `icons/icon.svg` is also the favicon.
`tools/make_icons.js` (`npm run icons`) makes all five from `data/body.json`:
it traces the figure's front silhouette into the SVG without a browser, so CI
can check that the SVG comes out byte for byte the same, then renders the PNGs
in Playwright's Chromium.

A meta Content-Security-Policy allows scripts from the page's origin and
cdnjs only, and fetches, fonts and styles from the page's origin only.
`test/vendor.sh` drops cdnjs from the copy in `index.local.html`. A test loads
both pages, uses every page and the Data panel, and fails on any violation or
any request to another host. Style needs `'unsafe-inline'` because `js/ui.js`
writes `style` attributes into chart legends.

The five regions are `move` (legs and feet), `heart` (chest and arms, because
the watch reads the pulse at the wrist), `sleep` (head), `sound` (ears) and
`fuel` (abdomen).

## 2. The store

```js
{
  meta: { start, end, days, updated, sample? },
  daily: [ { date, steps, miles, activeKcal, restingKcal, exerciseMin,
             standHours, flights, daylightMin, restingHr, walkingHr, hrv,
             recoveryHrv, cardioRecovery, spo2, respRate, vo2max, weightLb,
             bmi, walkMph, stepLenIn, walkAsym, walkDbl, envAudio,
             headphoneAudio, sleepTotal, sleepCore, sleepDeep, sleepRem,
             sleepAwake } ],
  walks: [ { id, date, time, type, durMin, miles, mphAvg, mphMax, steps,
             cadence, kcal, hrAvg, hrMax, flights, ascentFt, tempF, humidity,
             hr: [bpm per minute], route: [[lat, lon], …] } ],
  meds:      [ { date, time, name, med, dose, status, seq? } ],
  nutrition: [ { date, energyKcal, carbsG, … } ],
  alerts:    [ { when, date, kind, peak, threshold } ],
  ecgs:      [ { when, date, class, bpm, hz, samples } ]
}
```

`meta.sample` is `true` only in `data/sample.json`. While it is set, the first
real import replaces the store instead of merging into it, so invented records
never mix with real ones.

The store above is one record in the database's object store, under the key
`current`. A second record, under the key `backup`, holds `{ at }`: the UTC
stamp, in the format of `meta.updated`, of the last click on Download backup.
`HealthStore.markBackup()` writes it and `HealthStore.lastBackup()` reads it,
resolving to the stamp or `null`. Neither creates the database: a tab whose
records another tab erased still offers Download backup, and marking that
backup would otherwise bring the database back holding only this record.
Erase deletes the database and the record with it, and so does the first real
import over the sample, which deletes the database before it merges. A
restore and the sample leave the record alone. `load()` reads only `current`,
so code from before the record existed ignores it.

The IndexedDB database `body-scan` and the localStorage key `body-scan-motion`
(the Pause motion choice) keep their names from before the project was renamed
Glassbody, because the browser finds stored data by name: new names would start
empty and hide what was saved before the rename.

Units in the store are miles, kcal, pounds, inches and °F. Conversion happens
once, at ingest.

Exports are rolling windows that overlap, so records merge by key and the
newer file wins on a collision. Importing the same export twice adds nothing.

| Collection | Key |
|---|---|
| `daily` | `date` |
| `walks` | `id` (workout start) |
| `meds` | `date + ' ' + time + '|' + med`, plus `'#' + seq` when `seq` is above 1 |
| `nutrition` | `date` |
| `alerts` | `when` |
| `ecgs` | `when` |

`time` is to the minute, so two doses of one medicine logged in the same
minute would share a key. The ingesters number them `seq` 1, 2, … in file
order; the first has no `seq` field, which keeps stores written before `seq`
existed valid. Rows are the same dose when the logged time, scheduled time,
medicine and dosage all match; the status may differ. When one zip holds
several Medications files, both ingesters read them newest name first, so the
newer status wins. A later export missing the first of two same-minute doses
would renumber the other as `seq` 1; no export seen so far does that.

`tools/ingest.py` and `js/ingest.js` are the same parser twice. Change both
or neither; a test checks they build the same store from the summed fixture.

## 3. Source format

Health Auto Export's manual export zip (Export All), flat:

- `HealthAutoExport-<start>-<end>.csv`: one row per day, about 126 columns,
  most empty. Daily metrics and nutrition both come from it.
- `Workouts-<range>.csv`: one row per workout.
- `<Type>-Heart Rate-<YYYYMMDD_HHMMSS>.csv`: per-minute heart rate for one
  workout.
- `<Type>-Route-<YYYYMMDD_HHMMSS>.csv` or `.gpx`: about one GPS point per
  second.
- `Medications-<range>.csv`.
- `HeartRateNotifications-<range>.csv` and `ECG-<YYYY-MM-DD_HHMMSS>.csv`, one
  ECG file per recording; both are key/value rows, not tables. Both
  ingesters match `^ECG-.*\.csv$`. The ECG name comes from the synthetic
  fixture (`tools/make_sample.py`); no real export has been checked.

Detail files are matched to their workout by the start stamp, with seconds
first and then by minute: `2026-10-27 11:09` becomes `20261027_1109`.

Files are found by basename wherever they sit in the zip, skipping
`__MACOSX/` and `._` resource forks; when two share a basename, the first in
zip order wins. Neither ingester unpacks the zip to disk.

Both ingesters refuse an export before reading any of it when the zip is over
500 MB, one of the files they read (the patterns above) unpacks to more than
50 MB, or those files together unpack to more than 200 MB. The sizes are the
ones the zip records. `tools/ingest.py` stops reading a member at its
recorded size and refuses the zip when the checksum then fails; the browser
trusts the recorded size. A CSV cell may be as long as its
file. Bytes that are not UTF-8 become U+FFFD: `TextDecoder` in the browser,
`errors="replace"` in Python, which agree. Both refuse a zip with any member
that is encrypted or packed with a method other than stored or deflate,
because JSZip cannot open such a zip at all. When one path appears twice, both
read and size-check the last copy. The Data panel refuses a backup over
100 MB.

Reading the store never creates the database; only a write does. Erase
deletes the database, and a tab that has it open closes its connection when
another tab erases.

The scheduled-automation export and the REST payload have other shapes and
are not parsed.

## 4. Traps

### 4.1 Average instead of Sum

Health Auto Export has an aggregation setting. Set to Average, every
cumulative metric arrives about a thousand times too small (0.058 steps for
a day) while heart rate, HRV and weight look normal. Both ingesters refuse an
export where most days show under 100 steps. Keep that guard;
`test/fixtures/sample-averaged.zip` tests it.

### 4.2 Blank cells are not zero

`Number('')` is `0` in JavaScript. Treating blanks as zero once gave a 46 bpm
mean resting heart rate and a weight range starting at 0 lb. Every numeric
read maps `''`, `null` and `undefined` to missing.

### 4.3 CRLF corrupts the last column

Python's `csv` writer defaults to `\r\n`, and the `\r` sticks to the last
field, so `"Taken"` became `"Taken\r"` and every dose read as not taken.
Write with `lineterminator='\n'`; the JS parser strips `\r`.

### 4.4 Dropped columns read as zero

A metric left out of the column map shows as zero or empty on the page, not
as an error. If a metric reads as zero, check the column map first.

### 4.5 Mixed units in one export

The daily file uses km and kJ; the workouts file in the same zip can use
miles and °F. Both ingesters accept either.

### 4.6 Charts measured before layout

d3 charts size themselves from `clientWidth`, which is 0 before the card is
in the DOM. `renderPage()` queues every chart in `draws[]` and runs them after
`pages.append(page)`. Keep that order.

## 5. The figure

`data/body.json`:

```js
{ units:'cm', up:'y', flat:bool, height, tris, verts,
  regions: { move|heart|sleep|sound|fuel: { pos:[x,y,z,…], idx:[…] } } }
```

Y up, centimetres, feet at y=0. `flat:true` makes `holo.js` shade facets
flat; missing means false.

Rendering, in `js/holo.js`: WebGL through three.js. A fresnel shader lights the
silhouette, a scan band travels up the body, and the glow is a bright-pass and
two-axis blur composited back over the frame, with a second sweep band drawn in
that pass. Hover is a raycast against the real triangles. The stripes, both
sweeps and the drifting motes all run on one clock; still mode (reduced motion,
or the Pause motion button) holds that clock, turns the screen sweep off and
stops the spin. `HOLO.setPaused` is a different thing: it stops drawing while a
region page covers the stage.

The current figure starts as `data/raw/astra_figure.stl`, a mesh GPT-6 Astra
built for this project (see the README). `tools/refine_figure.py` thickens the
legs, arms and torso toward target perimeters, scales the head up and adds a
neck flare and trapezius, then
`tools/body_from_stl.py` voxel-remeshes, decimates to 9,000 triangles, smooths
and splits it into regions. `tools/make_body.py` is the older procedural
figure.

What matters when changing it:

- The shader is additive and transparent, so two overlapping closed surfaces
  show their interiors as hollows, for example at the shoulders. A voxel
  remesh into one watertight skin fixes it. A Blender preview does not show
  this bug; only the page does.
- To re-pose arms, use a Blender armature with automatic (heat) weights.
  Selecting arm vertices by distance catches the head, walking mesh
  connectivity leaks into the neck, and automatic joint-finding fails on an
  asymmetric pose, so joints are measured and hardcoded. Setting
  `pose_bone.matrix` once only gets part of the way; iterate to convergence.

## 6. Offline and install

Section 1 covers the manifest and the icons, which make the page installable.
`sw.js`, a service worker at the site root, makes it work offline after one
online visit. It is a classic worker script, and its scope is the whole site.

`js/sw-register.js` registers it after the page's `load` event, so the
worker's downloads don't compete with the first visit's own. A blocked or
failed registration logs at debug level only, because the regression suite
fails on any console error. On `file://` it does nothing.

`index.local.html` registers no worker: `test/vendor.sh` deletes the script
tag and fails if the tag is still there. The worker's own fetches are not
bound by the page's CSP, so a worker registered from that page would still
fetch from cdnjs.

### 6.1 What the worker caches

Two lists at the top of `sw.js` name what it precaches. `SHELL` is every file
the page loads from its own origin; a file the page starts loading goes in
it, and `test/offline.spec.js` fails on a request that is in neither list.
`CDN` is the three cdnjs URLs with the integrity hashes from `index.html`; a
test compares the two, so a library bump changes both.

There is one cache, named by `CACHE` (`glassbody-1`). Its number changes only
when what the cache holds changes shape. A changed file needs no new number.

Install fetches every `SHELL` entry past the HTTP cache and every `CDN` entry
with its hash, and stores nothing until all of them have arrived in full with
a 200.
A failed fetch, an error status or a cdnjs file that fails its hash fails the
install, and the browser tries again on a later visit, so a changed cdnjs
file never enters the cache. The new worker then takes over at once. Activate
deletes every other cache and takes control of the open tabs.

The worker answers GET requests only:

- A `CDN` URL comes from the cache; on a miss, it is fetched with its hash
  and cached. These are pinned versions that never change.
- A same-origin URL goes to the network first, with `cache: 'no-cache'`, so
  the browser revalidates even when GitHub Pages' `max-age=600` would let it
  reuse its copy. A 200 is cached and returned. When the fetch fails, the
  cache answers, and a navigation with no cached match gets the cached
  `index.html`. Error statuses and partial responses pass through and are
  never cached.
- Anything else goes to the network untouched. The page's CSP allows no
  other host.

So every online load gets the server's current files, and a new `sw.js` is
found on the next navigation; the page needs no "update ready" prompt.
Same-origin files fetched at run time are cached too, which is how
`index.local.html` and `vendor/` end up cached when someone serves the
repository locally and has opened `index.html` with the worker on.

A connection that hangs, instead of failing, makes the page wait for it, as
it would without a worker. There is no timeout on purpose: a timeout would
serve old files on a slow network.

`playwright.config.js` blocks service workers, so no other test can be
answered by one, and a test in `test/regression.spec.js` checks that. Only
`test/offline.spec.js` allows them. It serves its own copy of the site and a
stand-in for cdnjs from `test/serve.js`, so it can change a file, serve a
tampered library, or stop both servers to go offline, without Playwright
routing the worker's requests. The site server sends `max-age=600` and ETags,
as GitHub Pages does.

### 6.2 Kill switch

An installed worker outlives the files that installed it. Deleting `sw.js`
from the site is not enough, because a browser that fails to fetch a new
worker keeps the old one. To take the worker out of visitors' browsers,
publish this `sw.js` in its place and remove the `js/sw-register.js` tag from
`index.html`:

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

To take the whole site down, publish the kill switch first and leave it up
for a few weeks, then turn Pages off or make the repository private. After
that, online visitors get GitHub's 404, because the worker passes error
responses through, while a browser the kill switch never reached still opens
the cached page offline. Visitors' records stay in their browsers either way.
