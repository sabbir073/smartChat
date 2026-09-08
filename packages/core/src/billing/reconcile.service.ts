import type { Database } from '@smartchat/database';
import type { MailMessage } from '../mail/provider.js';
import { accountLockedTemplate, type BrandContext } from '../mail/templates.js';
import { systemClock, type Clock } from '../time.js';
import { evaluateLock } from './lock.js';

/**
 * The hourly pass that turns "the grace window has run out" into a locked account and one email.
 *
 * The lock itself is not a stored fact: every request evaluates it from the subscription and the
 * grace setting, so an account locks the moment its window closes whether or not this job has
 * run. What this job adds is the *notice* - the email that says so - and the `lockedAt` stamp
 * that records the notice was sent, so it is sent once. When a payment lands the webhook clears
 * the stamp; if the window closes again, the notice goes again.
 */

export interface BillingReconcileOptions {
  db: Database;
  brand: BrandContext;
  deliver: (message: MailMessage) => Promise<void>;
  ownerOf: (accountId: string) => Promise<{ email: string; name: string } | null>;
  graceDays: () => Promise<number>;
  clock?: Clock;
}

export interface ReconcileOutcome {
  examined: number;
  newlyLocked: number;
  notified: number;
  /** Stamps cleared on accounts that are no longer locked (a manual plan change, say). */
  unlocked: number;
}

export class BillingReconcileService {
  private readonly clock: Clock;

  constructor(private readonly options: BillingReconcileOptions) {
    this.clock = options.clock ?? systemClock;
  }

  async run(): Promise<ReconcileOutcome> {
    const now = this.clock.now();
    const graceDays = await this.options.graceDays();
    const outcome: ReconcileOutcome = { examined: 0, newlyLocked: 0, notified: 0, unlocked: 0 };

    // Only the statuses that can be locked, or that carry a stale stamp. Active accounts on a
    // free plan - the overwhelming majority - are never read.
    const candidates = await this.options.db.subscription.findMany({
      where: {
        OR: [
          { status: { in: ['past_due', 'unpaid', 'canceled', 'incomplete_expired'] } },
          { lockedAt: { not: null } },
        ],
      },
      include: { account: { select: { deletedAt: true } } },
    });

    for (const subscription of candidates) {
      outcome.examined += 1;
      if (subscription.account.deletedAt) continue;

      const verdict = evaluateLock(subscription, graceDays, now);

      if (!verdict.locked) {
        if (subscription.lockedAt !== null) {
          await this.options.db.subscription.update({
            where: { id: subscription.id },
            data: { lockedAt: null },
          });
          outcome.unlocked += 1;
        }
        continue;
      }

      if (subscription.lockedAt !== null || verdict.reason === null) continue;

      // Stamp first, then email. The other order would send twice if the stamp failed.
      await this.options.db.subscription.update({
        where: { id: subscription.id },
        data: { lockedAt: now },
      });
      outcome.newlyLocked += 1;

      const owner = await this.options.ownerOf(subscription.accountId);
      if (!owner || verdict.reason === 'over_limit') continue;
      await this.options.deliver(
        accountLockedTemplate(this.options.brand, {
          email: owner.email,
          name: owner.name,
          reason: verdict.reason,
        }),
      );
      outcome.notified += 1;
    }

    return outcome;
  }
}
