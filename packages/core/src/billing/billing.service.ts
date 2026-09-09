import type { Database, Invoice, Plan } from '@smartchat/database';
import { ActorType as DbActorType } from '@smartchat/database';
import { AppError, ErrorCode, Permission, type TenantContext } from '@smartchat/types';
import { AuditAction, AuditRepository } from '../repositories/audit.repository.js';
import { requirePermission } from '../tenancy/context.js';
import type { MailMessage } from '../mail/provider.js';
import { billingEnquiryTemplate, type BrandContext } from '../mail/templates.js';
import type { EntitlementService, Entitlements } from './entitlements.js';
import type { PlatformSettingsService } from './settings.js';
import type { StripeGateway } from './stripe-gateway.js';

/**
 * Billing as an account sees it: which plan, what it allows, what it costs, what has been paid.
 *
 * Money never moves through this code. Checkout and card management are Stripe-hosted pages the
 * customer is sent to; what comes back is a webhook, handled elsewhere. This service reads the
 * mirror, starts those hosted sessions, and is the only place that decides which Stripe price a
 * plan and an interval mean.
 */

export type PlanCard = Pick<
  Plan,
  | 'id'
  | 'key'
  | 'name'
  | 'tagline'
  | 'description'
  | 'monthlyPriceCents'
  | 'annualPriceCents'
  | 'currency'
  | 'maxProperties'
  | 'maxMembers'
  | 'aiAgent'
  | 'aiRepliesPerMonth'
  | 'integrations'
  | 'removeBranding'
  | 'isContactSales'
  | 'sortOrder'
> & {
  /** Whether checkout can actually sell it: a Stripe price exists for at least one interval. */
  purchasable: boolean;
};

export interface BillingOverview {
  entitlements: Entitlements;
  usage: { properties: number; members: number };
  plans: PlanCard[];
  invoices: InvoiceView[];
  /** Whether "Manage payment" can work: Stripe is configured and this account has a customer. */
  canManagePayment: boolean;
  /** Whether anything can be bought at all. False until the operator enters Stripe keys. */
  checkoutAvailable: boolean;
  testMode: boolean;
}

export interface InvoiceView {
  id: string;
  number: string | null;
  status: Invoice['status'];
  amountDueCents: number;
  amountPaidCents: number;
  currency: string;
  planName: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  issuedAt: string | null;
  paidAt: string | null;
  hostedInvoiceUrl: string | null;
  invoicePdfUrl: string | null;
}

export interface BillingServiceOptions {
  db: Database;
  entitlements: EntitlementService;
  settings: PlatformSettingsService;
  /** Built from the current Stripe secret; null until the operator has entered one. */
  gateway: () => Promise<StripeGateway | null>;
  appUrl: string;
  brand: BrandContext;
  /** Hand an email to the queue. */
  deliver: (message: MailMessage) => Promise<void>;
  /** Where custom-plan enquiries land when the operator has not set a billing contact. */
  fallbackContactEmail: string;
}

export class BillingService {
  private readonly audit: AuditRepository;

  constructor(private readonly options: BillingServiceOptions) {
    this.audit = new AuditRepository(options.db);
  }

  /**
   * The plans as the public pricing page shows them: no context, no account, nothing about
   * whether Stripe is configured. What is on sale, for anybody to read.
   */
  async publicPlans(): Promise<Omit<PlanCard, 'purchasable'>[]> {
    const plans = await this.options.db.plan.findMany({
      where: { isActive: true, isPublic: true },
      orderBy: { sortOrder: 'asc' },
    });
    return plans.map(pickPlan);
  }

  async overview(context: TenantContext): Promise<BillingOverview> {
    requirePermission(context, Permission.BILLING_VIEW);
    const [entitlements, usage, plans, invoices, stripe, subscription] = await Promise.all([
      this.options.entitlements.forAccount(context.accountId),
      this.options.entitlements.usage(context.accountId),
      this.options.db.plan.findMany({
        where: { isActive: true, isPublic: true },
        orderBy: { sortOrder: 'asc' },
      }),
      this.options.db.invoice.findMany({
        where: { accountId: context.accountId, status: { not: 'draft' } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.options.settings.stripe(),
      this.options.db.subscription.findUnique({ where: { accountId: context.accountId } }),
    ]);

    return {
      entitlements,
      usage,
      plans: plans.map((plan) => ({
        ...pickPlan(plan),
        purchasable:
          !plan.isContactSales &&
          stripe !== null &&
          (plan.stripeMonthlyPriceId !== null || plan.stripeAnnualPriceId !== null),
      })),
      invoices: invoices.map(toInvoiceView),
      canManagePayment: stripe !== null && typeof subscription?.stripeCustomerId === 'string',
      checkoutAvailable: stripe !== null,
      testMode: stripe?.testMode ?? false,
    };
  }

  /**
   * Start buying a plan. Returns the Stripe-hosted page to send the browser to.
   *
   * An account that already pays is moved rather than sold to again: a second checkout would
   * create a second subscription, and Stripe would charge for both. That path prorates and
   * returns null, meaning "done, no page to visit".
   */
  async startCheckout(
    context: TenantContext,
    input: { planKey: string; interval: 'month' | 'year' },
    accountEmail: string,
  ): Promise<{ url: string } | { changed: true }> {
    requirePermission(context, Permission.BILLING_MANAGE);

    const gateway = await this.options.gateway();
    if (!gateway) throw new AppError(ErrorCode.BILLING_NOT_CONFIGURED);

    const plan = await this.options.db.plan.findFirst({
      where: { key: input.planKey, isActive: true, isPublic: true },
    });
    if (!plan || plan.isContactSales) throw new AppError(ErrorCode.PLAN_NOT_FOUND);

    const priceId = input.interval === 'year' ? plan.stripeAnnualPriceId : plan.stripeMonthlyPriceId;
    if (!priceId) {
      throw new AppError(ErrorCode.PLAN_NOT_FOUND, `${plan.name} is not available ${input.interval === 'year' ? 'annually' : 'monthly'}.`);
    }

    const account = await this.options.db.account.findUniqueOrThrow({
      where: { id: context.accountId },
      include: { subscription: true },
    });
    const subscription = account.subscription;

    // Already paying through Stripe: change the price on the existing subscription.
    if (
      subscription?.provider === 'stripe' &&
      subscription.stripeSubscriptionId &&
      ['active', 'past_due'].includes(subscription.status)
    ) {
      await gateway.changeSubscriptionPrice(subscription.stripeSubscriptionId, priceId);
      // The webhook will bring the authoritative state; record the intent now so a page reload
      // before it arrives does not show the old plan.
      await this.options.db.subscription.update({
        where: { accountId: context.accountId },
        data: { planId: plan.id, interval: input.interval },
      });
      this.options.entitlements.invalidate(context.accountId);
      await this.audit.record({
        accountId: context.accountId,
        actorType: DbActorType.user,
        actorId: context.userId ?? null,
        action: AuditAction.BILLING_PLAN_CHANGED,
        resourceType: 'subscription',
        resourceId: subscription.id,
        ip: context.ip ?? null,
        metadata: { planKey: plan.key, interval: input.interval, via: 'price_change' },
      });
      return { changed: true };
    }

    const customerId = await gateway.ensureCustomer({
      existingId: subscription?.stripeCustomerId ?? null,
      accountId: account.id,
      accountName: account.name,
      email: accountEmail,
    });
    if (subscription && subscription.stripeCustomerId !== customerId) {
      await this.options.db.subscription.update({
        where: { accountId: context.accountId },
        data: { stripeCustomerId: customerId },
      });
    }

    const base = this.options.appUrl.replace(/\/$/, '');
    const url = await gateway.createCheckoutSession({
      customerId,
      priceId,
      accountId: account.id,
      successUrl: `${base}/app/billing?checkout=success`,
      cancelUrl: `${base}/app/billing?checkout=cancelled`,
    });

    await this.audit.record({
      accountId: context.accountId,
      actorType: DbActorType.user,
      actorId: context.userId ?? null,
      action: AuditAction.BILLING_CHECKOUT_STARTED,
      resourceType: 'plan',
      resourceId: plan.id,
      ip: context.ip ?? null,
      metadata: { planKey: plan.key, interval: input.interval },
    });

    return { url };
  }

  /** The Stripe-hosted page for cards, invoices and cancellation. */
  async openPortal(context: TenantContext): Promise<{ url: string }> {
    requirePermission(context, Permission.BILLING_MANAGE);
    const gateway = await this.options.gateway();
    if (!gateway) throw new AppError(ErrorCode.BILLING_NOT_CONFIGURED);

    const subscription = await this.options.db.subscription.findUnique({
      where: { accountId: context.accountId },
    });
    if (!subscription?.stripeCustomerId) {
      throw new AppError(
        ErrorCode.NOT_FOUND,
        'There is no payment method on file yet. Choose a plan to add one.',
      );
    }
    const base = this.options.appUrl.replace(/\/$/, '');
    const url = await gateway.createPortalSession({
      customerId: subscription.stripeCustomerId,
      returnUrl: `${base}/app/billing`,
    });
    return { url };
  }

  /** "I need something bigger." Stored, and emailed to whoever handles sales. */
  async enquire(
    context: TenantContext,
    input: { name: string; email: string; message: string; wants: Record<string, unknown> },
  ): Promise<void> {
    requirePermission(context, Permission.BILLING_VIEW);
    const account = await this.options.db.account.findUniqueOrThrow({
      where: { id: context.accountId },
    });

    await this.options.db.billingEnquiry.create({
      data: {
        accountId: context.accountId,
        userId: context.userId ?? null,
        email: input.email,
        name: input.name,
        message: input.message,
        wants: input.wants as never,
      },
    });

    const to =
      (await this.options.settings.get('billing.contact_email')) ?? this.options.fallbackContactEmail;
    await this.options.deliver(
      billingEnquiryTemplate(this.options.brand, {
        to,
        accountName: account.name,
        accountId: account.id,
        fromName: input.name,
        fromEmail: input.email,
        message: input.message,
        wants: input.wants,
      }),
    );

    await this.audit.record({
      accountId: context.accountId,
      actorType: DbActorType.user,
      actorId: context.userId ?? null,
      action: AuditAction.BILLING_ENQUIRY_SENT,
      resourceType: 'account',
      resourceId: account.id,
      ip: context.ip ?? null,
      metadata: {},
    });
  }
}

export function pickPlan(plan: Plan): Omit<PlanCard, 'purchasable'> {
  return {
    id: plan.id,
    key: plan.key,
    name: plan.name,
    tagline: plan.tagline,
    description: plan.description,
    monthlyPriceCents: plan.monthlyPriceCents,
    annualPriceCents: plan.annualPriceCents,
    currency: plan.currency,
    maxProperties: plan.maxProperties,
    maxMembers: plan.maxMembers,
    aiAgent: plan.aiAgent,
    aiRepliesPerMonth: plan.aiRepliesPerMonth,
    integrations: plan.integrations,
    removeBranding: plan.removeBranding,
    isContactSales: plan.isContactSales,
    sortOrder: plan.sortOrder,
  };
}

export function toInvoiceView(invoice: Invoice): InvoiceView {
  return {
    id: invoice.id,
    number: invoice.number,
    status: invoice.status,
    amountDueCents: invoice.amountDueCents,
    amountPaidCents: invoice.amountPaidCents,
    currency: invoice.currency,
    planName: invoice.planName,
    periodStart: invoice.periodStart?.toISOString() ?? null,
    periodEnd: invoice.periodEnd?.toISOString() ?? null,
    issuedAt: invoice.issuedAt?.toISOString() ?? null,
    paidAt: invoice.paidAt?.toISOString() ?? null,
    hostedInvoiceUrl: invoice.hostedInvoiceUrl,
    invoicePdfUrl: invoice.invoicePdfUrl,
  };
}
