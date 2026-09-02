import type { Account, Database, Session, User } from '@smartchat/database';
import { ActorType as DbActorType, MemberStatus } from '@smartchat/database';
import { AppError, ErrorCode } from '@smartchat/types';
import type {
  ChangePasswordInput,
  LoginInput,
  RegisterInput,
  ResetPasswordInput,
} from '@smartchat/validation';
import {
  fakePasswordVerification,
  hashPassword,
  needsRehash,
  verifyPassword,
} from '../crypto/password.js';
import { generateToken, hashToken } from '../crypto/tokens.js';
import { LogMailProvider } from '../mail/log.provider.js';
import type { MailProvider } from '../mail/provider.js';
import {
  passwordChangedTemplate,
  passwordResetTemplate,
  verifyEmailTemplate,
  type BrandContext,
} from '../mail/templates.js';
import { EmailJob, type QueueProducer } from '../queue/index.js';
import type { LoginThrottle } from '../redis/login-throttle.js';
import { AuditAction, AuditRepository } from '../repositories/audit.repository.js';
import { AccountRepository } from '../repositories/account.repository.js';
import { SessionRepository, type SessionWithUser } from '../repositories/session.repository.js';
import { TokenPurpose, TokenRepository } from '../repositories/token.repository.js';
import { UserRepository } from '../repositories/user.repository.js';
import { DAY, HOUR, MINUTE, addMs, systemClock, type Clock } from '../time.js';
import { uniqueSlug } from './slug.js';

export interface RequestMeta {
  requestId: string;
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export interface AuthServiceOptions {
  db: Database;
  queue: QueueProducer | null;
  mailer: MailProvider;
  throttle: LoginThrottle;
  brand: BrandContext;
  clock?: Clock;
  sessionTtlMs?: number;
  verificationTtlMs?: number;
  passwordResetTtlMs?: number;
  /** When true, new accounts skip email verification. Development and tests only. */
  autoVerifyEmail?: boolean;
}

export interface SessionIssue {
  token: string;
  session: Session;
  expiresAt: Date;
  csrfToken: string;
}

export interface RegisterResult {
  user: User;
  account: Account;
  session: SessionIssue;
  requiresEmailVerification: boolean;
}

export class AuthService {
  private readonly clock: Clock;
  private readonly sessionTtlMs: number;
  private readonly verificationTtlMs: number;
  private readonly passwordResetTtlMs: number;

  constructor(private readonly options: AuthServiceOptions) {
    this.clock = options.clock ?? systemClock;
    this.sessionTtlMs = options.sessionTtlMs ?? 30 * DAY;
    this.verificationTtlMs = options.verificationTtlMs ?? 24 * HOUR;
    this.passwordResetTtlMs = options.passwordResetTtlMs ?? 60 * MINUTE;
  }

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  /**
   * Create a user, their account, the default roles and the owner membership.
   *
   * All of it happens in one transaction: a half-created account with a user who cannot reach it
   * is far worse than a failed signup the person can simply retry.
   */
  async register(input: RegisterInput, meta: RequestMeta): Promise<RegisterResult> {
    const existing = await new UserRepository(this.options.db).findByEmail(input.email);
    if (existing) {
      throw new AppError(ErrorCode.EMAIL_ALREADY_REGISTERED);
    }

    const passwordHash = await hashPassword(input.password);
    const accountRepo = new AccountRepository(this.options.db);
    const slug = await uniqueSlug(input.accountName, (candidate) =>
      accountRepo.slugExists(candidate),
    );
    const now = this.clock.now();
    const autoVerify = this.options.autoVerifyEmail === true;

    const created = await this.options.db.$transaction(async (tx) => {
      const users = new UserRepository(tx);
      const accounts = new AccountRepository(tx);

      const user = await users.create({
        email: input.email,
        passwordHash,
        name: input.name,
        timezone: input.timezone,
        locale: input.locale,
        emailVerifiedAt: autoVerify ? now : null,
      });

      const { account } = await accounts.createWithOwner({
        name: input.accountName,
        slug,
        ownerUserId: user.id,
        timezone: input.timezone,
        locale: input.locale,
      });

      await new AuditRepository(tx).record({
        accountId: account.id,
        actorType: DbActorType.user,
        actorId: user.id,
        actorLabel: user.email,
        action: AuditAction.ACCOUNT_CREATED,
        resourceType: 'account',
        resourceId: account.id,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        metadata: { slug, plan: 'free' },
      });

      return { user, account };
    });

    if (!autoVerify) {
      await this.sendVerificationEmail(created.user, meta);
    }

    const session = await this.issueSession(created.user.id, meta);

    return {
      user: created.user,
      account: created.account,
      session,
      requiresEmailVerification: !autoVerify,
    };
  }

  // ---------------------------------------------------------------------------
  // Login / logout
  // ---------------------------------------------------------------------------

  /**
   * Authenticate.
   *
   * Failure is deliberately uniform: the same error and roughly the same latency whether the
   * address is unknown or the password is wrong, so login cannot be used to enumerate accounts.
   */
  async login(
    input: LoginInput,
    meta: RequestMeta,
  ): Promise<{ user: User; session: SessionIssue }> {
    const throttleKey = `${input.email}|${meta.ip ?? 'unknown'}`;
    const state = await this.options.throttle.check(throttleKey);
    if (state.locked) {
      throw new AppError(ErrorCode.ACCOUNT_LOCKED, undefined, {
        context: { retryAfterMs: state.retryAfterMs },
      });
    }

    const users = new UserRepository(this.options.db);
    const user = await users.findByEmail(input.email);

    if (!user) {
      await fakePasswordVerification();
      await this.options.throttle.recordFailure(throttleKey);
      await this.recordLoginFailure(null, input.email, meta, 'unknown_email');
      throw new AppError(ErrorCode.INVALID_CREDENTIALS);
    }

    // An invited user who has not accepted yet has no password. That must look exactly like a
    // wrong password, or the login form becomes a way to discover who has been invited.
    const valid = await verifyPassword(user.passwordHash, input.password);
    if (!valid) {
      await Promise.all([
        this.options.throttle.recordFailure(throttleKey),
        users.recordFailedLogin(user.id),
        this.recordLoginFailure(user.id, user.email, meta, 'bad_password'),
      ]);
      throw new AppError(ErrorCode.INVALID_CREDENTIALS);
    }

    // Upgrade transparently when hashing parameters have been strengthened since this password
    // was last set. The person never sees it.
    if (needsRehash(user.passwordHash)) {
      await users.updatePassword(user.id, await hashPassword(input.password));
    }

    await this.options.throttle.recordSuccess(throttleKey);
    await users.recordSuccessfulLogin(user.id, this.clock.now());

    const session = await this.issueSession(user.id, meta, input.remember);

    const membership = await new AccountRepository(this.options.db).listMembershipsForUser(user.id);
    await new AuditRepository(this.options.db).record({
      accountId: membership[0]?.accountId ?? null,
      actorType: DbActorType.user,
      actorId: user.id,
      actorLabel: user.email,
      action: AuditAction.USER_LOGIN,
      resourceType: 'session',
      resourceId: session.session.id,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    });

    return { user, session };
  }

  async logout(sessionToken: string, meta: RequestMeta): Promise<void> {
    const sessions = new SessionRepository(this.options.db);
    const session = await sessions.findActiveByTokenHash(hashToken(sessionToken), this.clock.now());
    if (!session) return;

    await sessions.revoke(session.id, this.clock.now());
    await new AuditRepository(this.options.db).record({
      actorType: DbActorType.user,
      actorId: session.userId,
      actorLabel: session.user.email,
      action: AuditAction.USER_LOGOUT,
      resourceType: 'session',
      resourceId: session.id,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    });
  }

  /** Resolve a raw cookie value to a live session. Returns null for anything not currently valid. */
  async resolveSession(sessionToken: string): Promise<SessionWithUser | null> {
    if (!sessionToken || sessionToken.length < 20 || sessionToken.length > 200) return null;
    const sessions = new SessionRepository(this.options.db);
    const session = await sessions.findActiveByTokenHash(hashToken(sessionToken), this.clock.now());
    if (!session) return null;
    await sessions.touch(session.id, this.clock.now());
    return session;
  }

  async listSessions(userId: string): Promise<Session[]> {
    return new SessionRepository(this.options.db).listActiveForUser(userId, this.clock.now());
  }

  async revokeSession(userId: string, sessionId: string, meta: RequestMeta): Promise<boolean> {
    const sessions = new SessionRepository(this.options.db);
    const session = await sessions.findByIdForUser(sessionId, userId);
    if (!session) return false;
    await sessions.revoke(sessionId, this.clock.now());
    await new AuditRepository(this.options.db).record({
      actorType: DbActorType.user,
      actorId: userId,
      action: AuditAction.SESSION_REVOKED,
      resourceType: 'session',
      resourceId: sessionId,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    });
    return true;
  }

  // ---------------------------------------------------------------------------
  // Email verification
  // ---------------------------------------------------------------------------

  async sendVerificationEmail(user: User, meta: RequestMeta): Promise<void> {
    const tokens = new TokenRepository(this.options.db);
    const now = this.clock.now();
    await tokens.invalidateOutstanding(user.email, TokenPurpose.email_verification, now);

    const raw = generateToken();
    await tokens.create({
      purpose: TokenPurpose.email_verification,
      tokenHash: hashToken(raw),
      email: user.email,
      userId: user.id,
      expiresAt: addMs(now, this.verificationTtlMs),
    });

    await this.deliver(
      verifyEmailTemplate(this.options.brand, {
        name: user.name,
        email: user.email,
        url: `${this.options.brand.appUrl}/verify-email?token=${encodeURIComponent(raw)}`,
        expiresInHours: Math.round(this.verificationTtlMs / HOUR),
      }),
      meta,
    );
  }

  async verifyEmail(token: string, meta: RequestMeta): Promise<User> {
    const tokens = new TokenRepository(this.options.db);
    const now = this.clock.now();
    const record = await tokens.findUsable(hashToken(token), TokenPurpose.email_verification, now);
    if (!record?.userId) throw new AppError(ErrorCode.INVALID_TOKEN);

    if (!(await tokens.consume(record.id, now))) {
      throw new AppError(ErrorCode.INVALID_TOKEN);
    }

    const user = await new UserRepository(this.options.db).markEmailVerified(record.userId, now);
    await new AuditRepository(this.options.db).record({
      actorType: DbActorType.user,
      actorId: user.id,
      actorLabel: user.email,
      action: AuditAction.USER_EMAIL_VERIFIED,
      resourceType: 'user',
      resourceId: user.id,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    });
    return user;
  }

  /**
   * Resend verification. Returns nothing regardless of whether the address exists — the response
   * must not reveal which addresses are registered.
   */
  async resendVerification(email: string, meta: RequestMeta): Promise<void> {
    const user = await new UserRepository(this.options.db).findByEmail(email);
    if (!user || user.emailVerifiedAt) return;
    await this.sendVerificationEmail(user, meta);
  }

  // ---------------------------------------------------------------------------
  // Password reset
  // ---------------------------------------------------------------------------

  /** Always succeeds from the caller's point of view. See `resendVerification`. */
  async requestPasswordReset(email: string, meta: RequestMeta): Promise<void> {
    const user = await new UserRepository(this.options.db).findByEmail(email);
    if (!user) return;

    const tokens = new TokenRepository(this.options.db);
    const now = this.clock.now();
    await tokens.invalidateOutstanding(user.email, TokenPurpose.password_reset, now);

    const raw = generateToken();
    await tokens.create({
      purpose: TokenPurpose.password_reset,
      tokenHash: hashToken(raw),
      email: user.email,
      userId: user.id,
      expiresAt: addMs(now, this.passwordResetTtlMs),
    });

    await this.deliver(
      passwordResetTemplate(this.options.brand, {
        name: user.name,
        email: user.email,
        url: `${this.options.brand.appUrl}/reset-password?token=${encodeURIComponent(raw)}`,
        expiresInMinutes: Math.round(this.passwordResetTtlMs / MINUTE),
      }),
      meta,
    );
  }

  async resetPassword(input: ResetPasswordInput, meta: RequestMeta): Promise<User> {
    const tokens = new TokenRepository(this.options.db);
    const now = this.clock.now();
    const record = await tokens.findUsable(
      hashToken(input.token),
      TokenPurpose.password_reset,
      now,
    );
    if (!record?.userId) throw new AppError(ErrorCode.INVALID_TOKEN);
    if (!(await tokens.consume(record.id, now))) throw new AppError(ErrorCode.INVALID_TOKEN);

    const passwordHash = await hashPassword(input.password);
    const users = new UserRepository(this.options.db);
    const user = await users.updatePassword(record.userId, passwordHash);

    // Anyone holding a stolen session for this account loses it the moment the password changes.
    await new SessionRepository(this.options.db).revokeAllForUser(user.id, now);

    await new AuditRepository(this.options.db).record({
      actorType: DbActorType.user,
      actorId: user.id,
      actorLabel: user.email,
      action: AuditAction.USER_PASSWORD_RESET,
      resourceType: 'user',
      resourceId: user.id,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    });

    await this.deliver(
      passwordChangedTemplate(this.options.brand, {
        name: user.name,
        email: user.email,
        when: now.toUTCString(),
      }),
      meta,
    );

    return user;
  }

  async changePassword(
    userId: string,
    input: ChangePasswordInput,
    currentSessionId: string | undefined,
    meta: RequestMeta,
  ): Promise<void> {
    const users = new UserRepository(this.options.db);
    const user = await users.findById(userId);
    if (!user) throw new AppError(ErrorCode.UNAUTHENTICATED);

    if (!(await verifyPassword(user.passwordHash, input.currentPassword))) {
      throw new AppError(ErrorCode.INVALID_CREDENTIALS, 'Your current password is incorrect');
    }

    const now = this.clock.now();
    await users.updatePassword(user.id, await hashPassword(input.newPassword));
    await new SessionRepository(this.options.db).revokeAllForUser(user.id, now, currentSessionId);

    await new AuditRepository(this.options.db).record({
      actorType: DbActorType.user,
      actorId: user.id,
      actorLabel: user.email,
      action: AuditAction.USER_PASSWORD_CHANGED,
      resourceType: 'user',
      resourceId: user.id,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    });

    await this.deliver(
      passwordChangedTemplate(this.options.brand, {
        name: user.name,
        email: user.email,
        when: now.toUTCString(),
      }),
      meta,
    );
  }

  // ---------------------------------------------------------------------------
  // Invitations
  // ---------------------------------------------------------------------------
  //
  // Not here. `TeamService.sendInvitation` owns this, and this class held a complete second
  // implementation of it - invalidate outstanding tokens, mint a `member_invitation` token, send
  // the mail - that nothing ever called. Two ways to issue a credential is one way too many: the
  // day somebody tightens the expiry, or adds a rate limit, or starts logging invitations, they
  // will do it to one of them.

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Sign somebody in without a password.
   *
   * Used by flows where the caller has already proved who they are by other means - accepting an
   * invitation from a single-use emailed token. It is deliberately explicit rather than a flag on
   * `login`, so every call site that skips a password is visible.
   */
  async issueSessionFor(userId: string, meta: RequestMeta): Promise<SessionIssue> {
    return this.issueSession(userId, meta);
  }

  private async issueSession(
    userId: string,
    meta: RequestMeta,
    remember = true,
  ): Promise<SessionIssue> {
    const token = generateToken();
    const csrfToken = generateToken(24);
    const expiresAt = addMs(this.clock.now(), remember ? this.sessionTtlMs : 12 * HOUR);

    const session = await new SessionRepository(this.options.db).create({
      userId,
      tokenHash: hashToken(token),
      csrfSecret: csrfToken,
      expiresAt,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return { token, session, expiresAt, csrfToken };
  }

  private async recordLoginFailure(
    userId: string | null,
    email: string,
    meta: RequestMeta,
    reason: string,
  ): Promise<void> {
    await new AuditRepository(this.options.db).record({
      actorType: DbActorType.user,
      actorId: userId,
      actorLabel: email,
      action: AuditAction.USER_LOGIN_FAILED,
      resourceType: 'user',
      resourceId: userId,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      metadata: { reason },
    });
  }

  /**
   * Hand the message to the queue so a slow SMTP server can never delay an HTTP response.
   * Without a queue (tests, single-process dev) it is sent inline.
   */
  private async deliver(
    message: Parameters<MailProvider['send']>[0],
    meta: RequestMeta,
  ): Promise<void> {
    if (this.options.queue) {
      await this.options.queue.enqueue(EmailJob.SEND, {
        message,
        requestId: meta.requestId,
      });
      return;
    }
    await this.options.mailer.send(message);
  }
}

export { LogMailProvider, MemberStatus };
