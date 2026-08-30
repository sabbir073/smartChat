import type { Job } from 'bullmq';
import type { MailProvider, SendEmailPayload } from '@smartchat/core';
import type { Database } from '@smartchat/database';
import type { Logger } from '@smartchat/logger';

/**
 * Deliver one queued email, and record what happened to it.
 *
 * Throwing is the correct behaviour on a transient failure: BullMQ's exponential backoff then
 * retries, which is exactly what a temporarily unreachable SMTP host needs. A permanent failure
 * exhausts the attempts and lands in the failed set, where it stays visible rather than vanishing.
 *
 * The delivery row is the part a person can look at. Sending is attempted first and the row is
 * updated afterwards: if this process dies between the two, the outcome is a row that still says
 * `queued` for a message that was sent, which is a discrepancy somebody can investigate. The
 * opposite order would produce a row claiming `sent` for a message that never left, which is a
 * discrepancy nobody would ever think to look for.
 */
export async function processEmailJob(
  job: Job<SendEmailPayload>,
  mailer: MailProvider,
  db: Database,
  logger: Logger,
): Promise<void> {
  const { message, requestId, deliveryId } = job.data;
  const attempt = job.attemptsMade + 1;

  logger.info(
    { jobId: job.id, attempt, to: message.to.email, requestId, deliveryId },
    'sending email',
  );

  try {
    await mailer.send(message);
  } catch (error) {
    if (deliveryId) {
      await recordOutcome(db, logger, deliveryId, {
        // Only the last attempt is a failure anybody should act on; before that it is still in
        // flight, and a row flapping to `failed` and back would make the table unreadable.
        status: attempt >= (job.opts.attempts ?? 1) ? 'failed' : 'queued',
        attempts: attempt,
        error: error instanceof Error ? error.message.slice(0, 500) : 'Unknown transport error',
      });
    }
    throw error;
  }

  if (deliveryId) {
    await recordOutcome(db, logger, deliveryId, {
      status: 'sent',
      attempts: attempt,
      error: null,
      sentAt: new Date(),
    });
  }

  logger.info({ jobId: job.id, to: message.to.email, subject: message.subject }, 'email sent');
}

/**
 * Update the delivery row without ever failing the job because of it.
 *
 * The email has already been sent by the time this runs. Throwing here would retry a *delivered*
 * message and send it twice, which is a worse outcome than a bookkeeping row that is out of date.
 */
async function recordOutcome(
  db: Database,
  logger: Logger,
  deliveryId: string,
  data: {
    status: 'queued' | 'sent' | 'failed';
    attempts: number;
    error: string | null;
    sentAt?: Date;
  },
): Promise<void> {
  try {
    await db.emailDelivery.update({ where: { id: deliveryId }, data });
  } catch (error) {
    logger.error({ err: error, deliveryId }, 'could not record email delivery outcome');
  }
}
