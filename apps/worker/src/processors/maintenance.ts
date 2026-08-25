import type { Job } from 'bullmq';
import type { Database } from '@smartchat/database';
import { MaintenanceJob, SessionRepository, TokenRepository } from '@smartchat/core';
import type { Logger } from '@smartchat/logger';

/**
 * Housekeeping.
 *
 * Every task here is idempotent and bounded: running it twice changes nothing, and running it on
 * a large table deletes by an indexed predicate rather than scanning.
 */
export async function processMaintenanceJob(job: Job, db: Database, logger: Logger): Promise<void> {
  const now = new Date();

  switch (job.name) {
    case MaintenanceJob.PURGE_EXPIRED_SESSIONS: {
      // Keep revoked/expired rows for a week so the security team can still see recent activity.
      const cutoff = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
      const removed = await new SessionRepository(db).purgeExpired(cutoff);
      logger.info({ removed, cutoff }, 'purged expired sessions');
      return;
    }

    case MaintenanceJob.PURGE_EXPIRED_TOKENS: {
      const cutoff = new Date(now.getTime() - 24 * 3600 * 1000);
      const removed = await new TokenRepository(db).purgeExpired(cutoff);
      logger.info({ removed, cutoff }, 'purged expired verification tokens');
      return;
    }

    case MaintenanceJob.APPLY_RETENTION: {
      // Per-account retention arrives with the conversation model in a later phase; the job exists
      // now so the schedule is in place and its absence is visible rather than forgotten.
      logger.debug('retention job: nothing to apply yet');
      return;
    }

    default:
      logger.warn({ jobName: job.name }, 'unknown maintenance job — ignoring');
  }
}
