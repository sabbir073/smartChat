import { describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '@smartchat/types';
import { EntitlementService } from './entitlements.js';
import { PlatformBillingService } from './platform-billing.service.js';
import { PlatformSettingsService } from './settings.js';

const KEY = 'a'.repeat(64);
const principal = {
  adminId: 'admin_1',
  email: 'ops@example.com',
  name: 'Ops',
  permissions: new Set(['platform:billing:manage']),
} as never;
const nobody = { ...(principal as object), permissions: new Set() } as never;

function plan(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'plan_free',
    key: 'free',
    name: 'Free',
    tagline: null,
    description: null,
    monthlyPriceCents: 0,
    annualPriceCents: 0,
    currency: 'usd',
    maxProperties: 1,
    maxMembers: 1,
    aiAgent: false,
    aiRepliesPerMonth: null,
    integrations: false,
    removeBranding: false,
    aiOwnKey: false,
    isContactSales: false,
    isPublic: true,
    isDefault: true,
    isActive: true,
    sortOrder: 0,
    stripeProductId: null,
    stripeMonthlyPriceId: null,
    stripeAnnualPriceId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function harness(opts: { plans?: ReturnType<typeof plan>[]; gateway?: unknown } = {}) {
  const plans = opts.plans ?? [plan()];
  const settingsRows = new Map<string, { value: string; encrypted: boolean }>();
  const subscriptions = new Map<string, Record<string, unknown>>();
  const audit: unknown[] = [];

  const db = {
    plan: {
      findMany: vi.fn(async () => plans.map((p) => ({ ...p }))),
      findUnique: vi.fn(async ({ where }: { where: { id?: string; key?: string } }) =>
        plans.find((p) => (where.id ? p.id === where.id : p.key === where.key)) ?? null,
      ),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        for (const p of plans) Object.assign(p, data);
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const created = plan({ ...data, id: `plan_${data['key']}` });
        plans.push(created);
        return created;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = plans.find((p) => p.id === where.id)!;
        Object.assign(row, data);
        return { ...row };
      }),
    },
    subscription: {
      groupBy: vi.fn(async () => []),
      count: vi.fn(async () => 0),
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async ({ where, include }: { where: { accountId: string }; include?: unknown }) => {
        const row = subscriptions.get(where.accountId);
        if (!row) return null;
        return include ? { ...row, plan: plans.find((p) => p.id === row['planId']) } : { ...row };
      }),
      update: vi.fn(async ({ where, data }: { where: { accountId: string }; data: Record<string, unknown> }) => {
        Object.assign(subscriptions.get(where.accountId)!, data);
      }),
    },
    invoice: { findMany: vi.fn(async () => []) },
    property: { count: vi.fn(async () => 0) },
    accountMember: { count: vi.fn(async () => 1) },
    platformSetting: {
      findUnique: vi.fn(async ({ where }: { where: { key: string } }) => {
        const row = settingsRows.get(where.key);
        return row ? { key: where.key, ...row } : null;
      }),
      upsert: vi.fn(async ({ where, create }: { where: { key: string }; create: { value: string; encrypted: boolean } }) => {
        settingsRows.set(where.key, { value: create.value, encrypted: create.encrypted });
      }),
      deleteMany: vi.fn(async ({ where }: { where: { key: string } }) => {
        settingsRows.delete(where.key);
      }),
    },
    platformAuditLog: { create: vi.fn(async (input: unknown) => audit.push(input)) },
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(db),
  };

  const settings = new PlatformSettingsService(db as never, KEY);
  const entitlements = new EntitlementService({ db: db as never, graceDays: () => settings.graceDays() });
  const service = new PlatformBillingService({
    db: db as never,
    settings,
    entitlements,
    gateway: async () => (opts.gateway ?? null) as never,
    apiUrl: 'https://api.getchat.site',
  });
  return { service, db, plans, subscriptions, audit, settingsRows };
}

async function codeOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? 'unknown';
  }
}

describe('PlatformBillingService plans', () => {
  it('refuses anybody without the billing permission', async () => {
    const h = harness();
    expect(await codeOf(() => h.service.listPlans(nobody))).toBe(ErrorCode.FORBIDDEN);
  });

  it('will not let the default plan cost money: new accounts land on it without a card', async () => {
    const h = harness();
    expect(
      await codeOf(() =>
        h.service.updatePlan(principal, 'plan_free', { monthlyPriceCents: 500 }),
      ),
    ).toBe(ErrorCode.VALIDATION_FAILED);
  });

  it('will not retire the default plan', async () => {
    const h = harness();
    expect(await codeOf(() => h.service.updatePlan(principal, 'plan_free', { isActive: false }))).toBe(
      ErrorCode.VALIDATION_FAILED,
    );
  });

  it('moves the default flag when another plan becomes the default', async () => {
    const h = harness({ plans: [plan(), plan({ id: 'plan_b', key: 'basic', isDefault: false })] });
    await h.service.updatePlan(principal, 'plan_b', { isDefault: true });
    expect(h.plans.map((p) => [p.key, p.isDefault])).toEqual([
      ['free', false],
      ['basic', true],
    ]);
  });

  it('saves a priced plan and reports that Stripe was skipped when no key is stored', async () => {
    const h = harness();
    const outcome = await h.service.createPlan(principal, {
      key: 'starter',
      name: 'Starter',
      tagline: null,
      description: null,
      monthlyPriceCents: 2000,
      annualPriceCents: 20000,
      currency: 'USD',
      maxProperties: 3,
      maxMembers: 5,
      aiAgent: false,
      aiRepliesPerMonth: null,
      integrations: true,
      removeBranding: false,
      aiOwnKey: false,
      isContactSales: false,
      isPublic: true,
      isDefault: false,
      isActive: true,
      sortOrder: 1,
    });
    expect(outcome.stripe).toEqual({ status: 'skipped', error: null });
    expect(outcome.plan.currency).toBe('usd');
    expect(outcome.plan.stripeSynced).toBe(false);
    expect(h.audit).toHaveLength(1);
  });

  it('records the Stripe ids when a sync succeeds, and reports a failure without losing the save', async () => {
    const syncPlan = vi
      .fn()
      .mockResolvedValueOnce({ productId: 'prod_1', monthlyPriceId: 'price_m', annualPriceId: null })
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { code: ErrorCode.PAYMENT_PROVIDER_ERROR }));
    const h = harness({
      plans: [plan(), plan({ id: 'plan_s', key: 'starter', isDefault: false, monthlyPriceCents: 2000 })],
      gateway: { syncPlan },
    });

    const first = await h.service.updatePlan(principal, 'plan_s', { name: 'Starter+' });
    expect(first.stripe.status).toBe('synced');
    expect(first.plan.stripeMonthlyPriceId).toBe('price_m');
    expect(first.plan.stripeSynced).toBe(true);

    const second = await h.service.updatePlan(principal, 'plan_s', { monthlyPriceCents: 2500 });
    expect(second.stripe.status).toBe('failed');
    expect(second.plan.monthlyPriceCents).toBe(2500);
  });
});

describe('PlatformBillingService settings', () => {
  it('stores the secret sealed and never returns it', async () => {
    const h = harness();
    const view = await h.service.updateSettings(principal, {
      stripePublishableKey: 'pk_test_abc123',
      stripeSecretKey: 'sk_test_abc123',
    });
    expect(view.stripe).toEqual({
      publishableKey: 'pk_test_abc123',
      secretKeyConfigured: true,
      webhookSecretConfigured: false,
      testMode: true,
    });
    const stored = h.settingsRows.get('stripe.secret_key');
    expect(stored?.encrypted).toBe(true);
    expect(stored?.value).not.toContain('sk_test_abc123');
    expect(view.webhookUrl).toBe('https://api.getchat.site/api/v1/billing/webhooks/stripe');
  });

  it('refuses a test publishable key next to a live secret key', async () => {
    const h = harness();
    expect(
      await codeOf(() =>
        h.service.updateSettings(principal, {
          stripePublishableKey: 'pk_test_abc123',
          stripeSecretKey: 'sk_live_abc123',
        }),
      ),
    ).toBe(ErrorCode.VALIDATION_FAILED);
  });

  it('changes the grace window without touching the keys', async () => {
    const h = harness();
    await h.service.updateSettings(principal, { stripeSecretKey: 'sk_test_abc123', stripePublishableKey: 'pk_test_x' });
    const view = await h.service.updateSettings(principal, { graceDays: 7 });
    expect(view.graceDays).toBe(7);
    expect(view.stripe.secretKeyConfigured).toBe(true);
  });
});

describe('PlatformBillingService accounts', () => {
  it('puts an account on a plan by hand and clears any lock', async () => {
    const h = harness({ plans: [plan(), plan({ id: 'plan_g', key: 'growth', isDefault: false, maxProperties: 10 })] });
    h.subscriptions.set('acc_1', {
      id: 's1',
      accountId: 'acc_1',
      planId: 'plan_free',
      status: 'unpaid',
      provider: 'manual',
      interval: 'month',
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      pastDueSince: null,
      lockedAt: new Date(),
      note: null,
    });
    const view = await h.service.setAccountPlan(principal, 'acc_1', { planKey: 'growth', note: 'sponsored' });
    expect(view.plan.key).toBe('growth');
    expect(view.subscription).toMatchObject({ status: 'none', provider: 'manual', lockedAt: null, note: 'sponsored' });
    expect(view.locked.locked).toBe(false);
  });

  it('refuses to override an account that pays through Stripe', async () => {
    const h = harness({ plans: [plan(), plan({ id: 'plan_g', key: 'growth', isDefault: false })] });
    h.subscriptions.set('acc_1', {
      id: 's1',
      accountId: 'acc_1',
      planId: 'plan_g',
      status: 'active',
      provider: 'stripe',
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: 'sub_1',
    });
    expect(
      await codeOf(() => h.service.setAccountPlan(principal, 'acc_1', { planKey: 'free', note: null })),
    ).toBe(ErrorCode.CONFLICT);
  });
});
