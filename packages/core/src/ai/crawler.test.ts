import { describe, expect, it } from 'vitest';
import {
  siteHosts,
  crawlSite,
  extractLinks,
  excludes,
  looksLikeAppShell,
  isPrivateAddress,
  normaliseUrl,
  parseRobots,
  parseSitemap,
  tidyMarkdown,
  type CrawlResponse,
} from './crawler.js';
import type { ReadPage } from './reader.js';
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

describe('looksLikeAppShell', () => {
  it('recognises the frameworks\' empty shells', () => {
    expect(looksLikeAppShell('<html><body><div id="root"></div><script src="/app.js"></script></body></html>')).toBe(true);
    expect(looksLikeAppShell('<html><body><div id="__next"></div></body></html>')).toBe(true);
    expect(looksLikeAppShell('<html><body><app-root></app-root><script src="main.js"></script></body></html>')).toBe(true);
    expect(looksLikeAppShell('<html><body><noscript>You need to enable JavaScript to run this app.</noscript><div></div></body></html>')).toBe(true);
    expect(looksLikeAppShell('<html><body><div class="x"></div><script>boot()</script></body></html>')).toBe(true);
  });

  it('leaves ordinary pages alone', () => {
    const page = '<html><body><h1>Fees</h1><p>' + 'Monthly tuition is 3,500 taka per subject. '.repeat(4) + '</p><script>track()</script></body></html>';
    expect(looksLikeAppShell(page)).toBe(false);
    expect(looksLikeAppShell('<html><body></body></html>')).toBe(false);
  });
});

describe('crawlSite with the reader', () => {
  const shell = '<html><head><title>Shop</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>';
  const rendered = '<html><head><title>Shop</title></head><body><div id="root"><h1>Shop</h1><p>' + 'We sell bikes and helmets in Dhanmondi. '.repeat(5) + '</p><a href="/about">About</a></div></body></html>';
  const about = '<html><head><title>About</title></head><body><main><p>' + 'Founded in 2012 by three teachers who ride. '.repeat(5) + '</p></main></body></html>';
  const challenge = '<html><head><title>Bot Verification</title></head><body>verifying that you are not a robot</body></html>';

  const site = (pages: Record<string, string | { status: number; body: string }>) => async (url: string): Promise<CrawlResponse> => {
    const path = new URL(url).pathname;
    const entry = pages[path];
    const body = typeof entry === 'string' ? entry : entry?.body;
    return {
      status: entry === undefined ? 404 : typeof entry === 'string' ? 200 : entry.status,
      headers: { get: (name: string) => (name === 'content-type' ? 'text/html' : null) },
      text: async () => body ?? '',
    };
  };
  const read = (markdown: string, html: string, links: string[] = []) => (url: string): Promise<ReadPage> =>
    Promise.resolve({ finalUrl: url, status: 200, title: 'Shop', description: null, markdown, html, links });

  it('reads every page through the browser: its markdown is the text, its links are followed, bullets tidied', async () => {
    const reads: string[] = [];
    const pages: Array<{ url: string; text: string; title: string }> = [];
    const reader = read('# Shop\n\nWe sell bikes and helmets in Dhanmondi.\n\n* Road bikes\n* Helmets\n\n\n\nSee our about page.', rendered, ['https://shop.example/about']);
    const summary = await crawlSite(
      {
        startUrl: 'https://shop.example',
        maxPages: 10,
        delayMs: 0,
        fetchImpl: site({ '/': shell, '/about': about, '/robots.txt': '' }),
        read: async (url) => {
          reads.push(url);
          return reader(url);
        },
      },
      async (page) => {
        pages.push({ url: page.url, text: page.text, title: page.title });
      },
    );
    expect(reads).toEqual(['https://shop.example/', 'https://shop.example/about']);
    expect(summary.rendered).toBe(2);
    expect(pages.map((p) => p.url)).toEqual(['https://shop.example/', 'https://shop.example/about']);
    expect(pages[0]!.title).toBe('Shop');
    expect(pages[0]!.text).toBe('# Shop\n\nWe sell bikes and helmets in Dhanmondi.\n\n- Road bikes\n- Helmets\n\nSee our about page.');
  });

  it('falls back to the plain fetch and its own extraction when the reader fails or has nothing', async () => {
    const pages: Array<{ url: string; text: string }> = [];
    const summary = await crawlSite(
      {
        startUrl: 'https://shop.example',
        maxPages: 10,
        delayMs: 0,
        fetchImpl: site({ '/': rendered, '/about': about, '/robots.txt': '' }),
        // Down for the home page; an empty answer for the about page.
        read: async (url) => (url.endsWith('/about') ? { finalUrl: url, status: 200, title: null, description: null, markdown: '   ', html: about, links: [] } : null),
      },
      async (page) => {
        pages.push({ url: page.url, text: page.text });
      },
    );
    expect(pages.map((p) => p.url)).toEqual(['https://shop.example/', 'https://shop.example/about']);
    expect(pages[0]!.text).toContain('We sell bikes');
    expect(pages[1]!.text).toContain('Founded in 2012');
    expect(summary.rendered).toBe(0);
    expect(summary.skipped).toBe(0);

    // The browser rendered an empty document for a page the plain fetch read in full.
    const wiped: string[] = [];
    await crawlSite(
      {
        startUrl: 'https://shop.example',
        maxPages: 10,
        delayMs: 0,
        fetchImpl: site({ '/': about, '/robots.txt': '' }),
        read: async (url) => ({ finalUrl: url, status: 200, title: 'About', description: null, markdown: '\n', html: '<html><head><title>About</title></head><body><div></div></body></html>', links: [] }),
      },
      async (page) => {
        wiped.push(page.text);
      },
    );
    expect(wiped).toHaveLength(1);
    expect(wiped[0]).toContain('Founded in 2012');

    // A shell with no reader at all has nothing to say.
    const bare = await crawlSite(
      { startUrl: 'https://shop.example', maxPages: 10, delayMs: 0, fetchImpl: site({ '/': shell, '/robots.txt': '' }) },
      async (page) => {
        pages.push({ url: page.url, text: page.text });
      },
    );
    expect(bare.skipped).toBe(1);
    expect(pages).toHaveLength(2);
  });

  it('lets the browser through a bot challenge the plain fetch met, and gives up when it is challenged too', async () => {
    const pages: string[] = [];
    const summary = await crawlSite(
      {
        startUrl: 'https://shop.example',
        maxPages: 10,
        delayMs: 0,
        fetchImpl: site({ '/': challenge, '/about': { status: 403, body: 'forbidden' }, '/robots.txt': '' }),
        read: async (url) =>
          url.endsWith('/about')
            ? { finalUrl: url, status: 200, title: 'About', description: null, markdown: 'Founded in 2012 by three teachers who ride.', html: about, links: [] }
            : { finalUrl: url, status: 200, title: 'Shop', description: null, markdown: 'We sell bikes and helmets in Dhanmondi, and we fix them too.', html: rendered, links: ['https://shop.example/about'] },
      },
      async (page) => {
        pages.push(page.url);
      },
    );
    expect(pages).toEqual(['https://shop.example/', 'https://shop.example/about']);
    expect(summary.rendered).toBe(2);
    expect(summary.stoppedBecause).toBe('exhausted');

    const stuck = await crawlSite(
      {
        startUrl: 'https://shop.example',
        maxPages: 10,
        delayMs: 0,
        fetchImpl: site({ '/': challenge, '/robots.txt': '' }),
        read: async (url) => ({ finalUrl: url, status: 200, title: null, description: null, markdown: 'verifying that you are not a robot', html: challenge, links: [] }),
      },
      async () => undefined,
    );
    expect(stuck.stoppedBecause).toBe('bot_challenge');
  });
});

describe('tidyMarkdown', () => {
  it('normalises bullets, line endings and blank runs', () => {
    expect(tidyMarkdown('# A\r\n\r\n\r\n+ one  \n  * two\n\n\n\ntext\n')).toBe('# A\n\n- one\n- two\n\ntext');
    // crawl4ai puts a heading and its first paragraph on consecutive lines; the chunker wants them apart.
    expect(tidyMarkdown('# Fees\nMonthly tuition is 3,500 taka.\n## Discounts\nSiblings get ten percent.')).toBe('# Fees\n\nMonthly tuition is 3,500 taka.\n\n## Discounts\n\nSiblings get ten percent.');
  });
});
