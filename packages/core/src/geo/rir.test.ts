import { describe, expect, it } from 'vitest';
import { ipv4RangeToCidrs, ipv4ToNumber, numberToIpv4, parseDelegatedExtended } from './rir.js';

const SAMPLE = `2|apnic|20260907|3|19830613|20260906|+1000
apnic|*|ipv4|*|8|summary
apnic|*|ipv6|*|2|summary
apnic|JP|ipv4|1.0.16.0|4096|20110412|allocated|A91BDB29
apnic|CN|ipv4|1.0.32.0|3072|20110414|allocated|A91BDB29
apnic|AU|ipv4|1.0.0.0|256|20110811|assigned|A91BDB29
apnic|ZZ|ipv4|1.2.3.0|256|20110811|reserved|
apnic||ipv4|1.2.4.0|256|20110811|available|
apnic|JP|ipv6|2001:200::|35|19990813|allocated|A91BDB29
apnic|KR|ipv6|2001:220::|32|19990902|assigned|A91BDB29
apnic|XX|ipv4|9.9.9.0|256|20110811|allocated|
apnic|US|asn|1234|1|20110811|allocated|
# a comment line
apnic|IN|ipv4|not-an-ip|256|20110811|allocated|
`;

describe('parseDelegatedExtended', () => {
  const result = parseDelegatedExtended(SAMPLE);

  it('keeps allocated and assigned records, and nothing else', () => {
    const countries = result.ranges.map((r) => r.country);
    expect(countries).toEqual(expect.arrayContaining(['JP', 'CN', 'AU', 'KR']));
    expect(countries).not.toContain('ZZ');
    expect(countries).not.toContain('XX');
    expect(countries).not.toContain('US'); // the asn line
  });

  it('turns an ipv4 start+count into aligned CIDR blocks', () => {
    const jp = result.ranges.filter((r) => r.country === 'JP' && !r.network.includes(':'));
    expect(jp).toEqual([{ network: '1.0.16.0/20', country: 'JP', registry: 'apnic' }]);
  });

  /** 3072 addresses is /21 + /22, not any single block. This is the case a naive parser gets wrong. */
  it('splits a count that is not a power of two', () => {
    const cn = result.ranges.filter((r) => r.country === 'CN').map((r) => r.network);
    expect(cn).toEqual(['1.0.32.0/21', '1.0.40.0/22']);
  });

  it('carries ipv6 prefixes through as they are', () => {
    const v6 = result.ranges.filter((r) => r.network.includes(':')).map((r) => r.network);
    expect(v6).toEqual(['2001:200::/35', '2001:220::/32']);
  });

  it('counts what it skipped so the operator can see it', () => {
    // ZZ (reserved status) is caught by status first; XX is a user-assigned code, never a country.
    expect(result.skipped.reserved).toBe(1);
    expect(result.skipped.other).toBeGreaterThanOrEqual(2); // reserved + available statuses
    expect(result.skipped.malformed).toBe(1);
  });

  it('ignores the header, summaries and comments without counting them', () => {
    expect(
      parseDelegatedExtended(
        '2|arin|20260907|0|19830613|20260906|+0000\narin|*|ipv4|*|0|summary\n# hi\n',
      ),
    ).toEqual({
      ranges: [],
      skipped: { reserved: 0, other: 0, malformed: 0 },
    });
  });
});

describe('ipv4 arithmetic', () => {
  it('round-trips', () => {
    for (const ip of ['0.0.0.0', '1.0.16.0', '10.0.0.1', '192.168.1.254', '255.255.255.255']) {
      expect(numberToIpv4(ipv4ToNumber(ip)!)).toBe(ip);
    }
  });

  it('refuses a malformed address', () => {
    for (const bad of ['1.2.3', '1.2.3.4.5', '256.1.1.1', '1.2.3.x', '']) {
      expect(ipv4ToNumber(bad)).toBeNull();
    }
  });

  it.each([
    [ipv4ToNumber('10.0.0.0')!, 256, ['10.0.0.0/24']],
    [ipv4ToNumber('10.0.0.0')!, 65536, ['10.0.0.0/16']],
    [ipv4ToNumber('10.0.0.0')!, 768, ['10.0.0.0/23', '10.0.2.0/24']],
    [ipv4ToNumber('10.0.0.128')!, 384, ['10.0.0.128/25', '10.0.1.0/24']],
    [ipv4ToNumber('10.0.0.1')!, 1, ['10.0.0.1/32']],
  ])('decomposes %s × %s', (start, count, expected) => {
    expect(ipv4RangeToCidrs(start, count)).toEqual(expected);
  });

  /** The whole space, from zero: the alignment trick has to cope with a start of 0. */
  it('handles a range starting at 0.0.0.0 without an infinite loop', () => {
    expect(ipv4RangeToCidrs(0, 256)).toEqual(['0.0.0.0/24']);
  });

  /** 128.0.0.0 has its only set bit at 2^31, which is negative in JS's signed bitwise world. */
  it('handles the sign bit', () => {
    expect(ipv4RangeToCidrs(ipv4ToNumber('128.0.0.0')!, 16_777_216)).toEqual(['128.0.0.0/8']);
  });
});
