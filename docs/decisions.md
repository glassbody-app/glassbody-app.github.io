# Decisions log

2026-10-28:

- No backend. The page reads the export in the browser and keeps it in
  IndexedDB; nothing is sent anywhere.
- Dark theme only, a 7-day default range, and a click on a body region opens
  that region's page.
- Classic scripts, not ES modules, with pinned CDN versions; three.js stays
  at 0.160.1, the last release with the UMD build.
- Test fixtures are synthetic zips from `tools/make_sample.py`. Real exports
  never go in the repo; checks against them are manual and local.
- Licence: MIT.

2026-11-03:

- The figure's source mesh, `data/raw/astra_figure.stl`, was built by OpenAI's
  GPT-6 Astra in ChatGPT from a brief that required building from scratch: no
  downloaded, imported, traced or modified model, scan or asset. OpenAI's
  Terms of Use assign output to the user. An earlier figure, derived from a
  third-party model whose licence forbids redistribution, was replaced before
  this repository was published and is not in its history.
- `tools/refine_figure.py` thickens the legs, arms and torso toward target
  perimeters, scales the head by 1.08 and adds a neck flare and trapezius.
  Its output is rebuilt, not committed. `tools/body_from_stl.py` then makes
  `data/body.json` with its defaults: voxel remesh at 0.7 cm, decimated to
  9,000 triangles, smoothed twice, shaded smooth. For this figure the arm
  joints were re-measured and the chin and neck lines set to 0.854 and 0.820
  of the height.
- The source STL is committed (an exception in `.gitignore`) so the figure
  can be rebuilt from the repo alone.
- The figure is under MIT, like the code.

2026-11-05, for v1:

- The project is renamed Glassbody. The IndexedDB database keeps the name
  `body-scan`, so data already stored survives the rename. A web search found
  no GLASSBODY trademark; the USPTO's own search has not been run.
- Hosting: GitHub Pages under a free GitHub organization, `glassbody`, so the
  site is `glassbody.github.io` and its browser storage is not shared with
  any other `github.io` site of the owner's.
- The easy install is the hosted page made installable as a web app (manifest
  and service worker), working offline after the first visit. Running it
  locally with `python3 -m http.server` stays documented.
- Storage safeguards: ask the browser for persistent storage; tell Safari
  users to add the page to the Home Screen, since Safari deletes a site's
  data after 7 days of use without a visit and Home Screen web apps are
  exempt; show the date of the last backup and remind after an import.
- iPhone: the README documents importing in Safari by choosing the zip from
  Files, checked in the iOS Simulator.
- Data source for v1 stays Health Auto Export's manual export, which needs
  its Basic tier ($2.99 one-time on the US App Store listing, 2026-11-05).
  The README links to the app and leaves its export steps to the reader; no
  screenshot walkthrough. Support for the Health app's own free export comes
  after v1.

2026-11-05, for the v1 spec (`docs/specs/glassbody-v1.md`):

- The repository is `glassbody/glassbody.github.io`, so the page is at
  `https://glassbody.github.io/` and the bare address does not 404. No other
  repository in the organization turns on Pages, since every Pages site in it
  shares the one origin.
- Pages publishes from a GitHub Actions workflow that runs the tests first
  and uploads only the files the page loads.
- Every visible name and code name becomes Glassbody, and `tools/ingest.py`
  writes to `~/glassbody/health.json` by default. Two stored names stay: the
  IndexedDB database `body-scan` and the localStorage key `body-scan-motion`.
  `.gitignore` keeps the old backup pattern beside the new one.
- The icon is the figure's front silhouette, made by a script from
  `data/body.json`. The SVG is the favicon; the PNGs are committed.
- The service worker fetches the page's own files network first and the
  three cdnjs files cache first, precached with their integrity hashes.
- `navigator.storage.persist()` is requested after an import or restore that
  stores records, never on page load or for the sample.
- The Safari note is a line in the Data panel, for iPhone and iPad in any
  browser and for Safari on a Mac, when the page is not running as an
  installed app. It cannot be dismissed.
- The last backup date is recorded when Download backup is clicked, in the
  same database, so Erase removes it. An import that adds records ends with a
  reminder to download a backup.
- One script makes the README screenshot and the Open Graph image from the
  sample.
- v1 is version 1.0.0, tagged at publish. A Zenodo DOI is optional and comes
  after publishing.
- Security reports go through GitHub's private vulnerability reporting. There
  is one bug-report issue form, and blank issues are off.
- The iPhone check runs in the iOS Simulator with synthetic data. An import
  of a real export on a real iPhone follows publishing and does not gate it.

2026-11-09, slice 1 of the v1 spec (the rename):

- The `git grep` test for the old name skips itself when the folder has no
  `.git`, as in a downloaded or archived copy, so `npm test` still runs
  there. CI checks out the repository, so the test runs on every push.

2026-11-09, slice 2 of the v1 spec (manifest and icons):

- `tools/make_icons.js` takes `--out DIR`, so the test writes the SVG to a
  temporary folder instead of over the committed one.
- The figure is centred on its front bounding box and scaled so its farthest
  vertex sits 2 px (at 1024) inside the safe-zone circle, because the traced
  outline can lie half a pixel past a vertex. The safe-zone check can then
  fail only if that fitting is broken.
- Marching squares keeps the inside corners of a saddle cell apart.
- The SVG steps use only + - * / and one square root, never `**` or
  `Math.sin`, which ECMAScript lets engines approximate, so the SVG matches
  on every machine.

2026-11-09, slice 3 of the v1 spec (service worker):

- The worker's install counts any status but 200 as a failed fetch, so a
  missing file fails the install instead of entering the cache as a 404.
- The site server in `test/serve.js` sends `Cache-Control: max-age=600` and
  ETags, as GitHub Pages does. The update test then goes to the page again
  instead of reloading it: a reload revalidates by itself, and the test passed
  with the worker's `cache: 'no-cache'` removed.
- The controller check in `test/regression.spec.js` also checks that no
  worker is registered. With workers allowed, the second load can still have
  no controller while the first registration installs, so the controller
  alone did not catch it.
- The test's copy of the site holds the files the publishing workflow will
  upload (spec section 5.5), not the whole repository.

2026-11-10, slice 4 of the v1 spec (storage safeguards):

- An import over the sample deletes the database before it merges, as it did
  before slice 4, so a backup date recorded for the sample goes with it. The
  backup line then says no backup was downloaded, which is true of the
  reader's own records.
- When the backup date cannot be written, the message says `Backup
  downloaded, but its date could not be saved:` and the error, since the file
  itself was still offered for download.
- `markBackup()` writes only into a database that exists and resolves to
  `null` when there is none. A tab whose records another tab erased still
  offers Download backup, and marking it created the database again with
  only the `backup` record in it.

2026-11-10, slice 6 of the v1 spec (screenshots, meta tags, publishing):

- `tools/make_screenshots.js` presses Pause motion and then reloads, so the
  figure starts still with its clock at 0. Pressing Pause alone holds the
  clock wherever it had got to. The script also seeds `Math.random`, which
  places the background motes, and sets the time zone to UTC, so a rebuild
  on one machine writes the same bytes.
- `img/og.png` is published but is not in `SHELL` in `sw.js`: the page never
  loads it, and link previews fetch it from the site.
- `pages.yml` has a `concurrency` group, `pages`, that never cancels a
  running deployment, as GitHub's starter workflow for Pages does. Only the
  deploy job gets `pages: write` and `id-token: write`; the test job reads.
- With `branches-ignore: [main]` on its `push` trigger, `test.yml` no longer
  runs on a tag push. Pushing `main` with the tag still runs the suite,
  inside `pages.yml`.
- `pages.yml` checks out with `actions/checkout@v4`, as `test.yml` does,
  though the current major is v7. Both move together.

2026-11-10, slice 5 of the v1 spec (the iPhone check in spec section 4.1):

- The check ran in Xcode 27.2 (build 27B52), in the iOS Simulator on an
  iPhone 18 Pro with iOS 27.2 (24B8117), against
  `python3 -m http.server 8000 --bind 127.0.0.1` opened as
  `http://localhost:8000/`, with `test/fixtures/sample-summed.zip`. The
  Simulator was online throughout, so the three cdnjs files came from cdnjs
  on the first visit.
- Step 1: Safari asked `Do you want to download "sample-summed.zip"?` with
  one button, Download. The file landed in Files, On My iPhone, Downloads
  (239 KB), byte for byte the fixture.
- Step 2: the Data panel opened on an empty store with the iPhone wording of
  the Safari note. The server log shows `sw.js` fetched and then every
  `SHELL` file fetched a second time, `data/sample.json` and the four icons
  included, which the page itself had not asked for: the worker installed.
- Step 3: "choose a file" opens the Files picker straight away, on Recents.
  iOS 27.2 shows no Choose File menu for an input that accepts only zip.
  Browse, On My iPhone, Downloads, `sample-summed.zip`. The message read
  `Added 31 days, 12 walks, 25 doses, 10 days of food, 4 alerts and 1 ECG.
  Download a backup to keep a copy outside this browser.`
- Step 4: at 402 points wide, the main screen has the range control and
  Pause motion on one row, Data on the next, the figure, then the five
  region buttons in three rows. Movement and Heart and lungs each show their
  four numbers in a 2 × 2 grid and then one chart per row at full width;
  the alerts table fits its three columns. Back on the main screen after
  Movement, its summary card stayed open over the figure's upper body.
- Step 5: Safari asked `Do you want to download
  "glassbody-backup-2026-11-11.json" on "localhost"?` with View and
  Download. After Download the file was in Files, On My iPhone, Downloads,
  beside the zip (42 KB, all 31 days), and the panel said
  `Last backup downloaded Nov 10, 2026.` The check ran at 19:10 local time,
  after midnight UTC: the file name uses the UTC date, the line the
  reader's own day.
- Step 6: in iOS 27.2 Safari, Share is in the menu at the left of the
  address bar, and Add to Home Screen is under View More in the share sheet.
  The Add to Home Screen sheet showed the icon, `Glassbody` and
  `http://localhost:8000/`, with Open as Web App switched on. Opened from the
  Home Screen, Glassbody said `Nothing is stored in this browser yet.`, and
  the Safari note was gone.
- Step 7: in the Home Screen app the zip imported with the same message as
  in step 3, and the backup line said `No backup downloaded from this
  browser yet.`, so Safari's `backup` record is not visible there either.
  Restore backup asked before replacing the 31 days, then said
  `Restored 31 days from glassbody-backup-2026-11-11.json.`
- Step 8: with the server stopped and the Home Screen app quit
  (`xcrun simctl terminate`), the app opened, the figure drew, and the
  panel listed the 31 days, 12 walks, 25 doses, 10 days of food, 4 alerts
  and 1 ECG. The page's own files can only have come from the worker's
  cache; the Simulator was still online, so the cdnjs files may have come
  from either.
- The answer to step 6, on iOS 27.2: a Home Screen web app has its own
  storage and does not see what Safari stored. The iPhone note keeps "and
  import your export there" (spec section 4.2), and its test is unchanged.
  Someone who imported in Safari first can download a backup there and
  restore it in the Home Screen app, as step 7 did.
- A probe page served from a temporary folder on port 8001 read
  `navigator.standalone` and `matchMedia('(display-mode: standalone)')` as
  both false in Safari and both true once added to the Home Screen and
  opened from there. Either check alone hides the note in a Home Screen app.

2026-11-10, slice 7 of the v1 spec (README and community files):

- An addition from the slice 5 check: the backup file name uses the
  reader's own calendar day, as the last-backup line does. In that check, at
  19:10 local time on Nov 10, after midnight UTC, the file had been named
  from the UTC date, `glassbody-backup-2026-11-11.json`, while the line said
  Nov 10. A test in `test/storage.spec.js` sets a time zone and a clock where
  the two dates differ.
- The README's iPhone steps leave out the Choose File menu that spec section
  5.2 names, because on iOS 27.2 "choose a file" opens the Files picker
  straight away.
- The link test in `test/docs.spec.js` reads Markdown links and images,
  reference definitions, and `src` and `href` in HTML, leaving out code. It
  checks that each relative target is a file or folder inside the
  repository. It does not check anchors.

2026-11-10, the GitHub name:

- The name `glassbody` on GitHub already belongs to someone else's user
  account, and users and organizations share one set of names, so the
  organization the v1 spec names cannot be created. The organization is
  `glassbody-app` instead, the repository `glassbody-app/glassbody-app.github.io`
  and the site `https://glassbody-app.github.io/`. The project keeps the name
  Glassbody. The spec keeps its old URLs as the record of the plan; the
  files that publish an address now use the new one.
- Spec section 6.3 pushes `main` before setting the Pages source to GitHub
  Actions, so the first run of `pages.yml` would fail. The publish order is
  instead: create the empty repository, set the Pages source, then push.

2026-11-23, slice 8 of the v1 spec (the pre-publish check, spec sections 6.1
and 6.2). The leak scan ran on every commit of the build history and every
blob they reach, and again, with the same results, once the commits this
check added, this entry included, were made. That history was later
squashed into one commit (see the next entry):

- Secrets: pass. gitleaks is not installed, so the grep in spec 6.1 ran over
  `git log -p --all`. Each of its 24 hits was read: the `id-token: write`
  permission, the word "token" in the old-name test and in the spec, and the
  spec's token budgets. None is a secret. A second grep, for AWS, GitHub,
  Slack, Google and OpenAI-style keys, PEM blocks and JWTs, found nothing.
  `.env` is ignored and has never been committed.
- Identity: pass. Author and committer of every commit are one name with
  the maintainer's GitHub noreply address. No commit is signed and none has
  a trailer.
- Machine paths: pass. The spec's pattern `/(Users|home)/`, and the macOS
  temporary folders under `/private` and `/var`, match no tracked file, no
  diff in the history, no blob's raw bytes and no file inside the fixture
  zips.
- Earlier repository: pass. The build history had one root, the first
  commit of this repository, and `data/body.json` and
  `data/raw/astra_figure.stl` each had one version, from that commit. The STL's 80-byte header is zeros. A search for the
  usual model marketplaces and for non-commercial licence names found
  nothing.
- Coordinates: pass. All 23,690 points in the route CSV and GPX files of
  both fixture zips, and all 964 route points in `data/sample.json`, lie
  within 0.05° of `ORIGIN`. The only other pairs with four or more decimals
  are `ORIGIN` itself in `tools/make_sample.py` and the luminance weights
  0.2126 and 0.7152 in `js/holo.js`. `data/body.json` and the STL hold mesh
  vertices.
- PNG chunks: pass. The six PNGs in `icons/`, `img/` and `docs/img/` carry
  only IHDR, IDAT and IEND. `icon-maskable-512.png` has the same bytes as
  `icon-512.png`.
- Medicine names: pass. The 50 rows in the fixtures' Medications files name
  only Examplamine, Fictivol and Placebocin, with the nicknames in
  `tools/make_sample.py`. In `data/sample.json` every `med` is one of the
  three, and `name` is the nickname, or the medicine's own name where the
  nickname is empty (Placebocin).
- Health data: pass. Every path ever committed is still tracked. The only
  zips are the two in `test/fixtures/`, and none of the paths is a backup
  JSON, a `health*.json` or a `.env`.
- Size: pass. The largest blob in the history is the STL, 526,484 bytes.
- Privacy: pass. The README's request list matches the hosts the CSP test
  allows and the files the offline test sees (`SHELL`, `CDN` and
  `favicon.ico`). The page has no analytics, beacon or XHR code. The README
  says what GitHub logs, with GitHub's page as the source. Cookies: see the
  carried items below.
- Deleting data: pass. The README documents Erase and clearing the site data
  in the browser's settings.
- Claims: pass. Offline use and updates have tests in
  `test/offline.spec.js`. "Nothing is uploaded" rests on the CSP's
  `connect-src 'self'` and the test that fails on a request to any other
  host. The App Store page still listed Basic at $2.99 on 2026-11-23. The
  size limits are the constants in `js/ingest.js` and `js/data-panel.js`.
  With Blender 5.2.3, the two rebuild commands wrote `data/body.json` byte
  for byte.
- Accessibility: pass. `test/display.spec.js` and `test/access.spec.js` pass
  in a cold `npm ci && npm test` (113 passed), and the README's hero image
  has alt text.
- Licences: pass. `OFL-ChakraPetch.txt` and `OFL-IBMPlexSans.txt` are in
  `fonts/`. The README's figure section and `LICENSE.md` state the figure's
  provenance and its MIT licence. `CITATION.md` and `package.json` say
  1.0.0, and `CITATION.md` has the repository URL.
- Install: pass, in Playwright 1.64.1's Chromium, headless, since Google
  Chrome is not installed, so not in DevTools' Application panel. With the
  repository served by `python3 -m http.server 8791 --bind 127.0.0.1`,
  `Page.getAppManifest` and `Page.getInstallabilityErrors` returned no
  errors, the worker became active with 29 cache entries (26 from `SHELL`, 3
  from `CDN`), and after the server was stopped a reload was controlled by
  the worker, drew the figure and loaded the 45-day sample.
- External links: pass for the five that exist now, each 200 on 2026-11-23:
  the App Store page, MDN, the WebKit post, and GitHub Docs' Pages and
  private-reporting pages. The Pages page has the `#data-collection` anchor.
  The repository, its issues and advisories pages and
  `https://glassbody-app.github.io/` answer 404 until publishing. The name
  `glassbody-app` was still free on GitHub that day:
  `https://api.github.com/users/glassbody-app` answered 404.

Items carried from earlier slices, settled in the same check:

- The service worker's requests to cdnjs sent the site's origin as
  `Referer`, because the page's `no-referrer` meta tag does not reach a
  worker. `makeCdnRequest()` in `sw.js` now sets `referrerPolicy:
  'no-referrer'`. A test in `test/offline.spec.js` fails on any `Referer`
  the stand-in for cdnjs receives, and it failed before the change. In that
  test the stand-in sends `Cache-Control: no-store`: with `max-age=600` the
  browser answered the worker from the copies the script tags had fetched,
  and the worker's requests never reached the stand-in. cdnjs still sees the
  site's address in the CORS `Origin` header, as the README says.
- Cookies: the test that uses every page and the Data panel now fails on any
  cookie in the browser. A run with a cookie written from
  `js/data-panel.js` failed for both pages.
- Blender: `CONTRIBUTING.md` now gives the command that `requirements.txt`
  gives, without `--preview`, which is the one that was run. It says that
  `--preview` adds two gitignored PNGs after the JSON is written.
- Time zone: the three tests that need a zone where the local and UTC dates
  differ keep `America/New_York`. One comment in `test/storage.spec.js`
  said the iPhone check had run at that time in New York; it no longer does.
- Strix was not run: it is not installed, Docker was not running, and the
  repository has no `.env`.

2026-11-23, published as one commit. Before the first push, the 57-commit
build history was squashed into a single commit dated in UTC. Only the files
as they stand now become public, so no older version of a file can leak, and
the build's UTC offset and the old New York comment are gone. The reasoning
the build history recorded is in this file. The maintainer keeps the history
itself outside the repository.
