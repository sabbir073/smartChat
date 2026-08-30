import type { Job } from 'bullmq';
import { AnalyticsService, type AnalyticsRollupPayload } from '@smartchat/core';
import type { Database } from '@smartchat/database';
import type { Logger } from '@smartchat/logger';

/**
 * Keep the rollup current.
 *
 * Idempotent by construction: `rebuild` deletes and re-derives the range from the source tables,
 * so running it twice - or a hundred times - produces the same rows. That is what makes it safe
 * to run every quarter of an hour, and safe to retry after a failure.
 *
 * One account failing must not stop the rest. A single tenant with a pathological range should
 * not leave every other account's reports frozen at whatever they were, so each is caught, logged
 * and stepped over.
 */
export async function processAnalyticsJob(
  job: Job<AnalyticsRollupPayload>,
  db: Database,
  logger: Logger,
): Promise<void> {
  const analytics = new AnalyticsService({ db });
  const days = Math.min(Math.max(job.data.days ?? 2, 1), 31);

  const accountIds = await analytics.activeAccountIds();
  let rebuilt = 0;
  let failed = 0;

  for (const accountId of accountIds) {
    try {
      // "Today" is the account's today, which for a team in Auckland is not the same date as ours.
      const today = await analytics.accountToday(accountId);
      const from = new Date(today.getTime() - (days - 1) * 86_400_000);
      await analytics.rebuild(accountId, from, today);
      rebuilt += 1;
    } catch (error) {
      failed += 1;
      logger.error({ err: error, accountId }, 'analytics rollup failed for one account');
    }
  }

  logger.info({ accounts: accountIds.length, rebuilt, failed, days }, 'analytics rollup finished');
}
