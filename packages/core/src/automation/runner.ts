import type { Database } from '@smartchat/database';
import type { TriggerEventName } from '@smartchat/validation';
import { TriggerRepository, type ResolvedTrigger } from '../repositories/automation.repository.js';
import type { MessageDto } from '../realtime/events.js';
import type { ConversationService, VisitorIdentity } from '../services/conversation.service.js';
import { systemClock, type Clock } from '../time.js';
import { dedupeKeyFor, matchesConditions, type TriggerFacts } from './engine.js';

export interface TriggerRunResult {
  triggerId: string;
  triggerName: string;
  conversationId: string | null;
  /**
   * Present when the rule sent something.
   *
   * The caller hands this straight to the visitor's socket. It is the same DTO the fan-out
   * publishes, so a visitor who receives both sees one message: the panel keys on message id.
   */
  message: MessageDto | null;
}

export interface AutomationRunnerOptions {
  db: Database;
  conversations: ConversationService;
  clock?: Clock;
  /** Reported rather than thrown: one broken rule must not take a visitor's socket down. */
  onError?: (error: unknown, context: { triggerId: string }) => void;
}

/**
 * Runs rules for a live visitor.
 *
 * The order of operations matters and is the whole design:
 *
 *   1. read the enabled rules for this event
 *   2. evaluate conditions against the caller's snapshot
 *   3. *claim* the firing, by inserting a row a unique index guards
 *   4. only then do anything the visitor can see
 *
 * Claiming before acting is what makes "once per visitor" mean once. If the claim is taken, some
 * other socket - possibly on another gateway process - already fired this rule, and this one stops
 * without sending. If the actions then fail, the claim is released again, so a transient database
 * error does not silently consume a visitor's only greeting.
 */
export class AutomationRunner {
  private readonly clock: Clock;
  private readonly triggers: TriggerRepository;

  constructor(private readonly options: AutomationRunnerOptions) {
    this.clock = options.clock ?? systemClock;
    this.triggers = new TriggerRepository(options.db);
  }

  /** The rules that could fire for this visitor on this event, cheapest query first. */
  listCandidates(
    accountId: string,
    propertyId: string,
    event: TriggerEventName,
  ): Promise<ResolvedTrigger[]> {
    return this.triggers.listForEvent(accountId, propertyId, event);
  }

  /**
   * Evaluate one event.
   *
   * At most one rule fires per event. Two proactive messages arriving together read as a
   * malfunction to the person receiving them, so position decides and the first match wins.
   */
  async run(
    identity: VisitorIdentity,
    event: TriggerEventName,
    facts: TriggerFacts,
    options: { agentDisplayName?: string | null } = {},
  ): Promise<TriggerRunResult | null> {
    const candidates = await this.listCandidates(identity.accountId, identity.propertyId, event);

    for (const trigger of candidates) {
      if (!matchesConditions(trigger.match, trigger.conditions, facts)) continue;
      if (trigger.actions.length === 0) continue;

      try {
        const result = await this.fire(identity, trigger, options.agentDisplayName ?? null);
        if (result) return result;
      } catch (error) {
        this.options.onError?.(error, { triggerId: trigger.id });
      }
    }

    return null;
  }

  private async fire(
    identity: VisitorIdentity,
    trigger: ResolvedTrigger,
    agentDisplayName: string | null,
  ): Promise<TriggerRunResult | null> {
    const now = this.clock.now();

    // An uncapped rule is still not allowed to be a firehose. The cooldown is measured per
    // visitor, so a busy site does not silence a rule for everyone because one person tripped it.
    if (trigger.frequency === 'every_time' && trigger.cooldownSeconds > 0) {
      const last = await this.triggers.lastFiredAt(
        identity.accountId,
        trigger.id,
        identity.visitorId,
      );
      if (last && now.getTime() - last.getTime() < trigger.cooldownSeconds * 1000) return null;
    }

    const claim = await this.triggers.claimFiring({
      accountId: identity.accountId,
      triggerId: trigger.id,
      propertyId: identity.propertyId,
      visitorId: identity.visitorId,
      sessionId: identity.sessionId || null,
      dedupeKey: dedupeKeyFor(trigger.frequency, {
        visitorId: identity.visitorId,
        sessionId: identity.sessionId || null,
      }),
      firedAt: now,
    });
    // Already fired for this visitor or session. Not an error - the cap did its job.
    if (!claim) return null;

    try {
      const message = trigger.actions.find((action) => action.type === 'send_message');
      let conversationId: string | null = null;
      let delivered: MessageDto | null = null;

      if (message && message.type === 'send_message') {
        const sent = await this.options.conversations.sendBotMessage(identity, {
          body: message.body,
          senderName: agentDisplayName,
        });
        conversationId = sent.conversation.id;
        delivered = sent.message;
      } else {
        // No message to send, so the rule can only act on a conversation that already exists.
        const existing = await this.options.conversations.findVisitorConversation(identity);
        conversationId = existing?.id ?? null;
      }

      if (conversationId) {
        const patch: {
          addTag?: string;
          priority?: 'low' | 'normal' | 'high' | 'urgent';
          departmentId?: string;
        } = {};
        for (const action of trigger.actions) {
          if (action.type === 'add_tag') patch.addTag = action.tag;
          if (action.type === 'set_priority') patch.priority = action.priority;
          if (action.type === 'route_to_department') patch.departmentId = action.departmentId;
        }
        if (Object.keys(patch).length > 0) {
          await this.options.conversations.applyAutomation(identity, conversationId, patch);
        }
        await this.triggers.attachConversation(claim.id, conversationId);
      }

      await this.triggers.recordFired(identity.accountId, trigger.id, now);

      return {
        triggerId: trigger.id,
        triggerName: trigger.name,
        conversationId,
        message: delivered,
      };
    } catch (error) {
      // Give the claim back. A rule that failed to deliver has not been used up, and a visitor
      // should not lose their only greeting to a transient error.
      await this.triggers.deleteFiring(claim.id);
      throw error;
    }
  }
}
