import type { SubscriptionStatus } from '@smartchat/database';

/**
 * Whether an account may still change things, and if not, why.
 *
 * The rule the operator chose: a subscription that has stopped being paid locks the dashboard
 * until it is paid again. Reading stays open - nobody loses their conversations - and the
 * widget on the customer's site keeps working for their visitors, who did nothing wrong.
 *
 * "Stopped being paid" is not the same as "one charge failed". Stripe retries a failed card for
 * days before giving up, and locking somebody out the minute their bank hiccups is how a paying
 * customer becomes an ex-customer. So `past_due` gets a grace window the operator sets (three
 * days by default), during which the dashboard shows a warning and everything still works. When
 * Stripe gives up (`unpaid`), when the subscription is cancelled and its paid period has ended,
 * or when the grace window runs out, the lock applies.
 *
 * One more case comes from downgrades rather than money: an account with more websites or team
 * members than its plan allows (it had a bigger plan, and the subscription ended). Nothing is
 * deleted for them - but the dashboard is locked the same way until they either remove the
 * extras or pick a plan that fits. That is decided in the entitlement service, which has the
 * counts; `evaluateLock` only knows the subscription.
 */

export type LockReason = 'unpaid' | 'canceled' | 'grace_expired' | 'incomplete' | 'over_limit';

export interface LockVerdict {
  locked: boolean;
  reason: LockReason | null;
  /** For `past_due`: when the grace window ends, so the banner can say so. */
  graceEndsAt: Date | null;
}

export interface LockInput {
  status: SubscriptionStatus;
  pastDueSince: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

export function evaluateLock(input: LockInput, graceDays: number, now: Date): LockVerdict {
  switch (input.status) {
    case 'none':
    case 'active':
      return { locked: false, reason: null, graceEndsAt: null };

    case 'unpaid':
      return { locked: true, reason: 'unpaid', graceEndsAt: null };

    case 'incomplete_expired':
      return { locked: true, reason: 'incomplete', graceEndsAt: null };

    case 'incomplete':
      // The first payment has not gone through yet. Nothing has been bought, and nothing has
      // lapsed: the account is on whatever it had before, which the caller resolves.
      return { locked: false, reason: null, graceEndsAt: null };

    case 'canceled': {
      // A subscription cancelled at period end stays usable until the end of the period the
      // customer paid for. Stripe reports `canceled` only once that has passed, but the check
      // costs nothing and protects against a clock skew or a manual status change.
      if (input.currentPeriodEnd && input.currentPeriodEnd.getTime() > now.getTime()) {
        return { locked: false, reason: null, graceEndsAt: null };
      }
      return { locked: true, reason: 'canceled', graceEndsAt: null };
    }

    case 'past_due': {
      const since = input.pastDueSince ?? now;
      const graceEndsAt = new Date(since.getTime() + Math.max(0, graceDays) * 24 * 60 * 60 * 1000);
      if (graceEndsAt.getTime() <= now.getTime()) {
        return { locked: true, reason: 'grace_expired', graceEndsAt };
      }
      return { locked: false, reason: null, graceEndsAt };
    }

    default: {
      // Every status is handled above; a value the enum does not know about is a bug, and we
      // fail closed rather than let an account whose state we cannot read keep mutating data.
      const unknown: never = input.status;
      throw new Error(`Unhandled subscription status ${String(unknown)}`);
    }
  }
}

/** One sentence a locked account sees, by reason. Shown in the API error and on the lock wall. */
export function lockMessage(reason: LockReason): string {
  switch (reason) {
    case 'unpaid':
    case 'grace_expired':
      return 'Your subscription is unpaid. Update your payment method to keep working.';
    case 'canceled':
      return 'Your subscription has ended. Choose a plan to continue.';
    case 'incomplete':
      return 'Your first payment did not go through. Choose a plan to continue.';
    case 'over_limit':
      return 'Your account has more websites or team members than your plan includes. Remove some, or choose a bigger plan.';
  }
}
