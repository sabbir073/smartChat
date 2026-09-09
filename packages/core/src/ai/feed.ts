import { DOMParser } from 'linkedom';
import { htmlToText } from './extract.js';

/**
 * A product feed, read into products the index can hold.
 *
 * Two shapes, because they are the two every shop already has: the Google Merchant feed as RSS
 * 2.0 or Atom (the `g:` fields), and a CSV/TSV with a header row using the same field names.
 * Everything else about a product - variants, images, shipping tables - is left out; the
 * assistant needs the name, what it costs, whether it is in stock, and where to send someone.
 *
 * Each product becomes a document: a `#` title, the facts one per line, then the description
 * as text. That is the shape the chunker and the grounding check already understand, and it
 * puts the price and the availability - the two things a visitor asks - in the same passage as
 * the name.
 */

export interface FeedProduct {
  /** The feed's own id, for the document key when there is no link. */
  id: string;
  title: string;
  url: string | null;
  text: string;
}

export const MAX_FEED_PRODUCTS = 5_000;

export class FeedParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeedParseError';
  }
}

/** Parse a feed body, XML or CSV, by looking at it rather than at a declared type. */
export function parseFeed(body: string, contentType = ''): FeedProduct[] {
  const trimmed = body.replace(/^\uFEFF/, '').trimStart();
  if (trimmed.startsWith('<')) return parseXmlFeed(trimmed);
  if (contentType.includes('xml')) return parseXmlFeed(trimmed);
  return parseCsvFeed(trimmed);
}

// --- XML: RSS 2.0 or Atom with the Google namespace --------------------------------------

const FIELDS = {
  id: ['g:id', 'id', 'guid'],
  title: ['title', 'g:title'],
  link: ['link', 'g:link'],
  description: ['description', 'g:description', 'summary', 'content'],
  price: ['g:price', 'price'],
  salePrice: ['g:sale_price', 'sale_price'],
  availability: ['g:availability', 'availability'],
  brand: ['g:brand', 'brand'],
  category: ['g:product_type', 'product_type', 'g:google_product_category', 'google_product_category'],
  condition: ['g:condition', 'condition'],
  mpn: ['g:mpn', 'mpn'],
  gtin: ['g:gtin', 'gtin'],
} as const;

type Fields = Record<keyof typeof FIELDS, string>;

type XmlElement = {
  tagName: string;
  textContent: string | null;
  children: Iterable<XmlElement>;
  getAttribute(name: string): string | null;
  querySelectorAll(selector: string): Iterable<XmlElement>;
};

function parseXmlFeed(xml: string): FeedProduct[] {
  let root: XmlElement | null;
  try {
    const document = new DOMParser().parseFromString(xml, 'text/xml') as unknown as { documentElement: XmlElement | null };
    root = document.documentElement;
  } catch {
    throw new FeedParseError('The feed is not well-formed XML');
  }
  if (!root) throw new FeedParseError('The feed is empty');
  const rootName = root.tagName.toLowerCase();
  const itemName = rootName === 'feed' ? 'entry' : rootName === 'rss' || rootName === 'channel' ? 'item' : null;
  if (!itemName) throw new FeedParseError(`Not a product feed: the root element is <${rootName}>, expected <rss> or <feed>`);

  const products: FeedProduct[] = [];
  for (const item of root.querySelectorAll(itemName)) {
    if (products.length >= MAX_FEED_PRODUCTS) break;
    const fields = readFields(item);
    if (!fields.title) continue;
    const product = toProduct(fields, products.length);
    if (product) products.push(product);
  }
  return products;
}

function readFields(item: XmlElement): Fields {
  const byName = new Map<string, XmlElement[]>();
  for (const child of item.children) {
    const name = child.tagName.toLowerCase();
    const list = byName.get(name) ?? [];
    list.push(child);
    byName.set(name, list);
  }
  const read = (names: readonly string[]): string => {
    for (const name of names) {
      for (const element of byName.get(name) ?? []) {
        // Atom links live in href; RSS links are text.
        const value = name === 'link' && !element.textContent?.trim() ? element.getAttribute('href') : element.textContent;
        if (value && value.trim()) return value.trim();
      }
    }
    return '';
  };
  const out = {} as Fields;
  for (const key of Object.keys(FIELDS) as Array<keyof typeof FIELDS>) out[key] = read(FIELDS[key]);
  return out;
}

// --- CSV / TSV with a header row ---------------------------------------------------------------

function parseCsvFeed(text: string): FeedProduct[] {
  const delimiter = text.split('\n', 1)[0]!.includes('\t') ? '\t' : ',';
  const rows = parseDelimited(text, delimiter);
  const header = rows.shift();
  if (!header || header.length < 2) throw new FeedParseError('The feed is neither XML nor a CSV with a header row');
  const columns = header.map((h) => h.trim().toLowerCase().replace(/^g:/, ''));
  const index = (names: readonly string[]): number => {
    for (const name of names) {
      const i = columns.indexOf(name.replace(/^g:/, ''));
      if (i >= 0) return i;
    }
    return -1;
  };
  const at: Record<keyof typeof FIELDS, number> = {
    id: index(FIELDS.id),
    title: index(FIELDS.title),
    link: index(FIELDS.link),
    description: index(FIELDS.description),
    price: index(FIELDS.price),
    salePrice: index(FIELDS.salePrice),
    availability: index(FIELDS.availability),
    brand: index(FIELDS.brand),
    category: index(FIELDS.category),
    condition: index(FIELDS.condition),
    mpn: index(FIELDS.mpn),
    gtin: index(FIELDS.gtin),
  };
  if (at.title < 0) throw new FeedParseError('The CSV has no "title" column');

  const products: FeedProduct[] = [];
  for (const row of rows) {
    if (products.length >= MAX_FEED_PRODUCTS) break;
    if (row.every((cell) => cell.trim() === '')) continue;
    const fields = {} as Fields;
    for (const key of Object.keys(at) as Array<keyof typeof FIELDS>) {
      const i = at[key];
      fields[key] = i >= 0 ? (row[i] ?? '').trim() : '';
    }
    if (!fields.title) continue;
    const product = toProduct(fields, products.length);
    if (product) products.push(product);
  }
  return products;
}

/** RFC 4180-ish: quoted cells, doubled quotes, newlines inside quotes. */
function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

// --- one product ---------------------------------------------------------------------------------

function toProduct(fields: Fields, ordinal: number): FeedProduct | null {
  const title = clean(fields.title).slice(0, 200);
  if (!title) return null;
  const url = safeUrl(fields.link);
  const lines: string[] = [`# ${title}`, ''];
  const price = clean(fields.price);
  const sale = clean(fields.salePrice);
  if (price && sale && sale !== price) lines.push(`Price: ${sale} (was ${price})`);
  else if (sale || price) lines.push(`Price: ${sale || price}`);
  const availability = clean(fields.availability).replace(/_/g, ' ');
  if (availability) lines.push(`Availability: ${availability}`);
  if (fields.brand) lines.push(`Brand: ${clean(fields.brand)}`);
  if (fields.category) lines.push(`Category: ${clean(fields.category).replace(/\s*>\s*/g, ' › ')}`);
  if (fields.condition && fields.condition.toLowerCase() !== 'new') lines.push(`Condition: ${clean(fields.condition)}`);
  if (fields.mpn) lines.push(`Model number: ${clean(fields.mpn)}`);
  if (fields.gtin) lines.push(`GTIN: ${clean(fields.gtin)}`);
  const description = describe(fields.description).slice(0, 4_000);
  if (description) lines.push('', description);
  return {
    id: clean(fields.id) || `row-${ordinal + 1}`,
    title,
    url,
    text: lines.join('\n').trim(),
  };
}

function describe(raw: string): string {
  if (!raw) return '';
  return /<[a-z][\s\S]*>/i.test(raw) ? htmlToText(raw) : clean(raw);
}

function clean(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function safeUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}
