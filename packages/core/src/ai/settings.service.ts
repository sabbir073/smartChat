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
  maxRepliesPerConversation: number;
  enabledAt: string | null;
  plan: { includesAi: boolean; planName: string; repliesUsed: number; repliesLimit: number | null };
  knowledge: {
    documents: number;
    chunks: number;
    articles: number;
    lastIndexedAt: string | null;
    pending: number;
    failures: KnowledgeStatus['failures'];
  };
  /** How the AI did this month, for the settings page's small summary. */
  usage: { replies: number; answers: number; tickets: number; handoffs: number; failed: number };
}

export const DEFAULT_AI_SETTINGS = {
  mode: 'team',
  assistantName: 'AI assistant',
  instructions: '',
  keyFacts: '',
  ticketOfferText:
    "I can't help with that from here, but our team can. Would you like me to open a support ticket so they can follow up by email?",
  handoffText: "I'm passing this to a member of our team - they'll pick it up right here in a moment.",
  maxRepliesPerConversation: 50,
} as const;

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
      ...(input.maxRepliesPerConversation !== undefined
        ? { maxRepliesPerConversation: input.maxRepliesPerConversation }
        : {}),
      ...(input.mode && input.mode !== 'team' && (!existing || existing.mode === 'team')
        ? { enabledAt: now }
        : {}),
    };

    const saved = existing
      ? await this.options.db.aiSetting.update({ where: { id: existing.id }, data })
      : await this.options.db.aiSetting.create({
          data: { accountId: context.accountId, propertyId, ...data },
        });

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
   * "Re-index": every published article and the key facts, from scratch. For when the index
   * looks wrong, and after the embedding model changes.
   */
  async reindex(context: TenantContext, propertyId: string): Promise<{ queued: number }> {
    requirePermission(context, Permission.AI_MANAGE);
    await assertPropertyInAccount(this.options.db, context, propertyId);

    const queued = await this.syncProperty(context.accountId, propertyId);
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
    return { queued };
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

    // Mark everything un-indexed so the status page shows the rebuild, then queue each one.
    await this.options.db.knowledgeDocument.updateMany({
      where: { accountId, propertyId },
      data: { indexedAt: null, error: null },
    });
    const documentIds = await this.options.knowledge.listDocumentIds(accountId, propertyId);
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
    const [entitlements, allowance, knowledge, articles, turns] = await Promise.all([
      this.options.entitlements.forAccount(accountId),
      this.options.entitlements.aiReplyAllowance(accountId),
      this.options.knowledge.status(accountId, propertyId),
      this.options.db.knowledgeDocument.count({ where: { accountId, propertyId, kind: 'article' } }),
      this.options.db.aiTurn.groupBy({
        by: ['decision'],
        where: { accountId, propertyId, createdAt: { gte: monthStart } },
        _count: { _all: true },
      }),
    ]);
    const count = (decision: 'answer' | 'ticket' | 'human' | 'failed'): number =>
      turns.find((row) => row.decision === decision)?._count._all ?? 0;
    const usage = {
      answers: count('answer'),
      tickets: count('ticket'),
      handoffs: count('human'),
      failed: count('failed'),
      replies: 0,
    };
    usage.replies = usage.answers + usage.tickets + usage.handoffs + usage.failed;

    return {
      mode: settings?.mode ?? DEFAULT_AI_SETTINGS.mode,
      assistantName: settings?.assistantName ?? DEFAULT_AI_SETTINGS.assistantName,
      instructions: settings?.instructions ?? DEFAULT_AI_SETTINGS.instructions,
      keyFacts: settings?.keyFacts ?? DEFAULT_AI_SETTINGS.keyFacts,
      ticketOfferText: settings?.ticketOfferText ?? DEFAULT_AI_SETTINGS.ticketOfferText,
      handoffText: settings?.handoffText ?? DEFAULT_AI_SETTINGS.handoffText,
      maxRepliesPerConversation:
        settings?.maxRepliesPerConversation ?? DEFAULT_AI_SETTINGS.maxRepliesPerConversation,
      enabledAt: settings?.enabledAt?.toISOString() ?? null,
      plan: {
        includesAi: entitlements.plan.aiAgent,
        planName: entitlements.plan.name,
        repliesUsed: allowance.used,
        repliesLimit: allowance.limit,
      },
      knowledge: {
        documents: knowledge.documents,
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

function startOfMonthUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
