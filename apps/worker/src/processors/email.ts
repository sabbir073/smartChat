import type { Job } from 'bullmq';
import type { MailProvider, SendEmailPayload } from '@smartchat/core';
import type { Logger } from '@smartchat/logger';

/**
 * Deliver one queued email.
 *
 * Throwing is the correct behaviour on a transient failure: BullMQ's exponential backoff then
 * retries, which is exactly what a temporarily unreachable SMTP host needs. A permanent failure
 * exhausts the attempts and lands in the failed set, where it stays visible rather than vanishing.
 */
export async function processEmailJob(
  job: Job<SendEmailPayload>,
  mailer: MailProvider,
  logger: Logger,
): Promise<void> {
  const { message, requestId } = job.data;

  logger.info(
    { jobId: job.id, attempt: job.attemptsMade + 1, to: message.to.email, requestId },
    'sending email',
  );

  await mailer.send(message);

  logger.info({ jobId: job.id, to: message.to.email, subject: message.subject }, 'email sent');
}
