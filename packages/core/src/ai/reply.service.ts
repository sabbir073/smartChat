import type { AiSetting, Database } from '@smartchat/database';
import { AppError, ErrorCode, Permission, ServerEvent, room, type TenantContext } from '@smartchat/types';
import type { EntitlementService } from '../billing/entitlements.js';
import { toMessageDto, type EventPublisher } from '../realtime/events.js';
import { ConversationRepository } from '../repositories/conversation.repository.js';
import { agentAvailabilityReader } from '../services/availability.js';
import { requirePermission } from '../tenancy/context.js';
import { systemClock, type Clock } from '../time.js';
import { parseReply, parseSuggestions, REPLY_SCHEMA, SUGGESTIONS_SCHEMA } from './contract.js';
import { decideAiReply, shouldSuggestReplies, type AiSkipReason } from './dispatch.js';
import type { AiGateway } from './gateway.js';
import type { AiProviderKind } from './provider.js';
import type { KnowledgeService, RetrievedChunk } from './knowledge.service.js';
import type { LifecycleService } from './lifecycle.service.js';
import { postBotMessage } from './bot-message.js';
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
  /** The timers: take back, nudge, close. Absent in the API (drafts need none). */
  lifecycle?: LifecycleService;
  clock?: Clock;
  log?: (event: string, detail: Record<string, unknown>) => void;
  /** How long the model may take before the visitor is told it is being looked into. */
  holdingAfterMs?: number;
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
/** The lookup has taken this long: tell the visitor it is being looked into. */
const HOLDING_AFTER_MS = 2_500;

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
      // The reply was queued on facts that have since changed - a person took over, the mode was
      // switched. The person answering still gets their suggestions.
      if (shouldSuggestReplies({ settings, planIncludesAi, conversation })) {
        await this.suggest({ accountId: input.accountId, conversationId: conversation.id, messageId: message.id });
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
    // "Give me a moment, I'm checking that for you." Only if the lookup takes longer than a
    // moment: a greeting answered in a second must not be preceded by a promise to check.
    const holding = setTimeout(() => {
      void postBotMessage(this.options.db, this.options.events, {
        conversation,
        assistantName: settings.assistantName,
        body: settings.checkingText,
        metadata: { kind: 'holding', ...(settings.showAiBadge ? { badge: true } : {}) },
        now: this.clock.now(),
      }).catch((error: unknown) => this.options.log?.('ai.reply.holding_failed', { conversationId: conversation.id, error: String(error) }));
    }, this.options.holdingAfterMs ?? HOLDING_AFTER_MS);
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
        url: chunk.url,
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

      const outcome = await this.options.gateway.complete(
        { messages: prompt.messages, schema: REPLY_SCHEMA, maxTokens: 300, temperature: 0.2 },
        { accountId: input.accountId },
      );
      clearTimeout(holding);
      const latencyMs = this.clock.timestamp() - started;

      const parsed = parseReply(outcome.result.content, {
        passageCount: chunksInPrompt.length,
        allowedHosts: allowedHosts(conversation.property),
        grounding: [
          ...chunksInPrompt.flatMap((chunk) => [chunk.title, chunk.heading ?? '', chunk.text, chunk.url ?? '']),
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
        await this.options.lifecycle?.afterAssistantReply(conversation, settings);
        return { posted: true, decision: 'failed', provider: outcome.provider, fellBack: outcome.fellBack, latencyMs };
      }

      const { reply } = parsed;
      const note = parsed.downgraded ? [turnBase.error, parsed.downgraded].filter(Boolean).join('; ') : turnBase.error;

      // What the model noticed, acted on here - it has no hands of its own.
      const urgentNow = reply.urgent && conversation.priority !== 'urgent';
      if (urgentNow) await this.markUrgent(conversation);
      if (reply.topic && conversation.aiReplyCount === 0) await this.tag(conversation, reply.topic);
      const withUrgency = (text: string): string =>
        urgentNow && !/urgent/i.test(text) ? `${text} ${settings.urgentText}`.trim() : text;

      if (reply.decision === 'answer') {
        const cited = reply.sources.map((n) => chunksInPrompt[n - 1]!).filter(Boolean);
        await this.postAnswer(conversation, settings, message.id, withUrgency(reply.text), cited, chunksInPrompt, {
          ...turnBase,
          decision: 'answer',
          error: note,
        });
        await this.afterReply(conversation, settings, reply.goodbye);
        return { posted: true, decision: 'answer', provider: outcome.provider, fellBack: outcome.fellBack, latencyMs };
      }

      if (reply.decision === 'chat') {
        await this.post(conversation, settings, message.id, withUrgency(reply.text), { sources: [] }, chunksInPrompt, [], {
          ...turnBase,
          decision: 'chat',
          error: note,
        }, true);
        await this.afterReply(conversation, settings, reply.goodbye);
        return { posted: true, decision: 'chat', provider: outcome.provider, fellBack: outcome.fellBack, latencyMs };
      }

      if (reply.decision === 'human' && agentsOnline) {
        await this.postHandoff(conversation, settings, message.id, chunksInPrompt, history, question, {
          ...turnBase,
          decision: 'human',
          error: note,
        });
        await this.options.lifecycle?.afterHandoff(conversation, settings);
        return { posted: true, decision: 'human', provider: outcome.provider, fellBack: outcome.fellBack, latencyMs };
      }

      // A ticket, or a person wanted while nobody is online: the offer, in the owner's words.
      await this.postOffer(
        conversation,
        settings,
        message.id,
        chunksInPrompt,
        { ...turnBase, decision: reply.decision, error: note },
        withUrgency(reply.decision === 'human' ? settings.offlineHandoffText : settings.ticketOfferText),
      );
      await this.options.lifecycle?.afterAssistantReply(conversation, settings);
      return { posted: true, decision: reply.decision, provider: outcome.provider, fellBack: outcome.fellBack, latencyMs };
    } catch (error) {
      clearTimeout(holding);
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
      await this.options.lifecycle?.afterAssistantReply(conversation, settings);
      return { posted: true, decision: 'failed', provider: null, fellBack: false, latencyMs };
    } finally {
      clearTimeout(holding);
      await this.typing(conversation, settings.assistantName, false);
    }
  }

  /** After a reply: keep time. A goodbye closes soon; anything else waits for the visitor. */
  private async afterReply(conversation: ConversationRow, settings: AiSetting, goodbye: boolean): Promise<void> {
    if (!this.options.lifecycle) return;
    if (goodbye) await this.options.lifecycle.afterGoodbye(conversation);
    else await this.options.lifecycle.afterAssistantReply(conversation, settings);
  }

  /** The visitor said it is urgent: the row says so, and every open inbox sees it change. */
  private async markUrgent(conversation: ConversationRow): Promise<void> {
    await this.options.db.conversation.update({ where: { id: conversation.id }, data: { priority: 'urgent' } });
    conversation.priority = 'urgent';
    await this.publishRow(conversation);
    this.options.log?.('ai.reply.urgent', { conversationId: conversation.id });
  }

  /** The first reply names the subject; it becomes a tag unless the team already tagged it. */
  private async tag(conversation: ConversationRow, topic: string): Promise<void> {
    if (conversation.tags.length >= 10) return;
    if (conversation.tags.some((tag) => tag.toLowerCase() === topic)) return;
    const tags = [...conversation.tags, topic];
    await this.options.db.conversation.update({ where: { id: conversation.id }, data: { tags } });
    conversation.tags = tags;
    await this.publishRow(conversation);
  }

  private async publishRow(conversation: ConversationRow): Promise<void> {
    await this.options.events.publish({
      type: ServerEvent.CONVERSATION_UPDATED,
      accountId: conversation.accountId,
      propertyId: conversation.propertyId,
      conversationId: conversation.id,
      visitorId: conversation.visitorId,
      agentsOnly: true,
      payload: {
        conversationId: conversation.id,
        status: conversation.status,
        priority: conversation.priority,
        tags: conversation.tags,
        assignedMemberId: conversation.assignedMemberId,
      },
    });
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
      url: chunk.url,
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
      outcome = await this.options.gateway.complete(
        { messages: prompt.messages, schema: REPLY_SCHEMA, maxTokens: 300, temperature: 0.2 },
        { accountId: context.accountId },
      );
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
        ...chunksInPrompt.flatMap((chunk) => [chunk.title, chunk.heading ?? '', chunk.text, chunk.url ?? '']),
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

  /**
   * Suggestions for a person: up to three short replies to the visitor's message - one that
   * answers from the content when it can, one that asks the right clarifying question, one that
   * acknowledges and reassures. Stored on the conversation and pushed to every open inbox; the
   * person picks one, edits it, sends it, or ignores them all. Runs on the first visitor message
   * of a chat a person is handling; the Suggest button covers the rest.
   */
  async suggest(input: { accountId: string; conversationId: string; messageId: string }): Promise<{ suggestions: number }> {
    const { db } = this.options;
    const [conversation, message] = await Promise.all([
      db.conversation.findFirst({
        where: { accountId: input.accountId, id: input.conversationId, deletedAt: null },
        include: { property: { select: { name: true, websiteUrl: true, domains: { select: { pattern: true } } } } },
      }),
      db.message.findFirst({ where: { accountId: input.accountId, id: input.messageId, senderType: 'visitor', deletedAt: null } }),
    ]);
    if (!conversation || !message || conversation.status === 'closed') return { suggestions: 0 };
    const settings = await db.aiSetting.findUnique({
      where: { accountId_propertyId: { accountId: input.accountId, propertyId: conversation.propertyId } },
    });
    if (!settings || !settings.suggestReplies) return { suggestions: 0 };
    const question = message.body.trim().slice(0, MAX_QUESTION_CHARS);
    if (!question) return { suggestions: 0 };

    const started = this.clock.timestamp();
    const [retrieved, history] = await Promise.all([
      this.options.knowledge.retrieve(input.accountId, conversation.propertyId, question),
      this.history(conversation.id, message.seq),
    ]);
    const passages: PromptPassage[] = retrieved.chunks.map((chunk, i) => ({
      number: i + 1,
      title: chunk.title,
      heading: chunk.heading,
      text: chunk.text,
      url: chunk.url,
    }));
    const prompt = buildPrompt({
      assistantName: settings.assistantName,
      businessName: conversation.property.name,
      instructions: settings.instructions,
      passages,
      history,
      question,
    });
    const chunksInPrompt = retrieved.chunks.slice(0, prompt.passages.length);
    // The same prompt, a different final instruction: three candidates for a person, not one reply.
    const messages = [...prompt.messages];
    const last = messages.pop()!;
    messages.push({
      role: 'user',
      content: `${last.content}\n\nA member of our team will reply to this themselves. Draft up to three short replies they could send, each under 60 words, in the visitor's language: one that answers from the passages if they cover it (cite its passage numbers in "sources"), one that asks the most useful clarifying question, one that acknowledges and reassures. Skip any that would not help.`,
    });

    let content: string;
    let provider: AiProviderKind | null = null;
    let model: string | null = null;
    let fellBack = false;
    let promptTokens = 0;
    let completionTokens = 0;
    try {
      const outcome = await this.options.gateway.complete(
        { messages, schema: SUGGESTIONS_SCHEMA, maxTokens: 400, temperature: 0.4 },
        { accountId: input.accountId },
      );
      content = outcome.result.content;
      provider = outcome.provider;
      model = outcome.result.model;
      fellBack = outcome.fellBack;
      promptTokens = outcome.result.promptTokens;
      completionTokens = outcome.result.completionTokens;
    } catch (error) {
      this.options.log?.('ai.suggest.failed', { conversationId: conversation.id, error: String(error) });
      return { suggestions: 0 };
    }
    const latencyMs = this.clock.timestamp() - started;
    const suggestions = parseSuggestions(content, {
      passageCount: chunksInPrompt.length,
      allowedHosts: allowedHosts(conversation.property),
      grounding: [
        ...chunksInPrompt.flatMap((chunk) => [chunk.title, chunk.heading ?? '', chunk.text, chunk.url ?? '']),
        question,
        settings.instructions,
      ],
      practicePhrases: [...PRACTICE_PHRASES],
    }).map((suggestion) => ({
      ...suggestion,
      sources: dedupeSources(suggestion.sources.map((n) => chunksInPrompt[n - 1]!).filter(Boolean)),
    }));

    const now = this.clock.now();
    await db.conversation.update({
      where: { id: conversation.id },
      data: { aiSuggestions: suggestions, aiSuggestedAt: now },
    });
    await db.aiTurn.create({
      data: {
        accountId: conversation.accountId,
        propertyId: conversation.propertyId,
        conversationId: conversation.id,
        visitorMessageId: message.id,
        replyMessageId: null,
        decision: 'draft',
        provider,
        model,
        fellBack,
        promptTokens,
        completionTokens,
        latencyMs,
        retrievedChunkIds: chunksInPrompt.map((chunk) => chunk.chunkId),
        citedChunkIds: [],
        error: suggestions.length === 0 ? 'no usable suggestions' : null,
      },
    });
    await this.options.events.publish({
      type: ServerEvent.CONVERSATION_UPDATED,
      accountId: conversation.accountId,
      propertyId: conversation.propertyId,
      conversationId: conversation.id,
      visitorId: conversation.visitorId,
      agentsOnly: true,
      payload: {
        conversationId: conversation.id,
        status: conversation.status,
        priority: conversation.priority,
        tags: conversation.tags,
        aiSuggestions: suggestions,
        aiSuggestedAt: now.toISOString(),
      },
    });
    return { suggestions: suggestions.length };
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
    body: string = settings.ticketOfferText,
  ): Promise<void> {
    await this.post(
      conversation,
      settings,
      visitorMessageId,
      body,
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
    history: Array<{ role: 'visitor' | 'assistant'; text: string }>,
    question: string,
    turn: TurnRecord,
  ): Promise<void> {
    const now = this.clock.now();
    const assignee = await this.pickOnlineAgent(conversation.accountId, conversation.propertyId);
    // A handover note the person reads before their first word: what was asked, what was said.
    await new ConversationRepository(this.options.db).insertMessage({
      accountId: conversation.accountId,
      propertyId: conversation.propertyId,
      conversationId: conversation.id,
      senderType: 'bot',
      type: 'note',
      body: handoverSummary(settings.assistantName, history, question),
      metadata: { source: 'ai', senderName: settings.assistantName, kind: 'handover' },
      now,
    });
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
          ...(settings.showAiBadge ? { badge: true } : {}),
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
  assignedMemberId: string | null;
  aiReplyCount: number;
  property: { name: string; websiteUrl: string; domains: Array<{ pattern: string }> };
}

interface TurnRecord {
  decision: 'answer' | 'chat' | 'ticket' | 'human' | 'failed';
  provider: AiProviderKind | null;
  model: string | null;
  fellBack: boolean;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  error: string | null;
}

/**
 * The note a person finds when the assistant hands them a chat: the visitor's questions so
 * far and the assistant's answers, then the message that led here. Built from the transcript,
 * not the model - instant, and never wrong about what was said.
 */
export function handoverSummary(
  assistantName: string,
  history: Array<{ role: 'visitor' | 'assistant'; text: string }>,
  question: string,
): string {
  const asked = history.filter((turn) => turn.role === 'visitor').map((turn) => turn.text.trim()).filter(Boolean);
  const answered = history.filter((turn) => turn.role === 'assistant').map((turn) => turn.text.trim()).filter(Boolean);
  const clip = (text: string, max = 160): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
  const lines = [`Handover from ${assistantName}.`];
  if (asked.length > 0) lines.push(`Asked so far: ${asked.slice(-3).map((q) => `"${clip(q)}"`).join(' · ')}`);
  if (answered.length > 0) lines.push(`Last answer given: "${clip(answered.at(-1)!, 220)}"`);
  lines.push(`Now: "${clip(question)}" - the visitor asked for a person.`);
  return lines.join('\n');
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
