// The page renderer: a headless browser behind one HTTP endpoint.
//
// POST /render {url} → {html, finalUrl, status}. Used by the worker for pages that are an empty
// shell until their JavaScript runs. It is a browser pointed at a customer's website, so it is
// built like the crawler: only http(s), every hostname resolved here and refused when it is a
// private, loopback, link-local, CGNAT or metadata address - the page's own sub-requests
// included - images, media and fonts never fetched, a deadline on everything, and a shared
// secret so nothing but the worker can ask. One browser, a fresh context per page, two at once.

import { createServer } from 'node:http';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { chromium } from 'playwright';

const PORT = Number(process.env.PORT ?? 3000);
const TOKEN = process.env.RENDERER_TOKEN ?? '';
const ALLOW_PRIVATE = process.env.RENDERER_ALLOW_PRIVATE === 'true';
const CONCURRENCY = Number(process.env.RENDERER_CONCURRENCY ?? 2);
const NAVIGATION_TIMEOUT_MS = Number(process.env.RENDERER_TIMEOUT_MS ?? 20_000);
const SETTLE_MS = 1_500;
const MAX_HTML_BYTES = 3 * 1024 * 1024;
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 GetChatBot/1.0 (+https://getchat.site/bot)';

if (!TOKEN) {
  console.error('renderer: RENDERER_TOKEN is required');
  process.exit(1);
}

// --- address rules, the same as the crawler's ------------------------------------------------

function ipv4ToNumber(ip) {
  return ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);
}

const PRIVATE_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3],
].map(([base, bits]) => [ipv4ToNumber(base), bits]);

function isPrivateAddress(ip) {
  if (isIP(ip) === 4) {
    const n = ipv4ToNumber(ip);
    return PRIVATE_V4.some(([base, bits]) => (n >>> (32 - bits)) === (base >>> (32 - bits)));
  }
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('ff')) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isPrivateAddress(mapped[1]);
  return false;
}

const hostCache = new Map();
async function hostIsAllowed(hostname) {
  if (ALLOW_PRIVATE) return true;
  const key = hostname.toLowerCase();
  const cached = hostCache.get(key);
  if (cached && Date.now() - cached.at < 60_000) return cached.ok;
  let ok = false;
  try {
    const addresses = isIP(key) ? [{ address: key }] : await lookup(key, { all: true });
    ok = addresses.length > 0 && addresses.every((entry) => !isPrivateAddress(entry.address));
  } catch {
    ok = false;
  }
  hostCache.set(key, { at: Date.now(), ok });
  return ok;
}

function urlIsPlausible(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

// --- the browser ----------------------------------------------------------------------------------

let browserPromise = null;
function browser() {
  if (!browserPromise) {
    browserPromise = chromium
      .launch({
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
        // The image ships the matching browser; a developer running this outside it can point at one.
        ...(process.env.RENDERER_EXECUTABLE_PATH ? { executablePath: process.env.RENDERER_EXECUTABLE_PATH } : {}),
      })
      .then((b) => {
      b.on('disconnected', () => {
        browserPromise = null;
      });
      return b;
    });
  }
  return browserPromise;
}

let inFlight = 0;
const waiting = [];
function acquire() {
  if (inFlight < CONCURRENCY) {
    inFlight += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve)).then(() => {
    inFlight += 1;
  });
}
function release() {
  inFlight -= 1;
  const next = waiting.shift();
  if (next) next();
}

async function render(target) {
  const url = urlIsPlausible(target);
  if (!url) return { status: 400, body: { error: 'not an http(s) URL' } };
  if (!(await hostIsAllowed(url.hostname))) return { status: 403, body: { error: 'address refused' } };

  await acquire();
  const context = await (await browser()).newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1280, height: 900 },
    javaScriptEnabled: true,
    ignoreHTTPSErrors: false,
    locale: 'en-US',
  });
  try {
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    page.setDefaultTimeout(NAVIGATION_TIMEOUT_MS);
    await page.route('**/*', async (route) => {
      const request = route.request();
      const type = request.resourceType();
      if (type === 'image' || type === 'media' || type === 'font' || type === 'websocket') return route.abort();
      const requestUrl = urlIsPlausible(request.url());
      if (!requestUrl || !(await hostIsAllowed(requestUrl.hostname))) return route.abort();
      return route.continue();
    });
    let status = 0;
    page.on('response', (response) => {
      if (response.url() === page.url() && status === 0) status = response.status();
    });
    const response = await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
    status = response?.status() ?? status;
    await page.waitForLoadState('networkidle', { timeout: NAVIGATION_TIMEOUT_MS }).catch(() => undefined);
    await page.waitForTimeout(SETTLE_MS);
    const html = await page.content();
    if (Buffer.byteLength(html) > MAX_HTML_BYTES) return { status: 413, body: { error: 'rendered page too large' } };
    return { status: 200, body: { html, finalUrl: page.url(), status: status || 200 } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 502, body: { error: message.slice(0, 300) } };
  } finally {
    await context.close().catch(() => undefined);
    release();
  }
}

// --- HTTP ---------------------------------------------------------------------------------------------

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true, inFlight });
  if (req.method !== 'POST' || req.url !== '/render') return json(res, 404, { error: 'not found' });
  if (req.headers['x-renderer-token'] !== TOKEN) return json(res, 401, { error: 'unauthorised' });
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16_384) return json(res, 413, { error: 'body too large' });
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return json(res, 400, { error: 'expected JSON' });
  }
  if (typeof body?.url !== 'string' || body.url.length > 2_048) return json(res, 400, { error: 'expected {url}' });
  const started = Date.now();
  const outcome = await render(body.url);
  console.log(JSON.stringify({ at: new Date().toISOString(), url: body.url, status: outcome.status, ms: Date.now() - started }));
  return json(res, outcome.status, outcome.body);
});

server.listen(PORT, () => console.log(`renderer listening on :${PORT} (concurrency ${CONCURRENCY})`));

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close();
    (browserPromise ? browserPromise.then((b) => b.close()) : Promise.resolve()).finally(() => process.exit(0));
  });
}
