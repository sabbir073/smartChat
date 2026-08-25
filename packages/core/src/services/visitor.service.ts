import type { Database, Visitor } from '@smartchat/database';
import { AppError, ErrorCode, type DeviceType } from '@smartchat/types';
import type { WidgetConfig } from '@smartchat/validation';
import {
  VISITOR_TOKEN_TTL_SECONDS,
  issueVisitorToken,
  verifyVisitorToken,
} from '../crypto/visitor-token.js';
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
}

export interface VisitorServiceOptions {
  db: Database;
  visitorTokenSecret: string;
  /** Development convenience: accept localhost origins whatever the allowed-domain list says. */
  allowLocalhostOrigins: boolean;
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

  constructor(private readonly options: VisitorServiceOptions) {
    this.clock = options.clock ?? systemClock;
    this.widgets = new WidgetRepository(options.db);
    this.visitors = new VisitorRepository(options.db);
    this.properties = new PropertyRepository(options.db);
  }

  async bootstrap(input: BootstrapInput): Promise<BootstrapResult> {
    const property = await this.widgets.findPublishedByPublicId(input.publicId);
    // Deliberately the same error for "no such property" and "property paused or suspended":
    // the snippet is public, so this response must not become a probe.
    if (!property) throw new AppError(ErrorCode.PROPERTY_NOT_FOUND);

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

    return {
      token,
      expiresInSeconds: VISITOR_TOKEN_TTL_SECONDS,
      visitor: {
        id: visitor.id,
        name: visitor.name,
        email: visitor.email,
        isReturning,
      },
      sessionId,
      property: { publicId: input.publicId, name: property.propertyName },
      widget: { version: property.version, config: property.config },
    };
  }

  /** Config only, for the loader's first request. Cheap, and it never creates a visitor. */
  async publicConfig(publicId: string, origin: string | undefined) {
    const property = await this.widgets.findPublishedByPublicId(publicId);
    if (!property) throw new AppError(ErrorCode.PROPERTY_NOT_FOUND);
    this.assertOriginAllowed(property, origin);

    return {
      property: { publicId, name: property.propertyName },
      widget: { version: property.version, config: property.config },
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
    if (visitor.isBanned && (!visitor.bannedUntil || visitor.bannedUntil > this.clock.now())) {
      throw new AppError(ErrorCode.VISITOR_BANNED);
    }

    return {
      accountId: result.payload.accountId,
      propertyId: result.payload.propertyId,
      visitorId: result.payload.visitorId,
      sessionId: result.payload.sessionId,
      visitor,
    };
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
