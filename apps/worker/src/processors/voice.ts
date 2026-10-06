import type { Job } from 'bullmq';
import { VoiceJob, type CallService, type VoiceRingTimeoutPayload } from '@smartchat/core';
import type { Logger } from '@smartchat/logger';

/**
 * The voice queue: the timers a call runs on.
 *
 * A ring timeout is a deadline, not work: the job carries the ring sequence it was set for, and
 * the call service does nothing when the call has moved on since. That is what makes the timer
 * safe to fire late, twice, or after a restart. The sweep is the net under the timers - every
 * minute, calls that got stuck because a job or a webhook never came are ended.
 */
export async function processVoiceJob(
  job: Job,
  logger: Logger,
  deps: { calls: CallService | null },
): Promise<void> {
  if (!deps.calls) {
    logger.warn({ name: job.name }, 'voice job received but calling is not enabled here');
    return;
  }
  switch (job.name) {
    case VoiceJob.RING_TIMEOUT: {
      const payload = job.data as VoiceRingTimeoutPayload;
      await deps.calls.ringTimeout(payload.accountId, payload.callId, payload.ringSeq);
      return;
    }
    case VoiceJob.TRANSFER_TIMEOUT: {
      const payload = job.data as VoiceRingTimeoutPayload;
      await deps.calls.transferTimeout(payload.accountId, payload.callId, payload.ringSeq);
      return;
    }
    case VoiceJob.AI_RETRY: {
      const payload = job.data as VoiceRingTimeoutPayload;
      await deps.calls.aiRetry(payload.accountId, payload.callId, payload.ringSeq);
      return;
    }
    case VoiceJob.SWEEP: {
      const touched = await deps.calls.sweep();
      if (touched > 0) logger.info({ touched }, 'voice sweep ended stuck calls');
      return;
    }
    default:
      logger.warn({ name: job.name }, 'unknown voice job');
  }
}
