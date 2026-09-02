import type { Job } from 'bullmq';
import {
  EntitlementService,
  GRACE_DAYS,
  ManualBillingProvider,
  SubscriptionService,
  invoiceIssuedTemplate,
  planChangeApprovedTemplate,
  planChangeRejectedTemplate,
  planChangeRequestedTemplate,
  subscriptionPausedTemplate,
  trialEndingTemplate,
  type BrandContext,
  type MailProvider,
} from '@smartchat/core';
import type { Database } from '@smartchat/database';
import type { Logger } from '@smartchat/logger';

const DAY = 86_400_000;

/**
 * Billing email, and the subscription lifecycle.
 *
 * Two responsibilities in one file because they are two halves of the same thing: the sweeper
 * moves subscriptions between states, and every one of those moves owes somebody an email.
 *
 * Who gets the email is deliberately "everybody who can act on it" - the members holding
 * `account:billing` - rather than the account owner alone. An invoice that goes only to a founder
 * who has left the company is an invoice nobody pays, and the first anybody hears about it is the
 * account going read-only.
 */

async function billingRecipients(db: Database, accountId: string): Promise<string[]> {
  const members = await db.accountMember.findMany({
    where: { accountId, deletedAt: null, status: 'active' },
    include: { user: { select: { email: true } }, role: { select: { permissions: true } } },
  });

  const emails = members
    .filter((member) => member.role?.permissions.includes('account:billing') ?? false)
    .map((member) => member.user?.email)
    .filter((email): email is string => Boolean(email));

  if (emails.length > 0) return [...new Set(emails)];

  // Nobody holds the permission - a single-person account on a preset role, usually. The owner is
  // the correct fallback and the only one: silently sending to nobody is how an account is paused
  // without warning.
  const account = await db.account.findUnique({
    where: { id: accountId },
    include: { owner: { select: { email: true } } },
  });
  return account?.owner?.email ? [account.owner.email] : [];
}

export interface BillingJobDeps {
  db: Database;
  mailer: MailProvider;
  brand: BrandContext;
  logger: Logger;
}

/** Send the mail one billing event owes. */
export async function processBillingEmail(job: Job, deps: BillingJobDeps): Promise<void> {
  const { event } = job.data as { event: { type: string; accountId: string } & Record<string, unknown> };
  const { db, mailer, brand, logger } = deps;

  const [recipients, account] = await Promise.all([
    billingRecipients(db, event.accountId),
    db.account.findUnique({ where: { id: event.accountId }, select: { name: true } }),
  ]);

  if (recipients.length === 0 || !account) {
    logger.warn({ accountId: event.accountId, type: event.type }, 'billing email has no recipient');
    return;
  }

  for (const email of recipients) {
    const message = await buildMessage(event, { email, accountName: account.name, brand, db });
    if (!message) continue;
    await mailer.send(message);
  }

  logger.info(
    { accountId: event.accountId, type: event.type, recipients: recipients.length },
    'billing email sent',
  );
}

async function buildMessage(
  event: { type: string; accountId: string } & Record<string, unknown>,
  context: { email: string; accountName: string; brand: BrandContext; db: Database },
) {
  const { email, accountName, brand, db } = context;

  switch (event.type) {
    case 'change_requested':
      return planChangeRequestedTemplate(brand, {
        email,
        accountName,
        toPlanName: String(event['toPlanName'] ?? 'a new plan'),
        interval: String(event['interval'] ?? 'monthly'),
      });

    case 'change_approved':
      return planChangeApprovedTemplate(brand, {
        email,
        accountName,
        planName: String(event['toPlanName'] ?? 'your new plan'),
      });

    case 'change_rejected':
      return planChangeRejectedTemplate(brand, {
        email,
        planName: String(event['toPlanName'] ?? 'that plan'),
        note: typeof event['note'] === 'string' ? event['note'] : null,
      });

    case 'invoice_issued': {
      // Read back rather than carried in the payload: the invoice is the record, and a job that
      // sat in a queue through a deploy should describe the invoice as it is now.
      const invoice = await db.invoice.findUnique({
        where: { id: String(event['invoiceId']) },
      });
      if (!invoice) return null;
      return invoiceIssuedTemplate(brand, {
        email,
        accountName,
        number: invoice.number,
        planName: invoice.planName,
        amountCents: invoice.amountCents,
        currency: invoice.currency,
        periodStart: invoice.periodStart,
        periodEnd: invoice.periodEnd,
        dueBy: new Date(invoice.issuedAt.getTime() + GRACE_DAYS * DAY),
      });
    }

    case 'trial_ending': {
      const subscription = await db.subscription.findUnique({
        where: { accountId: event.accountId },
        include: { plan: true },
      });
      if (!subscription?.trialEndsAt) return null;
      return trialEndingTemplate(brand, {
        email,
        accountName,
        endsAt: subscription.trialEndsAt,
        planName: subscription.plan.name,
      });
    }

    case 'subscription_paused':
      return subscriptionPausedTemplate(brand, { email, accountName });

    default:
      return null;
  }
}

/**
 * Roll subscriptions forward.
 *
 * Runs on a schedule and is idempotent: a period that has already rolled has a `currentPeriodEnd`
 * in the future and is not selected again, and the invoice write is guarded on the period it
 * covers. Running it twice in a minute does nothing the second time, which is what makes it safe
 * to run often.
 */
export async function processSubscriptionLifecycle(
  db: Database,
  logger: Logger,
  enqueue: (event: { type: string; accountId: string } & Record<string, unknown>) => Promise<void>,
): Promise<void> {
  const entitlements = new EntitlementService(db);
  const subscriptions = new SubscriptionService({
    db,
    provider: new ManualBillingProvider(db),
    entitlements,
    notify: (event) => enqueue(event as never),
  });

  const tally = await subscriptions.runLifecycle();

  // A trial ending is the one event worth warning about *before* it happens, so it is not part of
  // the state machine above: three days out, once.
  const soon = new Date(Date.now() + 3 * DAY);
  const ending = await db.subscription.findMany({
    where: { status: 'trialing', trialEndsAt: { gt: new Date(), lte: soon } },
    select: { accountId: true },
  });
  for (const subscription of ending) {
    await enqueue({ type: 'trial_ending', accountId: subscription.accountId });
  }

  if (
    tally.trialsEnded + tally.periodsRolled + tally.paused + ending.length > 0 ||
    tally.invoicesIssued > 0
  ) {
    logger.info({ ...tally, trialWarnings: ending.length }, 'subscription lifecycle ran');
  }
}
