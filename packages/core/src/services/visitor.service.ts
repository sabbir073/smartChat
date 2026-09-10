import type { Database, Visitor } from '@smartchat/database';
import { ActorType as DbActorType } from '@smartchat/database';
import {
  AppError,
  ErrorCode,
  Permission,
  type DeviceType,
  type TenantContext,
} from '@smartchat/types';
import type { WidgetConfig } from '@smartchat/validation';
import {
  VISITOR_TOKEN_TTL_SECONDS,
  issueVisitorToken,
  verifyVisitorToken,
} from '../crypto/visitor-token.js';
import {
  EMBED_TICKET_TTL_SECONDS,
  issueEmbedTicket,
  verifyEmbedTicket,
} from '../crypto/embed-ticket.js';
import { AuditRepository } from '../repositories/audit.repository.js';
import { PresenterService } from './presenter.service.js';
import { requirePermission, requirePropertyAccess } from '../tenancy/context.js';
import { PropertyRepository } from '../repositories/property.repository.js';
import { VisitorRepository } from '../repositories/visitor.repository.js';
import { WidgetRepository } from '../repositories/widget.repository.js';
import { MINUTE, systemClock, type Clock } from '../time.js';
import { hostFromOrigin, isOriginAllowed } from './domain-matcher.js';
import { parseUserAgent, sanitiseUrl } from './user-agent.js';

/** A session is considered finished after this much inactivity, and the next visit is a new one. */
export const SESSION_IDLE_MS = 30 * MINUTE;

export interface BootstrapInput {
  publicId: string;
  origin: string | undefined;
  /**
   * The ticket the loader was given, proving which page the widget is embedded in.
   *
   * The panel's own `origin` is this product's CDN host and says nothing about the customer's
   * site, so with domain enforcement on this is the only thing that can answer the question. See
   * `crypto/embed-ticket.ts`.
   */
  embedTicket?: string | undefined;
  /** An existing token from the widget's own localStorage, if the visitor has been here before. */
  token?: string | undefined;
  page?: { url?: string | undefined; title?: string | undefined; referrer?: string | undefined };
  screen?: { width?: number | undefined; height?: number | undefined };
  language?: string | undefined;
  timezone?: string | undefined;
  ip?: string | undefined;
  userAgent?: string | undefined;
  requestId: string;
}

export interface BootstrapResult {
  token: string;
  expiresInSeconds: number;
  visitor: {
    id: string;
    name: string | null;
    email: string | null;
    isReturning: boolean;
  };
  sessionId: string;
  property: { publicId: string; name: string };
  widget: { version: number; config: WidgetConfig };
  /** Drives the widget's online/offline copy before the socket has connected. */
  agentsAvailable: boolean;
  /**
   * The largest file this deployment accepts.
   *
   * Sent rather than assumed: the limit is a property of the server, and a widget that guesses it
   * either refuses files the server would have taken or lets somebody upload for a minute before
   * being told no.
   */
  maxUploadBytes: number;
  /**
   * Whether to show "Powered by ..." in the widget.
   *
   * Decided here, from the account's plan, and sent to the widget: a flag the widget worked out
   * for itself on the customer's page would be one line of JavaScript away from being worked out
   * differently.
   */
  showBranding: boolean;
  /**
   * Who the window shows at the top: the person the visitor's current conversation is assigned
   * to, or the account's owner. A name and a picture, nothing else about them.
   */
  presenter: { name: string; avatarUrl: string | null } | null;
}

export interface VisitorServiceOptions {
  db: Database;
  visitorTokenSecret: string;
  /** Development convenience: accept localhost origins whatever the allowed-domain list says. */
  allowLocalhostOrigins: boolean;
  /**
   * Whether any agent is available right now.
   *
   * Injected rather than depended on, so the visitor service does not need Redis: presence is the
   * realtime layer's concern, and this keeps the two testable apart.
   */
  isAgentAvailable?: (accountId: string) => Promise<boolean>;
  /**
   * IP → country, from the registries' own data. Injected for the same reason as presence: the
   * lookup lives in its own module with its own table, and a service test should not need it.
   * Absent means every visitor is "unknown", which is honest and is what a fresh deployment
   * shows until the first registry load has run.
   */
  resolveCountry?: (ip: string | null | undefined) => Promise<string | null>;
  /**
   * Whether the account's plan lets it hide the widget branding. Absent means the branding shows,
   * which is the safe default for a deployment that has not wired billing.
   */
  canRemoveBranding?: (accountId: string) => Promise<boolean>;
  maxUploadBytes?: number;
  clock?: Clock;
}

/**
 * Everything the widget needs to start, in one call.
 *
 * The widget is on somebody else's website, so this endpoint is the trust boundary: the property
 * is identified by a public id that authorises nothing, the origin is validated against the
 * property's own allowed-domain list, and the visitor identity comes from a token we signed - never
 * from anything the page can set.
 */
export class VisitorService {
  private readonly clock: Clock;
  private readonly widgets: WidgetRepository;
  private readonly visitors: VisitorRepository;
  private readonly properties: PropertyRepository;
  private readonly audit: AuditRepository;

  private readonly presenters: PresenterService;

  constructor(private readonly options: VisitorServiceOptions) {
    this.clock = options.clock ?? systemClock;
    this.presenters = new PresenterService(options.db);
    this.widgets = new WidgetRepository(options.db);
    this.visitors = new VisitorRepository(options.db);
    this.properties = new PropertyRepository(options.db);
    this.audit = new AuditRepository(options.db);
  }

  async bootstrap(input: BootstrapInput): Promise<BootstrapResult> {
    const property = await this.widgets.findPublishedByPublicId(input.publicId);
    // Deliberately the same error for "no such property" and "property paused or suspended":
    // the snippet is public, so this response must not become a probe.
    if (!property) throw new AppError(ErrorCode.PROPERTY_NOT_FOUND);

    this.assertEmbedAllowed(property, input);

    const now = this.clock.now();
    const agent = parseUserAgent(input.userAgent);

    /**
     * Resolved once per bootstrap, from the address the request actually arrived from.
     *
     * The address is the only thing here the page cannot lie about: it comes from the socket
     * (or from the proxy chain we trust), never from the body. Country-level only - see
     * `geo/rir.ts` for why that is the honest limit.
     */
    const country = this.options.resolveCountry
      ? await this.options.resolveCountry(input.ip).catch(() => null)
      : null;

    const context = {
      accountId: property.accountId,
      propertyId: property.propertyId,
      ip: input.ip ?? null,
      country,
      userAgent: input.userAgent ?? null,
      referrer: sanitiseUrl(input.page?.referrer),
      landingUrl: sanitiseUrl(input.page?.url),
      language: input.language ?? null,
      screenWidth: input.screen?.width ?? null,
      screenHeight: input.screen?.height ?? null,
      timezone: input.timezone ?? null,
      browser: agent.browser,
      os: agent.os,
      deviceType: agent.deviceType satisfies DeviceType,
    };

    const existing = await this.resolveExistingVisitor(
      input,
      property.accountId,
      property.propertyId,
    );

    let visitor: Visitor;
    let sessionId: string;
    let isReturning = false;
    let startedNewSession = true;

    if (existing) {
      visitor = existing.visitor;
      isReturning = true;

      // A ban that only applied to the token in hand would last exactly as long as it took the
      // visitor to reload the page: bootstrap would recognise them, mint a new token, and hand
      // back an identity that `authenticate` had just refused. The check belongs at both doors.
      this.assertNotBanned(visitor);

      const resumable = await this.visitors.findResumableSession(
        property.accountId,
        visitor.id,
        existing.sessionId,
        new Date(now.getTime() - SESSION_IDLE_MS),
      );

      if (resumable) {
        sessionId = resumable.id;
        startedNewSession = false;
        await this.visitors.touchSession(
          sessionId,
          now,
          { url: context.landingUrl, title: input.page?.title ?? null },
          { ip: context.ip, country },
        );
      } else {
        sessionId = (await this.visitors.createSession(context, visitor.id, now)).id;
      }
    } else {
      visitor = await this.visitors.create(context, now);
      sessionId = (await this.visitors.createSession(context, visitor.id, now)).id;
    }

    await this.visitors.touch(visitor.id, now, startedNewSession && isReturning);
    // The durable row carries the latest answer, so the inbox can show a flag without a join and
    // an automation rule on `visitor.country` matches a returning visitor too.
    if (existing && country !== visitor.country) {
      await this.visitors.setCountry(visitor.id, country);
    }

    if (context.landingUrl) {
      await this.visitors.recordPageView({
        accountId: property.accountId,
        propertyId: property.propertyId,
        visitorId: visitor.id,
        sessionId,
        url: context.landingUrl,
        title: input.page?.title ?? null,
        referrer: context.referrer,
        now,
      });
    }

    // Serving the widget from an allowed origin is what proves the snippet is installed; there is
    // no separate verification step for the customer to run.
    await this.properties.recordWidgetRequest(property.propertyId, now);

    const token = issueVisitorToken(
      {
        accountId: property.accountId,
        propertyId: property.propertyId,
        visitorId: visitor.id,
        sessionId,
        ttlSeconds: VISITOR_TOKEN_TTL_SECONDS,
        now,
      },
      this.options.visitorTokenSecret,
    );

    const [agentsAvailable, removeBranding, presenter] = await Promise.all([
      this.options.isAgentAvailable
        ? this.options.isAgentAvailable(property.accountId).catch(() => false)
        : false,
      this.options.canRemoveBranding
        ? this.options.canRemoveBranding(property.accountId).catch(() => false)
        : false,
      this.presenterFor(property.accountId, visitor.id),
    ]);

    return {
      token,
      expiresInSeconds: VISITOR_TOKEN_TTL_SECONDS,
      agentsAvailable,
      showBranding: !removeBranding,
      presenter,
      visitor: {
        id: visitor.id,
        name: visitor.name,
        email: visitor.email,
        isReturning,
      },
      sessionId,
      maxUploadBytes: this.options.maxUploadBytes ?? 10 * 1024 * 1024,
      property: { publicId: input.publicId, name: property.propertyName },
      widget: { version: property.version, config: property.config },
    };
  }

  /** The presenter for the visitor's latest conversation, or the owner when there is none. */
  private async presenterFor(accountId: string, visitorId: string): Promise<{ name: string; avatarUrl: string | null } | null> {
    const latest = await this.options.db.conversation.findFirst({
      where: { accountId, visitorId, deletedAt: null },
      orderBy: { lastMessageAt: 'desc' },
      select: { assignedMemberId: true },
    });
    return this.presenters.forConversation(accountId, latest?.assignedMemberId ?? null);
  }

  /** Config only, for the loader's first request. Cheap, and it never creates a visitor. */
  async publicConfig(publicId: string, origin: string | undefined) {
    const property = await this.widgets.findPublishedByPublicId(publicId);
    if (!property) throw new AppError(ErrorCode.PROPERTY_NOT_FOUND);
    this.assertOriginAllowed(property, origin);

    /**
     * This is where "installed" is decided, not `bootstrap`.
     *
     * The loader calls this on every page it renders on; `bootstrap` only runs when somebody
     * actually opens the panel. Marking installation there meant a site where the snippet was in
     * place and working, but nobody had yet started a chat, showed as "awaiting snippet" in the
     * dashboard - which is the one screen a customer checks to find out whether they installed it
     * correctly. `bootstrap` records it too, so a widget opened without a prior config call still
     * counts.
     */
    await this.properties.recordWidgetRequest(property.propertyId, this.clock.now());

    /**
     * The ticket that carries this origin decision to the panel.
     *
     * Issued here because here is the only place a real embedding origin exists: this request came
     * from the loader, running in the customer's own page. The panel's later request comes from an
     * iframe on our CDN and cannot answer the question at all.
     *
     * Issued whether or not enforcement is on, so switching enforcement on does not have to wait
     * for every cached loader to notice. It is only *required* when enforcement is on.
     */
    const host = origin ? hostFromOrigin(origin) : null;

    return {
      property: { publicId, name: property.propertyName },
      widget: { version: property.version, config: property.config },
      ...(host
        ? {
            embedTicket: issueEmbedTicket(
              { publicId, host, ttlSeconds: EMBED_TICKET_TTL_SECONDS, now: this.clock.now() },
              this.options.visitorTokenSecret,
            ),
            embedTicketExpiresInSeconds: EMBED_TICKET_TTL_SECONDS,
          }
        : {}),
    };
  }

  /**
   * Resolve the identity carried by a request that already has a token.
   * Used by every other widget endpoint, so authorisation lives in one place.
   */
  async authenticate(
    token: string,
    expectedPropertyId?: string,
  ): Promise<{
    accountId: string;
    propertyId: string;
    visitorId: string;
    sessionId: string;
    visitor: Visitor;
  }> {
    const result = verifyVisitorToken(token, this.options.visitorTokenSecret, {
      now: this.clock.now(),
      ...(expectedPropertyId ? { expectedPropertyId } : {}),
    });
    if (!result.ok) throw new AppError(ErrorCode.INVALID_TOKEN);

    const visitor = await this.visitors.findByIdForProperty(
      result.payload.accountId,
      result.payload.propertyId,
      result.payload.visitorId,
    );
    // A token whose visitor has been erased is no longer a valid identity, even if the signature
    // is still good.
    if (!visitor) throw new AppError(ErrorCode.INVALID_TOKEN);
    this.assertNotBanned(visitor);

    return {
      accountId: result.payload.accountId,
      propertyId: result.payload.propertyId,
      visitorId: result.payload.visitorId,
      sessionId: result.payload.sessionId,
      visitor,
    };
  }

  /**
   * A ban is `is_banned` plus an optional expiry, so one column carries both kinds: with a date it
   * is a cooling-off period that ends on its own, without one it is permanent. An expired ban is
   * left on the row rather than cleaned up - it is the record of what happened, and a visitor who
   * comes back after it lapses is simply not banned any more.
   */

  private assertNotBanned(visitor: Visitor): void {
    if (!visitor.isBanned) return;
    if (visitor.bannedUntil && visitor.bannedUntil <= this.clock.now()) return;
    throw new AppError(ErrorCode.VISITOR_BANNED);
  }

  /**
   * Stop this visitor chatting.
   *
   * Scoped to the caller's account like everything else - a visitor id from another account is a
   * 404, not a ban applied to somebody else's customer. `CONTACT_UPDATE` rather than a permission
   * of its own: it is the "manage this person" right, which owners, admins and managers hold and
   * agents deliberately do not (ADR-083).
   *
   * The effect is on the next request, not the current socket. An open connection was already
   * authenticated, and the honest description of this control is "they cannot come back" rather
   * than "they are cut off mid-sentence" - a banned visitor's next page load, token refresh or
   * gateway ticket is refused, and a socket has to mint a ticket to reconnect.
   */
  async ban(
    context: TenantContext,
    visitorId: string,
    input: { until?: Date | null; reason?: string | undefined } = {},
  ): Promise<Visitor> {
    requirePermission(context, Permission.CONTACT_UPDATE);
    const visitor = await this.findInAccount(context, visitorId);

    const until = input.until ?? null;
    if (until && until <= this.clock.now()) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'A ban must end in the future');
    }

    const updated = await this.options.db.visitor.update({
      where: { id: visitor.id },
      data: { isBanned: true, bannedUntil: until },
    });

    await this.audit.record({
      accountId: context.accountId,
      actorType: DbActorType.user,
      actorId: context.userId,
      action: 'visitor.banned',
      resourceType: 'visitor',
      resourceId: visitor.id,
      metadata: {
        until: until ? until.toISOString() : null,
        ...(input.reason ? { reason: input.reason.slice(0, 200) } : {}),
      },
    });

    return updated;
  }

  async unban(context: TenantContext, visitorId: string): Promise<Visitor> {
    requirePermission(context, Permission.CONTACT_UPDATE);
    const visitor = await this.findInAccount(context, visitorId);

    const updated = await this.options.db.visitor.update({
      where: { id: visitor.id },
      data: { isBanned: false, bannedUntil: null },
    });

    await this.audit.record({
      accountId: context.accountId,
      actorType: DbActorType.user,
      actorId: context.userId,
      action: 'visitor.unbanned',
      resourceType: 'visitor',
      resourceId: visitor.id,
      metadata: {},
    });

    return updated;
  }

  /** Tenant-scoped lookup. Someone else's visitor does not exist, rather than being forbidden. */
  private async findInAccount(context: TenantContext, visitorId: string): Promise<Visitor> {
    const visitor = await this.options.db.visitor.findFirst({
      where: { accountId: context.accountId, id: visitorId },
    });
    if (!visitor) throw new AppError(ErrorCode.NOT_FOUND);
    // A restricted member can only act on the properties they were given.
    requirePropertyAccess(context, visitor.propertyId);
    return visitor;
  }

  async recordPageView(
    token: string,
    page: { url: string; title?: string | undefined; referrer?: string | undefined },
  ): Promise<void> {
    const identity = await this.authenticate(token);
    const url = sanitiseUrl(page.url);
    if (!url) return;

    await this.visitors.recordPageView({
      accountId: identity.accountId,
      propertyId: identity.propertyId,
      visitorId: identity.visitorId,
      sessionId: identity.sessionId,
      url,
      title: page.title ?? null,
      referrer: sanitiseUrl(page.referrer),
      now: this.clock.now(),
    });
  }

  /**
   * Attach traits the customer's site supplied via `SmartChat('identify', ...)`.
   *
   * These are claims, not credentials: they populate the agent's sidebar and never widen what the
   * visitor can see or do.
   */
  async identify(
    token: string,
    traits: {
      name?: string | undefined;
      email?: string | undefined;
      phone?: string | undefined;
      externalId?: string | undefined;
    },
  ): Promise<void> {
    const identity = await this.authenticate(token);
    await this.visitors.identify(identity.accountId, identity.visitorId, {
      ...(traits.name !== undefined ? { name: traits.name } : {}),
      ...(traits.email !== undefined ? { email: traits.email } : {}),
      ...(traits.phone !== undefined ? { phone: traits.phone } : {}),
      ...(traits.externalId !== undefined ? { externalId: traits.externalId } : {}),
    });
  }

  private async resolveExistingVisitor(
    input: BootstrapInput,
    accountId: string,
    propertyId: string,
  ): Promise<{ visitor: Visitor; sessionId: string } | null> {
    if (!input.token) return null;

    const result = verifyVisitorToken(input.token, this.options.visitorTokenSecret, {
      now: this.clock.now(),
      expectedPropertyId: propertyId,
    });
    // An unusable token is not an error here: the visitor simply starts fresh, which is exactly
    // what should happen when a token expires, a property is reconfigured, or a secret is rotated.
    if (!result.ok) return null;
    if (result.payload.accountId !== accountId) return null;

    const visitor = await this.visitors.findByIdForProperty(
      accountId,
      propertyId,
      result.payload.visitorId,
    );
    if (!visitor) return null;

    return { visitor, sessionId: result.payload.sessionId };
  }

  private assertOriginAllowed(
    property: { enforceDomains: boolean; domains: { pattern: string; isWildcard: boolean }[] },
    origin: string | undefined,
  ): void {
    if (!property.enforceDomains) return;
    const allowed = isOriginAllowed(origin, property.domains, {
      allowLocalhost: this.options.allowLocalhostOrigins,
    });
    if (!allowed) {
      throw new AppError(ErrorCode.ORIGIN_NOT_ALLOWED, undefined, { context: { origin } });
    }
  }

  /**
   * The same question as `assertOriginAllowed`, asked of a request that cannot answer it.
   *
   * `bootstrap` is called by the panel, which runs in an iframe on this product's own CDN host —
   * so its `Origin` is ours, not the customer's, on every site including the authorised ones.
   * Checking it meant enforcement rejected everybody: switch it on and no widget anywhere could
   * start, which is exactly what happened.
   *
   * The embedding page's host therefore comes from the ticket the loader was issued, and it is
   * re-checked against the property's *current* domain list rather than trusted because a ticket
   * exists — a domain removed a minute ago should stop working within the ticket's short life,
   * not at the end of it.
   */
  private assertEmbedAllowed(
    property: { enforceDomains: boolean; domains: { pattern: string; isWildcard: boolean }[] },
    input: { publicId: string; origin: string | undefined; embedTicket?: string | undefined },
  ): void {
    if (!property.enforceDomains) return;

    // A panel opened directly in a tab, with no host page, is judged on its own origin - which is
    // the honest answer for a request that really did come from nowhere else.
    if (!input.embedTicket) {
      if (
        this.options.allowLocalhostOrigins &&
        isOriginAllowed(input.origin, property.domains, { allowLocalhost: true })
      ) {
        return;
      }
      throw new AppError(ErrorCode.ORIGIN_NOT_ALLOWED, undefined, {
        context: { origin: input.origin, reason: 'no embed ticket' },
      });
    }

    const ticket = verifyEmbedTicket(input.embedTicket, this.options.visitorTokenSecret, {
      now: this.clock.now(),
      expectedPublicId: input.publicId,
    });
    if (!ticket.ok) {
      throw new AppError(ErrorCode.ORIGIN_NOT_ALLOWED, undefined, {
        context: { origin: input.origin, reason: ticket.reason },
      });
    }

    const allowed = isOriginAllowed(`https://${ticket.payload.h}`, property.domains, {
      allowLocalhost: this.options.allowLocalhostOrigins,
    });
    if (!allowed) {
      throw new AppError(ErrorCode.ORIGIN_NOT_ALLOWED, undefined, {
        context: { origin: ticket.payload.h },
      });
    }
  }
}
