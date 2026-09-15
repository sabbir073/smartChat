import { isIP } from 'node:net';
import type { Database } from '@smartchat/database';
import { ActorType as DbActorType } from '@smartchat/database';
import { AppError, ErrorCode, Permission, type TenantContext } from '@smartchat/types';
import { AiJob } from '../queue/jobs.js';
import type { QueueProducer } from '../queue/producer.js';
import { AuditRepository } from '../repositories/audit.repository.js';
import { requirePermission } from '../tenancy/context.js';
import { assertPropertyInAccount } from '../tenancy/property-access.js';
import { systemClock, type Clock } from '../time.js';
import { isPrivateAddress, normaliseUrl, readOnePage } from './crawler.js';
import type { KnowledgeService } from './knowledge.service.js';
import type { ReadPage } from './reader.js';

/**
 * The knowledge an owner curates by hand: individual pages they paste, and the button that makes
 * the assistant forget a whole source again.
 *
 * The website crawl answers "learn my site". This answers the two questions it leaves open -
 * "also learn *this* page" (a supplier's spec sheet, a partner's terms, one page on a second site
 * of their own) and "forget what you learned from X", which is the only honest way to correct an
 * assistant that has read something wrong or out of date.
 *
 * Pages added here are documents of kind `link`, deliberately not `page`: the crawl deletes every
 * `page` it no longer finds on the site, and a page on somebody else's domain would be deleted by
 * the first sync after it was added.
 */

export interface KnowledgeSourceServiceOptions {
  db: Database;
  knowledge: KnowledgeService;
  queue: QueueProducer;
  clock?: Clock;
  /** The browser-backed reader, when the worker has one. See CrawlServiceOptions.read. */
  read?: (url: string) => Promise<ReadPage | null>;
  /** Development only: allow private addresses, so a local test site can be added. */
  allowPrivateAddresses?: boolean;
  /** Injected in tests; production uses the crawler's own single-page reader. */
  readPage?: typeof readOnePage;
  log?: (event: string, detail: Record<string, unknown>) => void;
}

/** One pasted page as the settings screen shows it. */
export interface KnowledgeLinkView {
  id: string;
  url: string;
  title: string;
  /** `reading` while the worker has not finished; `failed` carries a sentence in `error`. */
  status: 'reading' | 'ready' | 'failed';
  error: string | null;
  chunks: number;
  addedAt: string;
  indexedAt: string | null;
}

/** What "forget this" can be pointed at. Files are removed one at a time, with their storage. */
export type ForgettableSource = 'website' | 'links' | 'feed' | 'keyFacts';

/** One property can hold this many pasted pages. A knowledge base, not a second crawler. */
export const MAX_LINKS_PER_PROPERTY = 100;
/** And this many in one go, which is also what the settings page's box is sized for. */
export const MAX_LINKS_PER_REQUEST = 25;

export class KnowledgeSourceService {
  private readonly clock: Clock;
  private readonly audit: AuditRepository;

  constructor(private readonly options: KnowledgeSourceServiceOptions) {
    this.clock = options.clock ?? systemClock;
    this.audit = new AuditRepository(options.db);
  }

  async listLinks(context: TenantContext, propertyId: string): Promise<KnowledgeLinkView[]> {
    requirePermission(context, Permission.PROPERTY_VIEW);
    await assertPropertyInAccount(this.options.db, context, propertyId);
    const documents = await this.options.db.knowledgeDocument.findMany({
      where: { accountId: context.accountId, propertyId, kind: 'link' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, url: true, title: true, error: true, chunkCount: true, createdAt: true, indexedAt: true },
      take: MAX_LINKS_PER_PROPERTY,
    });
    return documents.map((document) => ({
      id: document.id,
      url: document.url ?? '',
      title: document.title,
      status: document.error ? 'failed' : document.indexedAt ? 'ready' : 'reading',
      error: document.error,
      chunks: document.chunkCount,
      addedAt: document.createdAt.toISOString(),
      indexedAt: document.indexedAt?.toISOString() ?? null,
    }));
  }

  /**
   * Take a list of addresses and start reading them.
   *
   * Each page becomes a document straight away, before it has been read, so the settings page can
   * show the address with "reading…" beside it rather than nothing at all - and so a page that
   * turns out to be unreadable has somewhere to put the reason.
   *
   * Addresses already on the list are re-read rather than refused: pasting a page again is how
   * somebody says "this one has changed".
   */
  async addLinks(
    context: TenantContext,
    propertyId: string,
    urls: string[],
  ): Promise<{ queued: number; rejected: Array<{ url: string; reason: string }>; links: KnowledgeLinkView[] }> {
    requirePermission(context, Permission.AI_MANAGE);
    await assertPropertyInAccount(this.options.db, context, propertyId);

    const rejected: Array<{ url: string; reason: string }> = [];
    const wanted: string[] = [];
    for (const raw of urls.slice(0, MAX_LINKS_PER_REQUEST)) {
      const checked = this.check(raw);
      if ('reason' in checked) {
        rejected.push({ url: raw.trim().slice(0, 200), reason: checked.reason });
        continue;
      }
      if (!wanted.includes(checked.url)) wanted.push(checked.url);
    }

    if (wanted.length > 0) {
      const existing = await this.options.db.knowledgeDocument.count({
        where: { accountId: context.accountId, propertyId, kind: 'link', url: { notIn: wanted } },
      });
      const room = Math.max(0, MAX_LINKS_PER_PROPERTY - existing);
      for (const url of wanted.slice(room)) {
        rejected.push({ url, reason: `There is room for ${MAX_LINKS_PER_PROPERTY} added pages on one website.` });
      }
      wanted.length = Math.min(wanted.length, room);
    }

    const now = this.clock.now();
    let queued = 0;
    for (const url of wanted) {
      /**
       * Upserted by URL, and the `page` case matters: an address the crawl has already indexed
       * becomes a `link`, which is what the owner asked for - they want that page kept whatever
       * the crawl finds later. The text is left alone until the worker has read it, so the
       * assistant keeps answering from the old copy in the meantime.
       */
      const document = await this.options.db.knowledgeDocument.upsert({
        where: { accountId_propertyId_url: { accountId: context.accountId, propertyId, url } },
        create: {
          accountId: context.accountId,
          propertyId,
          kind: 'link',
          title: url,
          url,
          text: '',
          contentHash: '',
          lastSeenAt: now,
        },
        /**
         * `indexedAt` is cleared as well as the error, so a re-paste shows as *reading…* rather
         * than claiming to be indexed while the worker is still fetching it - the settings page
         * polls on exactly that, and would otherwise never notice a re-read that failed. The
         * text and its chunks stay in place meanwhile, so the assistant keeps answering from the
         * previous copy until the new one replaces it.
         */
        update: { kind: 'link', error: null, indexedAt: null, lastSeenAt: now },
        select: { id: true },
      });
      await this.options.queue.enqueue(AiJob.READ_LINK, {
        accountId: context.accountId,
        propertyId,
        documentId: document.id,
      });
      queued += 1;
    }

    if (queued > 0) {
      await this.audit.record({
        accountId: context.accountId,
        actorType: DbActorType.user,
        actorId: context.userId ?? null,
        action: 'ai.knowledge.links_added',
        resourceType: 'property',
        resourceId: propertyId,
        ip: context.ip ?? null,
        metadata: { queued, urls: wanted.slice(0, 25) },
      });
    }

    return { queued, rejected, links: await this.listLinks(context, propertyId) };
  }

  async removeLink(context: TenantContext, propertyId: string, documentId: string): Promise<void> {
    requirePermission(context, Permission.AI_MANAGE);
    await assertPropertyInAccount(this.options.db, context, propertyId);
    const document = await this.options.db.knowledgeDocument.findFirst({
      where: { accountId: context.accountId, propertyId, id: documentId, kind: 'link' },
      select: { id: true, url: true },
    });
    if (!document) throw new AppError(ErrorCode.NOT_FOUND, 'That page is not on the list.');
    await this.options.knowledge.deleteDocument(context.accountId, document.id);
    await this.audit.record({
      accountId: context.accountId,
      actorType: DbActorType.user,
      actorId: context.userId ?? null,
      action: 'ai.knowledge.link_removed',
      resourceType: 'property',
      resourceId: propertyId,
      ip: context.ip ?? null,
      metadata: { url: document.url },
    });
  }

  /**
   * Forget one source entirely.
   *
   * Destructive and meant to be: the assistant answers from what it has read, so the only way to
   * stop it repeating something wrong is for that something to stop existing. Each source also
   * has its own bookkeeping reset, so the settings page does not go on claiming "42 pages
   * indexed" over an empty index.
   */
  async forget(
    context: TenantContext,
    propertyId: string,
    source: ForgettableSource,
  ): Promise<{ removed: number }> {
    requirePermission(context, Permission.AI_MANAGE);
    await assertPropertyInAccount(this.options.db, context, propertyId);
    const accountId = context.accountId;

    let removed = 0;
    switch (source) {
      case 'website': {
        removed = await this.options.knowledge.forgetKind(accountId, propertyId, 'page');
        await this.options.db.aiSetting.updateMany({
          where: { accountId, propertyId },
          data: { crawlPagesFound: 0, crawlPagesIndexed: 0, lastCrawledAt: null, crawlError: null },
        });
        break;
      }
      case 'links': {
        removed = await this.options.knowledge.forgetKind(accountId, propertyId, 'link');
        break;
      }
      case 'feed': {
        removed = await this.options.knowledge.forgetKind(accountId, propertyId, 'product');
        // The address goes with the products. Leaving it would mean the next website sync
        // quietly brought back everything the owner just asked to be forgotten.
        await this.options.db.aiSetting.updateMany({
          where: { accountId, propertyId },
          data: { productFeedUrl: null, feedProducts: 0, lastFeedAt: null, feedError: null },
        });
        break;
      }
      case 'keyFacts': {
        removed = await this.options.knowledge.forgetKind(accountId, propertyId, 'notes');
        await this.options.db.aiSetting.updateMany({
          where: { accountId, propertyId },
          data: { keyFacts: '' },
        });
        break;
      }
    }

    await this.audit.record({
      accountId,
      actorType: DbActorType.user,
      actorId: context.userId ?? null,
      action: 'ai.knowledge.forgotten',
      resourceType: 'property',
      resourceId: propertyId,
      ip: context.ip ?? null,
      metadata: { source, removed },
    });
    return { removed };
  }

  /**
   * Read one pasted page and index it. Runs in the worker.
   *
   * A failure is written to the document rather than thrown away, because the owner is looking at
   * that address on the settings page waiting to be told what happened to it. The job itself does
   * not fail: retrying a 404 five times helps nobody.
   */
  async readLink(accountId: string, propertyId: string, documentId: string): Promise<{ indexed: boolean; error?: string }> {
    const document = await this.options.db.knowledgeDocument.findFirst({
      where: { accountId, propertyId, id: documentId, kind: 'link' },
      select: { id: true, url: true },
    });
    if (!document?.url) return { indexed: false, error: 'gone' };

    try {
      const page = await (this.options.readPage ?? readOnePage)(document.url, {
        read: this.options.read,
        ...(this.options.allowPrivateAddresses ? { allowPrivateAddresses: true } : {}),
      });
      /**
       * Indexed under the address the owner typed, not the one it redirected to.
       *
       * Otherwise a page that redirects would be stored under a URL the owner never saw, and
       * pasting the same address again would make a second document beside the first.
       */
      const result = await this.options.knowledge.syncLink(
        accountId,
        propertyId,
        { ...page, url: document.url },
        this.clock.now(),
      );
      await this.options.knowledge.indexDocument(accountId, result.documentId);
      return { indexed: true };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.options.db.knowledgeDocument
        .updateMany({ where: { accountId, id: documentId }, data: { error: reason.slice(0, 500), indexedAt: null } })
        .catch(() => undefined);
      this.options.log?.('ai.link.failed', { propertyId, url: document.url, error: reason });
      return { indexed: false, error: reason };
    }
  }

  /** One address, checked the way the owner would want it checked before anything is queued. */
  private check(raw: string): { url: string } | { reason: string } {
    const trimmed = raw.trim();
    if (!trimmed) return { reason: 'Empty.' };
    if (trimmed.length > 2_000) return { reason: 'That address is too long.' };
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const url = normaliseUrl(withScheme, null);
    if (!url) {
      // `normaliseUrl` has several reasons to refuse and says none of them. The two worth
      // telling apart are the ones a person hits by accident.
      let parsed: URL | null = null;
      try {
        parsed = new URL(withScheme);
      } catch {
        parsed = null;
      }
      if (parsed && parsed.port && parsed.port !== '80' && parsed.port !== '443') {
        return { reason: 'Addresses with a port number cannot be added.' };
      }
      if (parsed && (parsed.username || parsed.password)) {
        return { reason: 'Leave the username and password out of the address.' };
      }
      return { reason: 'That is not a web address.' };
    }
    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      return { reason: 'That is not a web address.' };
    }
    /**
     * A hostname on the public internet only.
     *
     * A name that *resolves* to a private address is refused at connect time by the fetcher,
     * which is the check that actually protects us; this one is for the owner, so an address that
     * was never going to work is refused while they are looking at it rather than half a minute
     * later as a failed page. `isPrivateAddress` answers "is this a private IP" and says yes to
     * anything that is not an IP at all, so it is only asked about IP literals.
     */
    if (!this.options.allowPrivateAddresses) {
      const isLiteral = isIP(hostname) !== 0;
      if (
        hostname === 'localhost' ||
        hostname.endsWith('.localhost') ||
        !(isLiteral || hostname.includes('.')) ||
        (isLiteral && isPrivateAddress(hostname))
      ) {
        return { reason: 'That address is not reachable from the internet.' };
      }
    }
    return { url };
  }
}
