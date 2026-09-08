import type { Job } from 'bullmq';
import type { Database } from '@smartchat/database';
import {
  BillingReconcileService,
  GeoService,
  MaintenanceJob,
  RIR_FILE_MAX_BYTES,
  RetentionService,
  SessionRepository,
  TokenRepository,
  createOutboundFetch,
  findAccountOwner,
  readGraceDays,
  type BrandContext,
  type MailMessage,
  type StorageService,
} from '@smartchat/core';
import type { Logger } from '@smartchat/logger';

/**
 * Housekeeping.
 *
 * Every task here is idempotent and bounded: running it twice changes nothing, and running it on
 * a large table deletes by an indexed predicate rather than scanning.
 */
export interface MaintenanceDeps {
  storage?: StorageService;
  /** For the billing notices: who we are, and how an email leaves. */
  brand: BrandContext;
  deliver: (message: MailMessage) => Promise<void>;
}

export async function processMaintenanceJob(
  job: Job,
  db: Database,
  logger: Logger,
  deps: MaintenanceDeps,
): Promise<void> {
  const { storage } = deps;
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

    case MaintenanceJob.REFRESH_GEO: {
      const geo = new GeoService({
        db,
        // The registries are public hosts on the internet, fetched through the same DNS-pinned
        // client as everything else that leaves this process - with a cap sized for a ~15MB
        // registry file rather than a webhook acknowledgement.
        fetch: createOutboundFetch({ maxResponseBytes: RIR_FILE_MAX_BYTES }),
      });
      const outcome = await geo.refresh();
      if (outcome.complete) {
        logger.info({ rangeCount: outcome.rangeCount }, 'geo ranges rebuilt from the registries');
        return;
      }
      // Loud, because the alternative is a flag quietly missing for a whole continent - and a
      // failure, so the queue retries with backoff rather than calling a load that loaded
      // nothing a success. The previous data stays in place throughout.
      logger.error({ sources: outcome.sources }, 'geo refresh incomplete - kept the previous data');
      const failed = Object.entries(outcome.sources)
        .filter(([, source]) => !source.ok)
        .map(([registry, source]) => `${registry}: ${(source as { error: string }).error}`)
        .join('; ');
      throw new Error(`geo refresh incomplete - ${failed}`);
    }

    case MaintenanceJob.BILLING_RECONCILE: {
      const outcome = await new BillingReconcileService({
        db,
        brand: deps.brand,
        deliver: deps.deliver,
        ownerOf: (accountId) => findAccountOwner(db, accountId),
        graceDays: () => readGraceDays(db),
      }).run();
      if (outcome.newlyLocked > 0 || outcome.unlocked > 0) {
        logger.info(outcome, 'billing reconciled');
      } else {
        logger.debug(outcome, 'billing reconciled - nothing to do');
      }
      return;
    }

    default:
      logger.warn({ jobName: job.name }, 'unknown maintenance job — ignoring');
  }
}
