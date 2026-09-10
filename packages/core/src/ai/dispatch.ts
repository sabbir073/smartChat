import type { AiSetting, Database } from '@smartchat/database';
import type { EntitlementService } from '../billing/entitlements.js';
import type { QueueProducer } from '../queue/producer.js';
import { AiJob } from '../queue/jobs.js';
import { agentAvailabilityReader } from '../services/availability.js';
import { systemClock, type Clock } from '../time.js';

/**
 * Whether the AI speaks, decided once and used twice.
 *
 * The realtime server asks after every visitor message, to decide whether to queue a reply. The
 * worker asks again before it posts one, because seconds have passed and a person may have taken
 * the conversation in between. Both call `decideAiReply` with the same facts, so the two cannot
 * disagree about the rules - only about the moment.
 */

export interface AiDispatchFacts {
  settings: Pick<AiSetting, 'mode' | 'maxRepliesPerConversation'> | null;
  planIncludesAi: boolean;
  agentsOnline: boolean;
  conversation: {
    status: 'open' | 'pending' | 'closed';
    channel: string;
    assignedMemberId: string | null;
    aiPausedAt: Date | null;
    aiReplyCount: number;
  };
}

export type AiDispatchDecision =
  | { reply: true }
  | { reply: false; reason: AiSkipReason };

export type AiSkipReason =
  | 'mode_team'
  | 'plan'
  | 'closed'
  | 'not_widget'
  | 'assigned'
  | 'paused'
  | 'agents_online'
  | 'reply_limit';

export function decideAiReply(facts: AiDispatchFacts): AiDispatchDecision {
  const { settings, conversation } = facts;
  if (!settings || settings.mode === 'team') return { reply: false, reason: 'mode_team' };
  if (!facts.planIncludesAi) return { reply: false, reason: 'plan' };
  if (conversation.status === 'closed') return { reply: false, reason: 'closed' };
  // Offline-form conversations are tickets in the making; email and API ones have no widget to
  // answer into.
  if (conversation.channel !== 'widget') return { reply: false, reason: 'not_widget' };
  if (conversation.aiPausedAt) return { reply: false, reason: 'paused' };
  if (conversation.assignedMemberId) return { reply: false, reason: 'assigned' };
  if (settings.mode === 'ai_when_offline' && facts.agentsOnline) {
    return { reply: false, reason: 'agents_online' };
  }
  if (conversation.aiReplyCount >= settings.maxRepliesPerConversation) {
    return { reply: false, reason: 'reply_limit' };
  }
  return { reply: true };
}

/**
 * When the assistant will not answer, should it draft replies for the person who will?
 *
 * On the first visitor message of a chat a person handles (the team mode, a takeover, a pause,
 * the team being online), and only once per chat - after that the Suggest button is theirs.
 * Asked by the realtime server when it decides not to queue a reply, and again by the worker
 * when a queued reply turns out to be unwanted, so a settings change the realtime cache has not
 * seen yet still ends in suggestions rather than silence.
 */
export function shouldSuggestReplies(facts: {
  settings: Pick<AiSetting, 'suggestReplies'> | null;
  planIncludesAi: boolean;
  conversation: { status: string; channel: string; aiSuggestedAt: Date | null };
}): boolean {
  return (
    facts.planIncludesAi &&
    !!facts.settings?.suggestReplies &&
    facts.conversation.status !== 'closed' &&
    facts.conversation.channel === 'widget' &&
    !facts.conversation.aiSuggestedAt
  );
}

export interface AiDispatchServiceOptions {
  db: Database;
  entitlements: EntitlementService;
  queue: QueueProducer;
  clock?: Clock;
  /** Settings are read on every visitor message; a short cache keeps that off the database. */
  settingsCacheMs?: number;
  onError?: (error: unknown, meta: Record<string, unknown>) => void;
}

/**
 * The realtime side: after a visitor message is stored, queue a reply if the rules say so.
 *
 * Never throws. A failure here is logged and the message stands unanswered by the AI, which is
 * what would have happened before the feature existed; it must not cost the visitor their
 * message or their socket.
 */
export class AiDispatchService {
  private readonly clock: Clock;
  private readonly cacheMs: number;
  private readonly hasAvailableAgent: (accountId: string) => Promise<boolean>;
  private readonly settingsCache = new Map<string, { at: number; value: AiSetting | null }>();

  constructor(private readonly options: AiDispatchServiceOptions) {
    this.clock = options.clock ?? systemClock;
    this.cacheMs = options.settingsCacheMs ?? 10_000;
    this.hasAvailableAgent = agentAvailabilityReader(options.db);
  }

  async settingsFor(accountId: string, propertyId: string): Promise<AiSetting | null> {
    const key = `${accountId}:${propertyId}`;
    const cached = this.settingsCache.get(key);
    const now = this.clock.timestamp();
    if (cached && now - cached.at < this.cacheMs) return cached.value;
    const value = await this.options.db.aiSetting.findUnique({
      where: { accountId_propertyId: { accountId, propertyId } },
    });
    this.settingsCache.set(key, { at: now, value });
    return value;
  }

  invalidate(accountId: string, propertyId: string): void {
    this.settingsCache.delete(`${accountId}:${propertyId}`);
  }

  async onVisitorMessage(input: {
    accountId: string;
    propertyId: string;
    conversationId: string;
    messageId: string;
    requestId?: string;
  }): Promise<AiDispatchDecision | null> {
    try {
      const settings = await this.settingsFor(input.accountId, input.propertyId);
      if (!settings) return { reply: false, reason: 'mode_team' };

      const [planIncludesAi, agentsOnline, conversation] = await Promise.all([
        this.options.entitlements.hasFeature(input.accountId, 'aiAgent'),
        this.hasAvailableAgent(input.accountId),
        this.options.db.conversation.findFirst({
          where: { accountId: input.accountId, id: input.conversationId, deletedAt: null },
          select: {
            status: true,
            channel: true,
            assignedMemberId: true,
            aiPausedAt: true,
            aiReplyCount: true,
            aiSuggestedAt: true,
          },
        }),
      ]);
      if (!conversation) return null;

      const decision = settings.mode === 'team' ? { reply: false as const, reason: 'mode_team' as const } : decideAiReply({ settings, planIncludesAi, agentsOnline, conversation });
      if (!decision.reply) {
        if (shouldSuggestReplies({ settings, planIncludesAi, conversation })) {
          await this.options.queue.enqueue(
            AiJob.SUGGEST,
            { accountId: input.accountId, conversationId: input.conversationId, messageId: input.messageId },
            { attempts: 1, jobId: `ai-suggest-${input.conversationId}` },
          );
        }
        return decision;
      }

      await this.options.queue.enqueue(
        AiJob.REPLY,
        {
          accountId: input.accountId,
          propertyId: input.propertyId,
          conversationId: input.conversationId,
          messageId: input.messageId,
          ...(input.requestId ? { requestId: input.requestId } : {}),
        },
        // One attempt: the reply is answered from the passages as they are now, and a retry five
        // seconds later would answer a question the visitor may have moved past. A failure is
        // recorded as a `failed` turn by the worker, not retried.
        { attempts: 1, jobId: `ai-reply-${input.messageId}` },
      );
      return decision;
    } catch (error) {
      this.options.onError?.(error, { conversationId: input.conversationId, messageId: input.messageId });
      return null;
    }
  }
}
