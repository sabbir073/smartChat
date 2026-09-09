import type { AiSetting, Database } from '@smartchat/database';
import { AppError, ErrorCode, Permission, ServerEvent, room, type TenantContext } from '@smartchat/types';
import type { EntitlementService } from '../billing/entitlements.js';
import { toMessageDto, type EventPublisher } from '../realtime/events.js';
import { ConversationRepository } from '../repositories/conversation.repository.js';
import { agentAvailabilityReader } from '../services/availability.js';
import { requirePermission } from '../tenancy/context.js';
import { systemClock, type Clock } from '../time.js';
import { parseReply, REPLY_SCHEMA } from './contract.js';
import { decideAiReply, type AiSkipReason } from './dispatch.js';
import type { AiGateway } from './gateway.js';
import type { KnowledgeService, RetrievedChunk } from './knowledge.service.js';
import { buildPrompt, PRACTICE_PHRASES, type PromptPassage } from './prompt.js';

/**
 * One AI turn, start to finish. Runs in the worker.
 *
 * The shape of it is: check the rules again, find the passages, ask the model, validate what it
 * said, and then do exactly one of three things - post the answer, post the ticket offer, or
 * hand off to a person. The model chooses between those three; it cannot add a fourth. Whatever
 * happens, one `ai_turns` row records it, including the cases where nothing was posted.
 *
 * Idempotent on the visitor message: the queue already de-duplicates by message id, and the turn
 * row is checked too, so a redelivered job cannot answer twice.
 */

export interface AiReplyServiceOptions {
  db: Database;
  knowledge: KnowledgeService;
  gateway: AiGateway;
  entitlements: EntitlementService;
  events: EventPublisher;
  clock?: Clock;
  log?: (event: string, detail: Record<string, unknown>) => void;
}

/** A reply drafted for an agent. `draft` is null when the content does not answer the question. */
export interface AiDraft {
  draft: string | null;
  sources: Array<{ title: string; url: string | null }>;
  /** Why there is no draft: the content does not cover it, or the model is unavailable. */
  reason?: 'not_in_content' | 'wants_person' | 'unavailable' | 'no_question';
  provider: string | null;
  latencyMs: number;
}

export type AiReplyOutcome =
  | { posted: true; decision: 'answer' | 'chat' | 'ticket' | 'human' | 'failed'; provider: string | null; fellBack: boolean; latencyMs: number }
  | { posted: false; reason: AiSkipReason | 'duplicate' | 'missing' | 'allowance' | 'offer_pending' };

const MAX_HISTORY_MESSAGES = 10;
const MAX_QUESTION_CHARS = 2_000;

export class AiReplyService {
  private readonly clock: Clock;
  private readonly hasAvailableAgent: (accountId: string) => Promise<boolean>;

  constructor(private readonly options: AiReplyServiceOptions) {
    this.clock = options.clock ?? systemClock;
    this.hasAvailableAgent = agentAvailabilityReader(options.db);
  }

  async reply(input: {
    accountId: string;
    propertyId: string;
    conversationId: string;
    messageId: string;
  }): Promise<AiReplyOutcome> {
    const { db } = this.options;

    const existingTurn = await db.aiTurn.findFirst({
      where: { accountId: input.accountId, visitorMessageId: input.messageId },
      select: { id: true },
    });
    if (existingTurn) return { posted: false, reason: 'duplicate' };

    const [conversation, message, settings] = await Promise.all([
      db.conversation.findFirst({
        where: { accountId: input.accountId, id: input.conversationId, deletedAt: null },
        include: {
          property: { select: { name: true, websiteUrl: true, domains: { select: { pattern: true } } } },
        },
      }),
      db.message.findFirst({
        where: { accountId: input.accountId, id: input.messageId, conversationId: input.conversationId, deletedAt: null },
      }),
      db.aiSetting.findUnique({
        where: { accountId_propertyId: { accountId: input.accountId, propertyId: input.propertyId } },
      }),
    ]);
    if (!conversation || !message || message.senderType !== 'visitor') {
      return { posted: false, reason: 'missing' };
    }

    // A message that arrived after the one being answered means the visitor kept typing; the
    // newest one carries its own job, and answering an older one out of order reads as confusion.
    const newer = await db.message.findFirst({
      where: {
        conversationId: conversation.id,
        senderType: 'visitor',
        deletedAt: null,
        seq: { gt: message.seq },
      },
      select: { id: true },
    });
    if (newer) return { posted: false, reason: 'duplicate' };

    const [planIncludesAi, agentsOnline] = await Promise.all([
      this.options.entitlements.hasFeature(input.accountId, 'aiAgent'),
      this.hasAvailableAgent(input.accountId),
    ]);
    const decision = decideAiReply({ settings, planIncludesAi, agentsOnline, conversation });
    if (!decision.reply) {
      // The loop guard has a voice: the first time the limit is hit the visitor is told a person
      // will take it from here, once.
      if (decision.reason === 'reply_limit' && settings) {
        const pending = await this.lastBotMessageIsOffer(conversation.id);
        if (pending) return { posted: false, reason: 'offer_pending' };
        const started = this.clock.timestamp();
        await this.postOffer(conversation, settings, message.id, [], {
          decision: 'ticket',
          provider: null,
          model: null,
          fellBack: false,
          promptTokens: 0,
          completionTokens: 0,
          latencyMs: this.clock.timestamp() - started,
          error: 'reply limit for this conversation reached',
        });
        return { posted: true, decision: 'ticket', provider: null, fellBack: false, latencyMs: 0 };
      }
      return { posted: false, reason: decision.reason };
    }
    if (!settings) return { posted: false, reason: 'mode_team' };

    const allowance = await this.options.entitlements.aiReplyAllowance(input.accountId);
    if (!allowance.allowed) {
      const pending = await this.lastBotMessageIsOffer(conversation.id);
      if (pending) return { posted: false, reason: 'allowance' };
      await this.postOffer(conversation, settings, message.id, [], {
        decision: 'ticket',
        provider: null,
        model: null,
        fellBack: false,
        promptTokens: 0,
        completionTokens: 0,
        latencyMs: 0,
        error: `monthly allowance reached (${allowance.used}/${allowance.limit})`,
      });
      return { posted: true, decision: 'ticket', provider: null, fellBack: false, latencyMs: 0 };
    }

    const started = this.clock.timestamp();
    await this.typing(conversation, settings.assistantName, true);
    try {
      const question = message.body.trim().slice(0, MAX_QUESTION_CHARS);
      const [retrieved, history] = await Promise.all([
        this.options.knowledge.retrieve(input.accountId, input.propertyId, question),
        this.history(conversation.id, message.seq),
      ]);

      const passages: PromptPassage[] = retrieved.chunks.map((chunk, i) => ({
        number: i + 1,
        title: chunk.title,
        heading: chunk.heading,
        text: chunk.text,
      }));
      const prompt = buildPrompt({
        assistantName: settings.assistantName,
        businessName: conversation.property.name,
        instructions: settings.instructions,
        passages,
        history,
        question,
      });
      // fitPassages keeps a prefix and renumbers it, so the passages the model saw are the first
      // N retrieved, in order, and its citations index into that prefix.
      const chunksInPrompt = retrieved.chunks.slice(0, prompt.passages.length);

      const outcome = await this.options.gateway.complete({
        messages: prompt.messages,
        schema: REPLY_SCHEMA,
        maxTokens: 300,
        temperature: 0.2,
      });
      const latencyMs = this.clock.timestamp() - started;

      const parsed = parseReply(outcome.result.content, {
        passageCount: chunksInPrompt.length,
        allowedHosts: allowedHosts(conversation.property),
        grounding: [
          ...chunksInPrompt.flatMap((chunk) => [chunk.title, chunk.heading ?? '', chunk.text]),
          question,
          settings.instructions,
        ],
        practicePhrases: [...PRACTICE_PHRASES],
      });

      const turnBase = {
        provider: outcome.provider,
        model: outcome.result.model,
        fellBack: outcome.fellBack,
        promptTokens: outcome.result.promptTokens,
        completionTokens: outcome.result.completionTokens,
        latencyMs,
        error: outcome.fallbackReason ?? null,
      };

      if (!parsed.ok) {
        await this.postOffer(conversation, settings, message.id, chunksInPrompt, {
          ...turnBase,
          decision: 'failed',
          error: [turnBase.error, parsed.reason].filter(Boolean).join('; '),
        });
        return { posted: true, decision: 'failed', provider: outcome.provider, fellBack: outcome.fellBack, latencyMs };
      }

      const { reply } = parsed;
      const note = parsed.downgraded ? [turnBase.error, parsed.downgraded].filter(Boolean).join('; ') : turnBase.error;

      if (reply.decision === 'answer') {
        const cited = reply.sources.map((n) => chunksInPrompt[n - 1]!).filter(Boolean);
        await this.postAnswer(conversation, settings, message.id, reply.text, cited, chunksInPrompt, {
          ...turnBase,
          decision: 'answer',
          error: note,
        });
        return { posted: true, decision: 'answer', provider: outcome.provider, fellBack: outcome.fellBack, latencyMs };
      }

      if (reply.decision === 'chat') {
        await this.post(conversation, settings, message.id, reply.text, { sources: [] }, chunksInPrompt, [], {
          ...turnBase,
          decision: 'chat',
          error: note,
        }, true);
        return { posted: true, decision: 'chat', provider: outcome.provider, fellBack: outcome.fellBack, latencyMs };
      }

      if (reply.decision === 'human' && agentsOnline) {
        await this.postHandoff(conversation, settings, message.id, chunksInPrompt, {
          ...turnBase,
          decision: 'human',
          error: note,
        });
        return { posted: true, decision: 'human', provider: outcome.provider, fellBack: outcome.fellBack, latencyMs };
      }

      await this.postOffer(conversation, settings, message.id, chunksInPrompt, {
        ...turnBase,
        decision: reply.decision,
        error: note,
      });
      return { posted: true, decision: reply.decision, provider: outcome.provider, fellBack: outcome.fellBack, latencyMs };
    } catch (error) {
      const latencyMs = this.clock.timestamp() - started;
      const detail = error instanceof Error ? error.message : String(error);
      this.options.log?.('ai.reply.failed', { conversationId: conversation.id, error: detail });
      // The visitor is not left hanging: the offer goes out, and the turn says why.
      await this.postOffer(conversation, settings, message.id, [], {
        decision: 'failed',
        provider: null,
        model: null,
        fellBack: false,
        promptTokens: 0,
        completionTokens: 0,
        latencyMs,
        error: error instanceof AppError && error.code === ErrorCode.AI_UNAVAILABLE ? `unavailable: ${detail}` : detail.slice(0, 500),
      });
      return { posted: true, decision: 'failed', provider: null, fellBack: false, latencyMs };
    } finally {
      await this.typing(conversation, settings.assistantName, false);
    }
  }

  /**
   * A reply drafted for a person to edit and send.
   *
   * The same retrieval, prompt and contract as a visitor-facing reply - the draft is as grounded
   * as an answer would be - but nothing is posted: the text comes back to the agent, who decides.
   * When the model would have offered a ticket there is no draft, and the agent is told the
   * content does not cover it; a person can answer what the assistant cannot, that is the point.
   * Recorded as a `draft` turn so the report can say how often the team leans on it.
   */
  async draft(context: TenantContext, conversationId: string): Promise<AiDraft> {
    requirePermission(context, Permission.CONVERSATION_REPLY);
    await this.options.entitlements.assertFeature(context.accountId, 'aiAgent');
    const { db } = this.options;
    const conversation = await db.conversation.findFirst({
      where: {
        accountId: context.accountId,
        id: conversationId,
        deletedAt: null,
        ...(context.propertyIds && context.propertyIds.size > 0 ? { propertyId: { in: [...context.propertyIds] } } : {}),
      },
      include: {
        property: { select: { name: true, websiteUrl: true, domains: { select: { pattern: true } } } },
      },
    });
    if (!conversation) throw new AppError(ErrorCode.CONVERSATION_NOT_FOUND);
    const message = await db.message.findFirst({
      where: { conversationId: conversation.id, senderType: 'visitor', deletedAt: null, type: 'text' },
      orderBy: { seq: 'desc' },
    });
    const question = message?.body.trim().slice(0, MAX_QUESTION_CHARS) ?? '';
    if (!message || !question) return { draft: null, sources: [], reason: 'no_question', provider: null, latencyMs: 0 };

    const settings =
      (await db.aiSetting.findUnique({
        where: { accountId_propertyId: { accountId: context.accountId, propertyId: conversation.propertyId } },
      })) ?? null;
    const assistantName = settings?.assistantName ?? 'AI assistant';
    const instructions = settings?.instructions ?? '';

    const started = this.clock.timestamp();
    const [retrieved, history] = await Promise.all([
      this.options.knowledge.retrieve(context.accountId, conversation.propertyId, question),
      this.history(conversation.id, message.seq),
    ]);
    const passages: PromptPassage[] = retrieved.chunks.map((chunk, i) => ({
      number: i + 1,
      title: chunk.title,
      heading: chunk.heading,
      text: chunk.text,
    }));
    const prompt = buildPrompt({
      assistantName,
      businessName: conversation.property.name,
      instructions,
      passages,
      history,
      question,
    });
    const chunksInPrompt = retrieved.chunks.slice(0, prompt.passages.length);

    let outcome;
    try {
      outcome = await this.options.gateway.complete({
        messages: prompt.messages,
        schema: REPLY_SCHEMA,
        maxTokens: 300,
        temperature: 0.2,
      });
    } catch (error) {
      const latencyMs = this.clock.timestamp() - started;
      await this.recordDraft(context, conversation, message.id, chunksInPrompt, {
        provider: null,
        model: null,
        fellBack: false,
        promptTokens: 0,
        completionTokens: 0,
        latencyMs,
        error: `unavailable: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500),
      });
      return { draft: null, sources: [], reason: 'unavailable', provider: null, latencyMs };
    }
    const latencyMs = this.clock.timestamp() - started;
    const parsed = parseReply(outcome.result.content, {
      passageCount: chunksInPrompt.length,
      allowedHosts: allowedHosts(conversation.property),
      grounding: [
        ...chunksInPrompt.flatMap((chunk) => [chunk.title, chunk.heading ?? '', chunk.text]),
        question,
        instructions,
      ],
      practicePhrases: [...PRACTICE_PHRASES],
    });
    const decision = parsed.ok ? parsed.reply.decision : 'failed';
    const text = parsed.ok && (decision === 'answer' || decision === 'chat') ? parsed.reply.text : null;
    const cited = parsed.ok && decision === 'answer' ? parsed.reply.sources.map((n) => chunksInPrompt[n - 1]!).filter(Boolean) : [];
    await this.recordDraft(context, conversation, message.id, chunksInPrompt, {
      provider: outcome.provider,
      model: outcome.result.model,
      fellBack: outcome.fellBack,
      promptTokens: outcome.result.promptTokens,
      completionTokens: outcome.result.completionTokens,
      latencyMs,
      citedChunkIds: cited.map((chunk) => chunk.chunkId),
      error: [outcome.fallbackReason, parsed.ok ? parsed.downgraded : parsed.reason, text ? null : `model decided: ${decision}`]
        .filter(Boolean)
        .join('; ') || null,
    });
    return {
      draft: text,
      sources: dedupeSources(cited),
      ...(text ? {} : { reason: decision === 'human' ? 'wants_person' : 'not_in_content' }),
      provider: outcome.provider,
      latencyMs,
    };
  }

  private async recordDraft(
    context: TenantContext,
    conversation: { id: string; propertyId: string },
    visitorMessageId: string,
    retrieved: RetrievedChunk[],
    turn: Omit<TurnRecord, 'decision'> & { citedChunkIds?: string[] },
  ): Promise<void> {
    await this.options.db.aiTurn.create({
      data: {
        accountId: context.accountId,
        propertyId: conversation.propertyId,
        conversationId: conversation.id,
        visitorMessageId,
        replyMessageId: null,
        decision: 'draft',
        provider: turn.provider,
        model: turn.model,
        fellBack: turn.fellBack,
        promptTokens: turn.promptTokens,
        completionTokens: turn.completionTokens,
        latencyMs: turn.latencyMs,
        retrievedChunkIds: retrieved.map((chunk) => chunk.chunkId),
        citedChunkIds: turn.citedChunkIds ?? [],
        error: turn.error,
      },
    });
  }

  // ---------------------------------------------------------------------------

  private async history(
    conversationId: string,
    beforeSeq: bigint,
  ): Promise<Array<{ role: 'visitor' | 'assistant'; text: string }>> {
    const rows = await this.options.db.message.findMany({
      where: {
        conversationId,
        deletedAt: null,
        seq: { lt: beforeSeq },
        type: { in: ['text'] },
        senderType: { in: ['visitor', 'bot', 'agent'] },
      },
      orderBy: { seq: 'desc' },
      take: MAX_HISTORY_MESSAGES,
      select: { senderType: true, body: true, metadata: true },
    });
    return rows
      .reverse()
      .filter((row) => row.body.trim().length > 0)
      .map((row) => ({
        // An agent's earlier words are shown as the assistant's: the model is continuing the same
        // side of the conversation, and it must not contradict what the team already said.
        role: row.senderType === 'visitor' ? ('visitor' as const) : ('assistant' as const),
        text: row.body.slice(0, 1_000),
      }));
  }

  private async lastBotMessageIsOffer(conversationId: string): Promise<boolean> {
    const last = await this.options.db.message.findFirst({
      where: { conversationId, deletedAt: null, senderType: { in: ['bot', 'agent', 'visitor'] } },
      orderBy: { seq: 'desc' },
      select: { senderType: true, metadata: true },
    });
    if (!last || last.senderType !== 'bot') return false;
    const raw = last.metadata as Record<string, unknown> | null;
    return raw?.['source'] === 'ai' && raw?.['offer'] === 'ticket';
  }

  private async typing(
    conversation: { id: string; accountId: string; propertyId: string; visitorId: string },
    actorName: string,
    typing: boolean,
  ): Promise<void> {
    await this.options.events.publish({
      type: ServerEvent.TYPING,
      accountId: conversation.accountId,
      propertyId: conversation.propertyId,
      conversationId: conversation.id,
      visitorId: conversation.visitorId,
      payload: { conversationId: conversation.id, actorType: 'bot', actorId: 'ai', actorName, typing },
    });
  }

  private async postAnswer(
    conversation: ConversationRow,
    settings: AiSetting,
    visitorMessageId: string,
    text: string,
    cited: RetrievedChunk[],
    retrieved: RetrievedChunk[],
    turn: TurnRecord,
  ): Promise<void> {
    const sources = dedupeSources(cited);
    await this.post(conversation, settings, visitorMessageId, text, { sources }, retrieved, cited, turn, true);
  }

  private async postOffer(
    conversation: ConversationRow,
    settings: AiSetting,
    visitorMessageId: string,
    retrieved: RetrievedChunk[],
    turn: TurnRecord,
  ): Promise<void> {
    await this.post(
      conversation,
      settings,
      visitorMessageId,
      settings.ticketOfferText,
      { sources: [], offer: 'ticket' },
      retrieved,
      [],
      turn,
      turn.decision !== 'failed',
    );
  }

  /**
   * The visitor asked for a person and one is online: the conversation is assigned to them, now.
   *
   * The operator's rule, verbatim: "assign to the person immediately". The person is the online
   * member with the fewest open conversations already on their desk, restricted to those who can
   * see this website when the account limits members to properties. If no one qualifies after
   * all (everyone online is restricted to other websites), the conversation is flagged as
   * waiting instead, which the inbox shows to everyone who can see it.
   */
  private async postHandoff(
    conversation: ConversationRow,
    settings: AiSetting,
    visitorMessageId: string,
    retrieved: RetrievedChunk[],
    turn: TurnRecord,
  ): Promise<void> {
    const now = this.clock.now();
    const assignee = await this.pickOnlineAgent(conversation.accountId, conversation.propertyId);
    await this.options.db.conversation.update({
      where: { id: conversation.id },
      data: {
        aiPausedAt: now,
        aiHandoffAt: now,
        ...(assignee ? { assignedMemberId: assignee.id } : {}),
      },
    });
    await this.post(conversation, settings, visitorMessageId, settings.handoffText, { sources: [] }, retrieved, [], turn, true);

    const base = {
      accountId: conversation.accountId,
      propertyId: conversation.propertyId,
      conversationId: conversation.id,
      agentsOnly: true,
    };
    if (assignee) {
      await this.options.events.publish({
        ...base,
        type: ServerEvent.CONVERSATION_ASSIGNED,
        payload: { conversationId: conversation.id, assignedMemberId: assignee.id, by: 'ai' },
      });
    }
    // The inbox list shows "waiting for a person" from the flag; tell it the row changed.
    await this.options.events.publish({
      ...base,
      type: ServerEvent.CONVERSATION_UPDATED,
      visitorId: conversation.visitorId,
      payload: {
        conversationId: conversation.id,
        status: conversation.status,
        priority: conversation.priority,
        tags: conversation.tags,
        assignedMemberId: assignee?.id ?? null,
        aiHandoffAt: now.toISOString(),
        aiPausedAt: now.toISOString(),
      },
    });
  }

  private async pickOnlineAgent(accountId: string, propertyId: string): Promise<{ id: string } | null> {
    const candidates = await this.options.db.accountMember.findMany({
      where: {
        accountId,
        availability: 'online',
        status: 'active',
        deletedAt: null,
        user: { deletedAt: null },
        // Either unrestricted, or explicitly given this website.
        OR: [{ properties: { none: {} } }, { properties: { some: { propertyId } } }],
      },
      select: {
        id: true,
        _count: {
          select: {
            assignedConversations: { where: { status: { in: ['open', 'pending'] }, deletedAt: null } },
          },
        },
      },
    });
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a._count.assignedConversations - b._count.assignedConversations);
    return { id: candidates[0]!.id };
  }

  /** Insert the bot message, publish it, record the turn, bump the counters. */
  private async post(
    conversation: ConversationRow,
    settings: AiSetting,
    visitorMessageId: string,
    body: string,
    info: { sources: Array<{ title: string; url: string | null }>; offer?: 'ticket' },
    retrieved: RetrievedChunk[],
    cited: RetrievedChunk[],
    turn: TurnRecord,
    countsAsReply: boolean,
  ): Promise<void> {
    const now = this.clock.now();
    const persisted = await this.options.db.$transaction(async (tx) => {
      const inserted = await new ConversationRepository(tx).insertMessage({
        accountId: conversation.accountId,
        propertyId: conversation.propertyId,
        conversationId: conversation.id,
        senderType: 'bot',
        type: 'text',
        body,
        metadata: {
          source: 'ai',
          senderName: settings.assistantName,
          sources: info.sources,
          ...(info.offer ? { offer: info.offer } : {}),
        },
        now,
      });
      if (countsAsReply) {
        await tx.conversation.update({
          where: { id: conversation.id },
          data: { aiReplyCount: { increment: 1 }, aiLastReplyAt: now },
        });
      }
      await tx.aiTurn.create({
        data: {
          accountId: conversation.accountId,
          propertyId: conversation.propertyId,
          conversationId: conversation.id,
          visitorMessageId,
          replyMessageId: inserted.message.id,
          decision: turn.decision,
          provider: turn.provider,
          model: turn.model,
          fellBack: turn.fellBack,
          promptTokens: turn.promptTokens,
          completionTokens: turn.completionTokens,
          latencyMs: turn.latencyMs,
          retrievedChunkIds: retrieved.map((c) => c.chunkId),
          citedChunkIds: cited.map((c) => c.chunkId),
          error: turn.error,
        },
      });
      return inserted;
    });

    await this.options.events.publish({
      type: ServerEvent.MESSAGE_NEW,
      accountId: conversation.accountId,
      propertyId: conversation.propertyId,
      conversationId: conversation.id,
      visitorId: conversation.visitorId,
      payload: {
        message: toMessageDto(persisted.message, settings.assistantName),
        room: room.conversation(conversation.id),
      },
    });
  }
}

interface ConversationRow {
  id: string;
  accountId: string;
  propertyId: string;
  visitorId: string;
  status: 'open' | 'pending' | 'closed';
  priority: string;
  tags: string[];
  property: { name: string; websiteUrl: string; domains: Array<{ pattern: string }> };
}

interface TurnRecord {
  decision: 'answer' | 'chat' | 'ticket' | 'human' | 'failed';
  provider: 'local' | 'openai' | 'deepseek' | null;
  model: string | null;
  fellBack: boolean;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  error: string | null;
}

function dedupeSources(chunks: RetrievedChunk[]): Array<{ title: string; url: string | null }> {
  const seen = new Set<string>();
  const out: Array<{ title: string; url: string | null }> = [];
  for (const chunk of chunks) {
    if (seen.has(chunk.documentId)) continue;
    seen.add(chunk.documentId);
    out.push({ title: chunk.title, url: chunk.url });
  }
  return out;
}

/** The hosts a reply may link to: the website itself and every domain the widget is allowed on. */
export function allowedHosts(property: { websiteUrl: string; domains: Array<{ pattern: string }> }): string[] {
  const hosts = new Set<string>();
  try {
    hosts.add(new URL(property.websiteUrl).hostname.toLowerCase());
  } catch {
    // A website URL that does not parse simply allows nothing extra.
  }
  for (const domain of property.domains) {
    const host = domain.pattern.replace(/^\*\./, '').toLowerCase();
    if (host) hosts.add(host);
  }
  return [...hosts];
}
