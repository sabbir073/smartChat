import type {
  BillingInterval,
  Database,
  Invoice,
  PlanChangeRequest,
  Subscription,
} from '@smartchat/database';
import { ActorType as DbActorType } from '@smartchat/database';
import {
  AppError,
  ErrorCode,
  FeatureKey,
  Permission,
  type FeatureKey as FeatureKeyType,
  type TenantContext,
} from '@smartchat/types';
import { defaultPlan, ensureSubscription } from '../billing/bootstrap.js';
import { periodEnd, priceForInterval } from '../billing/periods.js';
import type { BillingProvider } from '../billing/provider.js';
import { AuditRepository } from '../repositories/audit.repository.js';
import { requirePermission } from '../tenancy/context.js';
import { DAY, systemClock, type Clock } from '../time.js';
import type { EntitlementService } from './entitlement.service.js';

/** How long an unpaid subscription keeps working before it is paused. */
export const GRACE_DAYS = 14;

export interface UsageLine {
  key: FeatureKeyType;
  used: number;
  limit: number | null;
  /** True when `used` is already past `limit` - which a downgrade can cause without any new writes. */
  over: boolean;
}

export interface SubscriptionOverview {
  plan: { id: string; code: string; name: string; tagline: string | null };
  status: Subscription['status'];
  interval: BillingInterval;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  trialEndsAt: Date | null;
  graceEndsAt: Date | null;
  cancelAtPeriodEnd: boolean;
  amountCents: number;
  currency: string;
  /** What the account is allowed to do right now, and what it is actually using. */
  usage: UsageLine[];
  features: Record<string, boolean>;
  pendingChange:
    | (Pick<PlanChangeRequest, 'id' | 'status' | 'interval' | 'createdAt'> & {
        toPlanName: string;
        fromPlanName: string;
        /** A downgrade is dated, not waiting on anybody. An upgrade waits for an operator. */
        kind: 'scheduled_downgrade' | 'upgrade_request';
        /** When a scheduled downgrade lands. Null for a request nobody has decided yet. */
        effectiveAt: Date | null;
      })
    | null;
  /** True when service is reduced: read-only, nothing deleted. */
  isPaused: boolean;
  canSelfServe: boolean;
}

export interface SubscriptionServiceOptions {
  db: Database;
  provider: BillingProvider;
  entitlements: EntitlementService;
  clock?: Clock;
  /** Fired when something a customer should hear about happens. Optional so tests can omit it. */
  notify?: (event: BillingEvent) => Promise<void>;
}

export type BillingEvent =
  | { type: 'change_requested'; accountId: string; toPlanName: string; requestId: string }
  | { type: 'change_approved'; accountId: string; toPlanName: string }
  | { type: 'change_rejected'; accountId: string; toPlanName: string; note: string | null }
  | { type: 'invoice_issued'; accountId: string; invoiceId: string }
  | { type: 'trial_ending'; accountId: string; endsAt: Date }
  | { type: 'subscription_paused'; accountId: string };

/**
 * Subscriptions, from the customer's side.
 *
 * The service owns three things the billing provider deliberately does not: what an account is
 * *using* against its plan, what happens when that stops fitting, and the audit trail.
 *
 * The rule for not fitting is "pause, never destroy" (ADR-088). A subscription that lapses, or a
 * downgrade that leaves an account over a limit, never deletes anything and never silently drops a
 * customer's data. It stops *new* work: no new websites, no new agents, no new conversations on
 * the websites outside the allowance. Everything already there stays readable, exportable and
 * intact, and paying again restores it whole.
 */
export class SubscriptionService {
  private readonly clock: Clock;
  private readonly audit: AuditRepository;

  constructor(private readonly options: SubscriptionServiceOptions) {
    this.clock = options.clock ?? systemClock;
    this.audit = new AuditRepository(options.db);
  }

  // ---------------------------------------------------------------------------
  // Reading
  // ---------------------------------------------------------------------------

  async overview(context: TenantContext): Promise<SubscriptionOverview> {
    requirePermission(context, Permission.ACCOUNT_VIEW);
    return this.overviewFor(context.accountId);
  }

  async overviewFor(accountId: string): Promise<SubscriptionOverview> {
    // Self-healing rather than a 404: an account that somehow has no subscription is an account
    // whose billing screen would be permanently broken, and the fix is one row.
    await ensureSubscription(this.options.db, accountId, this.clock.now());

    const subscription = await this.options.db.subscription.findUnique({
      where: { accountId },
      include: { plan: true },
    });
    if (!subscription) throw new AppError(ErrorCode.NOT_FOUND);

    const [usage, entitlements, pending] = await Promise.all([
      this.usage(accountId),
      this.options.entitlements.forAccount(accountId),
      this.options.db.planChangeRequest.findFirst({
        where: { accountId, status: 'pending' },
        include: { toPlan: true, fromPlan: true },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return {
      plan: {
        id: subscription.plan.id,
        code: subscription.plan.code,
        name: subscription.plan.name,
        tagline: subscription.plan.tagline,
      },
      status: subscription.status,
      interval: subscription.interval,
      currentPeriodStart: subscription.currentPeriodStart,
      currentPeriodEnd: subscription.currentPeriodEnd,
      trialEndsAt: subscription.trialEndsAt,
      graceEndsAt: subscription.graceEndsAt,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      amountCents: priceForInterval(subscription.plan, subscription.interval),
      currency: subscription.plan.currency,
      usage,
      features: entitlements.features,
      pendingChange: pending
        ? {
            id: pending.id,
            status: pending.status,
            interval: pending.interval,
            createdAt: pending.createdAt,
            toPlanName: pending.toPlan.name,
            fromPlanName: pending.fromPlan.name,
            ...(priceForInterval(pending.toPlan, pending.interval) <
            priceForInterval(pending.fromPlan, pending.interval)
              ? {
                  kind: 'scheduled_downgrade' as const,
                  effectiveAt: subscription.currentPeriodEnd,
                }
              : { kind: 'upgrade_request' as const, effectiveAt: null }),
          }
        : null,
      isPaused: subscription.status === 'paused',
      canSelfServe: this.options.provider.canSelfServe(),
    };
  }

  /**
   * What the account is actually using, per limit.
   *
   * Counted live rather than read from a cached total. These numbers decide whether somebody is
   * told they are over their plan, and a stale count there is worse than a slow page.
   */
  async usage(accountId: string): Promise<UsageLine[]> {
    const entitlements = await this.options.entitlements.forAccount(accountId);
    const periodStart = this.monthStart();

    const [
      properties,
      agents,
      conversations,
      storage,
      articles,
      webhooks,
      triggers,
      shortcuts,
    ] = await Promise.all([
      this.options.db.property.count({ where: { accountId, deletedAt: null } }),
      this.options.db.accountMember.count({ where: { accountId, deletedAt: null } }),
      this.options.db.conversation.count({
        where: { accountId, startedAt: { gte: periodStart } },
      }),
      this.options.db.attachment.aggregate({
        where: { accountId, status: 'ready' },
        _sum: { byteSize: true },
      }),
      this.options.db.kbArticle.count({ where: { accountId, deletedAt: null } }),
      this.options.db.webhook.count({ where: { accountId, deletedAt: null } }),
      this.options.db.trigger.count({ where: { accountId, deletedAt: null } }),
      this.options.db.shortcut.count({ where: { accountId, deletedAt: null } }),
    ]);

    const counts: Record<string, number> = {
      [FeatureKey.MAX_PROPERTIES]: properties,
      [FeatureKey.MAX_AGENTS]: agents,
      [FeatureKey.MAX_MONTHLY_CONVERSATIONS]: conversations,
      [FeatureKey.MAX_STORAGE_BYTES]: Number(storage._sum.byteSize ?? 0),
      [FeatureKey.MAX_KB_ARTICLES]: articles,
      [FeatureKey.MAX_WEBHOOKS]: webhooks,
      [FeatureKey.MAX_TRIGGERS]: triggers,
      [FeatureKey.MAX_SHORTCUTS]: shortcuts,
    };

    return Object.entries(counts).map(([key, used]) => {
      const limit = key in entitlements.limits ? (entitlements.limits[key] ?? null) : null;
      return {
        key: key as FeatureKeyType,
        used,
        limit,
        over: limit !== null && used > limit,
      };
    });
  }

  async invoices(context: TenantContext, limit = 24): Promise<Invoice[]> {
    requirePermission(context, Permission.ACCOUNT_VIEW);
    return this.options.db.invoice.findMany({
      where: { accountId: context.accountId },
      orderBy: { issuedAt: 'desc' },
      take: limit,
    });
  }


  // ---------------------------------------------------------------------------
  // Changing
  // ---------------------------------------------------------------------------

  async requestChange(
    context: TenantContext,
    input: { planCode: string; interval: BillingInterval },
  ): Promise<{
    status: 'applied' | 'scheduled' | 'pending';
    requestId?: string;
    effectiveAt?: string;
  }> {
    // Billing is its own permission for a reason: an admin who runs the team should not be able to
    // put the company on a more expensive plan.
    requirePermission(context, Permission.ACCOUNT_BILLING);

    const [subscription, toPlan] = await Promise.all([
      this.options.db.subscription.findUnique({
        where: { accountId: context.accountId },
        include: { plan: true },
      }),
      this.options.db.plan.findUnique({ where: { code: input.planCode } }),
    ]);
    if (!subscription) throw new AppError(ErrorCode.NOT_FOUND);
    if (!toPlan || !toPlan.isPublic) {
      throw new AppError(ErrorCode.NOT_FOUND, 'No such plan.');
    }

    const outcome = await this.options.provider.requestChange({
      accountId: context.accountId,
      fromPlan: subscription.plan,
      fromInterval: subscription.interval,
      toPlan,
      interval: input.interval,
      requestedByUserId: context.userId ?? null,
      requestedByEmail: null,
    });

    await this.audit.record({
      accountId: context.accountId,
      actorType: DbActorType.user,
      actorId: context.userId,
      action: 'subscription.change_requested',
      resourceType: 'subscription',
      resourceId: subscription.id,
      metadata: {
        from: subscription.plan.code,
        to: toPlan.code,
        interval: input.interval,
        outcome: outcome.kind,
      },
    });

    if (outcome.kind === 'applied') {
      this.options.entitlements.invalidate(context.accountId);
      return { status: 'applied' };
    }

    const requestId = outcome.changeRequestId;
    await this.options.notify?.({
      type: 'change_requested',
      accountId: context.accountId,
      toPlanName: toPlan.name,
      requestId,
    });

    // A scheduled downgrade is already agreed - nobody has to approve it, so the customer is told
    // the date rather than "waiting on us", which would be untrue and would invite a chase.
    if (outcome.kind === 'scheduled') {
      return {
        status: 'scheduled',
        requestId,
        effectiveAt: outcome.effectiveAt.toISOString(),
      };
    }

    return { status: 'pending', requestId };
  }

  async withdrawChange(context: TenantContext, requestId: string): Promise<void> {
    requirePermission(context, Permission.ACCOUNT_BILLING);
    const request = await this.options.db.planChangeRequest.findFirst({
      where: { id: requestId, accountId: context.accountId },
    });
    if (!request) throw new AppError(ErrorCode.NOT_FOUND);
    if (request.status !== 'pending') {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'That request has already been decided.');
    }

    await this.options.db.planChangeRequest.update({
      where: { id: request.id },
      data: { status: 'withdrawn', decidedAt: this.clock.now() },
    });
  }

  async cancel(context: TenantContext, immediately = false): Promise<void> {
    requirePermission(context, Permission.ACCOUNT_BILLING);
    await this.options.provider.cancel({ accountId: context.accountId, immediately });
    this.options.entitlements.invalidate(context.accountId);

    await this.audit.record({
      accountId: context.accountId,
      actorType: DbActorType.user,
      actorId: context.userId,
      action: 'subscription.cancelled',
      resourceType: 'subscription',
      resourceId: null,
      metadata: { immediately },
    });
  }

  async resume(context: TenantContext): Promise<void> {
    requirePermission(context, Permission.ACCOUNT_BILLING);
    await this.options.provider.resume(context.accountId);
    this.options.entitlements.invalidate(context.accountId);

    await this.audit.record({
      accountId: context.accountId,
      actorType: DbActorType.user,
      actorId: context.userId,
      action: 'subscription.resumed',
      resourceType: 'subscription',
      resourceId: null,
      metadata: {},
    });
  }

  // ---------------------------------------------------------------------------
  // Enforcement
  // ---------------------------------------------------------------------------
  //
  // Not here. "Pause, never destroy" is applied by PlanGuard, which is the single place a plan
  // decides whether something may happen, and which is wired into the API, the realtime gateway
  // and the worker. Two implementations of "is this account read-only" is one implementation and
  // one bug waiting for the day they disagree.

  // ---------------------------------------------------------------------------
  // Lifecycle, driven by the sweeper
  // ---------------------------------------------------------------------------

  /**
   * Move every subscription that has reached the end of something.
   *
   * Deliberately one pass with explicit stages rather than a state machine spread across the
   * codebase: trials end, periods roll over and are invoiced, unpaid periods enter grace, and
   * grace that has run out pauses. Returns a tally so the job logs something meaningful.
   */
  async runLifecycle(now = this.clock.now()): Promise<{
    trialsEnded: number;
    periodsRolled: number;
    invoicesIssued: number;
    paused: number;
    changesApplied: number;
  }> {
    const tally = {
      trialsEnded: 0,
      periodsRolled: 0,
      invoicesIssued: 0,
      paused: 0,
      changesApplied: 0,
    };

    /**
     * 1. Trials whose time is up.
     *
     * A trial runs on the full product, so ending one by simply activating it would put a
     * customer on a paid plan they never agreed to and then invoice them for it. Instead the
     * subscription falls back to the free plan. Nothing is deleted: whatever they built during
     * the trial is still there, and anything beyond the free plan's limits is read-only until
     * they choose to pay - the same rule a lapse follows.
     *
     * A trial already on a free plan just activates, because there is nothing to fall back to.
     */
    const endedTrials = await this.options.db.subscription.findMany({
      where: { status: 'trialing', trialEndsAt: { lte: now } },
      include: { plan: true },
    });
    const fallback = endedTrials.length > 0 ? await defaultPlan(this.options.db) : null;

    for (const subscription of endedTrials) {
      const paid = priceForInterval(subscription.plan, subscription.interval) > 0;
      const target = paid && fallback ? fallback : subscription.plan;
      const anchorDay = subscription.currentPeriodStart.getUTCDate();

      await this.options.db.subscription.update({
        where: { id: subscription.id },
        data: {
          planId: target.id,
          status: 'active',
          ...(target.id === subscription.planId
            ? {}
            : {
                currentPeriodStart: now,
                currentPeriodEnd: periodEnd(now, subscription.interval, anchorDay),
              }),
        },
      });
      this.options.entitlements.invalidate(subscription.accountId);
      tally.trialsEnded += 1;
    }

    // 2. Periods that have ended.
    const due = await this.options.db.subscription.findMany({
      where: { status: { in: ['active', 'past_due'] }, currentPeriodEnd: { lte: now } },
      include: { plan: true },
    });

    for (const subscription of due) {
      // 2a. A deferred downgrade takes effect now, before the new period is priced - otherwise the
      //     customer is invoiced for the plan they asked to leave.
      const pending = await this.options.db.planChangeRequest.findFirst({
        where: { accountId: subscription.accountId, status: 'pending' },
        include: { toPlan: true },
        orderBy: { createdAt: 'asc' },
      });
      let plan = subscription.plan;
      let interval = subscription.interval;
      if (pending && priceForInterval(pending.toPlan, pending.interval) < priceForInterval(plan, interval)) {
        await this.options.db.planChangeRequest.update({
          where: { id: pending.id },
          data: { status: 'approved', decidedAt: now, note: 'Applied at the end of the period' },
        });
        plan = pending.toPlan;
        interval = pending.interval;
        tally.changesApplied += 1;
      }

      if (subscription.cancelAtPeriodEnd) {
        await this.options.db.subscription.update({
          where: { id: subscription.id },
          data: { status: 'paused', pausedAt: now },
        });
        this.options.entitlements.invalidate(subscription.accountId);
        await this.options.notify?.({
          type: 'subscription_paused',
          accountId: subscription.accountId,
        });
        tally.paused += 1;
        continue;
      }

      const anchorDay = subscription.currentPeriodStart.getUTCDate();
      const nextStart = subscription.currentPeriodEnd;
      const price = priceForInterval(plan, interval);

      await this.options.db.subscription.update({
        where: { id: subscription.id },
        data: {
          planId: plan.id,
          interval,
          currentPeriodStart: nextStart,
          currentPeriodEnd: periodEnd(nextStart, interval, anchorDay),
          // A free plan is never past due. A paid one owes for the period just started.
          status: price > 0 ? 'past_due' : 'active',
          graceEndsAt: price > 0 ? new Date(now.getTime() + GRACE_DAYS * DAY) : null,
        },
      });
      this.options.entitlements.invalidate(subscription.accountId);
      tally.periodsRolled += 1;

      const invoice = await this.options.provider.issueInvoiceForPeriod(subscription.accountId);
      if (invoice) {
        tally.invoicesIssued += 1;
        await this.options.notify?.({
          type: 'invoice_issued',
          accountId: subscription.accountId,
          invoiceId: invoice.invoiceId,
        });
      }
    }

    // 3. Grace that has run out. This is the only place an account becomes read-only, and it is
    //    deliberately a long way from the moment a payment was missed.
    const lapsed = await this.options.db.subscription.findMany({
      where: { status: 'past_due', graceEndsAt: { lte: now } },
    });
    for (const subscription of lapsed) {
      await this.options.db.subscription.update({
        where: { id: subscription.id },
        data: { status: 'paused', pausedAt: now },
      });
      this.options.entitlements.invalidate(subscription.accountId);
      await this.options.notify?.({
        type: 'subscription_paused',
        accountId: subscription.accountId,
      });
      tally.paused += 1;
    }

    return tally;
  }

  private monthStart(): Date {
    const now = this.clock.now();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }
}
