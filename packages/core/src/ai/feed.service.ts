import type { Database } from '@smartchat/database';
import { systemClock, type Clock } from '../time.js';
import { fetchDocument } from './crawler.js';
import { FeedParseError, parseFeed, type FeedProduct } from './feed.js';
import type { KnowledgeService } from './knowledge.service.js';

/**
 * "Read my product feed": fetch it, index what changed, forget what is gone.
 *
 * Runs in the worker after the website crawl, in the same job, so "Sync website" and the weekly
 * job cover both. Products that did not change (same hash) cost nothing; products the feed no
 * longer lists are removed when the read completes. A feed that cannot be read removes nothing
 * and leaves the reason on the settings row for the owner.
 */

const MAX_FEED_BYTES = 20 * 1024 * 1024;
const FEED_TIMEOUT_MS = 60_000;

export interface FeedServiceOptions {
  db: Database;
  knowledge: KnowledgeService;
  clock?: Clock;
  /** Injected in tests. */
  fetch?: (url: string) => Promise<{ status: number; contentType: string; text: string }>;
  allowPrivateAddresses?: boolean;
  log?: (event: string, detail: Record<string, unknown>) => void;
}

export interface FeedOutcome {
  products: number;
  indexed: number;
  unchanged: number;
  removed: number;
  failed: number;
  error: string | null;
}

export class FeedService {
  private readonly clock: Clock;

  constructor(private readonly options: FeedServiceOptions) {
    this.clock = options.clock ?? systemClock;
  }

  async syncFeed(accountId: string, propertyId: string): Promise<FeedOutcome> {
    const { db, knowledge } = this.options;
    const settings = await db.aiSetting.findUnique({ where: { accountId_propertyId: { accountId, propertyId } } });
    const outcome: FeedOutcome = { products: 0, indexed: 0, unchanged: 0, removed: 0, failed: 0, error: null };
    if (!settings) return outcome;
    if (!settings.productFeedUrl) {
      outcome.removed = await knowledge.pruneProducts(accountId, propertyId, null);
      if (settings.lastFeedAt || settings.feedProducts > 0 || settings.feedError) {
        await db.aiSetting.update({ where: { id: settings.id }, data: { lastFeedAt: null, feedProducts: 0, feedError: null } });
      }
      return outcome;
    }

    const startedAt = this.clock.now();
    let products: FeedProduct[] = [];
    try {
      const fetched = await (this.options.fetch ?? this.fetchFeed.bind(this))(settings.productFeedUrl);
      if (fetched.status !== 200) throw new Error(`the feed answered HTTP ${fetched.status}`);
      products = parseFeed(fetched.text, fetched.contentType);
      if (products.length === 0) throw new FeedParseError('the feed has no products with a title');
    } catch (error) {
      outcome.error = explain(error, settings.productFeedUrl);
      await db.aiSetting.update({ where: { id: settings.id }, data: { lastFeedAt: this.clock.now(), feedError: outcome.error } });
      this.options.log?.('ai.feed.failed', { propertyId, error: outcome.error });
      return outcome;
    }

    outcome.products = products.length;
    for (const product of products) {
      const result = await knowledge.syncProduct(accountId, propertyId, product, startedAt);
      if (!result.changed) {
        outcome.unchanged += 1;
        continue;
      }
      try {
        await knowledge.indexDocument(accountId, result.documentId);
        outcome.indexed += 1;
      } catch (error) {
        outcome.failed += 1;
        this.options.log?.('ai.feed.index_failed', { propertyId, product: product.id, error: String(error) });
      }
    }
    outcome.removed = await knowledge.pruneProducts(accountId, propertyId, startedAt);
    await db.aiSetting.update({
      where: { id: settings.id },
      data: { lastFeedAt: this.clock.now(), feedProducts: products.length, feedError: null },
    });
    this.options.log?.('ai.feed.done', { propertyId, ...outcome });
    return outcome;
  }

  private async fetchFeed(url: string): Promise<{ status: number; contentType: string; text: string }> {
    return fetchDocument(url, {
      maxBytes: MAX_FEED_BYTES,
      timeoutMs: FEED_TIMEOUT_MS,
      accept: 'application/xml,text/xml,application/rss+xml,application/atom+xml,text/csv,text/plain;q=0.9,*/*;q=0.5',
      ...(this.options.allowPrivateAddresses ? { allowPrivateAddresses: true } : {}),
    });
  }
}

function explain(error: unknown, url: string): string {
  const reason = error instanceof Error ? error.message : String(error);
  let host = url;
  try {
    host = new URL(url).hostname;
  } catch {
    // The URL itself is the best name there is.
  }
  if (error instanceof FeedParseError) return `The product feed at ${host} could not be understood: ${reason}. It should be a Google Merchant feed (RSS or Atom XML) or a CSV with a title column.`;
  return `The product feed at ${host} could not be read (${reason}).`;
}
