import { Prisma, type Database } from '@smartchat/database';
import type { OutboundFetch } from '../integrations/outbound.js';
import { systemClock, type Clock } from '../time.js';
import { RIR_SOURCES, parseDelegatedExtended, registryOf, type RirRange } from './rir.js';

/**
 * IP address → country, from the registries' own data.
 *
 * Two halves. `lookup` is what the widget bootstrap calls: one indexed containment query against
 * the `ip_country_ranges` table, answered in a handful of page reads. `refresh` is what the worker
 * runs daily: fetch the five registry files, parse them, and replace the table's contents in one
 * transaction so a lookup never sees a half-loaded table.
 *
 * "Unknown" is a legitimate answer and is returned as `null`, not guessed. A private address, a
 * block the registries have not allocated, or a table nobody has loaded yet all come back null,
 * and the dashboard says nothing rather than something wrong.
 */

export interface GeoLookupResult {
  /** ISO 3166-1 alpha-2, uppercase. `EU` and `AP` are possible: regional, not national. */
  country: string;
  registry: string;
}

export interface GeoRefreshOutcome {
  rangeCount: number;
  sources: Record<
    string,
    { ok: true; records: number; fetchedAt: string } | { ok: false; error: string }
  >;
  /** True when every registry was fetched. A partial refresh is not applied - see below. */
  complete: boolean;
}

export interface GeoStatus {
  loaded: boolean;
  refreshedAt: Date | null;
  rangeCount: number;
  sources: GeoRefreshOutcome['sources'];
  lastError: string | null;
}

export interface GeoServiceOptions {
  db: Database;
  /** The DNS-pinned outbound client, with a response cap large enough for a registry file. */
  fetch?: OutboundFetch;
  clock?: Clock;
}

const DATASET_ID = 'rir';
/** Registry files run to ~15MB. Sized with headroom; past this the client drops the rest. */
export const RIR_FILE_MAX_BYTES = 64 * 1024 * 1024;
/**
 * Generous, because this is a nightly background job and the registries are not fast: RIPE's
 * 18MB file took two minutes from one cloud region. A tight timeout here does not make anything
 * quicker; it only turns a slow success into a failure.
 */
const RIR_FETCH_TIMEOUT_MS = 5 * 60_000;
/** Rows per INSERT. Large enough to be fast, small enough that one statement stays bounded. */
const INSERT_CHUNK = 5_000;

export class GeoService {
  private readonly clock: Clock;

  constructor(private readonly options: GeoServiceOptions) {
    this.clock = options.clock ?? systemClock;
  }

  /**
   * Which country an address belongs to, or null.
   *
   * The input is whatever the request layer handed us, so it is validated here before it can
   * reach a `::inet` cast: an unparseable value is "unknown", not an exception in the bootstrap
   * path that starts every visitor's session.
   */
  async lookup(ip: string | null | undefined): Promise<GeoLookupResult | null> {
    const address = normaliseIp(ip);
    if (!address) return null;

    try {
      const rows = await this.options.db.$queryRaw<{ country: string; registry: string }[]>`
        SELECT "country", "registry"
        FROM "ip_country_ranges"
        WHERE "network" >>= ${address}::inet
        ORDER BY masklen("network") DESC
        LIMIT 1
      `;
      const row = rows[0];
      return row ? { country: row.country, registry: row.registry } : null;
    } catch {
      // A lookup failure must never fail a visitor's session. The flag is a nicety; the chat
      // is the product.
      return null;
    }
  }

  async status(): Promise<GeoStatus> {
    const row = await this.options.db.geoDataset.findUnique({ where: { id: DATASET_ID } });
    return {
      loaded: (row?.rangeCount ?? 0) > 0,
      refreshedAt: row?.refreshedAt ?? null,
      rangeCount: row?.rangeCount ?? 0,
      sources: (row?.sources as GeoRefreshOutcome['sources'] | undefined) ?? {},
      lastError: row?.lastError ?? null,
    };
  }

  /**
   * Fetch all five registries and rebuild the table.
   *
   * All or nothing, deliberately. Applying four registries because the fifth timed out would
   * silently turn every address in, say, Latin America into "unknown" until the next run — and
   * a table that is a day stale is far better than one with a continent missing. On a partial
   * fetch the existing data stays and the status row records which registry failed and why.
   */
  async refresh(): Promise<GeoRefreshOutcome> {
    if (!this.options.fetch) {
      throw new Error('GeoService.refresh needs an outbound fetch client');
    }

    const sources: GeoRefreshOutcome['sources'] = {};
    const ranges: RirRange[] = [];

    for (const source of RIR_SOURCES) {
      const outcome = await this.fetchRegistry(source);
      sources[source.registry] = outcome.status;
      if (outcome.ranges) {
        // Not `push(...parsed.ranges)`: RIPE alone is ~300,000 records, and spreading that many
        // arguments into one call overflows the stack. It did, on the first real run.
        for (const range of outcome.ranges) ranges.push(range);
      }
    }

    const complete = RIR_SOURCES.every((source) => sources[source.registry]?.ok);

    if (!complete) {
      const failed = Object.entries(sources)
        .filter(([, outcome]) => !outcome.ok)
        .map(([registry, outcome]) => `${registry}: ${outcome.ok ? '' : outcome.error}`)
        .join('; ');
      await this.options.db.geoDataset.upsert({
        where: { id: DATASET_ID },
        create: { id: DATASET_ID, sources, lastError: failed },
        update: { sources, lastError: failed },
      });
      const current = await this.status();
      return { rangeCount: current.rangeCount, sources, complete: false };
    }

    const inserted = await this.replaceRanges(ranges);

    // Recorded from what the database says it wrote, not from what we meant to write. The
    // first version stored `ranges.length` and would have reported 700,000 rows over an empty
    // table if the insert had quietly done nothing.
    if (inserted !== ranges.length) {
      throw new Error(`geo refresh wrote ${inserted} of ${ranges.length} ranges`);
    }

    await this.options.db.geoDataset.upsert({
      where: { id: DATASET_ID },
      create: {
        id: DATASET_ID,
        refreshedAt: this.clock.now(),
        rangeCount: inserted,
        sources,
        lastError: null,
      },
      update: { refreshedAt: this.clock.now(), rangeCount: inserted, sources, lastError: null },
    });

    return { rangeCount: inserted, sources, complete: true };
  }

  /**
   * One registry, from wherever will serve it.
   *
   * The home host first, then each mirror. Every attempt's failure is kept, so a registry that
   * could not be fetched anywhere reports all of its reasons rather than only the last.
   */
  private async fetchRegistry(source: { registry: string; urls: readonly string[] }): Promise<{
    status: GeoRefreshOutcome['sources'][string];
    ranges: RirRange[] | null;
  }> {
    const failures: string[] = [];

    for (const url of source.urls) {
      const host = new URL(url).hostname;
      try {
        const response = await this.options.fetch!(url, {
          method: 'GET',
          headers: { accept: 'text/plain', 'user-agent': 'SmartChat-GeoRefresh' },
          body: '',
          timeoutMs: RIR_FETCH_TIMEOUT_MS,
        });
        if (response.status !== 200) {
          failures.push(`${host}: HTTP ${response.status}`);
          continue;
        }
        const text = await response.text();
        const declared = registryOf(text);
        if (declared !== source.registry) {
          // A mirror that served somebody else's file, or an error page with a 200.
          failures.push(`${host}: file is for "${declared ?? 'unknown'}", not ${source.registry}`);
          continue;
        }
        const parsed = parseDelegatedExtended(text);
        if (parsed.ranges.length === 0) {
          // A registry never publishes an empty file. An empty parse is a truncated download.
          failures.push(`${host}: no usable records`);
          continue;
        }
        return {
          status: {
            ok: true,
            records: parsed.ranges.length,
            fetchedAt: this.clock.now().toISOString(),
          },
          ranges: parsed.ranges,
        };
      } catch (error) {
        failures.push(`${host}: ${describe(error)}`);
      }
    }

    return { status: { ok: false, error: failures.join('; ') }, ranges: null };
  }

  /**
   * Swap the table's contents inside one transaction.
   *
   * Postgres MVCC does the work: readers keep seeing the old rows until COMMIT, then see the new
   * ones, and at no instant see an empty or half-filled table. Rows go in as arrays unnested
   * server-side - one statement per chunk rather than one per row, which is the difference
   * between seconds and an hour for ~700,000 blocks.
   */
  private async replaceRanges(ranges: RirRange[]): Promise<number> {
    return this.options.db.$transaction(
      async (tx) => {
        await tx.$executeRaw`DELETE FROM "ip_country_ranges"`;

        let inserted = 0;
        for (let offset = 0; offset < ranges.length; offset += INSERT_CHUNK) {
          const chunk = ranges.slice(offset, offset + INSERT_CHUNK);
          const networks = chunk.map((range) => range.network);
          const countries = chunk.map((range) => range.country);
          const registries = chunk.map((range) => range.registry);
          inserted += await tx.$executeRaw`
            INSERT INTO "ip_country_ranges" ("network", "country", "registry")
            SELECT n::cidr, c, r
            FROM unnest(${networks}::text[], ${countries}::text[], ${registries}::text[]) AS t(n, c, r)
          `;
        }
        return inserted;
      },
      // The whole rebuild, not the default five seconds.
      {
        timeout: 10 * 60_000,
        maxWait: 30_000,
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      },
    );
  }
}

/**
 * Node's connection failures come as an `AggregateError` with an empty message and the real
 * reason in `code` - which is how the first production run logged four registries failing with
 * `""`. Say the code.
 */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as { code?: unknown }).code;
  if (error.message) return typeof code === 'string' ? `${error.message} (${code})` : error.message;
  return typeof code === 'string' ? code : error.name || 'failed';
}

/**
 * Only something that is unambiguously an IP address reaches the database.
 *
 * Strips an IPv4-mapped IPv6 prefix (`::ffff:1.2.3.4`), which is how Node reports a v4 client on a
 * dual-stack listener, and refuses anything that is not plainly v4 or v6 - a hostname, a port
 * suffix, a comma-separated forwarding chain nobody split.
 */
export function normaliseIp(value: string | null | undefined): string | null {
  if (!value) return null;
  let ip = value.trim();
  if (ip.startsWith('::ffff:') && ip.includes('.')) ip = ip.slice('::ffff:'.length);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    return ip.split('.').every((octet) => Number(octet) <= 255) ? ip : null;
  }
  if (/^[0-9a-f:]+$/i.test(ip) && ip.includes(':') && ip.length <= 39) return ip;
  return null;
}
