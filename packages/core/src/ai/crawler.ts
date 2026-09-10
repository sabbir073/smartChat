import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { extractPage, type ExtractedPage } from './extract.js';
import type { ReadPage } from './reader.js';

/**
 * The website crawler: the owner's public pages, found and read.
 *
 * It is a classic SSRF target - a URL somebody typed, fetched by a server inside a private
 * network - and is built as one:
 *
 *   - it only ever fetches the property's own host (and its `www.` twin), over http(s) on the
 *     default ports; nothing else is even queued;
 *   - every connection resolves the name itself and refuses private, loopback, link-local and
 *     cloud-metadata ranges *at connect time*, so a name that rebinds between check and use gets
 *     nothing;
 *   - redirects are followed by hand, up to three, each re-checked like a fresh URL;
 *   - only `text/html` bodies are read, at most 2 MB each, 20 s each, one request a second;
 *   - robots.txt is honoured, and the crawler names itself.
 *
 * Pages come from the sitemap first (the owner's own list of what matters) and then from links
 * found on pages already read, breadth first, until the page budget is spent.
 */

export interface CrawlOptions {
  startUrl: string;
  maxPages: number;
  /** Between requests to the site. Tests set 0. */
  delayMs?: number;
  timeoutMs?: number;
  maxBytes?: number;
  userAgent?: string;
  /** Injected in tests. Production uses undici with the private-range-refusing lookup. */
  fetchImpl?: (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<CrawlResponse>;
  /** Stop early - the job was cancelled, the property is gone. */
  shouldStop?: () => boolean;
  /**
   * Paths the owner does not want read: `/blog/*`, `/cart`, `*.pdf`. See `excludes`. The start
   * page is always read.
   */
  exclude?: string[];
  /**
   * The page reader - a browser and crawl4ai in their own container, see `reader.ts`. When it is
   * there, every HTML page is read through it: the JavaScript runs, the chrome is dropped, and
   * the text comes back as markdown with the page's headings. When it is absent, or fails on a
   * page, the plain fetch and the built-in extraction stand in. Returns null when it could not.
   */
  read?: (url: string) => Promise<ReadPage | null>;
  /**
   * Development only: let the crawler reach private addresses (a test site on localhost). The
   * production compose file never sets it, and the config schema defaults it to false.
   */
  allowPrivateAddresses?: boolean;
}

export interface CrawlResponse {
  status: number;
  headers: { get(name: string): string | null };
  /** Read the body as text, giving up past `maxBytes` (the reader's own cap when omitted). */
  text(maxBytes?: number): Promise<string>;
  body?: unknown;
}

export interface CrawledPage extends ExtractedPage {
  url: string;
}

export interface CrawlSummary {
  /** Pages read through the browser (the reader), rather than the plain fetch. */
  rendered: number;
  /** Distinct URLs discovered (sitemap + links), whether or not fetched. */
  found: number;
  fetched: number;
  /** Fetched but not usable: not HTML, empty, too big. */
  skipped: number;
  failed: number;
  /** Why the crawl stopped: budget, exhausted, stopped, or the reason nothing could be read. */
  stoppedBecause: 'budget' | 'exhausted' | 'stopped' | 'start_unreachable' | 'bot_challenge';
  errors: Array<{ url: string; reason: string }>;
}

/**
 * Some hosts answer every non-browser request with a challenge page (LiteSpeed's "Bot
 * Verification", Cloudflare's "Just a moment…"). The crawler does not try to get past those - it
 * is a bot, and the host has asked bots to leave - but it must recognise them, because indexing a
 * page that says "verifying that you are not a robot" as the business's home page would be worse
 * than indexing nothing. The owner is told, and can ask their host to allow the crawler's agent.
 */
export function looksLikeBotChallenge(html: string): boolean {
  const head = html.slice(0, 6_000).toLowerCase();
  return (
    head.includes('lsrecaptcha') ||
    head.includes('altcha-widget') ||
    head.includes('<title>bot verification') ||
    head.includes('<title>just a moment...') ||
    head.includes('cf-chl-') ||
    head.includes('challenge-platform') ||
    head.includes('verifying that you are not a robot') ||
    head.includes('checking your browser before accessing')
  );
}

export const CRAWLER_USER_AGENT = 'GetChatBot/1.0 (+https://getchat.site/bot)';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const MAX_SITEMAP_URLS = 2_000;
const MAX_SITEMAPS = 10;
const MAX_QUEUE = 5_000;
/** Below this much text a page has nothing to teach; below this much markdown the reader's answer is not trusted over the plain one. */
const MIN_PAGE_CHARS = 40;

const SKIP_EXTENSIONS = /\.(?:jpe?g|png|gif|webp|svg|ico|bmp|tiff?|mp4|mp3|wav|avi|mov|mkv|webm|zip|gz|tar|rar|7z|pdf|docx?|xlsx?|pptx?|css|js|json|xml|rss|atom|woff2?|ttf|eot|exe|dmg|apk)$/i;
const TRACKING_PARAMS = /^(?:utm_|fbclid|gclid|mc_|ref$|_ga)/i;

export async function crawlSite(
  options: CrawlOptions,
  onPage: (page: CrawledPage) => Promise<void>,
): Promise<CrawlSummary> {
  const start = normaliseUrl(options.startUrl, null);
  if (!start) throw new Error(`Not a crawlable URL: ${options.startUrl}`);
  const hosts = siteHosts(new URL(start).hostname);
  const fetchImpl = options.fetchImpl ?? (options.allowPrivateAddresses ? unsafeFetchForDevelopment : safeFetch);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const delayMs = options.delayMs ?? 1_000;
  const userAgent = options.userAgent ?? CRAWLER_USER_AGENT;
  const summary: CrawlSummary = { found: 0, fetched: 0, skipped: 0, failed: 0, rendered: 0, stoppedBecause: 'exhausted', errors: [] };

  const get = async (url: string): Promise<{ status: number; contentType: string; text: string; finalUrl: string } | { error: string }> => {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(current, {
          headers: { 'user-agent': userAgent, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5', 'accept-language': '*' },
          signal: controller.signal,
        });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (!location) return { error: `redirect without location (${response.status})` };
          const next = normaliseUrl(location, current);
          if (!next || !hosts.has(new URL(next).hostname)) return { error: 'redirect leaves the site' };
          current = next;
          continue;
        }
        const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
        const length = Number(response.headers.get('content-length') ?? '0');
        if (length > maxBytes) return { error: 'too large' };
        const text = await response.text(maxBytes);
        if (text.length > maxBytes) return { error: 'too large' };
        return { status: response.status, contentType, text, finalUrl: current };
      } catch (error) {
        const reason = controller.signal.aborted ? 'timed out' : error instanceof Error ? error.message : String(error);
        return { error: reason };
      } finally {
        clearTimeout(timer);
      }
    }
    return { error: 'too many redirects' };
  };

  // --- robots.txt ---------------------------------------------------------------------------
  const origin = new URL(start).origin;
  const robots = await get(`${origin}/robots.txt`);
  const rules = 'error' in robots || robots.status !== 200 ? parseRobots('', userAgent) : parseRobots(robots.text, userAgent);
  await sleep(delayMs);

  // --- the queue -------------------------------------------------------------------------------
  const excluded = excludes(options.exclude ?? []);
  const queued = new Set<string>();
  const queue: string[] = [];
  const enqueue = (candidate: string, base: string | null): void => {
    const url = normaliseUrl(candidate, base);
    if (!url || queued.has(url) || queued.size >= MAX_QUEUE) return;
    const parsed = new URL(url);
    if (!hosts.has(parsed.hostname)) return;
    if (SKIP_EXTENSIONS.test(parsed.pathname)) return;
    if (!rules.allows(parsed.pathname + parsed.search)) return;
    if (url !== start && excluded(parsed.pathname + parsed.search)) {
      summary.skipped += 1;
      return;
    }
    queued.add(url);
    queue.push(url);
  };

  enqueue(start, null);
  const sitemaps = rules.sitemaps.length > 0 ? rules.sitemaps : [`${origin}/sitemap.xml`];
  let sitemapUrls = 0;
  const seenSitemaps = new Set<string>();
  const sitemapQueue = [...sitemaps];
  while (sitemapQueue.length > 0 && seenSitemaps.size < MAX_SITEMAPS && sitemapUrls < MAX_SITEMAP_URLS) {
    const sitemapUrl = normaliseUrl(sitemapQueue.shift()!, origin);
    if (!sitemapUrl || seenSitemaps.has(sitemapUrl) || !hosts.has(new URL(sitemapUrl).hostname)) continue;
    seenSitemaps.add(sitemapUrl);
    const result = await get(sitemapUrl);
    await sleep(delayMs);
    if ('error' in result || result.status !== 200) continue;
    const { pages, nested } = parseSitemap(result.text);
    for (const nestedUrl of nested) sitemapQueue.push(nestedUrl);
    for (const page of pages) {
      if (sitemapUrls >= MAX_SITEMAP_URLS) break;
      sitemapUrls += 1;
      enqueue(page, null);
    }
  }

  // --- the crawl -------------------------------------------------------------------------------
  let startReachable = false;
  // Final URLs already delivered: two queued URLs that redirect to the same page count once.
  const delivered = new Set<string>();
  while (queue.length > 0) {
    if (options.shouldStop?.()) {
      summary.stoppedBecause = 'stopped';
      break;
    }
    if (summary.fetched >= options.maxPages) {
      summary.stoppedBecause = 'budget';
      break;
    }
    const url = queue.shift()!;
    // The plain fetch first: cheap, and it settles the status, the content type, the redirect
    // and whether the host is turning bots away, before a browser is spent on the page.
    const result = await get(url);
    await sleep(delayMs);
    if ('error' in result) {
      summary.failed += 1;
      if (summary.errors.length < 50) summary.errors.push({ url, reason: result.error });
      continue;
    }
    const challenged = result.status === 200 && looksLikeBotChallenge(result.text);
    let read: ReadPage | null = null;
    if (options.read && (result.status === 200 || result.status === 403 || challenged)) {
      const isHtml = result.contentType.includes('text/html') || result.contentType.includes('application/xhtml');
      // A host that challenges or refuses the plain fetch may still serve a browser; the reader
      // is one. Otherwise only pages worth reading are sent to it.
      if (isHtml || result.status === 403) {
        read = await options.read(result.finalUrl);
        if (read && (read.status !== 200 || looksLikeBotChallenge(read.html))) read = null;
        // The browser came back with next to nothing (a page that rendered empty, a script that
        // wiped the document): the plain fetch's HTML is the better copy whenever it has words.
        // Measured live: a site the plain fetch read in full once came back from the browser as
        // three kilobytes of head and an empty body, and was indexed as nothing.
        if (read && read.markdown.trim().length < MIN_PAGE_CHARS && result.status === 200 && !challenged) {
          const plain = extractPage(result.text, result.finalUrl);
          if (plain && plain.text.length >= MIN_PAGE_CHARS) read = null;
        }
      }
    }
    if (result.status !== 200 && !read) {
      summary.failed += 1;
      if (summary.errors.length < 50) summary.errors.push({ url, reason: `HTTP ${result.status}` });
      continue;
    }
    if (url === start) startReachable = true;
    if (!read && !result.contentType.includes('text/html') && !result.contentType.includes('application/xhtml')) {
      summary.skipped += 1;
      continue;
    }
    if (challenged && !read) {
      summary.failed += 1;
      if (summary.errors.length < 50) summary.errors.push({ url, reason: 'bot verification page' });
      if (url === start) {
        summary.stoppedBecause = 'bot_challenge';
        break;
      }
      continue;
    }
    const finalUrl = read?.finalUrl && hosts.has(new URL(read.finalUrl).hostname) ? normaliseUrl(read.finalUrl, null) ?? result.finalUrl : result.finalUrl;
    if (delivered.has(finalUrl)) continue;
    delivered.add(finalUrl);
    summary.fetched += 1;
    if (finalUrl !== url) queued.add(finalUrl);
    const html = read?.html ?? result.text;
    for (const link of extractLinks(html)) enqueue(link, finalUrl);
    for (const link of read?.links ?? []) enqueue(link, finalUrl);
    let extracted: ExtractedPage | null = null;
    if (read && read.markdown.trim().length >= MIN_PAGE_CHARS) {
      summary.rendered += 1;
      const plain = extractPage(html, finalUrl);
      extracted = {
        title: read.title ?? plain?.title ?? finalUrl,
        description: read.description ?? plain?.description ?? null,
        text: tidyMarkdown(read.markdown),
      };
    } else {
      extracted = extractPage(html, finalUrl);
    }
    if (!extracted || extracted.text.length < MIN_PAGE_CHARS) {
      summary.skipped += 1;
      continue;
    }
    await onPage({ ...extracted, url: finalUrl });
  }
  summary.found = queued.size;
  if (summary.fetched === 0 && !startReachable && summary.stoppedBecause !== 'bot_challenge') {
    summary.stoppedBecause = 'start_unreachable';
  }
  return summary;
}

/**
 * The reader's markdown, in the shape the chunker reads: `-` bullets, every heading on a line of
 * its own with blank lines around it (the chunker takes a heading only as a block by itself),
 * single blank lines between blocks.
 */
export function tidyMarkdown(markdown: string): string {
  return markdown
    .replace(/\r\n?/g, '\n')
    .replace(/^[ \t]*[*+][ \t]+/gm, '- ')
    .replace(/[ \t]+$/gm, '')
    .replace(/^(#{1,6}[ \t]+[^\n]+)$/gm, '\n$1\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// --- URL handling ----------------------------------------------------------------------------------

/** Absolute, http(s), default port, no fragment, no tracking parameters, trailing slash on bare paths. */
/**
 * The owner's exclusions, as a test on a URL's path.
 *
 * A pattern is a path with `*` wildcards. One that starts with `/` is anchored at the start of
 * the path and, with no wildcard, also covers everything beneath it, so `/blog` excludes `/blog`
 * and `/blog/2024/hello`. One that does not start with `/` may match anywhere in the path, so
 * `*.pdf` and `.pdf` both exclude every PDF, and `?add-to-cart` excludes the shop's action links.
 * Matching ignores case. An empty or unparseable pattern excludes nothing.
 */
export function excludes(patterns: string[]): (path: string) => boolean {
  const tests = patterns
    .map((raw) => raw.trim())
    .filter((pattern) => pattern.length > 0 && pattern.length <= 200)
    .map((pattern) => {
      const anchored = pattern.startsWith('/');
      const body = pattern
        .split('*')
        .map((piece) => piece.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*');
      const tail = anchored && !pattern.includes('*') ? '(?:$|[/?#])' : '';
      return new RegExp(`${anchored ? '^' : ''}${body}${tail}`, 'i');
    });
  if (tests.length === 0) return () => false;
  return (path) => tests.some((test) => test.test(path));
}

export function normaliseUrl(candidate: string, base: string | null): string | null {
  let url: URL;
  try {
    url = base ? new URL(candidate, base) : new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (url.port && url.port !== '80' && url.port !== '443') return null;
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  if (url.search.length > 200) return null;
  if (url.pathname === '') url.pathname = '/';
  return url.toString();
}

export function siteHosts(hostname: string): Set<string> {
  const host = hostname.toLowerCase();
  const bare = host.replace(/^www\./, '');
  return new Set([host, bare, `www.${bare}`]);
}

/**
 * Does this HTML look like it needs JavaScript to say anything? The signs the frameworks leave:
 * a root element for the app, a "you need to enable JavaScript" notice, or a body that is all
 * script and no words. Cheap, and only consulted when the extracted text is already near empty.
 */
export function looksLikeAppShell(html: string): boolean {
  const head = html.slice(0, 200_000);
  if (/id=["'](?:root|app|__next|__nuxt|___gatsby|svelte|q-app)["']/i.test(head)) return true;
  if (/<app-root|<div[^>]+data-reactroot|ng-version=|data-server-rendered/i.test(head)) return true;
  if (/<noscript>[\s\S]{0,300}?(?:enable|need|requires?)\s+javascript/i.test(head)) return true;
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(head)?.[1] ?? '';
  const withoutScripts = body.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  const words = withoutScripts.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return body.length > 0 && words.length < 80 && /<script/i.test(body);
}

const HREF = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

export function extractLinks(html: string): string[] {
  const out: string[] = [];
  for (const match of html.matchAll(HREF)) {
    const href = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (!href || href.startsWith('#') || /^(?:mailto|tel|javascript|data):/i.test(href)) continue;
    out.push(href.replace(/&amp;/g, '&'));
  }
  return out;
}

// --- sitemaps --------------------------------------------------------------------------------------

export function parseSitemap(xml: string): { pages: string[]; nested: string[] } {
  const pages: string[] = [];
  const nested: string[] = [];
  const isIndex = /<sitemapindex/i.test(xml);
  for (const match of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
    const loc = match[1]!.replace(/&amp;/g, '&');
    (isIndex ? nested : pages).push(loc);
  }
  return { pages, nested };
}

// --- robots.txt ------------------------------------------------------------------------------------

export interface RobotsRules {
  allows(path: string): boolean;
  sitemaps: string[];
}

/**
 * The subset of robots.txt that matters: the `Disallow` lines for `*` and for our own agent (the
 * more specific group wins, as the standard says), `Allow` overriding a longer match, and
 * `Sitemap:` lines. Wildcards `*` and `$` are honoured.
 */
export function parseRobots(text: string, userAgent: string): RobotsRules {
  const agentToken = userAgent.split('/')[0]!.toLowerCase();
  const groups: Array<{ agents: string[]; allow: string[]; disallow: string[] }> = [];
  const sitemaps: string[] = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === 'sitemap') {
      sitemaps.push(value);
      continue;
    }
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], allow: [], disallow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === 'disallow' && value) current.disallow.push(value);
    if (field === 'allow' && value) current.allow.push(value);
  }
  const specific = groups.find((g) => g.agents.some((a) => a === agentToken || agentToken.startsWith(a)));
  const group = specific ?? groups.find((g) => g.agents.includes('*')) ?? { allow: [], disallow: [] };
  const toRegex = (pattern: string): RegExp => {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped.endsWith('\\$') ? escaped.slice(0, -2) + '$' : escaped}`);
  };
  const disallow = group.disallow.map((p) => ({ length: p.length, re: toRegex(p) }));
  const allow = group.allow.map((p) => ({ length: p.length, re: toRegex(p) }));
  return {
    sitemaps,
    allows(path: string): boolean {
      const blocked = disallow.filter((r) => r.re.test(path)).sort((a, b) => b.length - a.length)[0];
      if (!blocked) return true;
      const allowed = allow.filter((r) => r.re.test(path)).sort((a, b) => b.length - a.length)[0];
      return allowed !== undefined && allowed.length >= blocked.length;
    },
  };
}

// --- the safe fetch --------------------------------------------------------------------------------

/** Is this address one the crawler must never connect to? */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a = 0, b = 0] = address.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true;
    if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice(7));
    if (lower.startsWith('64:ff9b:')) return true;
    return false;
  }
  return true;
}

/** A DNS lookup that refuses private answers, wired into undici's connector. */
function safeLookup(
  hostname: string,
  options: unknown,
  callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
): void {
  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      callback(Object.assign(new Error(`refusing private address ${hostname}`), { code: 'EPRIVATE' }), '');
      return;
    }
    callback(null, hostname, isIP(hostname));
    return;
  }
  dnsLookup(hostname, { all: true })
    .then((addresses) => {
      const usable = addresses.filter((entry) => !isPrivateAddress(entry.address));
      if (usable.length === 0) {
        callback(Object.assign(new Error(`${hostname} resolves only to private addresses`), { code: 'EPRIVATE' }), '');
        return;
      }
      const all = (options as { all?: boolean } | undefined)?.all;
      if (all) callback(null, usable);
      else callback(null, usable[0]!.address, usable[0]!.family);
    })
    .catch((error: NodeJS.ErrnoException) => callback(error, ''));
}

let agent: Dispatcher | null = null;
/**
 * The most a single response is read, whoever asked. The crawl caps pages at 2 MB itself; a
 * product feed may legitimately be much larger, and the reader applies its own limit on top.
 */
const FETCH_READ_CAP = 25 * 1024 * 1024;

function crawlerAgent(): Dispatcher {
  if (!agent) {
    agent = new Agent({
      connect: { lookup: safeLookup as never, timeout: 10_000 },
    });
  }
  return agent;
}

async function safeFetch(
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
): Promise<CrawlResponse> {
  const response = await undiciFetch(url, {
    method: 'GET',
    headers: init.headers,
    signal: init.signal,
    redirect: 'manual',
    dispatcher: crawlerAgent(),
  });
  return {
    status: response.status,
    headers: response.headers,
    text: (maxBytes?: number) => readCapped(response, Math.min(maxBytes ?? FETCH_READ_CAP, FETCH_READ_CAP)),
  };
}

/**
 * One document from the site's own hosts, for readers other than the crawl (the product feed).
 * The same SSRF rules: name resolved by us, private ranges refused at connect time, redirects
 * followed by hand and re-checked, a byte cap, a deadline. Returns the body as text.
 */
export async function fetchDocument(
  url: string,
  options: { maxBytes: number; timeoutMs: number; allowPrivateAddresses?: boolean; userAgent?: string; accept?: string },
): Promise<{ status: number; contentType: string; text: string; finalUrl: string }> {
  const fetchImpl = options.allowPrivateAddresses ? unsafeFetchForDevelopment : safeFetch;
  const start = normaliseUrl(url, null);
  if (!start) throw new Error(`Not a fetchable URL: ${url}`);
  let current: string = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const response = await fetchImpl(current, {
        headers: { 'user-agent': options.userAgent ?? CRAWLER_USER_AGENT, accept: options.accept ?? '*/*' },
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        const next: string | null = location ? normaliseUrl(location, current) : null;
        if (!next) throw new Error(`redirect without a usable location (${response.status})`);
        current = next;
        continue;
      }
      const length = Number(response.headers.get('content-length') ?? '0');
      if (length > options.maxBytes) throw new Error('too large');
      const text = await response.text(options.maxBytes);
      if (text.length > options.maxBytes) throw new Error('too large');
      return { status: response.status, contentType: (response.headers.get('content-type') ?? '').toLowerCase(), text, finalUrl: current };
    } catch (error) {
      if (controller.signal.aborted) throw new Error('timed out');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('too many redirects');
}

/** The same request without the private-range refusal. Development only; see CrawlOptions. */
async function unsafeFetchForDevelopment(
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
): Promise<CrawlResponse> {
  const response = await undiciFetch(url, { method: 'GET', headers: init.headers, signal: init.signal, redirect: 'manual' });
  return { status: response.status, headers: response.headers, text: (maxBytes?: number) => readCapped(response, Math.min(maxBytes ?? FETCH_READ_CAP, FETCH_READ_CAP)) };
}

async function readCapped(response: Awaited<ReturnType<typeof undiciFetch>>, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return 'x'.repeat(maxBytes + 1);
    }
    chunks.push(value);
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks));
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}
