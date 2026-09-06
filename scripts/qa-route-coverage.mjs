/**
 * Does every call the front end makes reach a route, and does every page a link points at exist?
 *
 * Two failure modes, both of which survive typecheck, lint and unit tests, and both of which this
 * repository has now produced at least once:
 *
 *  - a client calling a path the router no longer registers. Removing billing deleted nine routes;
 *    a single missed `api.get('/billing/...')` would have compiled, linted and shipped, and only
 *    failed in a browser.
 *  - a link to a page that does not exist. Moving the dashboard under `/app` left buttons pointing
 *    at `/`, which is now the marketing home - so "Back to the dashboard" quietly went somewhere
 *    else.
 *
 * Reads the route files and the Next app directory as the source of truth, then checks every
 * `api.*('/...')` call and every internal `href` against them.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
const note = (ok, what, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (!ok && detail) for (const d of detail) console.log(`          ${d}`);
  if (!ok) failed += 1;
};

function walk(dir, test, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!/node_modules|\.next|\.turbo|dist/.test(full)) walk(full, test, acc);
    } else if (test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

// ---------------------------------------------------------------------------
// 1. What the API actually registers.
// ---------------------------------------------------------------------------
const routeFiles = walk(join(root, 'apps/api/src/routes'), (n) => n.endsWith('.ts'));
const registered = new Set();
for (const file of routeFiles) {
  const src = readFileSync(file, 'utf8');
  // app.get('/x'), guarded.post('/y'), scoped.delete(`/z/${id}`) - the verb is what identifies it.
  for (const m of src.matchAll(/\.(get|post|patch|put|delete)\(\s*['"`]([^'"`]+)['"`]/g)) {
    registered.add(m[2].replace(/:[A-Za-z0-9_]+/g, ':p'));
  }
}

// ---------------------------------------------------------------------------
// 2. What the front end calls.
// ---------------------------------------------------------------------------
const clientFiles = [
  ...walk(join(root, 'apps/web/src'), (n) => /\.(ts|tsx)$/.test(n) && !n.includes('.test.')),
  ...walk(join(root, 'apps/widget/src'), (n) => /\.(ts|tsx)$/.test(n) && !n.includes('.test.')),
];

/** `/conversations/${id}/messages` -> `/conversations/:p/messages` */
const normalise = (p) =>
  p
    .replace(/\$\{[^}]*\}/g, ':p')
    .replace(/:[A-Za-z0-9_]+/g, ':p')
    .split('?')[0]
    .replace(/\/$/, '');

const called = new Map();
for (const file of clientFiles) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(
    /\b(?:api|widgetApi|publicApiGet)\s*\.?\s*(?:get|post|patch|put|delete)?\s*(?:<[^>]*>)?\s*\(\s*[`'"]([/][^`'"]*)[`'"]/g,
  )) {
    called.set(normalise(m[1]), relative(root, file));
  }
}

console.log('Every call the front end makes, against every route the API registers\n');
console.log(`  ${registered.size} routes registered, ${called.size} distinct paths called\n`);

const missing = [];
for (const [path, where] of called) {
  if (path === '' || path.startsWith('//')) continue;
  const hit = [...registered].some((r) => normalise(r) === path);
  if (!hit) missing.push(`${path}   called from ${where}`);
}
note(missing.length === 0, 'every path the front end calls is a route the API registers', missing);

// ---------------------------------------------------------------------------
// 3. Internal links, against the pages that exist.
// ---------------------------------------------------------------------------
const appDir = join(root, 'apps/web/src/app');
const pages = new Set(['/']);
for (const file of walk(appDir, (n) => /^page\.tsx$/.test(n))) {
  let route = relative(appDir, dirname(file)).split(/[\\/]/).filter(Boolean);
  // Route groups - (marketing), (auth), (dashboard) - are organisational and not in the URL.
  route = route.filter((seg) => !/^\(.*\)$/.test(seg));
  pages.add('/' + route.join('/'));
}
// A segment like [id] or [publicId] matches anything.
const pageMatches = (href) => {
  const want = href.split('?')[0].split('#')[0].replace(/\/$/, '') || '/';
  for (const page of pages) {
    const a = page.split('/').filter(Boolean);
    const b = want.split('/').filter(Boolean);
    if (a.length !== b.length) continue;
    if (a.every((seg, i) => /^\[.*\]$/.test(seg) || seg === b[i])) return true;
  }
  return false;
};

const badLinks = [];
for (const file of walk(
  join(root, 'apps/web/src'),
  (n) => /\.tsx$/.test(n) && !n.includes('.test.'),
)) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/href=["'](\/[^"'{}]*)["']/g)) {
    const href = m[1];
    if (href.startsWith('//') || href.startsWith('/api/')) continue;
    if (!pageMatches(href)) badLinks.push(`${href}   linked from ${relative(root, file)}`);
  }
  for (const m of src.matchAll(
    /(?:router\.(?:push|replace)|location\.assign)\(\s*['"](\/[^'"]*)['"]/g,
  )) {
    const href = m[1];
    if (!pageMatches(href)) badLinks.push(`${href}   navigated to from ${relative(root, file)}`);
  }
}
note(badLinks.length === 0, 'every internal link points at a page that exists', [
  ...new Set(badLinks),
]);

// ---------------------------------------------------------------------------
// 4. Components nobody renders.
// ---------------------------------------------------------------------------
const componentFiles = walk(
  join(root, 'apps/web/src/components'),
  (n) => /\.tsx$/.test(n) && !n.includes('.test.'),
);
const allSrc = clientFiles.map((f) => readFileSync(f, 'utf8')).join('\n');
const orphans = [];
for (const file of componentFiles) {
  const base = file
    .replace(/\\/g, '/')
    .split('/apps/web/src/')[1]
    .replace(/\.tsx$/, '');
  const stem = base.split('/').pop();
  if (stem === 'index') continue;
  // Three ways a sibling can be imported, and missing any one of them turns a live component
  // into a false "orphan": by alias path (`@/components/inbox/shortcut-picker`), by relative
  // path from a neighbour (`./shortcut-picker`), or through a barrel (`@/components/ui`).
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const dir = dirname(base).replace(/\\/g, '/');
  const patterns = [
    new RegExp(`from ['"]@/${escaped}(\\.js)?['"]`),
    new RegExp(`from ['"]@/${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`),
    new RegExp(
      `from ['"]\\.{1,2}/(?:[\\w-]+/)*${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\.js)?['"]`,
    ),
  ];
  if (!patterns.some((p) => p.test(allSrc))) orphans.push(relative(root, file));
}
note(orphans.length === 0, 'every component file is imported by something', orphans);

console.log('\n' + '-'.repeat(70));
if (failed === 0) {
  console.log('No dangling calls, no dangling links, nothing orphaned.');
  process.exit(0);
}
console.log(`${failed} problem area(s).`);
process.exit(1);
