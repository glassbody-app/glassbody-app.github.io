# Security

Glassbody is a static page with no server of its own. The records it reads
stay in the visitor's browser, and a security problem here is one that
breaks that.

## What counts

- Script injection through an export or a backup file: anything in a zip or
  a JSON file that the page runs as script or inserts as HTML.
- Records leaving the browser: a request that carries stored data, or a way
  for another site to read it.
- A way around the Content-Security-Policy in `index.html`.
- The service worker, `sw.js`, serving anything other than the site's own
  files and the three pinned libraries from cdnjs.

## How to report

Use GitHub's private vulnerability reporting:
<https://github.com/glassbody-app/glassbody-app.github.io/security/advisories/new>.
The report goes to the maintainer privately, not to a public issue
([GitHub Docs, "Privately reporting a security vulnerability"](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately)).
There is no email address for reports.

Never attach real health data, yours or anyone else's. Reproduce the problem
with the sample (`data/sample.json`), the zips in `test/fixtures/`, or a file
you made by hand.

## Supported versions

The hosted site at <https://glassbody-app.github.io/> and the `main` branch.
Older commits get no fixes.

There is one maintainer and no promised response time.
