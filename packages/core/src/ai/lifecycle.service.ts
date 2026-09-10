import type { AiSetting, Conversation, Database } from '@smartchat/database';
import { ServerEvent } from '@smartchat/types';
import type { EntitlementService } from '../billing/entitlements.js';
import { AiJob, type AiFollowupKind, type AiFollowupPayload } from '../queue/jobs.js';
import type { QueueProducer } from '../queue/producer.js';
import type { EventPublisher } from '../realtime/events.js';
import { ConversationRepository } from '../repositories/conversation.repository.js';
import { agentAvailabilityReader } from '../services/availability.js';
import { systemClock, type Clock } from '../time.js';
import { postBotMessage } from './bot-message.js';
import { decideAiReply } from './dispatch.js';

/**
 * The assistant's sense of time.
 *
 * A chat has a rhythm a good support person keeps without thinking: when the colleague you
 * handed a customer to has not turned up in a few minutes, you step back in; when the customer
 * has gone quiet, you check they are still there before you close; when they are gone, you say
 * goodbye and tidy up. This is that, as three delayed jobs:
 *
 *   handoff_wait  - the person the chat was handed to has not replied: the assistant takes it
 *                   back, says so, and offers a ticket or more help.
 *   idle_nudge    - the visitor has been silent after the assistant's last reply: "anything
 *                   else, or shall I close this?"
 *   idle_close    - still silent after the nudge: thanks, goodbye, closed.
 *
 * Every timer carries the conversation's `aiFollowupSeq` from the moment it was scheduled. The
 * counter moves whenever the conversation does - a visitor message, a person replying, a
 * takeover, a hand-back - so a timer whose number no longer matches finds the world has moved
 * on and does nothing. Conditions are re-checked when the timer fires as well; the counter is
 * the fast path, the checks are the truth.
 */

export interface LifecycleServiceOptions {
  db: Database;
  queue: QueueProducer;
  events: EventPublisher;
  entitlements: EntitlementService;
  clock?: Clock;
  log?: (event: string, detail: Record<string, unknown>) => void;
  /** How long a "minute" in the settings is. Tests shorten it; production leaves it alone. */
  minuteMs?: number;
}

export class LifecycleService {
  private readonly clock: Clock;
  private readonly hasAvailableAgent: (accountId: string) => Promise<boolean>;
  private readonly minute: number;

  constructor(private readonly options: LifecycleServiceOptions) {
    this.clock = options.clock ?? systemClock;
    this.hasAvailableAgent = agentAvailabilityReader(options.db);
    this.minute = options.minuteMs ?? 60_000;
  }

  // ---------------------------------------------------------------------------
  // Scheduling
  // ---------------------------------------------------------------------------

  /**
   * Arm one timer. The counter is bumped first, so anything scheduled earlier is stale from
   * this moment, and the new job carries the new value.
   */
  async schedule(
    conversation: { id: string; accountId: string },
    kind: AiFollowupKind,
    delayMs: number,
  ): Promise<void> {
    if (delayMs <= 0) return;
    const bumped = await this.options.db.conversation.update({
      where: { id: conversation.id },
      data: { aiFollowupSeq: { increment: 1 } },
      select: { aiFollowupSeq: true },
    });
    const payload: AiFollowupPayload = {
      accountId: conversation.accountId,
      conversationId: conversation.id,
      kind,
      seq: bumped.aiFollowupSeq,
    };
    await this.options.queue.enqueue(AiJob.FOLLOWUP, payload, {
      delay: delayMs,
      jobId: `followup-${conversation.id}-${bumped.aiFollowupSeq}`,
      attempts: 1,
    });
  }

  /** After the assistant replied: if the visitor goes quiet, ask before closing. */
  async afterAssistantReply(conversation: { id: string; accountId: string }, settings: AiSetting): Promise<void> {
    if (settings.idleNudgeMinutes <= 0) return;
    await this.schedule(conversation, 'idle_nudge', settings.idleNudgeMinutes * this.minute);
  }

  /** After a handoff to a person: if they do not turn up, take the chat back. */
  async afterHandoff(conversation: { id: string; accountId: string }, settings: AiSetting): Promise<void> {
    if (settings.handoffWaitMinutes <= 0) return;
    await this.schedule(conversation, 'handoff_wait', settings.handoffWaitMinutes * this.minute);
  }

  /** The visitor said goodbye: a short grace, then close - "oh, one more thing" is common. */
  async afterGoodbye(conversation: { id: string; accountId: string }): Promise<void> {
    await this.options.db.conversation.update({
      where: { id: conversation.id },
      data: { aiIdleNudgedAt: this.clock.now() },
    });
    await this.schedule(conversation, 'idle_close', this.minute);
  }

  // ---------------------------------------------------------------------------
  // Firing
  // ---------------------------------------------------------------------------

  async run(payload: AiFollowupPayload): Promise<{ acted: boolean; reason: string }> {
    const { db } = this.options;
    const conversation = await db.conversation.findFirst({
      where: { accountId: payload.accountId, id: payload.conversationId, deletedAt: null },
    });
    if (!conversation) return { acted: false, reason: 'missing' };
    if (conversation.aiFollowupSeq !== payload.seq) return { acted: false, reason: 'stale' };
    if (conversation.status === 'closed') return { acted: false, reason: 'closed' };
    const settings = await db.aiSetting.findUnique({
      where: { accountId_propertyId: { accountId: conversation.accountId, propertyId: conversation.propertyId } },
    });
    if (!settings || settings.mode === 'team') return { acted: false, reason: 'mode_team' };

    switch (payload.kind) {
      case 'handoff_wait':
        return this.takeBack(conversation, settings);
      case 'idle_nudge':
        return this.nudge(conversation, settings);
      case 'idle_close':
        return this.close(conversation, settings);
      default:
        return { acted: false, reason: 'unknown' };
    }
  }

  /**
   * Nobody came. The assignment is cleared, the pause lifted, and the visitor told - in the
   * owner's words - that the assistant is back and what it can do. Only when the person really
   * has not written anything since the handoff; one reply from them and the chat is theirs.
   */
  private async takeBack(conversation: Conversation, settings: AiSetting): Promise<{ acted: boolean; reason: string }> {
    if (!conversation.aiHandoffAt) return { acted: false, reason: 'no_handoff' };
    const replied = await this.options.db.message.findFirst({
      where: { conversationId: conversation.id, senderType: 'agent', deletedAt: null, createdAt: { gt: conversation.aiHandoffAt } },
      select: { id: true },
    });
    if (replied) return { acted: false, reason: 'person_replied' };
    const planIncludesAi = await this.options.entitlements.hasFeature(conversation.accountId, 'aiAgent');
    if (!planIncludesAi) return { acted: false, reason: 'plan' };

    const now = this.clock.now();
    const previousAssignee = conversation.assignedMemberId;
    await this.options.db.conversation.update({
      where: { id: conversation.id },
      data: { assignedMemberId: null, aiPausedAt: null },
    });
    await postBotMessage(this.options.db, this.options.events, {
      conversation,
      assistantName: settings.assistantName,
      body: settings.handoffBackText,
      metadata: { kind: 'handoff_back', offer: 'ticket', ...(settings.showAiBadge ? { badge: true } : {}) },
      now,
    });
    await this.publishState(conversation, { assignedMemberId: null, aiPausedAt: null, aiTakenBackAt: now.toISOString() });
    if (previousAssignee) {
      await this.options.events.publish({
        type: ServerEvent.CONVERSATION_ASSIGNED,
        accountId: conversation.accountId,
        propertyId: conversation.propertyId,
        conversationId: conversation.id,
        agentsOnly: true,
        payload: { conversationId: conversation.id, assignedMemberId: null, by: 'ai', reason: 'no_reply' },
      });
    }
    this.options.log?.('ai.lifecycle.took_back', { conversationId: conversation.id, previousAssignee });
    // The visitor may not answer this either.
    await this.afterAssistantReply(conversation, settings);
    return { acted: true, reason: 'took_back' };
  }

  /** The assistant is the one talking, and the visitor has gone quiet since its last reply. */
  private async nudge(conversation: Conversation, settings: AiSetting): Promise<{ acted: boolean; reason: string }> {
    const active = await this.assistantIsActive(conversation, settings);
    if (!active.ok) return { acted: false, reason: active.reason };
    if (settings.idleNudgeMinutes <= 0) return { acted: false, reason: 'disabled' };
    const quietSince = conversation.lastVisitorMessageAt ?? conversation.startedAt;
    if (this.clock.timestamp() - quietSince.getTime() < settings.idleNudgeMinutes * this.minute - 1_000) {
      return { acted: false, reason: 'not_quiet_yet' };
    }
    const now = this.clock.now();
    await this.options.db.conversation.update({ where: { id: conversation.id }, data: { aiIdleNudgedAt: now } });
    await postBotMessage(this.options.db, this.options.events, {
      conversation,
      assistantName: settings.assistantName,
      body: settings.idleNudgeText,
      metadata: { kind: 'idle_nudge', ...(settings.showAiBadge ? { badge: true } : {}) },
      now,
    });
    if (settings.idleCloseMinutes > 0) {
      await this.schedule(conversation, 'idle_close', settings.idleCloseMinutes * this.minute);
    }
    return { acted: true, reason: 'nudged' };
  }

  /** Still nothing after the nudge (or a goodbye): thanks, and the chat is closed. */
  private async close(conversation: Conversation, settings: AiSetting): Promise<{ acted: boolean; reason: string }> {
    const active = await this.assistantIsActive(conversation, settings);
    if (!active.ok) return { acted: false, reason: active.reason };
    if (!conversation.aiIdleNudgedAt) return { acted: false, reason: 'not_nudged' };
    if (conversation.lastVisitorMessageAt && conversation.lastVisitorMessageAt > conversation.aiIdleNudgedAt) {
      return { acted: false, reason: 'visitor_replied' };
    }
    const now = this.clock.now();
    await postBotMessage(this.options.db, this.options.events, {
      conversation,
      assistantName: settings.assistantName,
      body: settings.idleCloseText,
      metadata: { kind: 'idle_close', ...(settings.showAiBadge ? { badge: true } : {}) },
      now,
    });
    const updated = await this.options.db.conversation.update({
      where: { id: conversation.id },
      data: { status: 'closed', closedAt: now, closedByMemberId: null, aiIdleNudgedAt: null },
    });
    await new ConversationRepository(this.options.db).insertMessage({
      accountId: conversation.accountId,
      propertyId: conversation.propertyId,
      conversationId: conversation.id,
      senderType: 'system',
      type: 'system',
      body: `${settings.assistantName} ended this chat after the visitor went quiet.`,
      metadata: { kind: 'conversation.closed', by: 'ai' },
      now,
    });
    await this.options.events.publish({
      type: ServerEvent.CONVERSATION_CLOSED,
      accountId: conversation.accountId,
      propertyId: conversation.propertyId,
      conversationId: conversation.id,
      visitorId: conversation.visitorId,
      payload: { conversationId: conversation.id, status: updated.status, closedBy: 'ai' },
    });
    this.options.log?.('ai.lifecycle.closed', { conversationId: conversation.id });
    return { acted: true, reason: 'closed' };
  }

  /** Would the assistant answer the visitor's next message? Then it is the one keeping time. */
  private async assistantIsActive(conversation: Conversation, settings: AiSetting): Promise<{ ok: true } | { ok: false; reason: string }> {
    const [planIncludesAi, agentsOnline] = await Promise.all([
      this.options.entitlements.hasFeature(conversation.accountId, 'aiAgent'),
      this.hasAvailableAgent(conversation.accountId),
    ]);
    const decision = decideAiReply({ settings, planIncludesAi, agentsOnline, conversation });
    if (!decision.reply) return { ok: false, reason: decision.reason };
    return { ok: true };
  }

  private async publishState(conversation: Conversation, extra: Record<string, unknown>): Promise<void> {
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
        ...extra,
      },
    });
  }
}
