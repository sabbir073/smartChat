import { describe, expect, it } from 'vitest';
import { FeedParseError, parseFeed } from './feed.js';

const RSS = `<?xml version="1.0"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
<channel><title>Acme Bikes</title>
<item>
  <g:id>SKU-1</g:id><title>Trek Marlin 5</title><link>https://acme.test/p/marlin-5?utm=x</link>
  <description><![CDATA[<p>A <b>hardtail</b> mountain bike.</p><ul><li>29" wheels</li></ul>]]></description>
  <g:price>85000 BDT</g:price><g:sale_price>79000 BDT</g:sale_price><g:availability>in_stock</g:availability>
  <g:brand>Trek</g:brand><g:product_type>Bikes &gt; Mountain</g:product_type><g:condition>new</g:condition>
</item>
<item><g:id>SKU-2</g:id><title>Helmet</title><g:price>2500 BDT</g:price><g:availability>out_of_stock</g:availability></item>
<item><g:id>SKU-3</g:id><g:price>1 BDT</g:price></item>
</channel></rss>`;

describe('parseFeed', () => {
  it('reads a Google Merchant RSS feed into headed product texts', () => {
    const products = parseFeed(RSS);
    expect(products).toHaveLength(2);
    const bike = products[0]!;
    expect(bike).toMatchObject({ id: 'SKU-1', title: 'Trek Marlin 5', url: 'https://acme.test/p/marlin-5?utm=x' });
    expect(bike.text).toContain('# Trek Marlin 5');
    expect(bike.text).toContain('Price: 79000 BDT (was 85000 BDT)');
    expect(bike.text).toContain('Availability: in stock');
    expect(bike.text).toContain('Brand: Trek');
    expect(bike.text).toContain('Category: Bikes › Mountain');
    expect(bike.text).not.toContain('Condition');
    expect(bike.text).toContain('A hardtail mountain bike.');
    expect(bike.text).toContain('- 29" wheels');
    expect(products[1]).toMatchObject({ id: 'SKU-2', url: null });
    expect(products[1]!.text).toContain('Availability: out of stock');
  });

  it('reads an Atom feed with links in href', () => {
    const atom = `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:g="http://base.google.com/ns/1.0">
      <entry><g:id>a1</g:id><title>Pump</title><link href="https://acme.test/pump" rel="alternate"/><g:price>900 BDT</g:price><summary>Floor pump.</summary></entry>
    </feed>`;
    const [pump] = parseFeed(atom);
    expect(pump).toMatchObject({ id: 'a1', title: 'Pump', url: 'https://acme.test/pump' });
    expect(pump!.text).toContain('Floor pump.');
  });

  it('reads a CSV with a header row, quotes and all', () => {
    const csv = 'id,title,description,link,price,availability\nc1,"Lock, heavy","A ""solid"" lock\nfor bikes",https://acme.test/lock,1200 BDT,in stock\n\nc2,Bell,,,150 BDT,preorder\n';
    const products = parseFeed(csv, 'text/csv');
    expect(products).toHaveLength(2);
    expect(products[0]).toMatchObject({ id: 'c1', title: 'Lock, heavy', url: 'https://acme.test/lock' });
    expect(products[0]!.text).toContain('A "solid" lock for bikes');
    expect(products[1]!.text).toContain('Availability: preorder');
  });

  it('reads a tab-separated file too', () => {
    const tsv = 'id\ttitle\tprice\nt1\tTube\t300 BDT\n';
    expect(parseFeed(tsv)[0]).toMatchObject({ id: 't1', title: 'Tube' });
  });

  it('refuses what it cannot read, with a reason', () => {
    expect(() => parseFeed('<html><body>Not a feed</body></html>')).toThrow(FeedParseError);
    expect(() => parseFeed('just one column\nvalue')).toThrow(/CSV/);
    expect(() => parseFeed('a,b\n1,2')).toThrow(/title/);
  });

  it('ignores links that are not http(s) and ids it has to invent', () => {
    const csv = 'title,link\nThing,javascript:alert(1)\nOther,https://acme.test/o';
    const products = parseFeed(csv);
    expect(products[0]).toMatchObject({ id: 'row-1', url: null });
    expect(products[1]).toMatchObject({ id: 'row-2', url: 'https://acme.test/o' });
  });
});
