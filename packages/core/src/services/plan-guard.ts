import type { Database } from '@smartchat/database';
import {
  AppError,
  ErrorCode,
  FEATURE_LABEL,
  FeatureKey,
  type FeatureKey as FeatureKeyType,
  type TenantContext,
} from '@smartchat/types';
import type { EntitlementService } from './entitlement.service.js';

/**
 * The one place a plan limit is actually applied.
 *
 * `EntitlementService` answers "what is this account allowed"; this answers "may it do this right
 * now", which needs a live count of what it already has. Before this existed, `assertCanAdd` was
 * called from exactly one service - websites - and the other seventeen entitlements the plans
 * define were decoration: a Free account could create webhooks, use the public API and open
 * tickets it was not entitled to, and the pricing page was advertising limits nobody enforced.
 *
 * Counting lives here rather than in each service on purpose. A limit whose count is computed by
 * the caller is a limit that gets counted differently in two places - deleted rows included in
 * one, excluded in the other - and the difference only ever shows up as a customer who cannot
 * create the thing they are entitled to.
 */
export class PlanGuard {
  constructor(
    private readonly db: Database,
    private readonly entitlements: EntitlementService,
  ) {}

  /** Throw unless the plan includes this capability at all. */
  async assertFeature(context: TenantContext, key: FeatureKeyType): Promise<void> {
    await this.entitlements.assertFeature(context, key);
  }

  /**
   * The same check where there is no signed-in member to have a context.
   *
   * A visitor uploading a file is still spending the *account's* entitlement, and the account is
   * the only party in the request that has one. Without this the visitor path would simply be
   * unguarded, which is how a Free plan ends up with unlimited storage.
   */
  async assertFeatureForAccount(accountId: string, key: FeatureKeyType): Promise<void> {
    if (await this.entitlements.isEnabled(accountId, key)) return;
    throw new AppError(
      ErrorCode.FEATURE_NOT_AVAILABLE,
      `${FEATURE_LABEL[key].replace(/^the /, '')} is not included in this plan.`,
      { context: { key } },
    );
  }

  /**
   * Whether a capability is in the plan, as a question rather than an assertion.
   *
   * Some entitlements do not refuse an action, they change what is rendered - branding removal is
   * the one that matters. Those callers need an answer, not an exception.
   */
  async isFeatureEnabled(accountId: string, key: FeatureKeyType): Promise<boolean> {
    return this.entitlements.isEnabled(accountId, key);
  }

  /** Throw when adding one more would exceed the plan's limit for `key`. */
  async assertCanAdd(context: TenantContext, key: FeatureKeyType, adding = 1): Promise<void> {
    const limit = await this.entitlements.limit(context.accountId, key);
    if (limit === null) return;

    const current = await this.count(context.accountId, key);
    await this.entitlements.assertCanAdd(context, key, current, adding);
  }

  /** Account-scoped counterpart, for the paths a visitor drives. */
  async assertCanAddForAccount(
    accountId: string,
    key: FeatureKeyType,
    adding = 1,
  ): Promise<void> {
    const limit = await this.entitlements.limit(accountId, key);
    if (limit === null) return;

    const current = await this.count(accountId, key);
    if (current + adding <= limit) return;

    throw new AppError(
      ErrorCode.PLAN_LIMIT_REACHED,
      `This plan includes ${limit} ${FEATURE_LABEL[key]}.`,
      { context: { key, limit, current } },
    );
  }

  // ---------------------------------------------------------------------------
  // Pause, never destroy (ADR-088)
  // ---------------------------------------------------------------------------

  /**
   * Refuse a write when the account's service is paused.
   *
   * This is the whole of "pause, never destroy" on the write side, and it lives here rather than
   * in each service for the same reason the limits do: a rule applied in twenty places is a rule
   * with nineteen chances to be forgotten on the twenty-first route. Reads are untouched on
   * purpose - a lapsed invoice is a commercial problem, and holding somebody's conversation
   * history hostage over one is not a remedy, it is a hostage.
   */
  async assertWritable(accountId: string): Promise<void> {
    if (!(await this.entitlements.isPaused(accountId))) return;
    throw new AppError(
      ErrorCode.SUBSCRIPTION_PAUSED,
      'This account is read-only until the subscription is renewed. Nothing has been deleted.',
    );
  }

  /**
   * Which websites are inside the plan's allowance.
   *
   * Oldest first, deterministically. When a downgrade leaves an account over its limit somebody
   * has to decide which websites keep serving, and "the ones you had first" is the only answer
   * that is stable across requests and that a customer can predict for themselves. The excess are
   * not deleted, not unpublished and not edited - their widget stops starting new conversations,
   * and they come back whole the moment the plan does.
   */
  private async entitledPropertyIds(accountId: string): Promise<string[]> {
    const limit = await this.entitlements.limit(accountId, FeatureKey.MAX_PROPERTIES);
    const properties = await this.db.property.findMany({
      where: { accountId, deletedAt: null },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
      ...(limit === null ? {} : { take: limit }),
    });
    return properties.map((property) => property.id);
  }

  /**
   * Which websites are actually serving visitors right now.
   *
   * The allowance *and* the pause, in one answer. Both questions were being asked separately for a
   * while, and the two callers disagreed: the widget correctly stopped on a paused account while
   * the dashboard's own list of websites went on saying every one of them was fine. The customer
   * was the last to know, which is the exact failure "pause, never destroy" exists to avoid.
   */
  async servingPropertyIds(accountId: string): Promise<string[]> {
    if (await this.entitlements.isPaused(accountId)) return [];
    return this.entitledPropertyIds(accountId);
  }

  /**
   * True when this website may serve visitors: not paused, and inside the allowance.
   *
   * Deliberately built on `servingPropertyIds` rather than short-circuiting on an unlimited plan.
   * The short-circuit costs one small query and buys back the possibility of the two answers
   * drifting apart, which is what went wrong the first time.
   */
  async isPropertyServing(accountId: string, propertyId: string): Promise<boolean> {
    return (await this.servingPropertyIds(accountId)).includes(propertyId);
  }

  /**
   * How many of `key` the account has.
   *
   * Soft-deleted rows never count: an account that deleted a website to make room must actually
   * get the room. Conversations count for the calendar month, matching how the limit is sold.
   */
  async count(accountId: string, key: FeatureKeyType): Promise<number> {
    switch (key) {
      case FeatureKey.MAX_PROPERTIES:
        return this.db.property.count({ where: { accountId, deletedAt: null } });

      case FeatureKey.MAX_AGENTS:
        return this.db.accountMember.count({ where: { accountId, deletedAt: null } });

      case FeatureKey.MAX_MONTHLY_CONVERSATIONS:
        return this.db.conversation.count({
          where: { accountId, startedAt: { gte: monthStart() } },
        });

      case FeatureKey.MAX_STORAGE_BYTES: {
        const total = await this.db.attachment.aggregate({
          where: { accountId, status: 'ready' },
          _sum: { byteSize: true },
        });
        return Number(total._sum.byteSize ?? 0);
      }

      case FeatureKey.MAX_KB_ARTICLES:
        return this.db.kbArticle.count({ where: { accountId, deletedAt: null } });

      case FeatureKey.MAX_WEBHOOKS:
        return this.db.webhook.count({ where: { accountId, deletedAt: null } });

      case FeatureKey.MAX_TRIGGERS:
        return this.db.trigger.count({ where: { accountId, deletedAt: null } });

      case FeatureKey.MAX_SHORTCUTS:
        return this.db.shortcut.count({ where: { accountId, deletedAt: null } });

      default:
        // A key with no countable resource - the feature_* flags, and the two limits enforced
        // elsewhere (API requests per day, in the auth hook; history days, by retention).
        return 0;
    }
  }

  /**
   * Storage is the one limit measured in bytes rather than rows, so it gets its own call: the
   * caller knows how large the incoming file claims to be, and that has to be part of the sum.
   *
   * Account-scoped because both sides of a conversation upload files, and only one of them has a
   * signed-in member. The declared size is what is checked here and the real one is re-measured
   * after the upload (ADR-045), so understating it buys nothing.
   */
  async assertStorageRoom(accountId: string, incomingBytes: number): Promise<void> {
    const limit = await this.entitlements.limit(accountId, FeatureKey.MAX_STORAGE_BYTES);
    if (limit === null) return;

    const used = await this.count(accountId, FeatureKey.MAX_STORAGE_BYTES);
    if (used + incomingBytes <= limit) return;

    throw new AppError(
      ErrorCode.PLAN_LIMIT_REACHED,
      `This plan includes ${formatBytes(limit)} of file storage, and ${formatBytes(used)} is in use.`,
      { context: { key: FeatureKey.MAX_STORAGE_BYTES, limit, used, incomingBytes } },
    );
  }
}

function monthStart(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Bytes as a person would say them. Only ever used inside an error message. */
function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${Math.round(bytes / 1_073_741_824)} GB`;
  if (bytes >= 1_048_576) return `${Math.round(bytes / 1_048_576)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}
