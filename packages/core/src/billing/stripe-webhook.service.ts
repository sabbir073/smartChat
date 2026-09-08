import type Stripe from 'stripe';
import type { Database, SubscriptionStatus } from '@smartchat/database';
import type { MailMessage } from '../mail/provider.js';
import {
  invoicePaidTemplate,
  paymentFailedTemplate,
  subscriptionActivatedTemplate,
  subscriptionCanceledTemplate,
  type BrandContext,
} from '../mail/templates.js';
import { systemClock, type Clock } from '../time.js';
import type { EntitlementService } from './entitlements.js';
import type { StripeGateway } from './stripe-gateway.js';
import {
  snapshotInvoice,
  snapshotSubscription,
  type InvoiceSnapshot,
  type SubscriptionSnapshot,
} from './stripe-gateway.js';

/**
 * Stripe tells us what happened; this keeps our side in step.
 *
 * Three rules, each of which has a bug story behind it somewhere in the industry:
 *
 *  1. **Signature first.** The body is not looked at until Stripe's signature over it has been
 *     verified with the secret the operator entered. A webhook endpoint that trusts its body is a
 *     "make my account free" endpoint.
 *  2. **Every event once.** Stripe delivers at least once, and retries anything that did not get a
 *     2xx. Each event id is recorded before it is handled; a duplicate is acknowledged and
 *     ignored, so a retry cannot send a second receipt or lock an account twice.
 *  3. **The event is a hint; the object is the truth.** Events can arrive out of order. On any
 *     subscription event the subscription is re-fetched from Stripe and the current state
 *     written, so a stale `updated` arriving after a `deleted` cannot resurrect anything.
 */

export interface StripeWebhookServiceOptions {
  db: Database;
  entitlements: EntitlementService;
  gateway: StripeGateway;
  brand: BrandContext;
  deliver: (message: MailMessage) => Promise<void>;
  /** Who to email about an account: the owner, by account id. */
  ownerOf: (accountId: string) => Promise<{ email: string; name: string } | null>;
  /** The operator's grace window, so the failed-payment email can say when the lock lands. */
  graceDays: () => Promise<number>;
  clock?: Clock;
}

export type WebhookOutcome =
  | { handled: true; type: string }
  | { handled: false; reason: 'duplicate' | 'ignored' | 'unlinked'; type: string };

const STATUS_MAP: Record<Stripe.Subscription.Status, SubscriptionStatus> = {
  active: 'active',
  trialing: 'active',
  past_due: 'past_due',
  unpaid: 'unpaid',
  canceled: 'canceled',
  incomplete: 'incomplete',
  incomplete_expired: 'incomplete_expired',
  // A paused subscription (Stripe's collection pause) is treated as unpaid: no money is coming
  // in, and the operator chose "lock until paid". Not a state this product ever puts one in.
  paused: 'unpaid',
};

export class StripeWebhookService {
  private readonly clock: Clock;

  constructor(private readonly options: StripeWebhookServiceOptions) {
    this.clock = options.clock ?? systemClock;
  }

  async handle(rawBody: Buffer | string, signature: string, webhookSecret: string): Promise<WebhookOutcome> {
    const event = this.options.gateway.constructEvent(rawBody, signature, webhookSecret);

    // Claim the event id. A unique violation means a retry of something already handled.
    try {
      await this.options.db.stripeEvent.create({ data: { id: event.id, type: event.type } });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') {
        return { handled: false, reason: 'duplicate', type: event.type };
      }
      throw error;
    }

    try {
      const outcome = await this.dispatch(event);
      await this.options.db.stripeEvent.update({
        where: { id: event.id },
        data: { processedAt: this.clock.now() },
      });
      return outcome;
    } catch (error) {
      await this.options.db.stripeEvent.update({
        where: { id: event.id },
        data: { error: error instanceof Error ? error.message.slice(0, 500) : String(error) },
      });
      throw error;
    }
  }

  private async dispatch(event: Stripe.Event): Promise<WebhookOutcome> {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.mode !== 'subscription' || !session.subscription) {
          return { handled: false, reason: 'ignored', type: event.type };
        }
        const subscriptionId =
          typeof session.subscription === 'string' ? session.subscription : session.subscription.id;
        // `client_reference_id` is our account id, set at checkout. It links a brand-new
        // subscription to its account before any subscription event has been seen.
        const accountId = session.client_reference_id ?? null;
        const snapshot = await this.options.gateway.retrieveSubscription(subscriptionId);
        return this.applySubscription(snapshot, accountId, event.type, { activated: true });
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
      case 'customer.subscription.paused':
      case 'customer.subscription.resumed': {
        const stale = snapshotSubscription(event.data.object);
        // Re-fetch: events can arrive out of order, and the object in a stale one is stale too.
        const fresh =
          event.type === 'customer.subscription.deleted'
            ? { ...stale, status: 'canceled' as const }
            : await this.options.gateway.retrieveSubscription(stale.id).catch(() => stale);
        return this.applySubscription(fresh, fresh.accountId, event.type, {
          activated: event.type === 'customer.subscription.created',
        });
      }

      case 'invoice.finalized':
      case 'invoice.paid':
      case 'invoice.payment_succeeded':
      case 'invoice.payment_failed':
      case 'invoice.voided':
      case 'invoice.marked_uncollectible':
      case 'invoice.updated': {
        const snapshot = snapshotInvoice(event.data.object);
        return this.applyInvoice(snapshot, event.type);
      }

      default:
        return { handled: false, reason: 'ignored', type: event.type };
    }
  }

  /**
   * Write what Stripe says the subscription is, and notice the transitions worth an email.
   *
   * The account is found by our own metadata first, then by the Stripe customer, then by the
   * subscription id already stored. An event about a subscription this deployment knows nothing
   * about - a different environment's key, a subscription made in the Stripe dashboard by hand -
   * is acknowledged and left alone rather than attached to the wrong account.
   */
  private async applySubscription(
    snapshot: SubscriptionSnapshot,
    hintedAccountId: string | null,
    type: string,
    flags: { activated: boolean },
  ): Promise<WebhookOutcome> {
    const db = this.options.db;

    const current =
      (hintedAccountId
        ? await db.subscription.findUnique({ where: { accountId: hintedAccountId } })
        : null) ??
      (await db.subscription.findFirst({ where: { stripeSubscriptionId: snapshot.id } })) ??
      (await db.subscription.findFirst({ where: { stripeCustomerId: snapshot.customerId } }));

    if (!current) return { handled: false, reason: 'unlinked', type };

    // An event about a subscription this account no longer has - typically the final `deleted`
    // for one it replaced, arriving after the replacement's checkout - must not touch the one it
    // has now. Only a checkout or a `created` may introduce a new subscription id.
    if (
      current.stripeSubscriptionId !== null &&
      current.stripeSubscriptionId !== snapshot.id &&
      !flags.activated
    ) {
      return { handled: false, reason: 'ignored', type };
    }

    // Which plan is this price? The price id was recorded when the operator synced the plan.
    const plan = snapshot.priceId
      ? await db.plan.findFirst({
          where: {
            OR: [{ stripeMonthlyPriceId: snapshot.priceId }, { stripeAnnualPriceId: snapshot.priceId }],
          },
        })
      : null;

    const status = STATUS_MAP[snapshot.status] ?? 'active';
    const now = this.clock.now();
    const owner = await this.options.ownerOf(current.accountId);

    // Over. Stripe reports `canceled` only once the paid period has ended (a cancellation "at
    // period end" stays `active` until then), so the account goes back to the default plan
    // rather than sitting locked on a plan it no longer pays for. The Stripe customer is kept:
    // their card is on file if they come back.
    if (status === 'canceled') {
      const fallback = await db.plan.findFirst({ where: { isDefault: true, isActive: true } });
      if (!fallback) {
        throw new Error('No default plan is configured; cannot end a subscription safely');
      }
      const alreadyEnded = current.stripeSubscriptionId === null;
      await db.subscription.update({
        where: { id: current.id },
        data: {
          planId: fallback.id,
          provider: 'manual',
          status: 'none',
          interval: 'month',
          stripeCustomerId: snapshot.customerId,
          stripeSubscriptionId: null,
          currentPeriodStart: null,
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
          canceledAt: snapshot.canceledAt ?? now,
          pastDueSince: null,
          lockedAt: null,
        },
      });
      this.options.entitlements.invalidate(current.accountId);

      if (owner && !alreadyEnded) {
        const ended = plan ?? (await db.plan.findUnique({ where: { id: current.planId } }));
        const { lock } = await this.options.entitlements.forAccount(current.accountId);
        await this.options.deliver(
          subscriptionCanceledTemplate(this.options.brand, {
            email: owner.email,
            name: owner.name,
            planName: ended?.name ?? 'paid',
            fallbackPlanName: fallback.name,
            overLimit: lock.reason === 'over_limit',
          }),
        );
      }
      return { handled: true, type };
    }

    const wasLocked = current.lockedAt !== null;
    const recovered = status === 'active' && current.status !== 'active';

    await db.subscription.update({
      where: { id: current.id },
      data: {
        provider: 'stripe',
        status,
        interval: snapshot.interval,
        stripeCustomerId: snapshot.customerId,
        stripeSubscriptionId: snapshot.id,
        currentPeriodStart: snapshot.currentPeriodStart,
        currentPeriodEnd: snapshot.currentPeriodEnd,
        cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
        canceledAt: snapshot.canceledAt,
        ...(plan ? { planId: plan.id } : {}),
        // The grace clock starts on the first failed charge and stops when a payment lands.
        pastDueSince: status === 'past_due' ? (current.pastDueSince ?? now) : null,
        // A payment unlocks. Locking itself is decided by the reconcile job and the guard, from
        // the status and the grace window, so it is never set here.
        ...(status === 'active' ? { lockedAt: null } : {}),
      },
    });
    this.options.entitlements.invalidate(current.accountId);

    if (owner && plan) {
      if (flags.activated && status === 'active' && current.status !== 'active') {
        await this.options.deliver(
          subscriptionActivatedTemplate(this.options.brand, {
            email: owner.email,
            name: owner.name,
            planName: plan.name,
            interval: snapshot.interval,
            renewsAt: snapshot.currentPeriodEnd,
          }),
        );
      } else if (recovered && wasLocked) {
        await this.options.deliver(
          subscriptionActivatedTemplate(this.options.brand, {
            email: owner.email,
            name: owner.name,
            planName: plan.name,
            interval: snapshot.interval,
            renewsAt: snapshot.currentPeriodEnd,
            reactivated: true,
          }),
        );
      }
    }
    // A subscription going past due is told about by the invoice.payment_failed handler, which
    // knows the amount and has the link to pay - a better email than "your status changed".

    return { handled: true, type };
  }

  private async applyInvoice(snapshot: InvoiceSnapshot, type: string): Promise<WebhookOutcome> {
    const db = this.options.db;

    // Whose is it? Through the subscription first, then the customer.
    const subscription =
      (snapshot.subscriptionId
        ? await db.subscription.findFirst({ where: { stripeSubscriptionId: snapshot.subscriptionId } })
        : null) ??
      (snapshot.customerId
        ? await db.subscription.findFirst({ where: { stripeCustomerId: snapshot.customerId } })
        : null);
    if (!subscription) return { handled: false, reason: 'unlinked', type };

    const existing = await db.invoice.findUnique({ where: { stripeInvoiceId: snapshot.id } });
    const data = {
      accountId: subscription.accountId,
      number: snapshot.number,
      status: snapshot.status,
      amountDueCents: snapshot.amountDueCents,
      amountPaidCents: snapshot.amountPaidCents,
      currency: snapshot.currency,
      planName: snapshot.planName,
      periodStart: snapshot.periodStart,
      periodEnd: snapshot.periodEnd,
      hostedInvoiceUrl: snapshot.hostedInvoiceUrl,
      invoicePdfUrl: snapshot.invoicePdfUrl,
      issuedAt: snapshot.issuedAt,
      paidAt: snapshot.paidAt,
    };
    await db.invoice.upsert({
      where: { stripeInvoiceId: snapshot.id },
      create: { stripeInvoiceId: snapshot.id, ...data },
      update: data,
    });

    const owner = await this.options.ownerOf(subscription.accountId);
    if (!owner) return { handled: true, type };

    // A receipt, once: the first time this invoice is seen paid. Stripe sends both `invoice.paid`
    // and `invoice.payment_succeeded` for one payment, and the mirror row is what makes them one.
    const justPaid = snapshot.status === 'paid' && existing?.status !== 'paid' && snapshot.amountPaidCents > 0;
    if (justPaid) {
      await this.options.deliver(
        invoicePaidTemplate(this.options.brand, {
          email: owner.email,
          name: owner.name,
          number: snapshot.number,
          amountCents: snapshot.amountPaidCents,
          currency: snapshot.currency,
          planName: snapshot.planName,
          periodStart: snapshot.periodStart,
          periodEnd: snapshot.periodEnd,
          hostedInvoiceUrl: snapshot.hostedInvoiceUrl,
          invoicePdfUrl: snapshot.invoicePdfUrl,
        }),
      );
    }

    if (type === 'invoice.payment_failed') {
      const graceDays = await this.options.graceDays();
      const since = subscription.pastDueSince ?? this.clock.now();
      const graceEndsAt = new Date(since.getTime() + graceDays * 24 * 60 * 60 * 1000);
      await this.options.deliver(
        paymentFailedTemplate(this.options.brand, {
          email: owner.email,
          name: owner.name,
          amountCents: snapshot.amountDueCents,
          currency: snapshot.currency,
          hostedInvoiceUrl: snapshot.hostedInvoiceUrl,
          graceEndsAt,
        }),
      );
    }

    return { handled: true, type };
  }
}
