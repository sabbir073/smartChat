import type { DatabaseOrTransaction, User } from '@smartchat/database';

export interface CreateUserInput {
  email: string;
  /**
   * Null for a user created by an invitation.
   *
   * The row has to exist so a membership can point at it, but nobody can sign in as that person
   * until they accept and choose a password - which is exactly what a null hash means, since
   * `verifyPassword` has nothing to compare against.
   */
  passwordHash: string | null;
  name: string;
  timezone?: string;
  locale?: string;
  emailVerifiedAt?: Date | null;
}

/**
 * Users are global, not tenant-owned: one person can belong to several accounts with a single
 * login. Tenant scoping happens at the membership level, never here.
 */
export class UserRepository {
  constructor(private readonly db: DatabaseOrTransaction) {}

  findById(id: string): Promise<User | null> {
    return this.db.user.findFirst({ where: { id, deletedAt: null } });
  }

  /** Citext column, so this is case-insensitive without a lower() index. */
  findByEmail(email: string): Promise<User | null> {
    return this.db.user.findFirst({ where: { email, deletedAt: null } });
  }

  create(input: CreateUserInput): Promise<User> {
    return this.db.user.create({
      data: {
        email: input.email,
        passwordHash: input.passwordHash,
        name: input.name,
        timezone: input.timezone ?? 'UTC',
        locale: input.locale ?? 'en',
        emailVerifiedAt: input.emailVerifiedAt ?? null,
      },
    });
  }

  updatePassword(userId: string, passwordHash: string): Promise<User> {
    return this.db.user.update({
      where: { id: userId },
      data: { passwordHash, failedLoginCount: 0, lockedUntil: null },
    });
  }

  markEmailVerified(userId: string, at: Date): Promise<User> {
    return this.db.user.update({
      where: { id: userId },
      data: { emailVerifiedAt: at },
    });
  }

  recordSuccessfulLogin(userId: string, at: Date): Promise<User> {
    return this.db.user.update({
      where: { id: userId },
      data: { lastLoginAt: at, failedLoginCount: 0, lockedUntil: null },
    });
  }

  recordFailedLogin(userId: string): Promise<User> {
    return this.db.user.update({
      where: { id: userId },
      data: { failedLoginCount: { increment: 1 } },
    });
  }

  updateProfile(
    userId: string,
    data: { name?: string; timezone?: string; locale?: string; avatarUrl?: string | null },
  ): Promise<User> {
    return this.db.user.update({ where: { id: userId }, data });
  }
}
