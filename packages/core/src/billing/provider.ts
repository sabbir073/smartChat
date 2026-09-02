import type { BillingInterval, Plan, Subscription } from '@smartchat/database';

/**
 * The seam between "what a subscription means" and "who takes the money".
 *
 * Everything above this interface - entitlements, limits, the pause behaviour, invoices, the
 * customer's billing screen - is provider-agnostic and fully implemented. Everything below it is
 * one deployment's commercial arrangement.
 *
 * There is exactly one implementation today, `ManualBillingProvider`, and it is a real one rather
 * than a placeholder: an operator approves plan changes and records payments, which is how a great
 * many B2B products actually bill. A card-processing provider slots in beside it by implementing
 * this interface; nothing above the seam changes, which is the whole point of drawing it here
 * rather than scattering `if (stripe)` through the services.
 *
 * The methods are deliberately about *intent* rather than mechanism. `requestChange` does not say
 * "create a checkout session" or "send an email" - it says a customer wants a different plan, and
 * lets the provider decide whether that is a redirect, an approval queue, or an immediate switch.
 */

export interface PlanChangeIntent {
  accountId: string;
  fromPlan: Plan;
  /** The interval the subscription is on today. Needed to tell a real change from a no-op. */
  fromInterval: BillingInterval;
  toPlan: Plan;
  interval: BillingInterval;
  requestedByUserId: string | null;
  requestedByEmail: string | null;
}

/**
 * What the provider decided should happen.
 *
 * `applied` means the subscription has already moved and the customer is on the new plan now.
 * `scheduled` means it is agreed and dated: a downgrade waits for the period the customer has
 * already paid for to run out, and `effectiveAt` is when it lands. `pending` means somebody has
 * to act - an operator approving, or a customer completing a payment elsewhere - and the change
 * request row is the record of that. `redirect` carries a URL the customer must visit; the manual
 * provider never returns one, but a hosted checkout would.
 */
export type PlanChangeOutcome =
  | { kind: 'applied'; subscription: Subscription }
  | { kind: 'scheduled'; changeRequestId: string; effectiveAt: Date }
  | { kind: 'pending'; changeRequestId: string }
  | { kind: 'redirect'; url: string; changeRequestId: string };

export interface CancelIntent {
  accountId: string;
  /** False cancels at the end of the paid period, which is the default and the kinder one. */
  immediately: boolean;
}

export interface BillingProvider {
  /** A stable identifier stored on the subscription, so a row says which system owns it. */
  readonly name: string;

  /**
   * Whether a customer may move themselves between plans at all.
   *
   * The manual provider says yes - it records the request. A provider that requires a payment
   * method on file might say no until one exists.
   */
  canSelfServe(): boolean;

  requestChange(intent: PlanChangeIntent): Promise<PlanChangeOutcome>;

  /**
   * Put a decided change into effect.
   *
   * Separate from `requestChange` because the decision can arrive much later and from somebody
   * else entirely: an operator approving in the console, or a payment provider's webhook saying
   * the money arrived. Both end here, so a subscription only ever moves between plans one way.
   */
  applyApprovedChange(
    accountId: string,
    planId: string,
    interval: BillingInterval,
  ): Promise<Subscription>;

  /** Stop the subscription renewing, or end it now. */
  cancel(intent: CancelIntent): Promise<Subscription>;

  /** Undo a pending cancellation while the period is still running. */
  resume(accountId: string): Promise<Subscription>;

  /**
   * Bill one period: write the invoice that says what is owed.
   *
   * Called by the lifecycle sweeper when a period rolls over. Returns null when there is nothing
   * to bill - a free plan, or a period already invoiced.
   */
  issueInvoiceForPeriod(accountId: string): Promise<{ invoiceId: string } | null>;
}
