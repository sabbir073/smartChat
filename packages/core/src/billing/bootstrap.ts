import type { DatabaseOrTransaction, Plan, Subscription } from '@smartchat/database';
import { AppError, ErrorCode } from '@smartchat/types';
import { periodEnd } from './periods.js';

/**
 * The plan a new account is given for its first fortnight.
 *
 * A trial on the free plan would be a trial of nothing, so a new account gets the whole product
 * and then falls back rather than being cut off. Nothing is deleted at the end of it: whatever
 * they built during the trial stays, and anything past the free plan's limits becomes read-only
 * until they choose to pay. That is the same "pause, never destroy" rule the rest of billing
 * follows, applied to the one moment every customer goes through.
 */
export const TRIAL_PLAN_CODE = 'pro';

/** Where a subscription lands when nobody has chosen anything: the cheapest published plan. */
export const DEFAULT_PLAN_CODE = 'free';

/** How long the trial lasts. Kept here with the plan it applies to, not with the sweeper. */
export const TRIAL_DAYS = 14;

const DAY_MS = 86_400_000;

/**
 * The plan an account falls back to.
 *
 * By code first, and by price second so a deployment that renamed its plans still resolves to
 * something restrictive rather than to nothing. Returning `null` here is what makes every limit
 * unlimited, so the fallback matters more than it looks.
 */
export async function defaultPlan(db: DatabaseOrTransaction): Promise<Plan | null> {
  const byCode = await db.plan.findUnique({ where: { code: DEFAULT_PLAN_CODE } });
  if (byCode) return byCode;

  return db.plan.findFirst({
    where: { isPublic: true, isContactSales: false },
    orderBy: [{ priceMonthlyCents: 'asc' }, { sortOrder: 'asc' }],
  });
}

/**
 * Give an account a subscription if it has none.
 *
 * Called when an account is created, and again from the read path, because the second call is
 * what repairs an account that predates this code. It is safe to call concurrently: the unique
 * index on `account_id` decides the race, and the loser simply reads the winner's row.
 *
 * This exists because for a while nothing created a subscription at all. Every limit the plans
 * defined resolved to "no subscription, therefore no limits, therefore unlimited", so the whole
 * entitlement system was inert for every real customer while looking, in the code and on the
 * pricing page, exactly as though it worked.
 */
export async function ensureSubscription(
  db: DatabaseOrTransaction,
  accountId: string,
  now: Date = new Date(),
): Promise<Subscription> {
  const existing = await db.subscription.findUnique({ where: { accountId } });
  if (existing) return existing;

  const trialPlan =
    (await db.plan.findUnique({ where: { code: TRIAL_PLAN_CODE } })) ?? (await defaultPlan(db));
  if (!trialPlan) {
    // No plans at all means an unseeded database. Refusing loudly is right: the alternative is an
    // account with no entitlements, which reads as "unlimited" everywhere downstream.
    throw new AppError(ErrorCode.INTERNAL_ERROR, 'No plans are configured.');
  }

  const anchorDay = now.getUTCDate();

  try {
    return await db.subscription.create({
      data: {
        accountId,
        planId: trialPlan.id,
        status: 'trialing',
        interval: 'monthly',
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd(now, 'monthly', anchorDay),
        trialEndsAt: new Date(now.getTime() + TRIAL_DAYS * DAY_MS),
        provider: 'manual',
      },
    });
  } catch {
    // Lost the race. The other writer's row is the answer.
    const raced = await db.subscription.findUnique({ where: { accountId } });
    if (raced) return raced;
    throw new AppError(ErrorCode.INTERNAL_ERROR, 'Could not start a subscription.');
  }
}
