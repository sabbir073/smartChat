/**
 * The internet's own answer to "which country is this address in".
 *
 * Every IP address on the internet was handed out by one of five regional registries — ARIN,
 * RIPE NCC, APNIC, LACNIC, AFRINIC — and each of them publishes, daily and for free, the full
 * list of the blocks it has allocated and the country each block was allocated to. That is the
 * upstream every commercial geolocation database is built on. Reading it ourselves means no
 * licence, no API key, no per-lookup call to somebody else, and data as authoritative as exists.
 *
 * What it cannot do, and nothing can: see through a VPN, a corporate proxy, or a mobile carrier
 * that routes traffic through another country. An IP address says where a *network* is, and that
 * is the honest limit of the whole field.
 *
 * The format ("delegated-extended"), one record per line:
 *
 *   registry|cc|type|start|value|date|status|opaque-id
 *   apnic|JP|ipv4|1.0.16.0|4096|20110412|allocated|A91BDB29
 *   ripencc|DE|ipv6|2001:67c:2e8::|48|20090311|assigned|...
 *
 * For ipv4 `value` is a count of addresses from `start`; for ipv6 it is a prefix length. Lines
 * beginning with `#` are comments, the first line is a version header, and `summary` lines are
 * totals. Only `allocated` and `assigned` records describe addresses somebody is actually using.
 */

export interface RirRange {
  /** A CIDR block, e.g. `1.0.16.0/20` or `2001:67c:2e8::/48`. */
  network: string;
  /** ISO 3166-1 alpha-2, uppercase. */
  country: string;
  registry: string;
}

export interface RirParseResult {
  ranges: RirRange[];
  /** Records that were skipped and why, for the operator's status page. */
  skipped: { reserved: number; other: number; malformed: number };
}

const USABLE_STATUS = new Set(['allocated', 'assigned']);

/**
 * Registries mark address space reserved for future allocation with `ZZ`, and a handful of
 * records have no country at all. Neither is a place.
 *
 * ISO 3166-1 sets aside `AA`, `QM`–`QZ`, `XA`–`XZ` and `ZZ` as "user-assigned" — codes that will
 * never mean a country, which registries and vendors use for exactly this kind of placeholder.
 * `EU` and `AP` are kept: they are not countries either, but they are what RIPE and APNIC record
 * for blocks used across a region, and "somewhere in Europe" is an honest answer where "unknown"
 * is a worse one.
 */
function isRealCountry(cc: string): boolean {
  if (!/^[A-Z]{2}$/.test(cc)) return false;
  if (cc === 'AA' || cc === 'ZZ') return false;
  if (cc[0] === 'X') return false;
  if (cc[0] === 'Q' && cc[1]! >= 'M') return false;
  return true;
}

export function parseDelegatedExtended(text: string): RirParseResult {
  const ranges: RirRange[] = [];
  const skipped = { reserved: 0, other: 0, malformed: 0 };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const fields = line.split('|');
    // The version header and per-type summary lines have a different shape and are not records.
    if (fields.length < 7 || fields[2] === 'summary' || fields[5] === 'summary') continue;

    const [registry = '', cc = '', type = '', start = '', value = '', , status = ''] = fields;
    if (type !== 'ipv4' && type !== 'ipv6') continue;

    if (!USABLE_STATUS.has(status)) {
      skipped.other += 1;
      continue;
    }

    const country = cc.toUpperCase();
    if (!isRealCountry(country)) {
      skipped.reserved += 1;
      continue;
    }

    if (type === 'ipv4') {
      const count = Number(value);
      const startNumber = ipv4ToNumber(start);
      if (startNumber === null || !Number.isInteger(count) || count <= 0) {
        skipped.malformed += 1;
        continue;
      }
      for (const network of ipv4RangeToCidrs(startNumber, count)) {
        ranges.push({ network, country, registry });
      }
      continue;
    }

    const prefixLength = Number(value);
    if (
      !isPlausibleIpv6(start) ||
      !Number.isInteger(prefixLength) ||
      prefixLength < 1 ||
      prefixLength > 128
    ) {
      skipped.malformed += 1;
      continue;
    }
    ranges.push({ network: `${start}/${prefixLength}`, country, registry });
  }

  return { ranges, skipped };
}

export function ipv4ToNumber(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    result = result * 256 + octet;
  }
  return result;
}

export function numberToIpv4(value: number): string {
  return [
    Math.floor(value / 16_777_216) % 256,
    Math.floor(value / 65_536) % 256,
    Math.floor(value / 256) % 256,
    value % 256,
  ].join('.');
}

/**
 * An address count is not always a power of two.
 *
 * Registries hand out ranges like `1.2.3.0` × 3072, which is no single CIDR block. The standard
 * decomposition: at each step take the largest aligned block that fits, which is bounded by both
 * the alignment of the current start and the addresses remaining.
 */
export function ipv4RangeToCidrs(start: number, count: number): string[] {
  const blocks: string[] = [];
  let cursor = start;
  let remaining = count;

  while (remaining > 0) {
    // The largest power of two that divides the cursor (its alignment), capped at 2^32.
    let size = cursor === 0 ? 4_294_967_296 : cursor & -cursor;
    if (size < 0) size = 2_147_483_648; // JS bitwise ops are signed 32-bit; 2^31 comes out negative.
    while (size > remaining) size /= 2;
    const prefix = 32 - Math.log2(size);
    blocks.push(`${numberToIpv4(cursor)}/${prefix}`);
    cursor += size;
    remaining -= size;
  }

  return blocks;
}

/** Enough shape-checking that a bad line cannot reach the database as a `cidr` cast error. */
function isPlausibleIpv6(address: string): boolean {
  return /^[0-9a-f:]+$/i.test(address) && address.includes(':') && address.length <= 39;
}

/**
 * The five registries, and where to get each one's file.
 *
 * Each registry publishes its own file, and RIPE NCC and APNIC also mirror everybody else's. The
 * home registry is tried first and the mirrors after it, because a single host is a single point
 * of failure and, on the first production run, exactly that: from one cloud region APNIC and
 * AFRINIC timed out outright while RIPE took two minutes. The mirrors are the same data, and the
 * file's own header says which registry it belongs to, so a mirror cannot quietly serve the
 * wrong one. Over https, and only https.
 */
export const RIR_SOURCES: readonly { registry: string; urls: readonly string[] }[] = [
  {
    registry: 'arin',
    urls: [
      'https://ftp.arin.net/pub/stats/arin/delegated-arin-extended-latest',
      'https://ftp.ripe.net/pub/stats/arin/delegated-arin-extended-latest',
      'https://ftp.apnic.net/stats/arin/delegated-arin-extended-latest',
    ],
  },
  {
    registry: 'ripencc',
    urls: [
      'https://ftp.ripe.net/pub/stats/ripencc/delegated-ripencc-extended-latest',
      'https://ftp.apnic.net/stats/ripe-ncc/delegated-ripencc-extended-latest',
    ],
  },
  {
    registry: 'apnic',
    urls: [
      'https://ftp.apnic.net/stats/apnic/delegated-apnic-extended-latest',
      'https://ftp.ripe.net/pub/stats/apnic/delegated-apnic-extended-latest',
    ],
  },
  {
    registry: 'lacnic',
    urls: [
      'https://ftp.lacnic.net/pub/stats/lacnic/delegated-lacnic-extended-latest',
      'https://ftp.ripe.net/pub/stats/lacnic/delegated-lacnic-extended-latest',
      'https://ftp.apnic.net/stats/lacnic/delegated-lacnic-extended-latest',
    ],
  },
  {
    registry: 'afrinic',
    urls: [
      'https://ftp.afrinic.net/pub/stats/afrinic/delegated-afrinic-extended-latest',
      'https://ftp.ripe.net/pub/stats/afrinic/delegated-afrinic-extended-latest',
      'https://ftp.apnic.net/stats/afrinic/delegated-afrinic-extended-latest',
    ],
  },
];

/**
 * Which registry a file says it is. The version header is the first non-comment line:
 * `2|apnic|20260908|...`. A mirror serving the wrong file, or an error page, fails this.
 */
export function registryOf(text: string): string | null {
  for (const rawLine of text.split('\n', 50)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const fields = line.split('|');
    return fields.length >= 3 && /^\d+(\.\d+)?$/.test(fields[0] ?? '') ? (fields[1] ?? null) : null;
  }
  return null;
}
