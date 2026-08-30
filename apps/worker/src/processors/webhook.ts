import type { Job } from 'bullmq';
import { WebhookJob, WebhookService } from '@smartchat/core';
import type { Database } from '@smartchat/database';
import type { Logger } from '@smartchat/logger';

/**
 * Deliver webhooks.
 *
 * Two jobs, and the second is why this design is trustworthy.
 *
 * `webhook.deliver` is the fast path: the API enqueues it the moment a delivery row is written, so
 * an endpoint usually hears within a second.
 *
 * `webhook.sweep` is the safety net: it asks the *database* what is due. Anything the fast path
 * never reached - because Redis was down when the row was written, because the queue was flushed,
 * because a job failed and its retries were exhausted - is picked up here. The row is the queue;
 * the job is only an optimisation, and this is the code that makes that claim true rather than
 * aspirational.
 */
export async function processWebhookJob(
  job: Job,
  db: Database,
  logger: Logger,
): Promise<void> {
  const webhooks = new WebhookService({ db });

  if (job.name === WebhookJob.DELIVER) {
    const { deliveryId } = job.data as { deliveryId: string };
    const result = await webhooks.attempt(deliveryId);
    logger.info({ deliveryId, ...result }, 'webhook delivery attempted');
    return;
  }

  if (job.name === WebhookJob.SWEEP) {
    // Bounded, so one account with a broken endpoint cannot starve everybody else's sweep.
    const due = await webhooks.dueDeliveries(200);
    let delivered = 0;
    let pending = 0;
    let failed = 0;

    for (const delivery of due) {
      try {
        const result = await webhooks.attempt(delivery.id);
        if (result.status === 'delivered') delivered += 1;
        else if (result.status === 'failed') failed += 1;
        else pending += 1;
      } catch (error) {
        // One endpoint's problem is not the sweep's problem.
        logger.error({ err: error, deliveryId: delivery.id }, 'webhook sweep: delivery threw');
      }
    }

    if (due.length > 0) {
      logger.info({ due: due.length, delivered, pending, failed }, 'webhook sweep finished');
    }
    return;
  }

  logger.warn({ jobName: job.name }, 'unknown webhook job - ignoring');
}
