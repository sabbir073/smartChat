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

    const limits: Record<string, number | null> = {};
    const features: Record<string, boolean> = {};

    if (subscription) {
      for (const feature of subscription.plan.features) {
        if (feature.boolValue !== null) features[feature.key] = feature.boolValue;
        if (feature.limitValue !== null) limits[feature.key] = Number(feature.limitValue);
        else if (feature.boolValue === null) limits[feature.key] = null; // explicit unlimited
      }
    }

    const value: Entitlements = {
      planCode: subscription?.plan.code ?? 'none',
      planName: subscription?.plan.name ?? 'No plan',
      limits,
      features,
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

  invalidate(accountId: string): void {
    this.cache.delete(accountId);
  }
}
