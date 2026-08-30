import type { Database, Webhook, WebhookDelivery } from '@smartchat/database';
import { ActorType as DbActorType } from '@smartchat/database';
import {
  AppError,
  ErrorCode,
  Permission,
  WebhookEvent,
  type TenantContext,
} from '@smartchat/types';
import type { CreateWebhookInput, UpdateWebhookInput } from '@smartchat/validation';
import { generateToken } from '../crypto/tokens.js';
import {
  DELIVERY_HEADER,
  EVENT_HEADER,
  MAX_DELIVERY_ATTEMPTS,
  SIGNATURE_HEADER,
  nextAttemptDelayMs,
  signPayload,
} from '../integrations/signature.js';
import { AuditRepository } from '../repositories/audit.repository.js';
import { notDeleted, tenantScope } from '../repositories/scope.js';
import { requirePermission } from '../tenancy/context.js';
import { systemClock, type Clock } from '../time.js';

/**
 * Webhooks.
 *
 * The design decision that matters is where the queue lives: **in the database**, not in Redis.
 *
 * A delivery row is written by the same request that caused the event, so a worker restart, a
 * Redis flush or a dropped pub/sub message cannot lose it. The BullMQ job that carries it is an
 * optimisation for latency; a sweeper picks up anything the job never reached. That is the
 * difference between "we told them" and "we published something and hoped somebody was listening"
 * - and for an integration that moves somebody's money or opens somebody's door, it is the whole
 * difference.
 */

/** The dispatcher's own limits. An endpoint gets a short time and a small answer. */
export const DELIVERY_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_CHARS = 2_000;
/** How many failures in a row before an endpoint is considered gone rather than unlucky. */
export const FAILURES_BEFORE_DISABLE = 20;

export interface WebhookServiceOptions {
  db: Database;
  clock?: Clock;
  /** Optional: nudge the dispatcher so a delivery does not wait for the next sweep. */
  notify?: (deliveryId: string) => Promise<void>;
  /** Injectable for tests; the real one is `fetch`. */
  send?: typeof fetch;
  /**
   * The platform kill switch for webhooks. Optional so the dispatcher can be built without it.
   * It stops new deliveries being *queued*; anything already queued still goes, because dropping
   * a delivery somebody is waiting for is a different and much worse act than pausing new ones.
   */
  flags?: { isEnabled(flag: 'webhooks', accountId?: string): Promise<boolean> };
}

export type WebhookWithoutSecret = Omit<Webhook, 'secret'>;

export class WebhookService {
  private readonly clock: Clock;
  private readonly audit: AuditRepository;

  constructor(private readonly options: WebhookServiceOptions) {
    this.clock = options.clock ?? systemClock;
    this.audit = new AuditRepository(options.db);
  }

  // ---------------------------------------------------------------------------
  // Managing endpoints
  // ---------------------------------------------------------------------------

  async list(context: TenantContext): Promise<WebhookWithoutSecret[]> {
    requirePermission(context, Permission.ACCOUNT_VIEW);
    const rows = await this.options.db.webhook.findMany({
      where: { ...tenantScope(context), ...notDeleted() },
      orderBy: [{ createdAt: 'desc' }],
    });
    // The secret is shown once, at creation. A list endpoint that returns it turns every
    // read-only screen into a place secrets leak from.
    return rows.map(({ secret: _secret, ...webhook }) => webhook);
  }

  async create(
    context: TenantContext,
    input: CreateWebhookInput,
  ): Promise<{ webhook: WebhookWithoutSecret; secret: string }> {
    requirePermission(context, Permission.ACCOUNT_UPDATE);
    const secret = `whsec_${generateToken(24)}`;

    const created = await this.options.db.webhook.create({
      data: {
        accountId: context.accountId,
        name: input.name,
        url: input.url,
        secret,
        events: input.events,
        enabled: input.enabled,
        createdByMemberId: context.memberId ?? null,
      },
    });

    await this.audit.record({
      accountId: context.accountId,
      actorType: DbActorType.user,
      actorId: context.userId ?? null,
      action: 'webhook.created',
      resourceType: 'webhook',
      resourceId: created.id,
      ip: context.ip ?? null,
      metadata: { url: created.url, events: created.events },
    });

    const { secret: _secret, ...webhook } = created;
    return { webhook, secret };
  }

  async update(
    context: TenantContext,
    id: string,
    input: UpdateWebhookInput,
  ): Promise<WebhookWithoutSecret> {
    requirePermission(context, Permission.ACCOUNT_UPDATE);
    const existing = await this.find(context, id);

    /**
     * Re-enabling clears the failure count and the reason.
     *
     * Otherwise an endpoint auto-disabled at twenty failures would be re-disabled by its twenty
     * first, which is to say by its next one - and the person who just fixed it would watch it
     * turn itself off again for no visible reason.
     */
    const reviving = input.enabled === true && !existing.enabled;

    const updated = await this.options.db.webhook.update({
      where: { id },
      data: {
        ...input,
        ...(reviving ? { consecutiveFailures: 0, disabledAt: null, disabledReason: null } : {}),
      },
    });
    const { secret: _secret, ...webhook } = updated;
    return webhook;
  }

  async remove(context: TenantContext, id: string): Promise<void> {
    requirePermission(context, Permission.ACCOUNT_UPDATE);
    await this.find(context, id);
    await this.options.db.webhook.update({
      where: { id },
      data: { deletedAt: this.clock.now(), enabled: false },
    });
  }

  private async find(context: TenantContext, id: string): Promise<Webhook> {
    const webhook = await this.options.db.webhook.findFirst({
      where: { ...tenantScope(context), ...notDeleted(), id },
    });
    if (!webhook) throw new AppError(ErrorCode.NOT_FOUND);
    return webhook;
  }

  async deliveries(context: TenantContext, id: string, limit: number): Promise<WebhookDelivery[]> {
    requirePermission(context, Permission.ACCOUNT_VIEW);
    await this.find(context, id);
    return this.options.db.webhookDelivery.findMany({
      where: { ...tenantScope(context), webhookId: id },
      orderBy: [{ createdAt: 'desc' }],
      take: limit,
    });
  }

  /** Send a `ping`, so somebody can find out whether their endpoint works before they need it to. */
  async ping(context: TenantContext, id: string): Promise<WebhookDelivery> {
    requirePermission(context, Permission.ACCOUNT_UPDATE);
    const webhook = await this.find(context, id);
    const deliveries = await this.queue(webhook.accountId, WebhookEvent.PING, {
      webhookId: webhook.id,
      message: 'If you are reading this, your endpoint is reachable and your signature verifies.',
    });
    const delivery = deliveries[0];
    if (!delivery) throw new AppError(ErrorCode.INTERNAL_ERROR);
    return delivery;
  }

  // ---------------------------------------------------------------------------
  // Emitting
  // ---------------------------------------------------------------------------

  /**
   * Record that something happened, for every endpoint that asked about it.
   *
   * Writes rows; does not send. Sending is the dispatcher's job, and keeping them apart is what
   * makes the emitting side cheap enough to call from inside a request that a person is waiting
   * on - and what makes a slow endpoint somebody else's problem rather than the visitor's.
   */
  async queue(
    accountId: string,
    event: WebhookEvent,
    data: Record<string, unknown>,
  ): Promise<WebhookDelivery[]> {
    if (this.options.flags && !(await this.options.flags.isEnabled('webhooks', accountId))) {
      return [];
    }

    const subscribers = await this.options.db.webhook.findMany({
      where: {
        accountId,
        deletedAt: null,
        enabled: true,
        events: { has: event },
        ...(event === WebhookEvent.PING ? { id: data['webhookId'] as string } : {}),
      },
      select: { id: true },
    });
    if (subscribers.length === 0) return [];

    const now = this.clock.now();
    const payload = {
      event,
      // Included in the signed body: a receiver can reject something replayed from last week even
      // if their own clock check is generous.
      sentAt: now.toISOString(),
      accountId,
      data,
    };

    const created: WebhookDelivery[] = [];
    for (const subscriber of subscribers) {
      const delivery = await this.options.db.webhookDelivery.create({
        data: {
          accountId,
          webhookId: subscriber.id,
          event,
          payload: payload as never,
          nextAttemptAt: now,
        },
      });
      created.push(delivery);
      // Best-effort: the row is already durable, so a queue that is down costs latency, not the
      // delivery itself.
      await this.options.notify?.(delivery.id).catch(() => undefined);
    }
    return created;
  }

  // ---------------------------------------------------------------------------
  // Dispatching
  // ---------------------------------------------------------------------------

  /** Everything due, oldest first. The sweeper's query, and the safety net under the queue. */
  async dueDeliveries(limit: number): Promise<WebhookDelivery[]> {
    return this.options.db.webhookDelivery.findMany({
      where: { status: 'pending', nextAttemptAt: { lte: this.clock.now() } },
      orderBy: [{ nextAttemptAt: 'asc' }],
      take: limit,
    });
  }

  /**
   * Attempt one delivery.
   *
   * Returns what happened rather than throwing, because every outcome here is an ordinary one: an
   * endpoint that is down is not an error in this system.
   */
  async attempt(deliveryId: string): Promise<{ status: string; responseStatus?: number }> {
    const delivery = await this.options.db.webhookDelivery.findUnique({
      where: { id: deliveryId },
    });
    if (!delivery || delivery.status !== 'pending') return { status: 'skipped' };

    const webhook = await this.options.db.webhook.findFirst({
      where: { accountId: delivery.accountId, id: delivery.webhookId },
    });
    if (!webhook || webhook.deletedAt) {
      await this.options.db.webhookDelivery.update({
        where: { id: delivery.id },
        data: { status: 'failed', error: 'The endpoint was removed' },
      });
      return { status: 'failed' };
    }

    const body = JSON.stringify(delivery.payload);
    const seconds = Math.floor(this.clock.now().getTime() / 1000);
    const attempts = delivery.attempts + 1;

    let responseStatus: number | undefined;
    let responseBody = '';
    let error: string | undefined;

    try {
      const send = this.options.send ?? fetch;
      const response = await send(webhook.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [SIGNATURE_HEADER]: signPayload(webhook.secret, body, seconds),
          [EVENT_HEADER]: delivery.event,
          [DELIVERY_HEADER]: delivery.id,
          'user-agent': 'SmartChat-Webhooks/1.0',
        },
        body,
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      responseStatus = response.status;
      responseBody = (await response.text().catch(() => '')).slice(0, MAX_RESPONSE_CHARS);
    } catch (caught) {
      error = caught instanceof Error ? caught.message.slice(0, 300) : 'Delivery failed';
    }

    const accepted = responseStatus !== undefined && responseStatus >= 200 && responseStatus < 300;

    if (accepted) {
      await this.options.db.$transaction([
        this.options.db.webhookDelivery.update({
          where: { id: delivery.id },
          data: {
            status: 'delivered',
            attempts,
            responseStatus: responseStatus ?? null,
            responseBody,
            error: null,
            deliveredAt: this.clock.now(),
          },
        }),
        this.options.db.webhook.update({
          where: { id: webhook.id },
          // Any success resets the count: an endpoint that answered is not gone.
          data: { consecutiveFailures: 0, lastDeliveryAt: this.clock.now() },
        }),
      ]);
      return { status: 'delivered', ...(responseStatus ? { responseStatus } : {}) };
    }

    const exhausted = attempts >= MAX_DELIVERY_ATTEMPTS;
    const failures = webhook.consecutiveFailures + 1;
    const disable = failures >= FAILURES_BEFORE_DISABLE;

    await this.options.db.$transaction([
      this.options.db.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: exhausted ? 'failed' : 'pending',
          attempts,
          responseStatus: responseStatus ?? null,
          responseBody,
          error: error ?? `Endpoint answered ${responseStatus}`,
          nextAttemptAt: new Date(this.clock.now().getTime() + nextAttemptDelayMs(attempts - 1)),
        },
      }),
      this.options.db.webhook.update({
        where: { id: webhook.id },
        data: {
          consecutiveFailures: failures,
          lastDeliveryAt: this.clock.now(),
          ...(disable
            ? {
                enabled: false,
                disabledAt: this.clock.now(),
                disabledReason: `${failures} deliveries in a row were not accepted`,
              }
            : {}),
        },
      }),
    ]);

    return {
      status: exhausted ? 'failed' : 'pending',
      ...(responseStatus ? { responseStatus } : {}),
    };
  }
}

/**
 * The slice of the webhook service other services depend on.
 *
 * An interface rather than the class, for the same reason as the ticket opener: a conversation
 * does not need to know what a signature is, and stating the one method keeps the dependency from
 * quietly widening.
 */
export interface WebhookEmitter {
  queue(accountId: string, event: WebhookEvent, data: Record<string, unknown>): Promise<unknown>;
}
