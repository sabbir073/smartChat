import Stripe from 'stripe';
import { AppError, ErrorCode } from '@smartchat/types';

/**
 * Everything this product says to Stripe, in one place.
 *
 * A thin wrapper rather than a leak of the SDK: the services above it talk in terms of accounts,
 * plans and intervals, and this is where those become customers, products and prices. It also
 * means the SDK's shape - which changed materially in the 2025 API versions, moving the billing
 * period from the subscription onto its items and the subscription reference on an invoice under
 * `parent` - is dealt with exactly once.
 *
 * Constructed per configuration, not per request: a key typed into the console yesterday must
 * be the one used today, so the container rebuilds the gateway when the secret changes.
 */

export interface SubscriptionSnapshot {
  id: string;
  customerId: string;
  status: Stripe.Subscription.Status;
  interval: 'month' | 'year';
  priceId: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
  /** Our own account id, carried in metadata from checkout so a webhook can find its way home. */
  accountId: string | null;
}

export interface InvoiceSnapshot {
  id: string;
  customerId: string | null;
  subscriptionId: string | null;
  number: string | null;
  status: 'draft' | 'open' | 'paid' | 'uncollectible' | 'void';
  amountDueCents: number;
  amountPaidCents: number;
  currency: string;
  hostedInvoiceUrl: string | null;
  invoicePdfUrl: string | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  issuedAt: Date | null;
  paidAt: Date | null;
  /** The first line's description, which Stripe fills with the product name. */
  planName: string | null;
}

export interface PlanPriceSync {
  productId: string;
  monthlyPriceId: string | null;
  annualPriceId: string | null;
}

export class StripeGateway {
  private readonly stripe: Stripe;

  constructor(secretKey: string, options: { productName: string } = { productName: 'SmartChat' }) {
    this.stripe = new Stripe(secretKey, {
      // Two retries on network trouble; Stripe's idempotency keys make that safe for writes.
      maxNetworkRetries: 2,
      timeout: 20_000,
      appInfo: { name: options.productName },
    });
  }

  /** Is the key real and live? Cheap, and what the console's "Test connection" button calls. */
  async testConnection(): Promise<{ ok: true; livemode: boolean; accountName: string | null }> {
    // The balance object carries `livemode`, which tells us which side of Stripe the key belongs
    // to without guessing from its prefix. The account name is decoration: a restricted key
    // without the account-information permission cannot read it, and that must not turn a key
    // that can do everything billing needs into a "connection failed".
    const balance = await this.wrap(() => this.stripe.balance.retrieve());
    const account = await this.stripe.accounts.retrieveCurrent().catch(() => null);
    return {
      ok: true,
      livemode: balance.livemode,
      accountName:
        account?.settings?.dashboard?.display_name ?? account?.business_profile?.name ?? null,
    };
  }

  async ensureCustomer(input: {
    existingId: string | null;
    accountId: string;
    accountName: string;
    email: string;
  }): Promise<string> {
    if (input.existingId) {
      // Confirm it still exists in this Stripe account: a key swapped from test to live makes
      // every stored customer id a stranger, and creating a fresh one is the right answer.
      const existing = await this.wrap(() => this.stripe.customers.retrieve(input.existingId!)).catch(
        () => null,
      );
      if (existing && !('deleted' in existing && existing.deleted)) return input.existingId;
    }
    const customer = await this.wrap(() =>
      this.stripe.customers.create({
        name: input.accountName,
        email: input.email,
        metadata: { accountId: input.accountId },
      }),
    );
    return customer.id;
  }

  async createCheckoutSession(input: {
    customerId: string;
    priceId: string;
    accountId: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<string> {
    const session = await this.wrap(() =>
      this.stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: input.customerId,
        line_items: [{ price: input.priceId, quantity: 1 }],
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        client_reference_id: input.accountId,
        // On the subscription itself, so every later webhook about it carries our account id
        // without a lookup.
        subscription_data: { metadata: { accountId: input.accountId } },
        allow_promotion_codes: true,
        billing_address_collection: 'auto',
        // Stripe collects tax ids and addresses for the invoice when the customer wants them.
        // With an existing customer (ours always is - the customer is created before the
        // session), Stripe requires permission to write the business name and address it
        // collects back onto that customer, or it refuses the session outright.
        tax_id_collection: { enabled: true },
        customer_update: { name: 'auto', address: 'auto' },
      }),
    );
    if (!session.url) {
      throw new AppError(ErrorCode.PAYMENT_PROVIDER_ERROR, undefined, {
        context: { reason: 'checkout session had no url' },
      });
    }
    return session.url;
  }

  /** Where a customer changes their card, sees invoices, or cancels. Stripe-hosted. */
  async createPortalSession(input: { customerId: string; returnUrl: string }): Promise<string> {
    const session = await this.wrap(() =>
      this.stripe.billingPortal.sessions.create({
        customer: input.customerId,
        return_url: input.returnUrl,
      }),
    );
    return session.url;
  }

  /**
   * Move an existing subscription to a different price, prorating the difference.
   *
   * Used for a plan change by somebody who already pays: a second checkout would create a second
   * subscription, and Stripe would happily charge for both.
   */
  async changeSubscriptionPrice(subscriptionId: string, priceId: string): Promise<void> {
    const current = await this.wrap(() => this.stripe.subscriptions.retrieve(subscriptionId));
    const item = current.items.data[0];
    if (!item) {
      throw new AppError(ErrorCode.PAYMENT_PROVIDER_ERROR, undefined, {
        context: { reason: 'subscription has no items', subscriptionId },
      });
    }
    await this.wrap(() =>
      this.stripe.subscriptions.update(subscriptionId, {
        items: [{ id: item.id, price: priceId }],
        proration_behavior: 'create_prorations',
        cancel_at_period_end: false,
      }),
    );
  }

  async cancelAtPeriodEnd(subscriptionId: string, cancel: boolean): Promise<void> {
    await this.wrap(() =>
      this.stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: cancel }),
    );
  }

  async retrieveSubscription(id: string): Promise<SubscriptionSnapshot> {
    return snapshotSubscription(await this.wrap(() => this.stripe.subscriptions.retrieve(id)));
  }

  async retrieveInvoice(id: string): Promise<InvoiceSnapshot> {
    return snapshotInvoice(await this.wrap(() => this.stripe.invoices.retrieve(id)));
  }

  /**
   * Make Stripe's catalogue match ours.
   *
   * A Product per plan, a Price per interval. A Stripe Price is immutable, so a changed amount
   * means a new Price and the old one archived - existing subscriptions keep paying the price
   * they signed up at, which is both how Stripe works and what a customer expects.
   */
  async syncPlan(plan: {
    key: string;
    name: string;
    description: string | null;
    currency: string;
    monthlyPriceCents: number;
    annualPriceCents: number;
    stripeProductId: string | null;
    stripeMonthlyPriceId: string | null;
    stripeAnnualPriceId: string | null;
  }): Promise<PlanPriceSync> {
    let productId = plan.stripeProductId;

    if (productId) {
      const existing = await this.wrap(() => this.stripe.products.retrieve(productId!)).catch(
        () => null,
      );
      if (!existing || existing.deleted) productId = null;
      else if (existing.name !== plan.name || (existing.description ?? null) !== plan.description) {
        await this.wrap(() =>
          this.stripe.products.update(productId!, {
            name: plan.name,
            description: plan.description ?? '',
          }),
        );
      }
    }

    if (!productId) {
      const product = await this.wrap(() =>
        this.stripe.products.create({
          name: plan.name,
          description: plan.description ?? undefined,
          metadata: { planKey: plan.key },
        }),
      );
      productId = product.id;
    }

    const monthlyPriceId = await this.syncPrice({
      productId,
      existingPriceId: plan.stripeMonthlyPriceId,
      amountCents: plan.monthlyPriceCents,
      currency: plan.currency,
      interval: 'month',
      planKey: plan.key,
    });
    const annualPriceId = await this.syncPrice({
      productId,
      existingPriceId: plan.stripeAnnualPriceId,
      amountCents: plan.annualPriceCents,
      currency: plan.currency,
      interval: 'year',
      planKey: plan.key,
    });

    return { productId, monthlyPriceId, annualPriceId };
  }

  private async syncPrice(input: {
    productId: string;
    existingPriceId: string | null;
    amountCents: number;
    currency: string;
    interval: 'month' | 'year';
    planKey: string;
  }): Promise<string | null> {
    // A zero price is "not for sale on this interval". Nothing is created for it.
    if (input.amountCents <= 0) {
      if (input.existingPriceId) await this.archivePrice(input.existingPriceId);
      return null;
    }

    if (input.existingPriceId) {
      const existing = await this.wrap(() => this.stripe.prices.retrieve(input.existingPriceId!)).catch(
        () => null,
      );
      const unchanged =
        existing &&
        existing.active &&
        existing.unit_amount === input.amountCents &&
        existing.currency === input.currency.toLowerCase() &&
        existing.recurring?.interval === input.interval &&
        (typeof existing.product === 'string' ? existing.product : existing.product.id) ===
          input.productId;
      if (unchanged) return input.existingPriceId;
      if (existing?.active) await this.archivePrice(input.existingPriceId);
    }

    const price = await this.wrap(() =>
      this.stripe.prices.create({
        product: input.productId,
        unit_amount: input.amountCents,
        currency: input.currency.toLowerCase(),
        recurring: { interval: input.interval },
        metadata: { planKey: input.planKey },
      }),
    );
    return price.id;
  }

  private async archivePrice(priceId: string): Promise<void> {
    await this.wrap(() => this.stripe.prices.update(priceId, { active: false })).catch(() => {
      /* already gone, or never ours: nothing to archive */
    });
  }

  /** Verify a webhook's signature and parse it. The raw body, byte for byte, or it fails. */
  constructEvent(rawBody: Buffer | string, signature: string, webhookSecret: string): Stripe.Event {
    try {
      return this.stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    } catch (error) {
      throw new AppError(ErrorCode.UNAUTHENTICATED, 'Webhook signature could not be verified', {
        cause: error,
      });
    }
  }

  /**
   * Stripe's errors carry the request id, the decline code and a message meant for us, not for
   * the customer. Logged with the cause; the client sees one sentence.
   */
  private async wrap<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(ErrorCode.PAYMENT_PROVIDER_ERROR, undefined, {
        cause: error,
        context: {
          stripeType: (error as { type?: string }).type,
          stripeCode: (error as { code?: string }).code,
          requestId: (error as { requestId?: string }).requestId,
        },
      });
    }
  }
}

const seconds = (value: number | null | undefined): Date | null =>
  typeof value === 'number' ? new Date(value * 1000) : null;

export function snapshotSubscription(subscription: Stripe.Subscription): SubscriptionSnapshot {
  const item = subscription.items.data[0];
  const price = item?.price;
  const interval = price?.recurring?.interval === 'year' ? 'year' : 'month';
  return {
    id: subscription.id,
    customerId:
      typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id,
    status: subscription.status,
    interval,
    priceId: price?.id ?? null,
    // On the item since the 2025 API versions; the subscription no longer carries it.
    currentPeriodStart: seconds(item?.current_period_start),
    currentPeriodEnd: seconds(item?.current_period_end),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    canceledAt: seconds(subscription.canceled_at),
    accountId: subscription.metadata?.['accountId'] ?? null,
  };
}

export function snapshotInvoice(invoice: Stripe.Invoice): InvoiceSnapshot {
  const subscription = invoice.parent?.subscription_details?.subscription ?? null;
  const line = invoice.lines?.data?.[0];
  const status: string = invoice.status ?? 'open';
  return {
    id: invoice.id,
    customerId: typeof invoice.customer === 'string' ? invoice.customer : (invoice.customer?.id ?? null),
    subscriptionId: typeof subscription === 'string' ? subscription : (subscription?.id ?? null),
    number: invoice.number,
    status: status === 'draft' || status === 'open' || status === 'paid' || status === 'uncollectible' || status === 'void' ? status : 'open',
    amountDueCents: invoice.amount_due,
    amountPaidCents: invoice.amount_paid,
    currency: invoice.currency,
    hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
    invoicePdfUrl: invoice.invoice_pdf ?? null,
    periodStart: seconds(line?.period?.start),
    periodEnd: seconds(line?.period?.end),
    issuedAt: seconds(invoice.status_transitions?.finalized_at ?? invoice.created),
    paidAt: seconds(invoice.status_transitions?.paid_at),
    planName: line?.description ?? null,
  };
}
