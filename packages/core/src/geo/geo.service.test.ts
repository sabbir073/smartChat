import { describe, expect, it, vi } from 'vitest';
import { GeoService, normaliseIp } from './geo.service.js';
import { registryOf } from './rir.js';

describe('normaliseIp', () => {
  it.each([
    ['8.8.8.8', '8.8.8.8'],
    [' 1.2.3.4 ', '1.2.3.4'],
    ['::ffff:8.8.4.4', '8.8.4.4'],
    ['2001:4860:4860::8888', '2001:4860:4860::8888'],
    ['::1', '::1'],
  ])('accepts %s as %s', (input, expected) => {
    expect(normaliseIp(input)).toBe(expected);
  });

  /**
   * Anything that is not plainly an address stays out of the `::inet` cast. A hostname, a port
   * suffix, or a forwarding chain nobody split would otherwise turn a session start into a
   * database error.
   */
  it.each([
    '',
    '   ',
    'garbage',
    '1.2.3',
    '256.1.1.1',
    '1.2.3.4:8080',
    '1.2.3.4, 5.6.7.8',
    'example.com',
    null,
    undefined,
  ])('refuses %s', (input) => {
    expect(normaliseIp(input)).toBeNull();
  });
});

function serviceWith(db: Record<string, unknown>, fetch?: ReturnType<typeof vi.fn>): GeoService {
  return new GeoService({
    db: db as never,
    ...(fetch ? { fetch: fetch as never } : {}),
    clock: { now: () => new Date('2026-09-08T00:00:00Z'), timestamp: () => 0 },
  });
}

describe('GeoService.lookup', () => {
  it('returns the registry answer', async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ country: 'BD', registry: 'apnic' }]);
    const geo = serviceWith({ $queryRaw: queryRaw });
    expect(await geo.lookup('123.200.2.234')).toEqual({ country: 'BD', registry: 'apnic' });
  });

  it('returns null for an address the registries have not allocated', async () => {
    const geo = serviceWith({ $queryRaw: vi.fn().mockResolvedValue([]) });
    expect(await geo.lookup('192.168.1.1')).toBeNull();
  });

  it('never queries for something that is not an address', async () => {
    const queryRaw = vi.fn();
    const geo = serviceWith({ $queryRaw: queryRaw });
    expect(await geo.lookup('not an ip')).toBeNull();
    expect(queryRaw).not.toHaveBeenCalled();
  });

  /** A flag is a nicety; the chat is the product. A lookup failure must not fail a session. */
  it('swallows a database failure as unknown', async () => {
    const geo = serviceWith({ $queryRaw: vi.fn().mockRejectedValue(new Error('down')) });
    expect(await geo.lookup('8.8.8.8')).toBeNull();
  });
});

const FILE = (cc: string, registry: string) =>
  `2|${registry}|20260908|1|19830613|20260907|+0000\n${registry}|${cc}|ipv4|10.0.0.0|256|20110412|allocated|X\n`;

/** Which registry a URL is for, from its path - the same way the sources table is laid out. */
function registryIn(url: string): string {
  const match = /delegated-([a-z]+)-extended/.exec(url);
  return match?.[1] ?? 'unknown';
}

function dbForRefresh() {
  const upsert = vi.fn().mockResolvedValue(undefined);
  const executeRaw = vi.fn().mockResolvedValue(1);
  const tx = { $executeRaw: executeRaw };
  const transaction = vi.fn(async (run: (t: unknown) => Promise<number>) => run(tx));
  return {
    db: {
      geoDataset: { upsert, findUnique: vi.fn().mockResolvedValue({ rangeCount: 0 }) },
      $transaction: transaction,
    },
    upsert,
    executeRaw,
    transaction,
  };
}

describe('GeoService.refresh', () => {
  it('rebuilds the table when every registry answers', async () => {
    const fetch = vi.fn(async (url: string) => ({
      status: 200,
      text: async () => FILE('US', registryIn(url)),
    }));
    const { db, upsert, executeRaw, transaction } = dbForRefresh();
    // The DELETE reports 0, the one INSERT reports the five records it wrote.
    executeRaw.mockResolvedValueOnce(0).mockResolvedValueOnce(5);

    const outcome = await serviceWith(db, fetch).refresh();

    expect(outcome.complete).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(transaction).toHaveBeenCalledTimes(1);
    // One DELETE, then one INSERT per chunk (five records fit in one chunk).
    expect(executeRaw).toHaveBeenCalledTimes(2);
    expect(upsert.mock.calls[0]?.[0]?.update).toMatchObject({ rangeCount: 5, lastError: null });
  });

  /**
   * The rule that matters. Four registries and a timeout on the fifth must not replace a full
   * table with one that is missing a continent.
   */
  it('keeps the previous data when any registry fails, and says which', async () => {
    const fetch = vi.fn(async (url: string) =>
      url.includes('lacnic')
        ? { status: 503, text: async () => '' }
        : { status: 200, text: async () => FILE('US', registryIn(url)) },
    );
    const { db, upsert, transaction } = dbForRefresh();

    const outcome = await serviceWith(db, fetch).refresh();

    expect(outcome.complete).toBe(false);
    expect(transaction).not.toHaveBeenCalled();
    // Every mirror was tried and every one is named in the reason.
    expect(outcome.sources['lacnic']).toMatchObject({ ok: false });
    const reason = (outcome.sources['lacnic'] as { error: string }).error;
    expect(reason).toContain('ftp.lacnic.net: HTTP 503');
    expect(reason).toContain('ftp.ripe.net: HTTP 503');
    expect(upsert.mock.calls[0]?.[0]?.update?.lastError).toContain('lacnic');
  });

  it('treats a file with no usable records as a failure, not as an empty registry', async () => {
    const fetch = vi.fn(async (url: string) => ({
      status: 200,
      text: async () =>
        url.includes('afrinic') ? '<html>redirect page</html>' : FILE('US', 'arin'),
    }));
    const { db, transaction } = dbForRefresh();

    const outcome = await serviceWith(db, fetch).refresh();
    expect(outcome.complete).toBe(false);
    expect(transaction).not.toHaveBeenCalled();
    expect(outcome.sources['afrinic']).toMatchObject({ ok: false });
  });

  it('refuses to record a count the database did not confirm', async () => {
    const fetch = vi.fn(async (url: string) => ({
      status: 200,
      text: async () => FILE('US', registryIn(url)),
    }));
    const { db, executeRaw, upsert } = dbForRefresh();
    executeRaw.mockResolvedValue(0); // the insert "succeeds" and writes nothing

    await expect(serviceWith(db, fetch).refresh()).rejects.toThrow(/wrote 0 of 5/);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('needs a fetch client', async () => {
    await expect(serviceWith(dbForRefresh().db).refresh()).rejects.toThrow(/outbound fetch/);
  });
});

describe('GeoService.refresh - mirrors', () => {
  /**
   * The first production run: APNIC and AFRINIC timed out from the server's region. RIPE mirrors
   * both, so a registry whose own host is unreachable is fetched from a mirror instead of taking
   * the whole rebuild down.
   */
  it('falls back to a mirror when the home registry is unreachable', async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.startsWith('https://ftp.apnic.net/')) {
        const error = new Error('') as Error & { code: string };
        error.code = 'ETIMEDOUT';
        throw error;
      }
      return { status: 200, text: async () => FILE('AU', registryIn(url)) };
    });
    const { db, executeRaw } = dbForRefresh();
    executeRaw.mockResolvedValueOnce(0).mockResolvedValueOnce(5);

    const outcome = await serviceWith(db, fetch).refresh();

    expect(outcome.complete).toBe(true);
    expect(outcome.sources['apnic']).toMatchObject({ ok: true, records: 1 });
    expect(
      fetch.mock.calls.some(
        ([url]) => url === 'https://ftp.ripe.net/pub/stats/apnic/delegated-apnic-extended-latest',
      ),
    ).toBe(true);
  });

  /** A mirror serving the wrong file - or an error page with a 200 - must not be accepted. */
  it('refuses a mirror that serves a different registry’s file', async () => {
    const fetch = vi.fn(async (url: string) => ({
      status: 200,
      // Every host answers with ARIN's file, whatever was asked for.
      text: async () => FILE('US', url.includes('arin') ? 'arin' : 'arin'),
    }));
    const { db, transaction } = dbForRefresh();

    const outcome = await serviceWith(db, fetch).refresh();

    expect(outcome.complete).toBe(false);
    expect(transaction).not.toHaveBeenCalled();
    expect((outcome.sources['apnic'] as { error: string }).error).toContain('file is for "arin"');
  });

  it('names the failure code when Node gives an empty message', async () => {
    const fetch = vi.fn(async () => {
      const error = new AggregateError([], '') as AggregateError & { code: string };
      error.code = 'ETIMEDOUT';
      throw error;
    });
    const { db } = dbForRefresh();
    const outcome = await serviceWith(db, fetch).refresh();
    expect((outcome.sources['arin'] as { error: string }).error).toContain('ETIMEDOUT');
  });
});

describe('registryOf', () => {
  it('reads the registry from the version header, skipping comments', () => {
    expect(registryOf('# comment\n2|apnic|20260908|1|x|y|+1000\napnic|AU|...')).toBe('apnic');
    expect(registryOf('2.3|ripencc|20260908|1|x|y|+0100')).toBe('ripencc');
  });

  it('has no answer for an HTML page or an empty body', () => {
    expect(registryOf('<html>oops</html>')).toBeNull();
    expect(registryOf('')).toBeNull();
  });
});
