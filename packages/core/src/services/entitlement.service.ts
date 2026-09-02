import type { Database } from '@smartchat/database';
import {
  AppError,
  ErrorCode,
  FEATURE_LABEL,
  type FeatureKey,
  type TenantContext,
} from '@smartchat/types';

export interface Entitlements {
  planCode: string;
  planName: string;
  limits: Record<string, number | null>;
  features: Record<string, boolean>;
  /**
   * True when service is reduced to read-only.
   *
   * Carried here rather than read separately because it is needed on exactly the same requests as
   * the limits are, and a second uncached query on every mutation is a second query on every
   * mutation. It is invalidated by the same `invalidate` call, so a payment restores service
   * within the same window an upgrade takes effect in.
   */
  isPaused: boolean;
}

/**
 * Resolves what an account is allowed to do.
 *
 * Cached in memory for a short window because entitlements are read on nearly every mutation and
 * change rarely — but the window is short enough that a plan upgrade takes effect while the
 * customer is still looking at the page.
 */
export class EntitlementService {
  private readonly cache = new Map<string, { value: Entitlements; expiresAt: number }>();

  constructor(
    private readonly db: Database,
    private readonly ttlMs = 30_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async forAccount(accountId: string): Promise<Entitlements> {
    const cached = this.cache.get(accountId);
    if (cached && cached.expiresAt > this.now()) return cached.value;

    const subscription = await this.db.subscription.findUnique({
      where: { accountId },
      include: { plan: { include: { features: true } } },
    });

    /**
     * An account with no subscription resolves to the cheapest published plan, not to nothing.
     *
     * "Nothing" reads as unlimited everywhere below - an absent limit is unlimited and an absent
     * flag is enabled - so a missing row would silently hand out the whole product. Every account
     * is given a subscription when it is created; this is the belt to that braces, for a row lost
     * to a restore, a manual fix, or an account made before that code existed.
     */
    const plan =
      subscription?.plan ??
      (await this.db.plan.findFirst({
        where: { isPublic: true, isContactSales: false },
        include: { features: true },
        orderBy: [{ priceMonthlyCents: 'asc' }, { sortOrder: 'asc' }],
      }));

    const limits: Record<string, number | null> = {};
    const features: Record<string, boolean> = {};

    if (plan) {
      for (const feature of plan.features) {
        if (feature.boolValue !== null) features[feature.key] = feature.boolValue;
        if (feature.limitValue !== null) limits[feature.key] = Number(feature.limitValue);
        else if (feature.boolValue === null) limits[feature.key] = null; // explicit unlimited
      }
    }

    const value: Entitlements = {
      planCode: plan?.code ?? 'none',
      planName: plan?.name ?? 'No plan',
      limits,
      features,
      isPaused: subscription?.status === 'paused',
    };

    this.cache.set(accountId, { value, expiresAt: this.now() + this.ttlMs });
    return value;
  }

  /** `null` means unlimited. A key with no configured value is treated as unlimited. */
  async limit(accountId: string, key: FeatureKey): Promise<number | null> {
    const entitlements = await this.forAccount(accountId);
    return key in entitlements.limits ? (entitlements.limits[key] ?? null) : null;
  }

  async isEnabled(accountId: string, key: FeatureKey): Promise<boolean> {
    const entitlements = await this.forAccount(accountId);
    // Absent means enabled: features are opt-out per plan, so adding a capability does not
    // silently disable it for every existing customer.
    return entitlements.features[key] ?? true;
  }

  /**
   * Throw if creating one more of `key` would exceed the plan.
   * `currentCount` is supplied by the caller because only it knows the correct scoped count.
   */
  async assertCanAdd(
    context: TenantContext,
    key: FeatureKey,
    currentCount: number,
    adding = 1,
  ): Promise<void> {
    const max = await this.limit(context.accountId, key);
    if (max === null) return;
    if (currentCount + adding <= max) return;

    throw new AppError(
      ErrorCode.PLAN_LIMIT_REACHED,
      `Your plan includes ${max} ${FEATURE_LABEL[key]}. Upgrade to add more.`,
      { context: { key, max, currentCount } },
    );
  }

  async assertFeature(context: TenantContext, key: FeatureKey): Promise<void> {
    if (await this.isEnabled(context.accountId, key)) return;
    throw new AppError(
      ErrorCode.FEATURE_NOT_AVAILABLE,
      `${FEATURE_LABEL[key].replace(/^the /, '')} is not included in your plan.`,
      { context: { key } },
    );
  }

  /** True when the account's service is paused: everything readable, nothing writable. */
  async isPaused(accountId: string): Promise<boolean> {
    return (await this.forAccount(accountId)).isPaused;
  }

  invalidate(accountId: string): void {
    this.cache.delete(accountId);
  }
}
