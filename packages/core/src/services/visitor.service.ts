import type { Database, Visitor } from '@smartchat/database';
import { ActorType as DbActorType } from '@smartchat/database';
import {
  AppError,
  ErrorCode,
  FeatureKey,
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
import { AuditRepository } from '../repositories/audit.repository.js';
import type { PlanGuard } from './plan-guard.js';
import { requirePermission, requirePropertyAccess } from '../tenancy/context.js';
import { PropertyRepository } from '../repositories/property.repository.js';
import { VisitorRepository } from '../repositories/visitor.repository.js';
import { WidgetRepository } from '../repositories/widget.repository.js';
import { MINUTE, systemClock, type Clock } from '../time.js';
import { isOriginAllowed } from './domain-matcher.js';
import { parseUserAgent, sanitiseUrl } from './user-agent.js';

/** A session is considered finished after this much inactivity, and the next visit is a new one. */
export const SESSION_IDLE_MS = 30 * MINUTE;

export interface BootstrapInput {
  publicId: string;
  origin: string | undefined;
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
  /**
   * Whether the widget shows "Powered by SmartChat".
   *
   * Decided here rather than in the widget, because it is something a plan sells and the widget
   * runs on the customer's own page - anything it decided for itself would be one line of
   * JavaScript away from being decided differently. `feature_remove_branding` was on the pricing
   * page for three plans before anything read it, which made it a paid feature that was never
   * delivered and a free plan that was never actually branded.
   */
  showBranding: boolean;
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
}

export interface VisitorServiceOptions {
  db: Database;
  visitorTokenSecret: string;
  /**
   * The plan gate.
   *
   * Required, not optional. A widget that serves visitors on a website the plan no longer covers
   * is the single most expensive way to get this wrong, and an optional dependency is one that
   * gets left out. Making it required means the compiler refuses to build an unguarded gateway.
   */
  plan: PlanGuard;
  /** Development convenience: accept localhost origins whatever the allowed-domain list says. */
  allowLocalhostOrigins: boolean;
  /**
   * Whether any agent is available right now.
   *
   * Injected rather than depended on, so the visitor service does not need Redis: presence is the
   * realtime layer's concern, and this keeps the two testable apart.
   */
  isAgentAvailable?: (accountId: string) => Promise<boolean>;
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

  constructor(private readonly options: VisitorServiceOptions) {
    this.clock = options.clock ?? systemClock;
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

    await this.assertServing(property.accountId, property.propertyId);
    this.assertOriginAllowed(property, input.origin);

    const now = this.clock.now();
    const agent = parseUserAgent(input.userAgent);

    const context = {
      accountId: property.accountId,
      propertyId: property.propertyId,
      ip: input.ip ?? null,
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
        await this.visitors.touchSession(sessionId, now, {
          url: context.landingUrl,
          title: input.page?.title ?? null,
        });
      } else {
        sessionId = (await this.visitors.createSession(context, visitor.id, now)).id;
      }
    } else {
      visitor = await this.visitors.create(context, now);
      sessionId = (await this.visitors.createSession(context, visitor.id, now)).id;
    }

    await this.visitors.touch(visitor.id, now, startedNewSession && isReturning);

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

    const agentsAvailable = this.options.isAgentAvailable
      ? await this.options.isAgentAvailable(property.accountId).catch(() => false)
      : false;

    return {
      token,
      expiresInSeconds: VISITOR_TOKEN_TTL_SECONDS,
      agentsAvailable,
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
      showBranding: await this.showBranding(property.accountId),
    };
  }

  /** Config only, for the loader's first request. Cheap, and it never creates a visitor. */
  async publicConfig(publicId: string, origin: string | undefined) {
    const property = await this.widgets.findPublishedByPublicId(publicId);
    if (!property) throw new AppError(ErrorCode.PROPERTY_NOT_FOUND);
    await this.assertServing(property.accountId, property.propertyId);
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

    return {
      property: { publicId, name: property.propertyName },
      widget: { version: property.version, config: property.config },
      showBranding: await this.showBranding(property.accountId),
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
  /**
   * Stop serving a website the plan no longer covers.
   *
   * The same `PROPERTY_NOT_FOUND` a deleted or unpublished website gives, on purpose. A stranger
   * on somebody else's page has no business learning that the page's owner is behind on a bill,
   * and a distinguishable answer here would turn the public snippet into a way to ask.
   *
   * Nothing is deleted and nothing is edited: the conversations, the transcripts and the
   * configuration are all still there, and the widget starts serving again the moment the plan
   * covers the website again.
   */
  /** Branding stays unless the plan includes removing it. Absent entitlement means branded. */
  private async showBranding(accountId: string): Promise<boolean> {
    return !(await this.options.plan.isFeatureEnabled(accountId, FeatureKey.FEATURE_REMOVE_BRANDING));
  }

  private async assertServing(accountId: string, propertyId: string): Promise<void> {
    if (await this.options.plan.isPropertyServing(accountId, propertyId)) return;
    throw new AppError(ErrorCode.PROPERTY_NOT_FOUND);
  }

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
}
