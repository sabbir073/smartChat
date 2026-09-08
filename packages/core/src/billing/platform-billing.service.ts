import type { Database, Plan } from '@smartchat/database';
import { AppError, ErrorCode, PlatformPermission } from '@smartchat/types';
import type {
  CreatePlanInput,
  SetAccountPlanInput,
  UpdateBillingSettingsInput,
  UpdatePlanInput,
} from '@smartchat/validation';
import type { PlatformPrincipal } from '../services/platform.service.js';
import { systemClock, type Clock } from '../time.js';
import { toInvoiceView, type InvoiceView } from './billing.service.js';
import type { EntitlementService } from './entitlements.js';
import { PlatformSettingKey, type PlatformSettingsService } from './settings.js';
import type { StripeGateway } from './stripe-gateway.js';

/**
 * Billing as the operator sees it: the plans on sale, the Stripe keys, and the levers for one
 * account at a time.
 *
 * Plans are rows, not code. The four the migration seeds are a starting point; the operator can
 * reprice them, retire them, or add a fifth, and nothing here knows the word "starter". The one
 * thing the code insists on is that exactly one active plan is the default, because a new
 * account has to land somewhere.
 */

export interface PlanAdminView extends Plan {
  /** How many accounts are on it right now. Shown before "retire", so nobody retires a plan blind. */
  subscribers: number;
  /** Whether Stripe knows about its prices. False until synced, and after a price change. */
  stripeSynced: boolean;
}

export interface PlanSaveOutcome {
  plan: PlanAdminView;
  /** What happened on the Stripe side. `skipped` when Stripe is not configured or not needed. */
  stripe: { status: 'synced' | 'skipped' | 'failed'; error: string | null };
}

export interface BillingSettingsView {
  stripe: {
    publishableKey: string | null;
    secretKeyConfigured: boolean;
    webhookSecretConfigured: boolean;
    testMode: boolean | null;
  };
  graceDays: number;
  contactEmail: string | null;
  /** Where Stripe should send events. Shown so the operator can paste it into the dashboard. */
  webhookUrl: string;
}

export interface AccountBillingView {
  subscription: {
    status: string;
    provider: string;
    interval: string;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    pastDueSince: string | null;
    lockedAt: string | null;
    stripeCustomerId: string | null;
    stripeSubscriptionId: string | null;
    note: string | null;
  };
  plan: Pick<Plan, 'id' | 'key' | 'name' | 'maxProperties' | 'maxMembers' | 'aiAgent' | 'integrations' | 'removeBranding'>;
  usage: { properties: number; members: number };
  locked: { locked: boolean; reason: string | null };
  invoices: InvoiceView[];
}

export interface PlatformBillingServiceOptions {
  db: Database;
  settings: PlatformSettingsService;
  entitlements: EntitlementService;
  gateway: () => Promise<StripeGateway | null>;
  apiUrl: string;
  clock?: Clock;
}

function requirePlatformPermission(principal: PlatformPrincipal): void {
  if (!principal.permissions.has(PlatformPermission.BILLING_MANAGE)) {
    throw new AppError(ErrorCode.FORBIDDEN, 'Your platform role does not include billing');
  }
}

export class PlatformBillingService {
  private readonly clock: Clock;

  constructor(private readonly options: PlatformBillingServiceOptions) {
    this.clock = options.clock ?? systemClock;
  }

  // --- plans ------------------------------------------------------------------

  async listPlans(principal: PlatformPrincipal): Promise<PlanAdminView[]> {
    requirePlatformPermission(principal);
    const [plans, counts] = await Promise.all([
      this.options.db.plan.findMany({ orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }),
      this.options.db.subscription.groupBy({ by: ['planId'], _count: { _all: true } }),
    ]);
    const byPlan = new Map(counts.map((row) => [row.planId, row._count._all]));
    return plans.map((plan) => this.adminView(plan, byPlan.get(plan.id) ?? 0));
  }

  async createPlan(
    principal: PlatformPrincipal,
    input: CreatePlanInput,
    ip?: string,
  ): Promise<PlanSaveOutcome> {
    requirePlatformPermission(principal);
    this.assertCoherent(input);

    const existing = await this.options.db.plan.findUnique({ where: { key: input.key } });
    if (existing) {
      throw new AppError(ErrorCode.CONFLICT, `A plan with the key "${input.key}" already exists`);
    }

    const plan = await this.options.db.$transaction(async (tx) => {
      if (input.isDefault) await tx.plan.updateMany({ data: { isDefault: false } });
      return tx.plan.create({ data: { ...input, currency: input.currency.toLowerCase() } });
    });
    await this.record(principal.adminId, 'billing.plan.created', null, { planKey: plan.key }, ip);
    return this.syncAfterSave(plan);
  }

  async updatePlan(
    principal: PlatformPrincipal,
    planId: string,
    input: UpdatePlanInput,
    ip?: string,
  ): Promise<PlanSaveOutcome> {
    requirePlatformPermission(principal);
    const current = await this.options.db.plan.findUnique({ where: { id: planId } });
    if (!current) throw new AppError(ErrorCode.PLAN_NOT_FOUND);

    // The default plan cannot be retired or hidden out from under new sign-ups; make another
    // plan the default first.
    if (current.isDefault && (input.isActive === false || input.isDefault === false)) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        'Make another plan the default before retiring this one',
      );
    }

    const merged = { ...current, ...input };
    this.assertCoherent(merged);

    const plan = await this.options.db.$transaction(async (tx) => {
      if (input.isDefault === true && !current.isDefault) {
        await tx.plan.updateMany({ data: { isDefault: false } });
      }
      return tx.plan.update({
        where: { id: planId },
        data: {
          ...input,
          ...(input.currency ? { currency: input.currency.toLowerCase() } : {}),
        },
      });
    });
    await this.record(principal.adminId, 'billing.plan.updated', null, { planKey: plan.key, changed: Object.keys(input) }, ip);

    // Existing subscribers see the new limits at their next request. Prices for them change on
    // the Stripe side only at their next checkout or plan change; a live Stripe subscription
    // keeps the price it was sold at, which is the honest thing and also what Stripe does.
    for (const subscriber of await this.options.db.subscription.findMany({
      where: { planId },
      select: { accountId: true },
    })) {
      this.options.entitlements.invalidate(subscriber.accountId);
    }

    return this.syncAfterSave(plan);
  }

  /** Push every sellable plan to Stripe. What the console's "Sync with Stripe" button does. */
  async syncPlans(principal: PlatformPrincipal, ip?: string): Promise<PlanSaveOutcome[]> {
    requirePlatformPermission(principal);
    const gateway = await this.options.gateway();
    if (!gateway) throw new AppError(ErrorCode.BILLING_NOT_CONFIGURED);
    const plans = await this.options.db.plan.findMany({ where: { isActive: true, isContactSales: false } });
    const outcomes: PlanSaveOutcome[] = [];
    for (const plan of plans) outcomes.push(await this.syncAfterSave(plan, gateway));
    await this.record(principal.adminId, 'billing.plans.synced', null, {
      results: outcomes.map((o) => ({ key: o.plan.key, status: o.stripe.status })),
    }, ip);
    return outcomes;
  }

  // --- settings -----------------------------------------------------------------

  async settings(principal: PlatformPrincipal): Promise<BillingSettingsView> {
    requirePlatformPermission(principal);
    const [publishableKey, secretKey, webhookSecret, graceDays, contactEmail] = await Promise.all([
      this.options.settings.get(PlatformSettingKey.STRIPE_PUBLISHABLE_KEY),
      this.options.settings.get(PlatformSettingKey.STRIPE_SECRET_KEY),
      this.options.settings.has(PlatformSettingKey.STRIPE_WEBHOOK_SECRET),
      this.options.settings.graceDays(),
      this.options.settings.get(PlatformSettingKey.BILLING_CONTACT_EMAIL),
    ]);
    return {
      stripe: {
        publishableKey,
        secretKeyConfigured: secretKey !== null,
        webhookSecretConfigured: webhookSecret,
        testMode: secretKey === null ? null : secretKey.startsWith('sk_test_') || secretKey.startsWith('rk_test_'),
      },
      graceDays,
      contactEmail,
      webhookUrl: `${this.options.apiUrl.replace(/\/$/, '')}/api/v1/billing/webhooks/stripe`,
    };
  }

  async updateSettings(
    principal: PlatformPrincipal,
    input: UpdateBillingSettingsInput,
    ip?: string,
  ): Promise<BillingSettingsView> {
    requirePlatformPermission(principal);
    const admin = principal.adminId;
    const changed: string[] = [];

    if (input.stripePublishableKey !== undefined) {
      await this.options.settings.set(PlatformSettingKey.STRIPE_PUBLISHABLE_KEY, input.stripePublishableKey, admin);
      changed.push('stripePublishableKey');
    }
    if (input.stripeSecretKey !== undefined) {
      await this.options.settings.set(PlatformSettingKey.STRIPE_SECRET_KEY, input.stripeSecretKey, admin);
      changed.push('stripeSecretKey');
    }
    if (input.stripeWebhookSecret !== undefined) {
      await this.options.settings.set(PlatformSettingKey.STRIPE_WEBHOOK_SECRET, input.stripeWebhookSecret, admin);
      changed.push('stripeWebhookSecret');
    }
    if (input.graceDays !== undefined) {
      await this.options.settings.set(PlatformSettingKey.BILLING_GRACE_DAYS, String(input.graceDays), admin);
      changed.push('graceDays');
    }
    if (input.contactEmail !== undefined) {
      await this.options.settings.set(PlatformSettingKey.BILLING_CONTACT_EMAIL, input.contactEmail, admin);
      changed.push('contactEmail');
    }

    // A test key and a live key must not be mixed: a checkout would be created on one side and
    // the webhook verified on the other, and nothing would ever activate.
    const [publishable, secret] = await Promise.all([
      this.options.settings.get(PlatformSettingKey.STRIPE_PUBLISHABLE_KEY),
      this.options.settings.get(PlatformSettingKey.STRIPE_SECRET_KEY),
    ]);
    if (publishable && secret) {
      const publishableTest = publishable.startsWith('pk_test_');
      const secretTest = secret.startsWith('sk_test_') || secret.startsWith('rk_test_');
      if (publishableTest !== secretTest) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'The publishable key and the secret key are from different modes (one is test, the other live). Use a matching pair.',
        );
      }
    }

    await this.record(admin, 'billing.settings.updated', null, { changed }, ip);
    return this.settings(principal);
  }

  /** Does the stored secret actually work? Cheap, and the thing to press after pasting a key. */
  async testStripe(principal: PlatformPrincipal): Promise<{ ok: true; livemode: boolean; accountName: string | null }> {
    requirePlatformPermission(principal);
    const gateway = await this.options.gateway();
    if (!gateway) throw new AppError(ErrorCode.BILLING_NOT_CONFIGURED, 'Enter a publishable key and a secret key first.');
    return gateway.testConnection();
  }

  // --- one account ----------------------------------------------------------------

  async accountBilling(principal: PlatformPrincipal, accountId: string): Promise<AccountBillingView> {
    requirePlatformPermission(principal);
    const [subscription, invoices] = await Promise.all([
      this.options.db.subscription.findUnique({ where: { accountId }, include: { plan: true } }),
      this.options.db.invoice.findMany({ where: { accountId }, orderBy: { createdAt: 'desc' }, take: 50 }),
    ]);
    if (!subscription) throw new AppError(ErrorCode.ACCOUNT_NOT_FOUND);
    // Fresh, not cached: the operator is looking at this account on purpose.
    this.options.entitlements.invalidate(accountId);
    const entitlements = await this.options.entitlements.forAccount(accountId);
    return {
      subscription: {
        status: subscription.status,
        provider: subscription.provider,
        interval: subscription.interval,
        currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        pastDueSince: subscription.pastDueSince?.toISOString() ?? null,
        lockedAt: subscription.lockedAt?.toISOString() ?? null,
        stripeCustomerId: subscription.stripeCustomerId,
        stripeSubscriptionId: subscription.stripeSubscriptionId,
        note: subscription.note,
      },
      plan: {
        id: subscription.plan.id,
        key: subscription.plan.key,
        name: subscription.plan.name,
        maxProperties: subscription.plan.maxProperties,
        maxMembers: subscription.plan.maxMembers,
        aiAgent: subscription.plan.aiAgent,
        integrations: subscription.plan.integrations,
        removeBranding: subscription.plan.removeBranding,
      },
      usage: entitlements.usage,
      locked: { locked: entitlements.lock.locked, reason: entitlements.lock.reason },
      invoices: invoices.map(toInvoiceView),
    };
  }

  /**
   * Put an account on a plan by hand.
   *
   * Refused while the account has a live Stripe subscription: the plan would then disagree with
   * what is being charged, and the next webhook would put it back anyway. Cancel it through
   * Stripe first (the customer portal, or the Stripe dashboard) and it falls to the default plan
   * on its own; then this works.
   */
  async setAccountPlan(
    principal: PlatformPrincipal,
    accountId: string,
    input: SetAccountPlanInput,
    ip?: string,
  ): Promise<AccountBillingView> {
    requirePlatformPermission(principal);
    const [subscription, plan] = await Promise.all([
      this.options.db.subscription.findUnique({ where: { accountId } }),
      this.options.db.plan.findUnique({ where: { key: input.planKey } }),
    ]);
    if (!subscription) throw new AppError(ErrorCode.ACCOUNT_NOT_FOUND);
    if (!plan || !plan.isActive) throw new AppError(ErrorCode.PLAN_NOT_FOUND);
    if (subscription.provider === 'stripe' && subscription.stripeSubscriptionId) {
      throw new AppError(
        ErrorCode.CONFLICT,
        'This account pays through Stripe. Cancel its subscription in Stripe first; it will fall back to the default plan, and then you can set one by hand.',
      );
    }

    await this.options.db.subscription.update({
      where: { accountId },
      data: {
        planId: plan.id,
        provider: 'manual',
        status: 'none',
        interval: 'month',
        currentPeriodStart: null,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        pastDueSince: null,
        lockedAt: null,
        note: input.note,
      },
    });
    this.options.entitlements.invalidate(accountId);
    await this.record(principal.adminId, 'billing.account.plan_set', accountId, { planKey: plan.key, note: input.note }, ip);
    return this.accountBilling(principal, accountId);
  }

  // --- enquiries -------------------------------------------------------------------

  async listEnquiries(principal: PlatformPrincipal, includeHandled: boolean) {
    requirePlatformPermission(principal);
    const rows = await this.options.db.billingEnquiry.findMany({
      where: includeHandled ? {} : { handledAt: null },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { account: { select: { id: true, name: true, slug: true } } },
    });
    return rows.map((row) => ({
      id: row.id,
      account: row.account,
      name: row.name,
      email: row.email,
      message: row.message,
      wants: row.wants,
      handledAt: row.handledAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async markEnquiryHandled(principal: PlatformPrincipal, id: string, ip?: string): Promise<void> {
    requirePlatformPermission(principal);
    const result = await this.options.db.billingEnquiry.updateMany({
      where: { id, handledAt: null },
      data: { handledAt: this.clock.now() },
    });
    if (result.count === 0) throw new AppError(ErrorCode.NOT_FOUND, 'That enquiry is not open');
    await this.record(principal.adminId, 'billing.enquiry.handled', null, { enquiryId: id }, ip);
  }

  // --- helpers ------------------------------------------------------------------------

  private assertCoherent(plan: {
    isContactSales: boolean;
    isDefault: boolean;
    isActive: boolean;
    monthlyPriceCents: number;
    annualPriceCents: number;
  }): void {
    if (plan.isDefault && plan.isContactSales) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'The default plan cannot be a contact-us plan');
    }
    if (plan.isDefault && !plan.isActive) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'The default plan must be active');
    }
    if (plan.isDefault && (plan.monthlyPriceCents > 0 || plan.annualPriceCents > 0)) {
      // A new account has no card on file (the operator's choice: no card for the free plan), so
      // the plan it lands on has to cost nothing.
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'The default plan must be free: new accounts land on it without a card');
    }
  }

  private adminView(plan: Plan, subscribers: number): PlanAdminView {
    const sellable = plan.isActive && !plan.isContactSales;
    const needsMonthly = plan.monthlyPriceCents > 0;
    const needsAnnual = plan.annualPriceCents > 0;
    const stripeSynced =
      !sellable ||
      ((!needsMonthly || plan.stripeMonthlyPriceId !== null) &&
        (!needsAnnual || plan.stripeAnnualPriceId !== null) &&
        (needsMonthly || needsAnnual ? plan.stripeProductId !== null : true));
    return { ...plan, subscribers, stripeSynced };
  }

  /**
   * After a save: push the plan to Stripe if there is a Stripe to push to.
   *
   * The row is already written; a Stripe failure is reported, not thrown, so the console can
   * show "saved, but Stripe said no" instead of a plan that looks unsaved and is not.
   */
  private async syncAfterSave(plan: Plan, gateway?: StripeGateway): Promise<PlanSaveOutcome> {
    const subscribers = await this.options.db.subscription.count({ where: { planId: plan.id } });
    const sellable = plan.isActive && !plan.isContactSales && (plan.monthlyPriceCents > 0 || plan.annualPriceCents > 0);
    if (!sellable) return { plan: this.adminView(plan, subscribers), stripe: { status: 'skipped', error: null } };

    const stripe = gateway ?? (await this.options.gateway());
    if (!stripe) return { plan: this.adminView(plan, subscribers), stripe: { status: 'skipped', error: null } };

    try {
      const synced = await stripe.syncPlan(plan);
      const updated = await this.options.db.plan.update({
        where: { id: plan.id },
        data: {
          stripeProductId: synced.productId,
          stripeMonthlyPriceId: synced.monthlyPriceId,
          stripeAnnualPriceId: synced.annualPriceId,
        },
      });
      return { plan: this.adminView(updated, subscribers), stripe: { status: 'synced', error: null } };
    } catch (error) {
      const message = error instanceof AppError ? error.message : 'Stripe did not accept the plan';
      return { plan: this.adminView(plan, subscribers), stripe: { status: 'failed', error: message } };
    }
  }

  private async record(
    adminId: string,
    action: string,
    accountId: string | null,
    metadata: Record<string, unknown>,
    ip?: string,
  ): Promise<void> {
    await this.options.db.platformAuditLog
      .create({ data: { adminId, action, accountId, metadata: metadata as never, ip: ip ?? null } })
      .catch(() => undefined);
  }
}
