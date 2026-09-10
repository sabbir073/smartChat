import type { AiSetting, Database } from '@smartchat/database';
import { ActorType as DbActorType } from '@smartchat/database';
import { AppError, ErrorCode, Permission, type TenantContext } from '@smartchat/types';
import type { UpdateAiSettingsInput } from '@smartchat/validation';
import type { EntitlementService } from '../billing/entitlements.js';
import { AiJob } from '../queue/jobs.js';
import type { QueueProducer } from '../queue/producer.js';
import { AuditRepository } from '../repositories/audit.repository.js';
import { requirePermission } from '../tenancy/context.js';
import { assertPropertyInAccount } from '../tenancy/property-access.js';
import { systemClock, type Clock } from '../time.js';
import type { KnowledgeService, KnowledgeStatus } from './knowledge.service.js';

/**
 * The AI agent as an account configures it: the mode, the persona, the key facts, and the state
 * of the knowledge index. One row per website, created on first save.
 *
 * Turning the mode away from `team` is the moment the plan is checked. Everything else can be
 * edited on any plan, so a Starter account can write its key facts before upgrading and find the
 * assistant ready when it does.
 */

export interface AiSettingsServiceOptions {
  db: Database;
  knowledge: KnowledgeService;
  queue: QueueProducer;
  entitlements: EntitlementService;
  clock?: Clock;
}

export interface AiSettingsView {
  mode: AiSetting['mode'];
  assistantName: string;
  instructions: string;
  keyFacts: string;
  ticketOfferText: string;
  handoffText: string;
  checkingText: string;
  offlineHandoffText: string;
  urgentText: string;
  handoffBackText: string;
  idleNudgeText: string;
  idleCloseText: string;
  handoffWaitMinutes: number;
  idleNudgeMinutes: number;
  idleCloseMinutes: number;
  showAiBadge: boolean;
  suggestReplies: boolean;
  maxRepliesPerConversation: number;
  crawlMaxPages: number;
  crawlExclude: string[];
  productFeedUrl: string | null;
  enabledAt: string | null;
  /** The website sync: what the crawler found and when, and why it could not, in a sentence. */
  website: {
    url: string;
    syncing: boolean;
    lastSyncedAt: string | null;
    pagesFound: number;
    pagesIndexed: number;
    error: string | null;
  };
  /** The product feed: how many products the last read found, and why it failed if it did. */
  feed: { url: string | null; lastSyncedAt: string | null; products: number; error: string | null };
  plan: { includesAi: boolean; planName: string; repliesUsed: number; repliesLimit: number | null };
  knowledge: {
    documents: number;
    pages: number;
    files: number;
    products: number;
    chunks: number;
    articles: number;
    lastIndexedAt: string | null;
    pending: number;
    failures: KnowledgeStatus['failures'];
  };
  /** How the AI did this month, for the settings page's small summary. */
  usage: { replies: number; answers: number; chats: number; tickets: number; handoffs: number; failed: number };
}

export const DEFAULT_AI_SETTINGS: {
  mode: AiSetting['mode'];
  assistantName: string;
  instructions: string;
  keyFacts: string;
  ticketOfferText: string;
  handoffText: string;
  checkingText: string;
  offlineHandoffText: string;
  urgentText: string;
  handoffBackText: string;
  idleNudgeText: string;
  idleCloseText: string;
  handoffWaitMinutes: number;
  idleNudgeMinutes: number;
  idleCloseMinutes: number;
  showAiBadge: boolean;
  suggestReplies: boolean;
  maxRepliesPerConversation: number;
  crawlMaxPages: number;
  crawlExclude: string[];
} = {
  mode: 'team',
  assistantName: 'Assistant',
  instructions: '',
  keyFacts: '',
  ticketOfferText:
    "I've checked our information and I don't have a definite answer on that. Let me create a ticket so a team member can look into it properly and get back to you by email.",
  handoffText: "I'm passing this to a member of our team - they'll pick it up right here in a moment.",
  checkingText: "Give me a moment, I'm checking that for you...",
  offlineHandoffText:
    "Our team isn't online right now. I can open a ticket so they follow up by email, and I'm happy to keep helping you here in the meantime.",
  urgentText: "I've marked this as urgent so the team sees it first.",
  handoffBackText:
    "It looks like our team member isn't available right now. I can keep helping you here, or open a ticket so they follow up by email - which would you prefer?",
  idleNudgeText: "I haven't heard from you for a little while - is there anything else I can help with, or shall I close this chat?",
  idleCloseText: "Thanks for chatting with us today - I'll close this chat for now. Come back any time, we're always happy to help. Goodbye!",
  handoffWaitMinutes: 3,
  idleNudgeMinutes: 5,
  idleCloseMinutes: 3,
  showAiBadge: false,
  suggestReplies: true,
  maxRepliesPerConversation: 50,
  crawlMaxPages: 200,
  crawlExclude: [],
};

export class AiSettingsService {
  private readonly clock: Clock;
  private readonly audit: AuditRepository;

  constructor(private readonly options: AiSettingsServiceOptions) {
    this.clock = options.clock ?? systemClock;
    this.audit = new AuditRepository(options.db);
  }

  async get(context: TenantContext, propertyId: string): Promise<AiSettingsView> {
    requirePermission(context, Permission.PROPERTY_VIEW);
    await assertPropertyInAccount(this.options.db, context, propertyId);
    const settings = await this.options.db.aiSetting.findUnique({
      where: { accountId_propertyId: { accountId: context.accountId, propertyId } },
    });
    return this.view(context.accountId, propertyId, settings);
  }

  async update(
    context: TenantContext,
    propertyId: string,
    input: UpdateAiSettingsInput,
  ): Promise<AiSettingsView> {
    requirePermission(context, Permission.AI_MANAGE);
    await assertPropertyInAccount(this.options.db, context, propertyId);

    if (input.mode && input.mode !== 'team') {
      await this.options.entitlements.assertFeature(context.accountId, 'aiAgent');
    }

    const now = this.clock.now();
    const existing = await this.options.db.aiSetting.findUnique({
      where: { accountId_propertyId: { accountId: context.accountId, propertyId } },
    });

    const data = {
      ...(input.mode !== undefined ? { mode: input.mode } : {}),
      ...(input.assistantName !== undefined ? { assistantName: input.assistantName } : {}),
      ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
      ...(input.keyFacts !== undefined ? { keyFacts: input.keyFacts } : {}),
      ...(input.ticketOfferText !== undefined ? { ticketOfferText: input.ticketOfferText } : {}),
      ...(input.handoffText !== undefined ? { handoffText: input.handoffText } : {}),
      ...(input.checkingText !== undefined ? { checkingText: input.checkingText } : {}),
      ...(input.offlineHandoffText !== undefined ? { offlineHandoffText: input.offlineHandoffText } : {}),
      ...(input.urgentText !== undefined ? { urgentText: input.urgentText } : {}),
      ...(input.handoffBackText !== undefined ? { handoffBackText: input.handoffBackText } : {}),
      ...(input.idleNudgeText !== undefined ? { idleNudgeText: input.idleNudgeText } : {}),
      ...(input.idleCloseText !== undefined ? { idleCloseText: input.idleCloseText } : {}),
      ...(input.handoffWaitMinutes !== undefined ? { handoffWaitMinutes: input.handoffWaitMinutes } : {}),
      ...(input.idleNudgeMinutes !== undefined ? { idleNudgeMinutes: input.idleNudgeMinutes } : {}),
      ...(input.idleCloseMinutes !== undefined ? { idleCloseMinutes: input.idleCloseMinutes } : {}),
      ...(input.showAiBadge !== undefined ? { showAiBadge: input.showAiBadge } : {}),
      ...(input.suggestReplies !== undefined ? { suggestReplies: input.suggestReplies } : {}),
      ...(input.maxRepliesPerConversation !== undefined
        ? { maxRepliesPerConversation: input.maxRepliesPerConversation }
        : {}),
      ...(input.crawlMaxPages !== undefined ? { crawlMaxPages: input.crawlMaxPages } : {}),
      ...(input.crawlExclude !== undefined ? { crawlExclude: dedupe(input.crawlExclude) } : {}),
      ...(input.productFeedUrl !== undefined ? { productFeedUrl: input.productFeedUrl } : {}),
      ...(input.mode && input.mode !== 'team' && (!existing || existing.mode === 'team')
        ? { enabledAt: now }
        : {}),
    };

    const saved = existing
      ? await this.options.db.aiSetting.update({ where: { id: existing.id }, data })
      : await this.options.db.aiSetting.create({
          data: { accountId: context.accountId, propertyId, ...data },
        });

    // Switching the AI on for the first time reads the website without being asked: "turn it on"
    // and "it knows my site" should be the same click. A new feed address is read the same way.
    const feedChanged = input.productFeedUrl !== undefined && input.productFeedUrl !== (existing?.productFeedUrl ?? null);
    if ((input.mode && input.mode !== 'team' && !saved.lastCrawledAt && !saved.crawlStartedAt) || feedChanged) {
      await this.options.queue.enqueueOnce(AiJob.CRAWL_PROPERTY, { accountId: context.accountId, propertyId }, `crawl-${propertyId}`);
    }

    // The key facts are a document in the index. Changing them re-indexes just that document.
    if (input.keyFacts !== undefined && input.keyFacts !== (existing?.keyFacts ?? '')) {
      const result = await this.options.knowledge.syncNotes(context.accountId, propertyId, input.keyFacts);
      if (result?.changed) {
        await this.options.queue.enqueue(AiJob.INDEX_DOCUMENT, {
          accountId: context.accountId,
          documentId: result.documentId,
        });
      }
    }

    await this.audit.record({
      accountId: context.accountId,
      actorType: DbActorType.user,
      actorId: context.userId ?? null,
      action: 'ai.settings.updated',
      resourceType: 'property',
      resourceId: propertyId,
      ip: context.ip ?? null,
      metadata: { changed: Object.keys(data), mode: saved.mode },
    });

    return this.view(context.accountId, propertyId, saved);
  }

  /**
   * "Sync website": crawl the site, re-read every article and the key facts, re-index the lot.
   * The crawl is one queued job per website, de-duplicated, so a second click while it runs
   * changes nothing.
   */
  async reindex(context: TenantContext, propertyId: string): Promise<{ queued: number; crawling: boolean }> {
    requirePermission(context, Permission.AI_MANAGE);
    await assertPropertyInAccount(this.options.db, context, propertyId);

    const queued = await this.syncProperty(context.accountId, propertyId);
    await this.options.queue.enqueueOnce(
      AiJob.CRAWL_PROPERTY,
      { accountId: context.accountId, propertyId },
      `crawl-${propertyId}`,
    );
    await this.audit.record({
      accountId: context.accountId,
      actorType: DbActorType.user,
      actorId: context.userId ?? null,
      action: 'ai.knowledge.reindexed',
      resourceType: 'property',
      resourceId: propertyId,
      ip: context.ip ?? null,
      metadata: { queued },
    });
    return { queued, crawling: true };
  }

  /**
   * Bring the documents of a property in line with its articles and notes, and queue a full
   * re-index of all of them. Used by the button above and by the worker's reindex job.
   */
  async syncProperty(accountId: string, propertyId: string): Promise<number> {
    const property = await this.options.db.property.findFirst({
      where: { accountId, id: propertyId, deletedAt: null },
      select: { publicId: true },
    });
    if (!property) throw new AppError(ErrorCode.PROPERTY_NOT_FOUND);

    const articles = await this.options.db.kbArticle.findMany({
      where: { accountId, propertyId },
      select: { id: true, title: true, slug: true, body: true, status: true, deletedAt: true },
    });
    for (const article of articles) {
      await this.options.knowledge.syncArticle({
        ...article,
        accountId,
        propertyId,
        propertyPublicId: property.publicId,
      });
    }
    const settings = await this.options.db.aiSetting.findUnique({
      where: { accountId_propertyId: { accountId, propertyId } },
      select: { keyFacts: true },
    });
    await this.options.knowledge.syncNotes(accountId, propertyId, settings?.keyFacts ?? '');

    // Mark the articles and notes un-indexed so the status page shows the rebuild, then queue
    // each one. Pages belong to the crawl, which re-reads them itself.
    await this.options.db.knowledgeDocument.updateMany({
      where: { accountId, propertyId, kind: { in: ['article', 'notes'] } },
      data: { indexedAt: null, error: null },
    });
    const documentIds = await this.options.knowledge.listDocumentIds(accountId, propertyId, ['article', 'notes']);
    for (const documentId of documentIds) {
      await this.options.queue.enqueue(AiJob.INDEX_DOCUMENT, { accountId, documentId });
    }
    return documentIds.length;
  }

  /**
   * An article was created, edited, published, unpublished or deleted. Called by the KB service
   * after its own write; never throws into it - the article is saved either way, and a missed
   * index run is caught by "re-index".
   */
  async onArticleChanged(accountId: string, articleId: string): Promise<void> {
    const article = await this.options.db.kbArticle.findFirst({
      where: { accountId, id: articleId },
      select: {
        id: true,
        propertyId: true,
        title: true,
        slug: true,
        body: true,
        status: true,
        deletedAt: true,
        property: { select: { publicId: true } },
      },
    });
    if (!article) return;
    const result = await this.options.knowledge.syncArticle({
      id: article.id,
      accountId,
      propertyId: article.propertyId,
      title: article.title,
      slug: article.slug,
      body: article.body,
      status: article.status,
      deletedAt: article.deletedAt,
      propertyPublicId: article.property.publicId,
    });
    if (result?.changed) {
      await this.options.queue.enqueue(AiJob.INDEX_DOCUMENT, { accountId, documentId: result.documentId });
    }
  }

  private async view(accountId: string, propertyId: string, settings: AiSetting | null): Promise<AiSettingsView> {
    const monthStart = startOfMonthUtc(this.clock.now());
    const [entitlements, allowance, knowledge, articles, property, turns] = await Promise.all([
      this.options.entitlements.forAccount(accountId),
      this.options.entitlements.aiReplyAllowance(accountId),
      this.options.knowledge.status(accountId, propertyId),
      this.options.db.knowledgeDocument.count({ where: { accountId, propertyId, kind: 'article' } }),
      this.options.db.property.findFirst({ where: { accountId, id: propertyId }, select: { websiteUrl: true } }),
      this.options.db.aiTurn.groupBy({
        by: ['decision'],
        where: { accountId, propertyId, createdAt: { gte: monthStart } },
        _count: { _all: true },
      }),
    ]);
    const count = (decision: 'answer' | 'chat' | 'ticket' | 'human' | 'failed'): number =>
      turns.find((row) => row.decision === decision)?._count._all ?? 0;
    const usage = {
      answers: count('answer'),
      chats: count('chat'),
      tickets: count('ticket'),
      handoffs: count('human'),
      failed: count('failed'),
      replies: 0,
    };
    usage.replies = usage.answers + usage.chats + usage.tickets + usage.handoffs + usage.failed;

    return {
      mode: settings?.mode ?? DEFAULT_AI_SETTINGS.mode,
      assistantName: settings?.assistantName ?? DEFAULT_AI_SETTINGS.assistantName,
      instructions: settings?.instructions ?? DEFAULT_AI_SETTINGS.instructions,
      keyFacts: settings?.keyFacts ?? DEFAULT_AI_SETTINGS.keyFacts,
      ticketOfferText: settings?.ticketOfferText ?? DEFAULT_AI_SETTINGS.ticketOfferText,
      handoffText: settings?.handoffText ?? DEFAULT_AI_SETTINGS.handoffText,
      checkingText: settings?.checkingText ?? DEFAULT_AI_SETTINGS.checkingText,
      offlineHandoffText: settings?.offlineHandoffText ?? DEFAULT_AI_SETTINGS.offlineHandoffText,
      urgentText: settings?.urgentText ?? DEFAULT_AI_SETTINGS.urgentText,
      handoffBackText: settings?.handoffBackText ?? DEFAULT_AI_SETTINGS.handoffBackText,
      idleNudgeText: settings?.idleNudgeText ?? DEFAULT_AI_SETTINGS.idleNudgeText,
      idleCloseText: settings?.idleCloseText ?? DEFAULT_AI_SETTINGS.idleCloseText,
      handoffWaitMinutes: settings?.handoffWaitMinutes ?? DEFAULT_AI_SETTINGS.handoffWaitMinutes,
      idleNudgeMinutes: settings?.idleNudgeMinutes ?? DEFAULT_AI_SETTINGS.idleNudgeMinutes,
      idleCloseMinutes: settings?.idleCloseMinutes ?? DEFAULT_AI_SETTINGS.idleCloseMinutes,
      showAiBadge: settings?.showAiBadge ?? DEFAULT_AI_SETTINGS.showAiBadge,
      suggestReplies: settings?.suggestReplies ?? DEFAULT_AI_SETTINGS.suggestReplies,
      maxRepliesPerConversation:
        settings?.maxRepliesPerConversation ?? DEFAULT_AI_SETTINGS.maxRepliesPerConversation,
      crawlMaxPages: settings?.crawlMaxPages ?? DEFAULT_AI_SETTINGS.crawlMaxPages,
      crawlExclude: settings?.crawlExclude ?? DEFAULT_AI_SETTINGS.crawlExclude,
      productFeedUrl: settings?.productFeedUrl ?? null,
      enabledAt: settings?.enabledAt?.toISOString() ?? null,
      website: {
        url: property?.websiteUrl ?? '',
        syncing: settings?.crawlStartedAt !== null && settings?.crawlStartedAt !== undefined,
        lastSyncedAt: settings?.lastCrawledAt?.toISOString() ?? null,
        pagesFound: settings?.crawlPagesFound ?? 0,
        pagesIndexed: settings?.crawlPagesIndexed ?? 0,
        error: settings?.crawlError ?? null,
      },
      feed: {
        url: settings?.productFeedUrl ?? null,
        lastSyncedAt: settings?.lastFeedAt?.toISOString() ?? null,
        products: settings?.feedProducts ?? 0,
        error: settings?.feedError ?? null,
      },
      plan: {
        includesAi: entitlements.plan.aiAgent,
        planName: entitlements.plan.name,
        repliesUsed: allowance.used,
        repliesLimit: allowance.limit,
      },
      knowledge: {
        documents: knowledge.documents,
        pages: knowledge.pages,
        files: knowledge.files,
        products: knowledge.products,
        chunks: knowledge.chunks,
        articles,
        lastIndexedAt: knowledge.lastIndexedAt?.toISOString() ?? null,
        pending: knowledge.pending,
        failures: knowledge.failures,
      },
      usage,
    };
  }
}

function dedupe(patterns: string[]): string[] {
  return [...new Set(patterns.map((p) => p.trim()).filter(Boolean))];
}

function startOfMonthUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
