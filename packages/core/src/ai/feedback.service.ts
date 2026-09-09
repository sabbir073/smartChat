import type { Database } from '@smartchat/database';
import { AppError, ErrorCode } from '@smartchat/types';
import { systemClock, type Clock } from '../time.js';

/**
 * The visitor's thumbs up or down on an AI reply.
 *
 * Written twice, on purpose: on the turn, where analytics count it, and into the message's
 * metadata, where the widget reads it back after a reload and the inbox shows it next to the
 * reply. A rating can be changed or withdrawn; only the visitor who owns the conversation can
 * give one, and only on a bot message the AI wrote.
 */

export type AiRatingValue = 'up' | 'down';

export class AiFeedbackService {
  private readonly clock: Clock;

  constructor(private readonly options: { db: Database; clock?: Clock }) {
    this.clock = options.clock ?? systemClock;
  }

  async rate(
    identity: { accountId: string; propertyId: string; visitorId: string },
    messageId: string,
    rating: AiRatingValue | null,
  ): Promise<{ messageId: string; rating: AiRatingValue | null }> {
    const message = await this.options.db.message.findFirst({
      where: {
        id: messageId,
        accountId: identity.accountId,
        senderType: 'bot',
        conversation: { propertyId: identity.propertyId, visitorId: identity.visitorId, deletedAt: null },
      },
      select: { id: true, metadata: true },
    });
    const raw = (message?.metadata ?? null) as Record<string, unknown> | null;
    if (!message || raw?.['source'] !== 'ai') throw new AppError(ErrorCode.MESSAGE_NOT_FOUND);

    const now = this.clock.now();
    const metadata = { ...raw };
    if (rating) metadata['rating'] = rating;
    else delete metadata['rating'];

    await this.options.db.$transaction([
      this.options.db.message.update({ where: { id: message.id }, data: { metadata } }),
      this.options.db.aiTurn.updateMany({
        where: { accountId: identity.accountId, replyMessageId: message.id },
        data: { rating, ratedAt: rating ? now : null },
      }),
    ]);
    return { messageId: message.id, rating };
  }
}
