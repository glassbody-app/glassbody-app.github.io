// Checks the documents around the page (docs/specs/glassbody-v1.md, sections 5.3
// and 5.6): the Open Graph tags in index.html and the image they name, and the
// relative links in the Markdown files.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { readPngSize } = require('./png');

const ROOT = path.join(__dirname, '..');
const SITE_HOST = 'glassbody-app.github.io';

/**
 * Read the content of each `<meta property="…">` tag in index.html.
 *
 * @returns {Object<string, string>} content by property, such as `og:url`
 */
function readMetaProperties() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const props = {};
  for (const [, name, content] of html.matchAll(/<meta property="([^"]+)" content="([^"]*)">/g)) {
    props[name] = content;
  }
  return props;
}

test('og:url and og:image are absolute https URLs on glassbody-app.github.io', () => {
  const props = readMetaProperties();
  for (const name of ['og:url', 'og:image']) {
    expect(props[name], name).toBeDefined();
    const url = new URL(props[name]);
    expect(url.protocol, name).toBe('https:');
    // host, not hostname, so a port fails too
    expect(url.host, name).toBe(SITE_HOST);
  }
});

test('og:image names img/og.png, which is 1200 × 630 as its size tags say', () => {
  const props = readMetaProperties();
  expect(props['og:image'], 'og:image').toBeDefined();
  expect(new URL(props['og:image']).pathname).toBe('/img/og.png');
  expect(readPngSize('img/og.png')).toEqual({ width: 1200, height: 630 });
  expect([props['og:image:width'], props['og:image:height']]).toEqual(['1200', '630']);
});

// Markdown files whose relative links and images must point at files that exist
const LINKED_DOCS = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md'].concat(
  fs.readdirSync(path.join(ROOT, 'docs')).filter((f) => f.endsWith('.md')).sort()
    .map((f) => 'docs/' + f));

/**
 * List the targets of the links and images in a Markdown text, leaving out code,
 * where a bracket and a parenthesis are only text.
 *
 * @param {string} markdown the file's text
 * @returns {string[]} each target as written, such as `docs/img/hero.png#top`
 */
function listLinkTargets(markdown) {
  const text = markdown
    .replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm, '')
    .replace(/`[^`\n]*`/g, '');
  const targets = [];
  // [text](target), ![alt](target), either with an optional "title"
  for (const [, t] of text.matchAll(/\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/g)) targets.push(t);
  // reference definitions, [label]: target
  for (const [, t] of text.matchAll(/^ {0,3}\[[^\]\n]+\]:[ \t]*<?([^\s>]+)>?/gm)) targets.push(t);
  // HTML written into the Markdown
  for (const [, t] of text.matchAll(/<(?:img|a)\b[^>]*?\b(?:src|href)="([^"]+)"/gi)) targets.push(t);
  return targets;
}

/**
 * Tell whether a link target is a path in the repository: no scheme such as
 * `https:` or `mailto:`, and not an anchor on the same page.
 *
 * @param {string} target a link target as written
 * @returns {boolean}
 */
function isRepoPath(target) {
  return !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith('//') && !target.startsWith('#');
}

/**
 * Tell whether a relative link target names a file or folder inside the repository.
 * GitHub resolves a leading `/` from the repository root.
 *
 * @param {string} file the Markdown file the link is in, relative to the root
 * @param {string} target the link target, relative to that file
 * @returns {boolean}
 */
function resolvesInRepo(file, target) {
  const bare = decodeURIComponent(target.replace(/[#?].*$/, ''));
  if (!bare) return true;   // "?plain=1" or similar, the file itself
  const full = bare.startsWith('/') ? path.join(ROOT, bare)
    : path.resolve(ROOT, path.dirname(file), bare);
  return full.startsWith(ROOT + path.sep) && fs.existsSync(full);
}

for (const file of LINKED_DOCS) {
  test(`every relative link and image in ${file} points at a file in the repository`, () => {
    const full = path.join(ROOT, file);
    expect(fs.existsSync(full), `${file} exists`).toBe(true);
    const broken = listLinkTargets(fs.readFileSync(full, 'utf8'))
      .filter(isRepoPath)
      .filter((t) => !resolvesInRepo(file, t));
    expect(broken, `broken links in ${file}`).toEqual([]);
  });
}

// so the checks above cannot pass by finding no links at all
test('the link check finds the README hero image', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  expect(listLinkTargets(readme)).toContain('docs/img/hero.png');
});
