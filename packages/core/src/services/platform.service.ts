import type {
  Account,
  BillingInterval,
  Database,
  FeatureFlag,
  PlanChangeStatus,
  PlatformAdmin,
} from '@smartchat/database';
import {
  AppError,
  ErrorCode,
  PLATFORM_FLAG_DESCRIPTIONS,
  PLATFORM_FLAG_VALUES,
  PlatformPermission,
  type PlatformFlag,
} from '@smartchat/types';
import { periodEnd, priceForInterval } from '../billing/periods.js';
import type { EntitlementService } from './entitlement.service.js';
import { fakePasswordVerification, verifyPassword } from '../crypto/password.js';
import { generateToken, hashToken } from '../crypto/tokens.js';
import { systemClock, type Clock } from '../time.js';

/**
 * The platform console.
 *
 * A different product from the dashboard, sharing a database. Everything here acts *on* accounts
 * from outside them, which is why none of it goes through `TenantContext`: that object exists to
 * make tenant scoping impossible to forget, and an operator suspending an account is deliberately
 * not scoped to it. Using it here would either be a lie or would have to be defeated, and both are
 * worse than a separate path with its own permissions and its own audit log.
 */

export interface PlatformPrincipal {
  adminId: string;
  email: string;
  name: string;
  permissions: Set<PlatformPermission>;
}

export interface PlatformServiceOptions {
  db: Database;
  clock?: Clock;
  sessionTtlMs?: number;
  /**
   * The entitlement cache, so an operator's decision reaches the customer at once.
   *
   * Required rather than optional. Entitlements are cached for thirty seconds; when an operator
   * approves an upgrade, that cache is the difference between the customer's new limit working
   * immediately and their next click still being refused for reasons they cannot see. An optional
   * dependency here is one that gets omitted, and the symptom is a support conversation about a
   * plan the customer has already paid for.
   */
  entitlements: EntitlementService;
}

export interface PlatformAccountSummary {
  id: string;
  name: string;
  slug: string;
  status: string;
  createdAt: string;
  suspendedAt: string | null;
  suspendedReason: string | null;
  planCode: string;
  planName: string;
  memberCount: number;
  propertyCount: number;
  conversationCount: number;
}

function requirePlatformPermission(
  principal: PlatformPrincipal,
  permission: PlatformPermission,
): void {
  if (!principal.permissions.has(permission)) {
    throw new AppError(ErrorCode.FORBIDDEN, 'Your platform role does not include that');
  }
}

export class PlatformService {
  private readonly clock: Clock;
  private readonly sessionTtlMs: number;

  constructor(private readonly options: PlatformServiceOptions) {
    this.clock = options.clock ?? systemClock;
    this.sessionTtlMs = options.sessionTtlMs ?? 8 * 60 * 60 * 1000;
  }

  // ---------------------------------------------------------------------------
  // Signing in
  // ---------------------------------------------------------------------------

  /**
   * Sign a platform administrator in.
   *
   * Deliberately not the tenant `AuthService`. There is no registration, no invitation, no
   * password reset by email and no "remember me": a platform account is created by an operator
   * with database access, and every convenience the dashboard has is an extra door on the most
   * privileged credential in the system.
   *
   * The session is eight hours rather than thirty days, for the same reason.
   */
  async signIn(input: {
    email: string;
    password: string;
    ip?: string;
    userAgent?: string;
  }): Promise<{ token: string; admin: PlatformAdmin }> {
    const admin = await this.options.db.platformAdmin.findUnique({
      where: { email: input.email },
    });

    const now = this.clock.now();
    // One answer for a missing admin, a wrong password, a locked account and a disabled one.
    const refuse = (): never => {
      throw new AppError(ErrorCode.INVALID_CREDENTIALS);
    };

    if (!admin || !admin.isActive) {
      // Spend the same time as a real verification, so a missing address does not answer
      // measurably faster than a wrong password.
      await fakePasswordVerification();
      return refuse();
    }
    if (admin.lockedUntil && admin.lockedUntil.getTime() > now.getTime()) return refuse();

    const valid = await verifyPassword(admin.passwordHash, input.password);
    if (!valid) {
      const failures = admin.failedLoginCount + 1;
      await this.options.db.platformAdmin.update({
        where: { id: admin.id },
        data: {
          failedLoginCount: failures,
          // Five wrong passwords locks it for fifteen minutes. Short enough to be an annoyance
          // for the real operator, long enough to make an online guessing attack pointless.
          ...(failures >= 5 ? { lockedUntil: new Date(now.getTime() + 15 * 60 * 1000) } : {}),
        },
      });
      return refuse();
    }

    const token = generateToken(32);
    await this.options.db.$transaction([
      this.options.db.platformSession.create({
        data: {
          adminId: admin.id,
          tokenHash: hashToken(token),
          ip: input.ip ?? null,
          userAgent: input.userAgent ?? null,
          expiresAt: new Date(now.getTime() + this.sessionTtlMs),
        },
      }),
      this.options.db.platformAdmin.update({
        where: { id: admin.id },
        data: { lastLoginAt: now, failedLoginCount: 0, lockedUntil: null },
      }),
    ]);

    await this.record(admin.id, 'platform.signed_in', null, {}, input.ip);
    return { token, admin };
  }

  async resolveSession(token: string): Promise<PlatformPrincipal | null> {
    const session = await this.options.db.platformSession.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { admin: true },
    });
    if (!session || session.revokedAt) return null;
    if (session.expiresAt.getTime() <= this.clock.now().getTime()) return null;
    if (!session.admin.isActive) return null;

    await this.options.db.platformSession
      .update({ where: { id: session.id }, data: { lastSeenAt: this.clock.now() } })
      .catch(() => undefined);

    return {
      adminId: session.admin.id,
      email: session.admin.email,
      name: session.admin.name,
      permissions: new Set(session.admin.permissions as PlatformPermission[]),
    };
  }

  async signOut(token: string): Promise<void> {
    await this.options.db.platformSession
      .updateMany({
        where: { tokenHash: hashToken(token), revokedAt: null },
        data: { revokedAt: this.clock.now() },
      })
      .catch(() => undefined);
  }

  // ---------------------------------------------------------------------------
  // Accounts
  // ---------------------------------------------------------------------------

  async listAccounts(
    principal: PlatformPrincipal,
    query: { search?: string; status?: string; limit: number },
  ): Promise<PlatformAccountSummary[]> {
    requirePlatformPermission(principal, PlatformPermission.ACCOUNT_VIEW);

    const accounts = await this.options.db.account.findMany({
      where: {
        deletedAt: null,
        ...(query.status ? { status: query.status as Account['status'] } : {}),
        ...(query.search
          ? {
              OR: [
                { name: { contains: query.search, mode: 'insensitive' } },
                { slug: { contains: query.search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }],
      take: query.limit,
      include: {
        subscription: { include: { plan: true } },
        _count: { select: { members: true, properties: true, conversations: true } },
      },
    });

    return accounts.map((account) => ({
      id: account.id,
      name: account.name,
      slug: account.slug,
      status: account.status,
      createdAt: account.createdAt.toISOString(),
      suspendedAt: account.suspendedAt?.toISOString() ?? null,
      suspendedReason: account.suspendedReason,
      planCode: account.subscription?.plan.code ?? 'none',
      planName: account.subscription?.plan.name ?? 'No plan',
      memberCount: account._count.members,
      propertyCount: account._count.properties,
      conversationCount: account._count.conversations,
    }));
  }

  /**
   * Suspend an account.
   *
   * The reason is required, and it is not decoration: it is what the account's own people are
   * shown, and it is the only thing that turns "everything stopped working" into something a
   * support conversation can start from.
   */
  async suspendAccount(
    principal: PlatformPrincipal,
    accountId: string,
    reason: string,
    ip?: string,
  ): Promise<PlatformAccountSummary> {
    requirePlatformPermission(principal, PlatformPermission.ACCOUNT_SUSPEND);
    const account = await this.options.db.account.findFirst({
      where: { id: accountId, deletedAt: null },
    });
    if (!account) throw new AppError(ErrorCode.ACCOUNT_NOT_FOUND);

    await this.options.db.account.update({
      where: { id: accountId },
      data: {
        status: 'suspended',
        suspendedAt: this.clock.now(),
        suspendedReason: reason,
      },
    });

    await this.record(principal.adminId, 'account.suspended', accountId, { reason }, ip);
    const [summary] = await this.listAccounts(principal, { limit: 1, search: account.slug });
    if (!summary) throw new AppError(ErrorCode.ACCOUNT_NOT_FOUND);
    return summary;
  }

  async resumeAccount(
    principal: PlatformPrincipal,
    accountId: string,
    ip?: string,
  ): Promise<PlatformAccountSummary> {
    requirePlatformPermission(principal, PlatformPermission.ACCOUNT_SUSPEND);
    const account = await this.options.db.account.findFirst({
      where: { id: accountId, deletedAt: null },
    });
    if (!account) throw new AppError(ErrorCode.ACCOUNT_NOT_FOUND);

    await this.options.db.account.update({
      where: { id: accountId },
      data: { status: 'active', suspendedAt: null, suspendedReason: null },
    });

    await this.record(principal.adminId, 'account.resumed', accountId, {}, ip);
    const [summary] = await this.listAccounts(principal, { limit: 1, search: account.slug });
    if (!summary) throw new AppError(ErrorCode.ACCOUNT_NOT_FOUND);
    return summary;
  }

  // ---------------------------------------------------------------------------
  // Plans
  // ---------------------------------------------------------------------------

  async listPlans(principal: PlatformPrincipal) {
    requirePlatformPermission(principal, PlatformPermission.PLAN_MANAGE);
    const plans = await this.options.db.plan.findMany({
      include: { features: true },
      orderBy: [{ sortOrder: 'asc' }, { priceMonthlyCents: 'asc' }],
    });
    return plans.map((plan) => ({
      id: plan.id,
      code: plan.code,
      name: plan.name,
      priceMonthlyCents: plan.priceMonthlyCents,
      currency: plan.currency,
      isPublic: plan.isPublic,
      features: plan.features.map((feature) => ({
        key: feature.key,
        boolValue: feature.boolValue,
        limitValue: feature.limitValue === null ? null : Number(feature.limitValue),
      })),
    }));
  }

  /**
   * Move an account to a plan, by operator decision.
   *
   * This is the override, not the ordinary path: a customer changes plan through
   * `SubscriptionService`, which goes through the billing provider and leaves a request row behind
   * it. This one exists for the cases that never fit that - an Enterprise agreement signed offline,
   * a goodwill upgrade, a correction - and it is audited as an operator action so the difference is
   * visible later.
   *
   * It starts a fresh billing period rather than keeping the old one, because assigning a plan is
   * the start of a new commercial arrangement and invoicing the remainder of somebody else's month
   * would be wrong in both directions.
   */
  async assignPlan(
    principal: PlatformPrincipal,
    accountId: string,
    planCode: string,
    ip?: string,
    interval: BillingInterval = 'monthly',
  ): Promise<void> {
    requirePlatformPermission(principal, PlatformPermission.PLAN_MANAGE);

    const [account, plan] = await Promise.all([
      this.options.db.account.findFirst({ where: { id: accountId, deletedAt: null } }),
      this.options.db.plan.findUnique({ where: { code: planCode } }),
    ]);
    if (!account) throw new AppError(ErrorCode.ACCOUNT_NOT_FOUND);
    if (!plan) throw new AppError(ErrorCode.NOT_FOUND, 'No such plan');

    const now = this.clock.now();
    await this.options.db.subscription.upsert({
      where: { accountId },
      create: {
        accountId,
        planId: plan.id,
        interval,
        status: 'active',
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd(now, interval),
      },
      update: {
        planId: plan.id,
        interval,
        status: 'active',
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd(now, interval),
        // An operator putting somebody on a plan is resolving whatever was wrong before it.
        graceEndsAt: null,
        pausedAt: null,
        cancelAtPeriodEnd: false,
        canceledAt: null,
      },
    });

    this.options.entitlements.invalidate(accountId);

    await this.record(
      principal.adminId,
      'account.plan_changed',
      accountId,
      { planCode, interval },
      ip,
    );
  }

  // ---------------------------------------------------------------------------
  // Plan change requests: the operator half of the manual billing provider
  // ---------------------------------------------------------------------------

  async listPlanChanges(principal: PlatformPrincipal, status: PlanChangeStatus = 'pending') {
    requirePlatformPermission(principal, PlatformPermission.PLAN_MANAGE);
    const rows = await this.options.db.planChangeRequest.findMany({
      where: { status },
      include: { account: { include: { subscription: true } }, fromPlan: true, toPlan: true },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });

    return rows.map((row) => ({
      id: row.id,
      accountId: row.accountId,
      accountName: row.account.name,
      fromPlan: row.fromPlan.name,
      toPlan: row.toPlan.code,
      toPlanName: row.toPlan.name,
      interval: row.interval,
      requestedByEmail: row.requestedByEmail,
      createdAt: row.createdAt,
      status: row.status,
      /**
       * Whether anybody actually has to decide this.
       *
       * A move to a cheaper plan is already agreed - it is only waiting for the period the
       * customer paid for to run out, and the sweeper applies it. Showing it beside genuine
       * upgrade requests would invite an operator to "approve" a downgrade early and take away a
       * fortnight the customer has already bought.
       */
      kind:
        priceForInterval(row.toPlan, row.interval) < priceForInterval(row.fromPlan, row.interval)
          ? ('scheduled_downgrade' as const)
          : ('upgrade_request' as const),
      effectiveAt: row.account.subscription?.currentPeriodEnd ?? null,
    }));
  }

  /**
   * Approve or refuse a plan change.
   *
   * Approving applies it through the same code path a customer's own upgrade takes, so there is
   * exactly one way a subscription moves between plans. Refusing records the reason, which the
   * customer sees - "no" without a reason is how a support ticket gets opened.
   */
  async decidePlanChange(
    principal: PlatformPrincipal,
    requestId: string,
    decision: 'approved' | 'rejected',
    options: { note?: string | undefined; apply: (accountId: string, planId: string, interval: BillingInterval) => Promise<unknown> },
    ip?: string,
  ): Promise<void> {
    requirePlatformPermission(principal, PlatformPermission.PLAN_MANAGE);

    const request = await this.options.db.planChangeRequest.findUnique({
      where: { id: requestId },
      include: { toPlan: true },
    });
    if (!request) throw new AppError(ErrorCode.NOT_FOUND);
    if (request.status !== 'pending') {
      throw new AppError(ErrorCode.CONFLICT, 'That request has already been decided.');
    }

    if (decision === 'approved') {
      await options.apply(request.accountId, request.toPlanId, request.interval);
    }

    await this.options.db.planChangeRequest.update({
      where: { id: request.id },
      data: {
        status: decision,
        decidedByAdminId: principal.adminId,
        decidedAt: this.clock.now(),
        note: options.note ?? null,
      },
    });

    // Whatever was decided, what the account is entitled to may have just moved. Approving is the
    // obvious case; refusing matters too, because the customer's screen has to stop saying that
    // something is waiting on us.
    this.options.entitlements.invalidate(request.accountId);

    await this.record(
      principal.adminId,
      decision === 'approved' ? 'plan_change.approved' : 'plan_change.rejected',
      request.accountId,
      { requestId, toPlan: request.toPlan.code, note: options.note ?? null },
      ip,
    );
  }

  async listInvoices(principal: PlatformPrincipal, accountId?: string) {
    requirePlatformPermission(principal, PlatformPermission.USAGE_VIEW);
    return this.options.db.invoice.findMany({
      where: accountId ? { accountId } : {},
      include: { account: { select: { name: true } } },
      orderBy: { issuedAt: 'desc' },
      take: 100,
    });
  }

  /**
   * Record that an invoice was paid.
   *
   * The whole of "taking the money" in the manual provider. `reference` is free text because what
   * identifies a payment differs per customer - a bank reference, a purchase order, a note saying
   * it was waived - and forcing it into a shape would just mean people write in the wrong field.
   */
  async markInvoicePaid(
    principal: PlatformPrincipal,
    invoiceId: string,
    reference: string | null,
    ip?: string,
  ): Promise<void> {
    requirePlatformPermission(principal, PlatformPermission.PLAN_MANAGE);

    const invoice = await this.options.db.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) throw new AppError(ErrorCode.NOT_FOUND);
    if (invoice.status === 'void') {
      throw new AppError(ErrorCode.CONFLICT, 'That invoice was voided.');
    }
    if (invoice.status === 'paid') return; // Idempotent: recording a payment twice is not an error.

    const now = this.clock.now();
    await this.options.db.$transaction([
      this.options.db.invoice.update({
        where: { id: invoiceId },
        data: { status: 'paid', paidAt: now, reference },
      }),
      // Paying clears the arrears: the subscription leaves `past_due` (or `paused`) and its grace
      // window is dropped. Nothing was deleted while it was paused, so this restores service whole.
      this.options.db.subscription.updateMany({
        where: { accountId: invoice.accountId, status: { in: ['past_due', 'paused'] } },
        data: { status: 'active', graceEndsAt: null, pausedAt: null },
      }),
    ]);

    // A payment can lift a pause, and a paused account is one where every write is being refused.
    // Leaving that in a cache for half a minute is half a minute of a paying customer being told no.
    this.options.entitlements.invalidate(invoice.accountId);

    await this.record(
      principal.adminId,
      'invoice.paid',
      invoice.accountId,
      { invoiceId, number: invoice.number, amountCents: invoice.amountCents },
      ip,
    );
  }

  // ---------------------------------------------------------------------------
  // Usage and health
  // ---------------------------------------------------------------------------

  async usage(principal: PlatformPrincipal, accountId: string) {
    requirePlatformPermission(principal, PlatformPermission.USAGE_VIEW);
    const [conversations, messages, properties, members, tickets, articles, attachments] =
      await Promise.all([
        this.options.db.conversation.count({ where: { accountId, deletedAt: null } }),
        this.options.db.message.count({ where: { accountId, deletedAt: null } }),
        this.options.db.property.count({ where: { accountId, deletedAt: null } }),
        this.options.db.accountMember.count({ where: { accountId, deletedAt: null } }),
        this.options.db.ticket.count({ where: { accountId, deletedAt: null } }),
        this.options.db.kbArticle.count({ where: { accountId, deletedAt: null } }),
        this.options.db.attachment.aggregate({
          where: { accountId, status: 'ready' },
          _sum: { byteSize: true },
          _count: true,
        }),
      ]);

    return {
      conversations,
      messages,
      properties,
      members,
      tickets,
      articles,
      files: attachments._count,
      storageBytes: Number(attachments._sum.byteSize ?? 0),
    };
  }

  /**
   * Is the platform working?
   *
   * Each check is a real query against the thing it claims to check, with its own timing. "The
   * process is up" is a different question from "the database answers", and a health page that
   * conflates them is a health page that is green during an outage.
   */
  async health(principal: PlatformPrincipal) {
    requirePlatformPermission(principal, PlatformPermission.SYSTEM_VIEW);

    const time = async <T>(check: () => Promise<T>) => {
      const started = Date.now();
      try {
        await check();
        return { ok: true, ms: Date.now() - started };
      } catch (error) {
        return {
          ok: false,
          ms: Date.now() - started,
          error: error instanceof Error ? error.message.slice(0, 200) : 'failed',
        };
      }
    };

    const [database, counts] = await Promise.all([
      time(() => this.options.db.$queryRaw`SELECT 1`),
      Promise.all([
        this.options.db.account.count({ where: { deletedAt: null, status: 'active' } }),
        this.options.db.account.count({ where: { status: 'suspended' } }),
        this.options.db.webhookDelivery.count({ where: { status: 'pending' } }),
        this.options.db.emailDelivery.count({ where: { status: 'queued' } }),
        this.options.db.webhookDelivery.count({ where: { status: 'failed' } }),
      ]),
    ]);

    return {
      database,
      activeAccounts: counts[0],
      suspendedAccounts: counts[1],
      /**
       * A pending count that keeps growing is the alarm the delivery tables exist for. It is
       * reported rather than judged - "how many is too many" depends on the hour of the day, and a
       * threshold guessed here would either cry wolf or stay quiet during the outage.
       */
      pendingWebhookDeliveries: counts[2],
      queuedEmails: counts[3],
      failedWebhookDeliveries: counts[4],
    };
  }

  // ---------------------------------------------------------------------------
  // Feature flags
  // ---------------------------------------------------------------------------

  /**
   * The flags, with any that do not exist yet filled in from the closed list.
   *
   * Created lazily rather than seeded, so the set an operator sees is always exactly the set the
   * code reads - adding a flag to `PlatformFlag` makes it appear here, and removing one makes it
   * disappear rather than lingering as a switch attached to nothing.
   */
  async listFlags(principal: PlatformPrincipal): Promise<FeatureFlag[]> {
    requirePlatformPermission(principal, PlatformPermission.FEATURE_FLAG_MANAGE);
    const existing = await this.options.db.featureFlag.findMany();
    const byKey = new Map(existing.map((flag) => [flag.key, flag]));

    const result: FeatureFlag[] = [];
    for (const key of PLATFORM_FLAG_VALUES) {
      const found = byKey.get(key);
      result.push(
        found ??
          (await this.options.db.featureFlag.create({
            data: { key, description: PLATFORM_FLAG_DESCRIPTIONS[key], enabled: true },
          })),
      );
    }
    return result;
  }

  async setFlag(
    principal: PlatformPrincipal,
    key: string,
    input: { enabled?: boolean; disabledAccountIds?: string[] },
    ip?: string,
  ): Promise<FeatureFlag> {
    requirePlatformPermission(principal, PlatformPermission.FEATURE_FLAG_MANAGE);
    if (!(PLATFORM_FLAG_VALUES as readonly string[]).includes(key)) {
      // A flag nothing reads is a switch that does nothing. Refusing to create one is the whole
      // point of the list being closed.
      throw new AppError(ErrorCode.NOT_FOUND, 'No such feature flag');
    }

    const flag = await this.options.db.featureFlag.upsert({
      where: { key },
      create: {
        key,
        description: PLATFORM_FLAG_DESCRIPTIONS[key as PlatformFlag],
        enabled: input.enabled ?? true,
        disabledAccountIds: input.disabledAccountIds ?? [],
        updatedByAdminId: principal.adminId,
      },
      update: {
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(input.disabledAccountIds === undefined
          ? {}
          : { disabledAccountIds: input.disabledAccountIds }),
        updatedByAdminId: principal.adminId,
      },
    });

    await this.record(principal.adminId, 'flag.changed', null, { key, ...input }, ip);
    return flag;
  }

  // ---------------------------------------------------------------------------
  // Audit
  // ---------------------------------------------------------------------------

  async auditLog(principal: PlatformPrincipal, limit: number) {
    requirePlatformPermission(principal, PlatformPermission.AUDIT_VIEW);
    const rows = await this.options.db.platformAuditLog.findMany({
      orderBy: [{ createdAt: 'desc' }],
      take: limit,
    });

    const adminIds = [...new Set(rows.map((row) => row.adminId))];
    const admins = await this.options.db.platformAdmin.findMany({
      where: { id: { in: adminIds } },
      select: { id: true, name: true, email: true },
    });
    const byId = new Map(admins.map((admin) => [admin.id, admin]));

    return rows.map((row) => ({
      id: row.id,
      action: row.action,
      accountId: row.accountId,
      adminName: byId.get(row.adminId)?.name ?? 'Removed administrator',
      metadata: row.metadata,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /** Append-only, and never allowed to fail the action it is recording. */
  private async record(
    adminId: string,
    action: string,
    accountId: string | null,
    metadata: Record<string, unknown>,
    ip?: string,
  ): Promise<void> {
    await this.options.db.platformAuditLog
      .create({
        data: { adminId, action, accountId, metadata: metadata as never, ip: ip ?? null },
      })
      .catch(() => undefined);
  }
}

/**
 * Reading flags from the application side.
 *
 * Separate class, on purpose: the console *manages* flags and needs a platform principal to do it,
 * while the API *reads* them on ordinary requests and must not need one. Cached for thirty seconds
 * for the same reason entitlements are - read on many requests, changed rarely, and a switch
 * thrown in an incident has to take effect while somebody is still watching.
 */
export class FeatureFlagService {
  private cache: { value: Map<string, FeatureFlag>; expiresAt: number } | null = null;

  constructor(
    private readonly db: Database,
    private readonly ttlMs = 30_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private async all(): Promise<Map<string, FeatureFlag>> {
    if (this.cache && this.cache.expiresAt > this.now()) return this.cache.value;
    const rows = await this.db.featureFlag.findMany();
    const value = new Map(rows.map((flag) => [flag.key, flag]));
    this.cache = { value, expiresAt: this.now() + this.ttlMs };
    return value;
  }

  /**
   * Is this capability available to this account?
   *
   * **Fails open.** A flag row that does not exist yet, or a database that will not answer, means
   * "on" - because the alternative is that a hiccup in a table nobody was thinking about silently
   * turns off uploads for every customer. A kill switch should require a deliberate act to kill.
   */
  async isEnabled(flag: PlatformFlag, accountId?: string): Promise<boolean> {
    try {
      const row = (await this.all()).get(flag);
      if (!row) return true;
      if (!row.enabled) return false;
      if (accountId && row.disabledAccountIds.includes(accountId)) return false;
      return true;
    } catch {
      return true;
    }
  }

  /** Throw the ordinary "not available" error, so a caller does not have to invent wording. */
  async assertEnabled(flag: PlatformFlag, accountId?: string): Promise<void> {
    if (!(await this.isEnabled(flag, accountId))) {
      throw new AppError(ErrorCode.TEMPORARILY_UNAVAILABLE);
    }
  }
}
