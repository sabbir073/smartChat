import type { DatabaseOrTransaction, VerificationToken } from '@smartchat/database';
import { TokenPurpose, toJson } from '@smartchat/database';

export { TokenPurpose };

export interface IssueTokenInput {
  purpose: TokenPurpose;
  tokenHash: string;
  email: string;
  userId?: string | null;
  accountId?: string | null;
  expiresAt: Date;
  metadata?: Record<string, unknown>;
}

export class TokenRepository {
  constructor(private readonly db: DatabaseOrTransaction) {}

  create(input: IssueTokenInput): Promise<VerificationToken> {
    return this.db.verificationToken.create({
      data: {
        purpose: input.purpose,
        tokenHash: input.tokenHash,
        email: input.email,
        userId: input.userId ?? null,
        accountId: input.accountId ?? null,
        expiresAt: input.expiresAt,
        metadata: toJson(input.metadata),
      },
    });
  }

  /**
   * Invalidate every outstanding token of one purpose for one address.
   *
   * Issuing a new password-reset link must retire the previous one, otherwise an old email left in
   * an inbox stays usable for as long as its expiry allows.
   */
  async invalidateOutstanding(email: string, purpose: TokenPurpose, now: Date): Promise<void> {
    await this.db.verificationToken.updateMany({
      where: { email, purpose, consumedAt: null },
      data: { consumedAt: now },
    });
  }

  findUsable(
    tokenHash: string,
    purpose: TokenPurpose,
    now: Date,
  ): Promise<VerificationToken | null> {
    return this.db.verificationToken.findFirst({
      where: { tokenHash, purpose, consumedAt: null, expiresAt: { gt: now } },
    });
  }

  /**
   * Consume atomically.
   *
   * `updateMany` with `consumedAt: null` in the predicate means two concurrent requests carrying
   * the same link cannot both succeed — the second one updates zero rows.
   */
  async consume(tokenId: string, now: Date): Promise<boolean> {
    const result = await this.db.verificationToken.updateMany({
      where: { id: tokenId, consumedAt: null },
      data: { consumedAt: now },
    });
    return result.count === 1;
  }

  async purgeExpired(before: Date): Promise<number> {
    const result = await this.db.verificationToken.deleteMany({
      where: { expiresAt: { lt: before } },
    });
    return result.count;
  }
}
