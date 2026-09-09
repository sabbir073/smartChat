import type { Database, Plan, Subscription } from '@smartchat/database';
import { AppError, ErrorCode } from '@smartchat/types';
import { systemClock, type Clock } from '../time.js';
import { evaluateLock, lockMessage, type LockVerdict } from './lock.js';

/**
 * What an account is allowed to do, in one place.
 *
 * Every limit and every feature gate reads from here, and nothing else reads the plan row
 * directly. That is what makes "upgrade to add more" true everywhere at once, and what stops a
 * gate being enforced on the API and forgotten on the socket.
 *
 * The plan and subscription are cached for thirty seconds per account: a plan change is not a
 * hot path, and thirty seconds of stale "you may add a website" is harmless. The usage counts
 * are not cached: they decide the over-limit lock, and an account that has just deleted a
 * website to get back under its limit must see the lock lift on its very next request, not
 * half a minute later. Two indexed counts per write is what that costs.
 */

export interface Entitlements {
  plan: Pick<
    Plan,
    | 'id'
    | 'key'
    | 'name'
    | 'maxProperties'
    | 'maxMembers'
    | 'aiAgent'
    | 'aiRepliesPerMonth'
    | 'integrations'
    | 'removeBranding'
    | 'aiOwnKey'
    | 'isContactSales'
  >;
  subscription: Pick<
    Subscription,
    | 'status'
    | 'interval'
    | 'provider'
    | 'currentPeriodEnd'
    | 'cancelAtPeriodEnd'
    | 'pastDueSince'
    | 'lockedAt'
  >;
  /** Live counts against the plan, so a page can show "3 of 5" and the lock can see excess. */
  usage: { properties: number; members: number };
  lock: LockVerdict;
}

export type PlanFeature = 'aiAgent' | 'integrations' | 'removeBranding' | 'aiOwnKey';

export interface EntitlementServiceOptions {
  db: Database;
  graceDays: () => Promise<number>;
  clock?: Clock;
  cacheTtlMs?: number;
}

export class EntitlementService {
  private readonly clock: Clock;
  private readonly ttlMs: number;
  private readonly cache = new Map<
    string,
    { at: number; value: Omit<Entitlements, 'usage' | 'lock'> & { graceDays: number } }
  >();

  constructor(private readonly options: EntitlementServiceOptions) {
    this.clock = options.clock ?? systemClock;
    this.ttlMs = options.cacheTtlMs ?? 30_000;
  }

  async forAccount(accountId: string): Promise<Entitlements> {
    const now = this.clock.now();
    const cached = this.cache.get(accountId);
    const base =
      cached && now.getTime() - cached.at < this.ttlMs ? cached.value : await this.load(accountId, now);
    const usage = await this.usage(accountId);
    return this.assemble(base, usage, now);
  }

  private async load(
    accountId: string,
    now: Date,
  ): Promise<Omit<Entitlements, 'usage' | 'lock'> & { graceDays: number }> {
    const subscription = await this.options.db.subscription.findUnique({
      where: { accountId },
      include: { plan: true },
    });

    // Every account has a subscription row from the moment it exists (created with the account,
    // backfilled by migration for the ones before). One missing is a bug, and it is treated as
    // the most restrictive thing that is not a lock, so the bug is visible without locking
    // somebody out over it.
    if (!subscription) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, undefined, {
        context: { accountId, reason: 'account has no subscription row' },
      });
    }

    const graceDays = await this.options.graceDays();
    const value = { plan: subscription.plan, subscription, graceDays };
    this.cache.set(accountId, { at: now.getTime(), value });
    return value;
  }

  private assemble(
    base: Omit<Entitlements, 'usage' | 'lock'> & { graceDays: number },
    usage: Entitlements['usage'],
    now: Date,
  ): Entitlements {
    const { plan, subscription, graceDays } = base;
    const verdict = evaluateLock(subscription, graceDays, now);
    const overLimit =
      (plan.maxProperties !== null && usage.properties > plan.maxProperties) ||
      (plan.maxMembers !== null && usage.members > plan.maxMembers);
    return {
      plan,
      subscription,
      usage,
      lock:
        !verdict.locked && overLimit
          ? { locked: true, reason: 'over_limit', graceEndsAt: null }
          : verdict,
    };
  }

  /** After a plan change or a webhook, so the next request sees it. */
  invalidate(accountId: string): void {
    this.cache.delete(accountId);
  }

  async assertNotLocked(accountId: string): Promise<void> {
    const { lock } = await this.forAccount(accountId);
    if (lock.locked && lock.reason) {
      throw new AppError(ErrorCode.BILLING_LOCKED, lockMessage(lock.reason), {
        context: { reason: lock.reason },
      });
    }
  }

  async assertFeature(accountId: string, feature: PlanFeature): Promise<void> {
    const { plan } = await this.forAccount(accountId);
    if (!plan[feature]) {
      throw new AppError(ErrorCode.FEATURE_NOT_IN_PLAN, featureMessage(feature, plan.name), {
        context: { feature, plan: plan.key },
      });
    }
  }

  async hasFeature(accountId: string, feature: PlanFeature): Promise<boolean> {
    const { plan } = await this.forAccount(accountId);
    return plan[feature];
  }

  /**
   * May one more website be added? Counted at the moment of asking, against the live rows.
   *
   * Deleted properties do not count; a customer who removed a site has the seat back.
   */
  async assertCanAddProperty(accountId: string): Promise<void> {
    const { plan } = await this.forAccount(accountId);
    if (plan.maxProperties === null) return;
    const used = await this.options.db.property.count({
      where: { accountId, deletedAt: null },
    });
    if (used >= plan.maxProperties) {
      throw new AppError(
        ErrorCode.PLAN_LIMIT_REACHED,
        `Your ${plan.name} plan includes ${plural(plan.maxProperties, 'website')}. Upgrade to add another.`,
        { context: { limit: plan.maxProperties, used, resource: 'properties' } },
      );
    }
  }

  /**
   * May one more person be invited? Invitations count as seats from the moment they are sent -
   * an invitation that cannot be accepted is worse than one that was never sent.
   */
  async assertCanInviteMember(accountId: string): Promise<void> {
    const { plan } = await this.forAccount(accountId);
    if (plan.maxMembers === null) return;
    const used = await this.options.db.accountMember.count({
      where: { accountId, deletedAt: null, status: { in: ['active', 'invited'] } },
    });
    if (used >= plan.maxMembers) {
      throw new AppError(
        ErrorCode.PLAN_LIMIT_REACHED,
        `Your ${plan.name} plan includes ${plural(plan.maxMembers, 'team member')}. Upgrade to invite more.`,
        { context: { limit: plan.maxMembers, used, resource: 'members' } },
      );
    }
  }

  /**
   * May the AI answer one more message this month?
   *
   * The count is live, like the others: a cap that is reached must stop the very next reply, and
   * the reply that finds it reached posts the ticket offer instead of nothing. A `failed` turn
   * counts too - it cost a model call - but the count is of turns, not of visitor messages.
   */
  async aiReplyAllowance(
    accountId: string,
  ): Promise<{ allowed: boolean; used: number; limit: number | null }> {
    const { plan } = await this.forAccount(accountId);
    if (!plan.aiAgent) return { allowed: false, used: 0, limit: 0 };
    if (plan.aiRepliesPerMonth === null) return { allowed: true, used: 0, limit: null };
    const used = await this.options.db.aiTurn.count({
      where: { accountId, createdAt: { gte: startOfMonth(this.clock.now()) } },
    });
    return { allowed: used < plan.aiRepliesPerMonth, used, limit: plan.aiRepliesPerMonth };
  }

  /** The numbers a billing page shows next to the limits. */
  async usage(accountId: string): Promise<{ properties: number; members: number }> {
    const [properties, members] = await Promise.all([
      this.options.db.property.count({ where: { accountId, deletedAt: null } }),
      this.options.db.accountMember.count({
        where: { accountId, deletedAt: null, status: { in: ['active', 'invited'] } },
      }),
    ]);
    return { properties, members };
  }
}

/** Calendar months in UTC. A plan month and a billing month are not the same thing, and this
 * one is the plain one that needs no time zone to explain. */
export function startOfMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function featureMessage(feature: PlanFeature, planName: string): string {
  switch (feature) {
    case 'aiAgent':
      return `The AI agent is not included in the ${planName} plan.`;
    case 'integrations':
      return `API keys and webhooks are not included in the ${planName} plan.`;
    case 'removeBranding':
      return `Removing the widget branding is not included in the ${planName} plan.`;
    case 'aiOwnKey':
      return `Using your own AI provider key is not included in the ${planName} plan.`;
  }
}
