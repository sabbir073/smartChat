import type { Job } from 'bullmq';
import type { Database } from '@smartchat/database';
import {
  EntitlementService,
  MaintenanceJob,
  RetentionService,
  SessionRepository,
  TokenRepository,
  type StorageService,
} from '@smartchat/core';
import type { Logger } from '@smartchat/logger';

/**
 * Housekeeping.
 *
 * Every task here is idempotent and bounded: running it twice changes nothing, and running it on
 * a large table deletes by an indexed predicate rather than scanning.
 */
export async function processMaintenanceJob(
  job: Job,
  db: Database,
  logger: Logger,
  storage?: StorageService,
): Promise<void> {
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
      /**
       * Honour `Account.dataRetentionDays`.
       *
       * This job logged "nothing to apply yet" for twelve phases while the column sat in the
       * schema and the setting sat in the product. An account that set 90 days believed its
       * customers' transcripts were being deleted; they were not. That is the worst kind of
       * unimplemented feature - not a visible gap, but a promise quietly unkept.
       */
      const outcome = await new RetentionService({
        db,
        entitlements: new EntitlementService(db),
        ...(storage ? { storage } : {}),
      }).apply();
      logger.info(outcome, 'retention applied');
      if (outcome.objectsOrphaned > 0) {
        // Said loudly, because the alternative is discovering it from a storage bill.
        logger.warn(
          { orphaned: outcome.objectsOrphaned },
          'retention deleted attachment rows whose objects could not be removed',
        );
      }
      return;
    }

    default:
      logger.warn({ jobName: job.name }, 'unknown maintenance job — ignoring');
  }
}
