import type { Database, DatabaseTransaction, Subscription } from '@smartchat/database';
import { AppError, ErrorCode } from '@smartchat/types';
import { systemClock, type Clock } from '../time.js';
import { periodEnd, priceForInterval } from './periods.js';
import type {
  BillingProvider,
  CancelIntent,
  PlanChangeIntent,
  PlanChangeOutcome,
} from './provider.js';

/**
 * Billing without a card processor.
 *
 * A customer picks a plan and the request is recorded; an operator approves it in the console and
 * the subscription moves; invoices are written when a period rolls over and marked paid when
 * somebody records the payment. That is a complete, honest billing system - it is how a great deal
 * of B2B software is actually sold - and every part of it works end to end with no third party.
 *
 * Two rules shape the implementation:
 *
 * **A downgrade is not a refund.** Moving to a cheaper plan takes effect at the end of the period
 * the customer has already paid for, not the moment they ask. Moving to a more expensive one takes
 * effect immediately, because they are asking for more and will be invoiced for it next period.
 * Nothing here attempts proration: with no card on file there is nothing to charge or return, and
 * pretending to prorate would produce numbers nobody acts on.
 *
 * **Free is not a request.** Moving to a zero-price plan needs no commercial agreement, so it is
 * applied immediately rather than queued behind an operator who may be asleep. A customer who
 * wants to stop paying should never have to wait for permission.
 */
export class ManualBillingProvider implements BillingProvider {
  readonly name = 'manual';

  constructor(
    private readonly db: Database,
    private readonly clock: Clock = systemClock,
  ) {}

  canSelfServe(): boolean {
    return true;
  }

  async requestChange(intent: PlanChangeIntent): Promise<PlanChangeOutcome> {
    const { accountId, fromPlan, toPlan, interval } = intent;

    if (toPlan.isContactSales) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        `${toPlan.name} is arranged with our team rather than selected here.`,
      );
    }
    if (fromPlan.id === toPlan.id && intent.fromInterval === interval) {
      // Not an error worth a stack trace, but not a no-op either: the caller asked for something
      // that cannot happen, and silently returning "applied" would be a lie.
      //
      // The interval is part of the comparison because moving from monthly to annual on the same
      // plan is a real change - a different commitment and a different invoice. Refusing it as
      // "you are already on Starter" would have made the annual prices on the pricing page
      // unreachable for anybody already paying monthly, which is most of the people who want them.
      throw new AppError(ErrorCode.VALIDATION_FAILED, `You are already on ${toPlan.name}.`);
    }

    const existing = await this.db.planChangeRequest.findFirst({
      where: { accountId, status: 'pending' },
    });
    if (existing) {
      throw new AppError(
        ErrorCode.CONFLICT,
        'There is already a plan change waiting on us. Withdraw it first if you want a different one.',
      );
    }

    const price = priceForInterval(toPlan, interval);
    // Priced at the *requested* interval on both sides, so "cheaper" compares like with like: a
    // year of Starter is not a downgrade from a month of Pro merely because it costs more.
    const current = priceForInterval(fromPlan, interval);

    const request = () =>
      this.db.planChangeRequest.create({
        data: {
          accountId,
          fromPlanId: fromPlan.id,
          toPlanId: toPlan.id,
          interval,
          status: 'pending',
          requestedByUserId: intent.requestedByUserId,
          requestedByEmail: intent.requestedByEmail,
        },
      });

    // Moving to a free plan needs no commercial agreement and no waiting: nobody should have to
    // ask permission to stop paying, and there is no paid period left to protect.
    if (price === 0) {
      const subscription = await this.applyChange(accountId, toPlan.id, interval);
      return { kind: 'applied', subscription };
    }

    /**
     * A cheaper paid plan is agreed now and applied at the end of the period.
     *
     * The row is the whole mechanism. An earlier version of this returned `applied` and wrote
     * nothing, on the theory that the sweeper would find the request - so the customer was told
     * their downgrade had gone through, the subscription never moved, and the next invoice was
     * for the plan they had asked to leave. The sweeper applies a pending request whose plan is
     * cheaper than the current one; it needs a pending request to find.
     */
    if (price < current) {
      const created = await request();
      const subscription = await this.db.subscription.findUnique({ where: { accountId } });
      return {
        kind: 'scheduled',
        changeRequestId: created.id,
        effectiveAt: subscription?.currentPeriodEnd ?? this.clock.now(),
      };
    }

    const created = await request();
    return { kind: 'pending', changeRequestId: created.id };
  }

  /** The interface's name for what `applyChange` does. Approval and self-serve end in one place. */
  async applyApprovedChange(
    accountId: string,
    planId: string,
    interval: PlanChangeIntent['interval'],
  ): Promise<Subscription> {
    return this.applyChange(accountId, planId, interval);
  }

  /**
   * Move the subscription onto a plan, now.
   *
   * Deliberately has no "later" mode. A change that is meant to take effect at the end of the
   * period is a pending change request, which the sweeper applies - one mechanism, in one place,
   * rather than a second scheduled-plan concept every read would have to remember.
   */
  async applyChange(
    accountId: string,
    planId: string,
    interval: PlanChangeIntent['interval'],
  ): Promise<Subscription> {
    const now = this.clock.now();
    const subscription = await this.db.subscription.findUnique({ where: { accountId } });
    if (!subscription) throw new AppError(ErrorCode.NOT_FOUND);

    const anchorDay = subscription.currentPeriodStart.getUTCDate();
    return this.db.subscription.update({
      where: { accountId },
      data: {
        planId,
        interval,
        status: 'active',
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd(now, interval, anchorDay),
        // An upgrade clears a lapse: they are paying again.
        graceEndsAt: null,
        pausedAt: null,
        cancelAtPeriodEnd: false,
        canceledAt: null,
        provider: this.name,
      },
    });
  }

  async cancel(intent: CancelIntent): Promise<Subscription> {
    const now = this.clock.now();
    const subscription = await this.db.subscription.findUnique({
      where: { accountId: intent.accountId },
    });
    if (!subscription) throw new AppError(ErrorCode.NOT_FOUND);

    if (!intent.immediately) {
      // The kind default: they keep everything until the period they paid for runs out.
      return this.db.subscription.update({
        where: { accountId: intent.accountId },
        data: { cancelAtPeriodEnd: true, canceledAt: now },
      });
    }

    return this.db.subscription.update({
      where: { accountId: intent.accountId },
      data: {
        status: 'paused',
        cancelAtPeriodEnd: true,
        canceledAt: now,
        pausedAt: now,
        currentPeriodEnd: now,
      },
    });
  }

  /**
   * Undo a cancellation, whether or not it has already taken effect.
   *
   * Two shapes, because a cancellation has two states. Before the period ends it is only an
   * intention, and resuming is just clearing the flag - the customer keeps the period they paid
   * for and never notices. After it has taken effect the subscription is paused, and resuming has
   * to start a period, because there is no longer one running.
   *
   * The second case exists because the first version of this method refused it, and that made
   * pausing a one-way door: an account that cancelled immediately could not resume, could not
   * re-request the plan it was already on, and on a free plan had nothing cheaper to move to. The
   * only way out was an operator. "Pause, never destroy" has to include a way back.
   */
  async resume(accountId: string): Promise<Subscription> {
    const now = this.clock.now();
    const subscription = await this.db.subscription.findUnique({ where: { accountId } });
    if (!subscription) throw new AppError(ErrorCode.NOT_FOUND);

    if (subscription.status === 'paused') {
      const anchorDay = subscription.currentPeriodStart.getUTCDate();
      return this.db.subscription.update({
        where: { accountId },
        data: {
          status: 'active',
          currentPeriodStart: now,
          currentPeriodEnd: periodEnd(now, subscription.interval, anchorDay),
          cancelAtPeriodEnd: false,
          canceledAt: null,
          pausedAt: null,
          graceEndsAt: null,
        },
      });
    }

    if (!subscription.cancelAtPeriodEnd) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'This subscription is not cancelling.');
    }

    return this.db.subscription.update({
      where: { accountId },
      data: { cancelAtPeriodEnd: false, canceledAt: null },
    });
  }

  async issueInvoiceForPeriod(accountId: string): Promise<{ invoiceId: string } | null> {
    const subscription = await this.db.subscription.findUnique({
      where: { accountId },
      include: { plan: true },
    });
    if (!subscription) return null;

    const amount = priceForInterval(subscription.plan, subscription.interval);
    // A free plan produces no invoice at all, rather than a zero one nobody needs to read.
    if (amount <= 0) return null;

    const already = await this.db.invoice.findFirst({
      where: {
        accountId,
        periodStart: subscription.currentPeriodStart,
        periodEnd: subscription.currentPeriodEnd,
        status: { not: 'void' },
      },
    });
    // Idempotent on purpose: the sweeper can run twice, and a customer must never receive two
    // invoices for one period because a job was retried.
    if (already) return { invoiceId: already.id };

    const invoice = await this.db.$transaction(async (tx: DatabaseTransaction) => {
      const number = await this.nextInvoiceNumber(tx, accountId);
      return tx.invoice.create({
        data: {
          accountId,
          number,
          planId: subscription.planId,
          // Copied, not joined. An invoice is a record of what was agreed at the time; renaming a
          // plan next year must not rewrite last year's paperwork.
          planName: subscription.plan.name,
          interval: subscription.interval,
          amountCents: amount,
          currency: subscription.plan.currency,
          status: 'issued',
          periodStart: subscription.currentPeriodStart,
          periodEnd: subscription.currentPeriodEnd,
          issuedAt: this.clock.now(),
          provider: this.name,
        },
      });
    });

    return { invoiceId: invoice.id };
  }

  /**
   * The same gapless-sequence trick the ticket numbers use: increment the counter on the account
   * row and take what comes back, inside the transaction that writes the invoice. Two concurrent
   * runs of the sweeper cannot hand out the same number, and `SELECT max(number) + 1` would.
   */
  private async nextInvoiceNumber(tx: DatabaseTransaction, accountId: string): Promise<number> {
    const rows = await tx.$queryRaw<{ invoice_seq: number }[]>`
      UPDATE accounts SET invoice_seq = invoice_seq + 1 WHERE id = ${accountId}::uuid
      RETURNING invoice_seq
    `;
    const next = rows[0]?.invoice_seq;
    if (next === undefined) throw new AppError(ErrorCode.NOT_FOUND);
    return Number(next);
  }
}
