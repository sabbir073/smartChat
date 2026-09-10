import type { Database } from '@smartchat/database';
import { systemClock, type Clock } from '../time.js';
import { crawlSite, type CrawlSummary } from './crawler.js';
import type { FeedOutcome, FeedService } from './feed.service.js';
import type { KnowledgeService } from './knowledge.service.js';
import type { ReadPage } from './reader.js';

/**
 * "Sync my website": crawl it, index what changed, forget what is gone.
 *
 * Runs in the worker as one job per property. The crawl reads up to `crawlMaxPages` pages a
 * second apart, so a 200-page site takes a few minutes; each page that changed is embedded as it
 * arrives rather than queued, so the settings page can watch the count climb. When the crawl
 * finishes normally, pages it did not see are removed from the index - the site dropped them, or
 * they moved. When it finishes badly (nothing readable, a bot challenge) nothing is removed and
 * the reason is written where the owner will read it.
 */

export const CRAWL_MAX_PAGES_CEILING = 1_000;

export interface CrawlServiceOptions {
  db: Database;
  knowledge: KnowledgeService;
  /** The product feed is read after the site, in the same job. Optional for tests. */
  feed?: FeedService;
  clock?: Clock;
  /** Milliseconds between requests to the site. Tests set 0. */
  delayMs?: number;
  /** Injected in tests. */
  crawl?: typeof crawlSite;
  /** Development only - see CrawlOptions.allowPrivateAddresses. */
  allowPrivateAddresses?: boolean;
  /** The page reader (crawl4ai); see CrawlOptions.read. */
  read?: (url: string) => Promise<ReadPage | null>;
  log?: (event: string, detail: Record<string, unknown>) => void;
}

export interface CrawlOutcome {
  found: number;
  fetched: number;
  indexed: number;
  unchanged: number;
  removed: number;
  failed: number;
  error: string | null;
  feed?: FeedOutcome;
}

export class CrawlService {
  private readonly clock: Clock;

  constructor(private readonly options: CrawlServiceOptions) {
    this.clock = options.clock ?? systemClock;
  }

  async crawlProperty(accountId: string, propertyId: string): Promise<CrawlOutcome> {
    const { db, knowledge } = this.options;
    const property = await db.property.findFirst({
      where: { accountId, id: propertyId, deletedAt: null },
      select: { websiteUrl: true, name: true },
    });
    if (!property) return { found: 0, fetched: 0, indexed: 0, unchanged: 0, removed: 0, failed: 0, error: 'website not found' };

    const settings = await db.aiSetting.upsert({
      where: { accountId_propertyId: { accountId, propertyId } },
      create: { accountId, propertyId },
      update: {},
    });
    const startedAt = this.clock.now();
    await db.aiSetting.update({
      where: { id: settings.id },
      data: { crawlStartedAt: startedAt, crawlError: null },
    });

    const outcome: CrawlOutcome = { found: 0, fetched: 0, indexed: 0, unchanged: 0, removed: 0, failed: 0, error: null };
    let summary: CrawlSummary | null = null;
    try {
      summary = await (this.options.crawl ?? crawlSite)(
        {
          startUrl: property.websiteUrl,
          maxPages: Math.min(Math.max(settings.crawlMaxPages, 1), CRAWL_MAX_PAGES_CEILING),
          exclude: settings.crawlExclude,
          ...(this.options.read ? { read: this.options.read } : {}),
          ...(this.options.delayMs !== undefined ? { delayMs: this.options.delayMs } : {}),
          ...(this.options.allowPrivateAddresses ? { allowPrivateAddresses: true } : {}),
        },
        async (page) => {
          const seenAt = this.clock.now();
          const result = await knowledge.syncPage(accountId, propertyId, page, seenAt);
          if (!result.changed) {
            outcome.unchanged += 1;
            return;
          }
          try {
            await knowledge.indexDocument(accountId, result.documentId);
            outcome.indexed += 1;
          } catch (error) {
            // Recorded on the document by indexDocument; the crawl carries on.
            outcome.failed += 1;
            this.options.log?.('ai.crawl.index_failed', { propertyId, url: page.url, error: String(error) });
          }
          await db.aiSetting.update({
            where: { id: settings.id },
            data: { crawlPagesIndexed: outcome.indexed + outcome.unchanged },
          });
        },
      );
    } catch (error) {
      outcome.error = error instanceof Error ? error.message : String(error);
    }

    if (summary) {
      outcome.found = summary.found;
      outcome.fetched = summary.fetched;
      outcome.failed += summary.failed;
      outcome.error = explain(summary, property.websiteUrl);
      if (!outcome.error) {
        outcome.removed = await knowledge.prunePages(accountId, propertyId, startedAt);
      }
    }

    await db.aiSetting.update({
      where: { id: settings.id },
      data: {
        crawlStartedAt: null,
        lastCrawledAt: this.clock.now(),
        crawlPagesFound: outcome.found,
        crawlPagesIndexed: outcome.indexed + outcome.unchanged,
        crawlError: outcome.error,
      },
    });
    // The first few page failures by name: "failed: 4" on its own has cost an afternoon.
    this.options.log?.('ai.crawl.done', { propertyId, ...outcome, errors: summary?.errors.slice(0, 5) ?? [] });
    if (this.options.feed) {
      outcome.feed = await this.options.feed.syncFeed(accountId, propertyId);
    }
    return outcome;
  }

  /** Properties whose AI is on and whose site has not been read for a week (or ever). */
  async dueForRecrawl(olderThanMs: number): Promise<Array<{ accountId: string; propertyId: string }>> {
    const before = new Date(this.clock.timestamp() - olderThanMs);
    const rows = await this.options.db.aiSetting.findMany({
      where: {
        mode: { not: 'team' },
        crawlStartedAt: null,
        OR: [{ lastCrawledAt: null }, { lastCrawledAt: { lt: before } }],
        property: { deletedAt: null },
      },
      select: { accountId: true, propertyId: true },
      take: 500,
    });
    return rows;
  }
}

/** A sentence the owner can act on, or null when the crawl was fine. */
function explain(summary: CrawlSummary, websiteUrl: string): string | null {
  const host = safeHost(websiteUrl);
  switch (summary.stoppedBecause) {
    case 'bot_challenge':
      return `${host} answers automated visitors with a bot-verification page, so its pages could not be read. Ask your hosting provider to allow the "GetChatBot" user agent (LiteSpeed and Cloudflare both have a bot allow-list), or paste the important content into Key facts.`;
    case 'start_unreachable': {
      const reason = summary.errors[0]?.reason;
      return `${host} could not be read${reason ? ` (${reason})` : ''}. Check that the website address on this property is right and that the site is up.`;
    }
    case 'stopped':
      return 'The sync was stopped before it finished.';
    default:
      if (summary.fetched === 0) return `${host} was reached but no readable pages were found.`;
      return null;
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
