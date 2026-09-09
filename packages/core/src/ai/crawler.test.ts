import { describe, expect, it } from 'vitest';
import {
  siteHosts,
  crawlSite,
  extractLinks,
  excludes,
  isPrivateAddress,
  normaliseUrl,
  parseRobots,
  parseSitemap,
  type CrawlResponse,
} from './crawler.js';
import { extractPage } from './extract.js';

const page = (title: string, body: string): string =>
  `<!doctype html><html><head><title>${title}</title><meta name="description" content="About ${title}"></head><body><nav><a href="/">Home</a><a href="/about">About</a></nav><main>${body}</main><footer>© Acme</footer></body></html>`;

/** A fake site: a map of path → response. */
function fakeSite(routes: Record<string, { status?: number; type?: string; body?: string; location?: string }>) {
  const hits: string[] = [];
  const fetchImpl = async (url: string): Promise<CrawlResponse> => {
    hits.push(url);
    const parsed = new URL(url);
    const route = routes[parsed.pathname + parsed.search] ?? routes[parsed.pathname];
    if (!route) return { status: 404, headers: { get: () => null }, text: async () => 'nope' };
    const headers: Record<string, string> = { 'content-type': route.type ?? 'text/html; charset=utf-8' };
    if (route.location) headers['location'] = route.location;
    return { status: route.status ?? 200, headers: { get: (n) => headers[n.toLowerCase()] ?? null }, text: async () => route.body ?? '' };
  };
  return { fetchImpl, hits };
}

describe('crawlSite', () => {
  it('reads the sitemap, follows same-site links, honours robots, and skips the rest', async () => {
    const site = fakeSite({
      '/robots.txt': { type: 'text/plain', body: 'User-agent: *\nDisallow: /admin\nSitemap: https://acme.example/sitemap.xml\n' },
      '/sitemap.xml': { type: 'application/xml', body: '<urlset><url><loc>https://acme.example/courses</loc></url><url><loc>https://acme.example/admin/secret</loc></url></urlset>' },
      '/': { body: page('Acme', '<h1>Welcome</h1><p>We teach O-level and A-level courses in Dhaka.</p><a href="/about?utm_source=x#top">About</a><a href="https://other.example/x">Other</a><a href="/brochure.pdf">PDF</a><a href="mailto:a@b">mail</a>') },
      '/about': { body: page('About', '<h2>Who we are</h2><p>Founded in 2010 by teachers who wanted smaller classes.</p><ul><li>Small groups</li><li>Weekly tests</li></ul>') },
      '/courses': { body: page('Courses', '<p>Physics, Chemistry, Maths. Fees from 3,000 BDT a month.</p>') },
      '/admin/secret': { body: page('Secret', '<p>never</p>') },
    });
    const pages: string[] = [];
    const summary = await crawlSite(
      { startUrl: 'https://acme.example', maxPages: 50, delayMs: 0, fetchImpl: site.fetchImpl },
      async (p) => {
        pages.push(`${p.url} :: ${p.title} :: ${p.text.replace(/\s+/g, ' ').slice(0, 60)}`);
      },
    );
    const expected = [
      'https://acme.example/ :: Acme :: # Welcome We teach O-level',
      'https://acme.example/courses :: Courses :: Physics, Chemistry',
      'https://acme.example/about :: About :: ## Who we are Founded',
    ];
    expect(pages).toHaveLength(3);
    expected.forEach((prefix, i) => expect(pages[i]!.startsWith(prefix), pages[i]).toBe(true));
    expect(site.hits).not.toContain('https://acme.example/admin/secret');
    expect(site.hits.some((h) => h.includes('other.example'))).toBe(false);
    expect(site.hits.some((h) => h.includes('brochure.pdf'))).toBe(false);
    // The tracking parameter and fragment were dropped before the page was fetched.
    expect(site.hits).toContain('https://acme.example/about');
    expect(summary).toMatchObject({ fetched: 3, failed: 0, stoppedBecause: 'exhausted' });
  });

  it('stops at the page budget', async () => {
    const routes: Record<string, { body: string }> = {};
    for (let i = 0; i < 10; i += 1) {
      routes[`/p${i}`] = { body: page(`P${i}`, `<p>Page ${i} has some words in it for the extractor to keep.</p><a href="/p${i + 1}">next</a>`) };
    }
    routes['/'] = { body: page('Home', '<p>Start here with enough words to count.</p><a href="/p0">first</a>') };
    const site = fakeSite(routes);
    const summary = await crawlSite({ startUrl: 'https://acme.example/', maxPages: 4, delayMs: 0, fetchImpl: site.fetchImpl }, async () => undefined);
    expect(summary.fetched).toBe(4);
    expect(summary.stoppedBecause).toBe('budget');
  });

  it('follows a redirect within the site and refuses one that leaves it', async () => {
    const site = fakeSite({
      '/': { status: 301, location: 'https://www.acme.example/home' },
      '/home': { body: page('Home', '<p>Welcome to the real home page with enough text.</p><a href="/away">away</a>') },
      '/away': { status: 302, location: 'https://evil.example/' },
    });
    const urls: string[] = [];
    const summary = await crawlSite({ startUrl: 'https://acme.example/', maxPages: 10, delayMs: 0, fetchImpl: site.fetchImpl }, async (p) => {
      urls.push(p.url);
    });
    expect(urls).toEqual(['https://www.acme.example/home']);
    expect(summary.errors.map((e) => e.reason)).toContain('redirect leaves the site');
    expect(site.hits.some((h) => h.includes('evil.example'))).toBe(false);
  });

  it('recognises a bot-verification page and stops rather than indexing it', async () => {
    const site = fakeSite({
      '/': { body: '<html><head><title>Bot Verification</title></head><body><form id="lsrecaptcha-form"><altcha-widget></altcha-widget></form><h3>acme.example: Verifying that you are not a robot...</h3></body></html>' },
    });
    const pages: string[] = [];
    const summary = await crawlSite({ startUrl: 'https://acme.example/', maxPages: 10, delayMs: 0, fetchImpl: site.fetchImpl }, async (p) => {
      pages.push(p.url);
    });
    expect(pages).toEqual([]);
    expect(summary.stoppedBecause).toBe('bot_challenge');
  });

  it('reports an unreachable start page', async () => {
    const site = fakeSite({});
    const summary = await crawlSite({ startUrl: 'https://acme.example/', maxPages: 10, delayMs: 0, fetchImpl: site.fetchImpl }, async () => undefined);
    expect(summary).toMatchObject({ fetched: 0, stoppedBecause: 'start_unreachable' });
  });
});

describe('normaliseUrl', () => {
  it('keeps only http(s) on default ports, without fragments, credentials or tracking', () => {
    expect(normaliseUrl('HTTPS://Acme.Example/a?utm_source=x&b=1#frag', null)).toBe('https://acme.example/a?b=1');
    expect(normaliseUrl('ftp://acme.example/x', null)).toBeNull();
    expect(normaliseUrl('https://acme.example:8443/', null)).toBeNull();
    expect(normaliseUrl('https://user:pw@acme.example/', null)).toBeNull();
    expect(normaliseUrl('/relative', 'https://acme.example/dir/page')).toBe('https://acme.example/relative');
    expect(normaliseUrl('javascript:alert(1)', 'https://acme.example/')).toBeNull();
  });

  it('treats www and bare hosts as one site', () => {
    expect([...siteHosts('www.acme.example')].sort()).toEqual(['acme.example', 'www.acme.example']);
    expect(siteHosts('shop.acme.example').has('acme.example')).toBe(false);
  });
});

describe('parseRobots', () => {
  const rules = parseRobots(
    'User-agent: Googlebot\nDisallow: /g\n\nUser-agent: *\nDisallow: /private\nDisallow: /tmp/*.html$\nAllow: /private/ok\nSitemap: https://acme.example/s.xml\n',
    'GetChatBot/1.0',
  );
  it('applies the wildcard group with allow overrides and wildcards', () => {
    expect(rules.allows('/public')).toBe(true);
    expect(rules.allows('/private/x')).toBe(false);
    expect(rules.allows('/private/ok/y')).toBe(true);
    expect(rules.allows('/tmp/a.html')).toBe(false);
    expect(rules.allows('/tmp/a.htmlx')).toBe(true);
    expect(rules.allows('/g')).toBe(true);
    expect(rules.sitemaps).toEqual(['https://acme.example/s.xml']);
  });
  it('prefers a group naming this crawler', () => {
    const own = parseRobots('User-agent: GetChatBot\nDisallow: /\n\nUser-agent: *\nDisallow:\n', 'GetChatBot/1.0');
    expect(own.allows('/anything')).toBe(false);
  });
});

describe('parseSitemap / extractLinks', () => {
  it('reads url sets and sitemap indexes', () => {
    expect(parseSitemap('<urlset><url><loc>https://a.example/x?a=1&amp;b=2</loc></url></urlset>')).toEqual({ pages: ['https://a.example/x?a=1&b=2'], nested: [] });
    expect(parseSitemap('<sitemapindex><sitemap><loc>https://a.example/s1.xml</loc></sitemap></sitemapindex>')).toEqual({ pages: [], nested: ['https://a.example/s1.xml'] });
  });
  it('finds hrefs in any quoting and drops non-navigational ones', () => {
    expect(extractLinks(`<a href="/a">x</a><a href='/b'>y</a><a href=/c>z</a><a href="#top">t</a><a href="mailto:x@y">m</a>`)).toEqual(['/a', '/b', '/c']);
  });
});

describe('isPrivateAddress', () => {
  it('refuses the ranges a crawler must never touch', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '129.225.82.147', '172.32.0.1', '2606:4700::1111']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
});

describe('extractPage', () => {
  it('drops chrome and keeps headings, lists and the description', () => {
    const html = page('Fees', '<h1>Fees</h1><p>Monthly fees are 3,000 BDT for O-level and 4,000 BDT for A-level. Sibling discount 10%.</p><h2>What is included</h2><ul><li>Notes</li><li>Weekly tests</li></ul>');
    const out = extractPage(html, 'https://acme.example/fees')!;
    expect(out.title).toBe('Fees');
    expect(out.description).toBe('About Fees');
    expect(out.text).toContain('# Fees');
    expect(out.text).toContain('## What is included');
    expect(out.text).toContain('- Notes');
    expect(out.text).not.toContain('Home');
    expect(out.text).not.toContain('© Acme');
  });
});

describe('excludes', () => {
  it('anchors a pattern that starts with a slash and covers what is beneath it', () => {
    const test = excludes(['/blog', '/cart']);
    expect(test('/blog')).toBe(true);
    expect(test('/blog/2024/hello')).toBe(true);
    expect(test('/blogger')).toBe(false);
    expect(test('/shop/cart')).toBe(false);
    expect(test('/cart?item=1')).toBe(true);
  });

  it('expands wildcards and matches anywhere without a leading slash', () => {
    const test = excludes(['/docs/*/draft', '*.pdf', '?add-to-cart']);
    expect(test('/docs/v1/draft')).toBe(true);
    expect(test('/docs/v1/final')).toBe(false);
    expect(test('/files/Price-List.PDF')).toBe(true);
    expect(test('/shop/?add-to-cart=12')).toBe(true);
    expect(test('/shop/')).toBe(false);
  });

  it('excludes nothing for empty or absurd patterns', () => {
    expect(excludes([])('/anything')).toBe(false);
    expect(excludes(['', '   ', 'x'.repeat(201)])('/anything')).toBe(false);
    expect(excludes(['(unbalanced'])('/(unbalanced/page')).toBe(true);
  });
});
