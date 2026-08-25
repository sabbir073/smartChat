import type { DatabaseOrTransaction, Session, User } from '@smartchat/database';

export interface CreateSessionInput {
  userId: string;
  tokenHash: string;
  csrfSecret: string;
  expiresAt: Date;
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export type SessionWithUser = Session & { user: User };

export class SessionRepository {
  constructor(private readonly db: DatabaseOrTransaction) {}

  create(input: CreateSessionInput): Promise<Session> {
    return this.db.session.create({
      data: {
        userId: input.userId,
        tokenHash: input.tokenHash,
        csrfSecret: input.csrfSecret,
        expiresAt: input.expiresAt,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
      },
    });
  }

  /**
   * Look up by hash only. The raw token never reaches the database, so this is also the reason a
   * database dump contains no usable session cookies.
   */
  async findActiveByTokenHash(tokenHash: string, now: Date): Promise<SessionWithUser | null> {
    const session = await this.db.session.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
    if (!session) return null;
    if (session.revokedAt !== null) return null;
    if (session.expiresAt.getTime() <= now.getTime()) return null;
    if (session.user.deletedAt !== null) return null;
    return session;
  }

  /**
   * Refresh `lastSeenAt` at most once every few minutes.
   *
   * Writing on every request would turn a read-heavy dashboard into a write-heavy one for no
   * benefit — the field only drives the "last active" column in the session list.
   */
  async touch(sessionId: string, now: Date, minIntervalMs = 5 * 60_000): Promise<void> {
    await this.db.session.updateMany({
      where: { id: sessionId, lastSeenAt: { lt: new Date(now.getTime() - minIntervalMs) } },
      data: { lastSeenAt: now },
    });
  }

  async revoke(sessionId: string, now: Date): Promise<void> {
    await this.db.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: now },
    });
  }

  /** Used on password change and on "sign out everywhere". */
  async revokeAllForUser(userId: string, now: Date, exceptSessionId?: string): Promise<number> {
    const result = await this.db.session.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
      },
      data: { revokedAt: now },
    });
    return result.count;
  }

  listActiveForUser(userId: string, now: Date): Promise<Session[]> {
    return this.db.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: now } },
      orderBy: { lastSeenAt: 'desc' },
      take: 50,
    });
  }

  findByIdForUser(sessionId: string, userId: string): Promise<Session | null> {
    return this.db.session.findFirst({ where: { id: sessionId, userId } });
  }

  /** Retention: expired and revoked rows are pruned by a scheduled job, not kept forever. */
  async purgeExpired(before: Date): Promise<number> {
    const result = await this.db.session.deleteMany({
      where: { OR: [{ expiresAt: { lt: before } }, { revokedAt: { lt: before } }] },
    });
    return result.count;
  }
}
