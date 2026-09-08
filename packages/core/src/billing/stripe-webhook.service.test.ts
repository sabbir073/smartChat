import { describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import { AppError, ErrorCode } from '@smartchat/types';
import { EntitlementService } from './entitlements.js';
import { StripeWebhookService } from './stripe-webhook.service.js';

/**
 * The webhook handler against an in-memory imitation of the few tables it touches. The Stripe
 * SDK is never called: the gateway is a stub whose `constructEvent` returns whatever event the
 * test hands in, and whose `retrieveSubscription` returns a canned snapshot.
 */

const now = new Date('2026-09-08T12:00:00Z');
const clock = { now: () => now, timestamp: () => now.getTime() };
const periodEnd = new Date('2026-10-08T12:00:00Z');

const plans = [
  {
    id: 'plan_free',
    key: 'free',
    name: 'Free',
    isDefault: true,
    isActive: true,
    maxProperties: 1,
    maxMembers: 1,
    aiAgent: false,
    integrations: false,
    removeBranding: false,
    isContactSales: false,
    stripeMonthlyPriceId: null,
    stripeAnnualPriceId: null,
  },
  {
    id: 'plan_growth',
    key: 'growth',
    name: 'Growth',
    isDefault: false,
    isActive: true,
    maxProperties: 10,
    maxMembers: 15,
    aiAgent: true,
    integrations: true,
    removeBranding: true,
    isContactSales: false,
    stripeMonthlyPriceId: 'price_growth_month',
    stripeAnnualPriceId: 'price_growth_year',
  },
];

function subscriptionSnapshot(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'sub_1',
    customerId: 'cus_1',
    status: 'active' as Stripe.Subscription.Status,
    interval: 'month' as const,
    priceId: 'price_growth_month',
    currentPeriodStart: now,
    currentPeriodEnd: periodEnd,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    accountId: 'acc_1',
    ...overrides,
  };
}

function harness(opts: { subscription?: Partial<Record<string, unknown>>; properties?: number } = {}) {
  const subscriptionRow: Record<string, unknown> = {
    id: 'subrow_1',
    accountId: 'acc_1',
    planId: 'plan_free',
    status: 'none',
    interval: 'month',
    provider: 'manual',
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    pastDueSince: null,
    lockedAt: null,
    ...opts.subscription,
  };
  const events = new Map<string, Record<string, unknown>>();
  const invoices = new Map<string, Record<string, unknown>>();

  const db = {
    stripeEvent: {
      create: vi.fn(async ({ data }: { data: { id: string; type: string } }) => {
        if (events.has(data.id)) throw Object.assign(new Error('dup'), { code: 'P2002' });
        events.set(data.id, { ...data });
        return data;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        events.set(where.id, { ...events.get(where.id), ...data });
      }),
    },
    subscription: {
      findUnique: vi.fn(async ({ where, include }: { where: { accountId?: string }; include?: unknown }) => {
        if (where.accountId !== undefined && where.accountId !== subscriptionRow['accountId']) return null;
        return include
          ? { ...subscriptionRow, plan: plans.find((p) => p.id === subscriptionRow['planId']) }
          : { ...subscriptionRow };
      }),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        for (const [key, value] of Object.entries(where)) {
          if (subscriptionRow[key] !== value) return null;
        }
        return { ...subscriptionRow };
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(subscriptionRow, data);
        return { ...subscriptionRow };
      }),
    },
    plan: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (where['OR']) {
          const wanted = (where['OR'] as Record<string, string>[]).map((o) => Object.values(o)[0]);
          return plans.find((p) => wanted.includes(p.stripeMonthlyPriceId ?? '') || wanted.includes(p.stripeAnnualPriceId ?? '')) ?? null;
        }
        if (where['isDefault']) return plans.find((p) => p.isDefault) ?? null;
        return null;
      }),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => plans.find((p) => p.id === where.id) ?? null),
    },
    invoice: {
      findUnique: vi.fn(async ({ where }: { where: { stripeInvoiceId: string } }) => invoices.get(where.stripeInvoiceId) ?? null),
      upsert: vi.fn(async ({ where, create, update }: { where: { stripeInvoiceId: string }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
        const existing = invoices.get(where.stripeInvoiceId);
        invoices.set(where.stripeInvoiceId, existing ? { ...existing, ...update } : { ...create });
      }),
    },
    property: { count: vi.fn().mockResolvedValue(opts.properties ?? 0) },
    accountMember: { count: vi.fn().mockResolvedValue(1) },
  };

  let nextEvent: Record<string, unknown> | null = null;
  let retrieved = subscriptionSnapshot();
  const gateway = {
    constructEvent: vi.fn(() => {
      if (!nextEvent) throw new Error('no event queued');
      return nextEvent;
    }),
    retrieveSubscription: vi.fn(async () => retrieved),
  };

  const deliver = vi.fn().mockResolvedValue(undefined);
  const entitlements = new EntitlementService({ db: db as never, graceDays: async () => 3, clock });
  const service = new StripeWebhookService({
    db: db as never,
    entitlements,
    gateway: gateway as never,
    brand: { productName: 'GetChat', appUrl: 'https://getchat.site', supportEmail: 'help@getchat.site' } as never,
    deliver,
    ownerOf: async () => ({ email: 'owner@example.com', name: 'Owner' }),
    graceDays: async () => 3,
    clock,
  });

  return {
    service,
    db,
    gateway,
    deliver,
    subscriptionRow,
    invoices,
    events,
    send(event: Record<string, unknown>, fresh?: ReturnType<typeof subscriptionSnapshot>) {
      nextEvent = event;
      if (fresh) retrieved = fresh;
      return service.handle('{}', 'sig', 'whsec');
    },
  };
}

const subscriptionObject = (overrides: Record<string, unknown> = {}) => ({
  id: 'sub_1',
  customer: 'cus_1',
  status: 'active',
  items: {
    data: [
      {
        price: { id: 'price_growth_month', recurring: { interval: 'month' } },
        current_period_start: now.getTime() / 1000,
        current_period_end: periodEnd.getTime() / 1000,
      },
    ],
  },
  cancel_at_period_end: false,
  canceled_at: null,
  metadata: { accountId: 'acc_1' },
  ...overrides,
});

const invoiceObject = (overrides: Record<string, unknown> = {}) => ({
  id: 'in_1',
  customer: 'cus_1',
  parent: { subscription_details: { subscription: 'sub_1' } },
  number: 'INV-0001',
  status: 'paid',
  amount_due: 5000,
  amount_paid: 5000,
  currency: 'usd',
  hosted_invoice_url: 'https://stripe.test/inv',
  invoice_pdf: 'https://stripe.test/inv.pdf',
  lines: { data: [{ description: 'Growth', period: { start: now.getTime() / 1000, end: periodEnd.getTime() / 1000 } }] },
  created: now.getTime() / 1000,
  status_transitions: { paid_at: now.getTime() / 1000 },
  ...overrides,
});

describe('StripeWebhookService', () => {
  it('activates the plan a checkout bought and sends the welcome email', async () => {
    const h = harness();
    const outcome = await h.send({
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: { object: { mode: 'subscription', subscription: 'sub_1', client_reference_id: 'acc_1' } },
    });
    expect(outcome).toEqual({ handled: true, type: 'checkout.session.completed' });
    expect(h.subscriptionRow).toMatchObject({
      planId: 'plan_growth',
      status: 'active',
      provider: 'stripe',
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: 'sub_1',
      currentPeriodEnd: periodEnd,
    });
    expect(h.deliver).toHaveBeenCalledTimes(1);
    expect(h.deliver.mock.calls[0]?.[0].subject).toContain('Growth');
    expect(h.events.get('evt_1')?.['processedAt']).toEqual(now);
  });

  it('acknowledges a redelivered event without doing anything twice', async () => {
    const h = harness();
    const event = {
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: { object: { mode: 'subscription', subscription: 'sub_1', client_reference_id: 'acc_1' } },
    };
    await h.send(event);
    const again = await h.send(event);
    expect(again).toEqual({ handled: false, reason: 'duplicate', type: 'checkout.session.completed' });
    expect(h.deliver).toHaveBeenCalledTimes(1);
  });

  it('refuses an event whose signature does not verify, before touching anything', async () => {
    const h = harness();
    h.gateway.constructEvent.mockImplementationOnce(() => {
      throw new AppError(ErrorCode.UNAUTHENTICATED, 'Webhook signature could not be verified');
    });
    let code: string | null = null;
    try {
      await h.service.handle('{}', 'bad', 'whsec');
    } catch (error) {
      code = (error as { code?: string }).code ?? null;
    }
    expect(code).toBe(ErrorCode.UNAUTHENTICATED);
    expect(h.db.stripeEvent.create).not.toHaveBeenCalled();
    expect(h.events.size).toBe(0);
  });

  it('leaves an event about a subscription nobody here owns alone', async () => {
    const h = harness();
    const outcome = await h.send(
      { id: 'evt_x', type: 'customer.subscription.updated', data: { object: subscriptionObject({ id: 'sub_other', customer: 'cus_other', metadata: {} }) } },
      subscriptionSnapshot({ id: 'sub_other', customerId: 'cus_other', accountId: null }),
    );
    expect(outcome).toEqual({ handled: false, reason: 'unlinked', type: 'customer.subscription.updated' });
    expect(h.subscriptionRow['status']).toBe('none');
  });

  it('starts the grace clock when a subscription goes past due, and stops it on recovery', async () => {
    const h = harness({
      subscription: { planId: 'plan_growth', status: 'active', provider: 'stripe', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1' },
    });
    await h.send(
      { id: 'evt_pd', type: 'customer.subscription.updated', data: { object: subscriptionObject({ status: 'past_due' }) } },
      subscriptionSnapshot({ status: 'past_due' }),
    );
    expect(h.subscriptionRow).toMatchObject({ status: 'past_due', pastDueSince: now });

    await h.send(
      { id: 'evt_ok', type: 'customer.subscription.updated', data: { object: subscriptionObject() } },
      subscriptionSnapshot(),
    );
    expect(h.subscriptionRow).toMatchObject({ status: 'active', pastDueSince: null, lockedAt: null });
  });

  it('puts an ended subscription back on the default plan and keeps the Stripe customer', async () => {
    const h = harness({
      subscription: { planId: 'plan_growth', status: 'active', provider: 'stripe', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1', currentPeriodEnd: periodEnd },
    });
    const outcome = await h.send({
      id: 'evt_del',
      type: 'customer.subscription.deleted',
      data: { object: subscriptionObject({ status: 'canceled', canceled_at: now.getTime() / 1000 }) },
    });
    expect(outcome).toEqual({ handled: true, type: 'customer.subscription.deleted' });
    expect(h.subscriptionRow).toMatchObject({
      planId: 'plan_free',
      status: 'none',
      provider: 'manual',
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: null,
      currentPeriodEnd: null,
      lockedAt: null,
    });
    expect(h.deliver).toHaveBeenCalledTimes(1);
    const mail = h.deliver.mock.calls[0]?.[0];
    expect(mail.subject).toContain('Growth subscription has ended');
    expect(mail.text).toContain('Free plan');
    expect(mail.text).not.toContain('locked');
  });

  it('tells a downgraded account that no longer fits its plan that the dashboard stays locked', async () => {
    const h = harness({
      properties: 4,
      subscription: { planId: 'plan_growth', status: 'active', provider: 'stripe', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1' },
    });
    await h.send({
      id: 'evt_del',
      type: 'customer.subscription.deleted',
      data: { object: subscriptionObject({ status: 'canceled' }) },
    });
    expect(h.deliver.mock.calls[0]?.[0].text).toContain('stays locked');
  });

  /** The final `deleted` of a replaced subscription must not reset the replacement. */
  it('ignores a late event about a subscription the account has already replaced', async () => {
    const h = harness({
      subscription: { planId: 'plan_growth', status: 'active', provider: 'stripe', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_2' },
    });
    const outcome = await h.send({
      id: 'evt_late',
      type: 'customer.subscription.deleted',
      data: { object: subscriptionObject({ id: 'sub_1', status: 'canceled' }) },
    });
    expect(outcome).toEqual({ handled: false, reason: 'ignored', type: 'customer.subscription.deleted' });
    expect(h.subscriptionRow).toMatchObject({ planId: 'plan_growth', status: 'active', stripeSubscriptionId: 'sub_2' });
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it('mirrors a paid invoice and sends the receipt once, however many paid events arrive', async () => {
    const h = harness({
      subscription: { planId: 'plan_growth', status: 'active', provider: 'stripe', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1' },
    });
    await h.send({ id: 'evt_i1', type: 'invoice.paid', data: { object: invoiceObject() } });
    await h.send({ id: 'evt_i2', type: 'invoice.payment_succeeded', data: { object: invoiceObject() } });
    await h.send({ id: 'evt_i3', type: 'invoice.updated', data: { object: invoiceObject() } });

    expect(h.invoices.get('in_1')).toMatchObject({
      accountId: 'acc_1',
      number: 'INV-0001',
      status: 'paid',
      amountPaidCents: 5000,
      planName: 'Growth',
      hostedInvoiceUrl: 'https://stripe.test/inv',
    });
    expect(h.deliver).toHaveBeenCalledTimes(1);
    expect(h.deliver.mock.calls[0]?.[0].subject).toMatch(/receipt|paid/i);
  });

  it('tells the owner about a failed payment and when the grace window ends', async () => {
    const h = harness({
      subscription: { planId: 'plan_growth', status: 'past_due', provider: 'stripe', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1', pastDueSince: now },
    });
    await h.send({
      id: 'evt_f',
      type: 'invoice.payment_failed',
      data: { object: invoiceObject({ status: 'open', amount_paid: 0, status_transitions: { paid_at: null } }) },
    });
    expect(h.invoices.get('in_1')).toMatchObject({ status: 'open', amountPaidCents: 0 });
    expect(h.deliver).toHaveBeenCalledTimes(1);
    const mail = h.deliver.mock.calls[0]?.[0];
    expect(mail.subject).toMatch(/payment/i);
    expect(mail.text).toContain('September 11, 2026');
  });

  it('records the failure on the event row when handling throws, and rethrows', async () => {
    const h = harness();
    h.db.subscription.findUnique.mockRejectedValueOnce(new Error('database away'));
    await expect(
      h.send({
        id: 'evt_boom',
        type: 'checkout.session.completed',
        data: { object: { mode: 'subscription', subscription: 'sub_1', client_reference_id: 'acc_1' } },
      }),
    ).rejects.toThrow('database away');
    expect(h.events.get('evt_boom')?.['error']).toBe('database away');
  });
});
