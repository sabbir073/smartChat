import type { DatabaseOrTransaction, Visitor, VisitorSession } from '@smartchat/database';
import { toJson } from '@smartchat/database';
import { clampLimit, type CursorPage, type DeviceType, type TenantContext } from '@smartchat/types';
import { afterCursor, encodeCursor, notDeleted, tenantScope } from './scope.js';

export interface VisitorContextInput {
  accountId: string;
  propertyId: string;
  ip?: string | null;
  userAgent?: string | null;
  referrer?: string | null;
  landingUrl?: string | null;
  language?: string | null;
  screenWidth?: number | null;
  screenHeight?: number | null;
  timezone?: string | null;
  browser?: string | null;
  os?: string | null;
  deviceType: DeviceType;
}

export class VisitorRepository {
  constructor(private readonly db: DatabaseOrTransaction) {}

  /** Visitor-surface lookup: no tenant context, so the account is pinned from the token. */
  findByIdForProperty(
    accountId: string,
    propertyId: string,
    visitorId: string,
  ): Promise<Visitor | null> {
    return this.db.visitor.findFirst({
      where: { id: visitorId, accountId, propertyId, deletedAt: null },
    });
  }

  create(input: VisitorContextInput, now: Date): Promise<Visitor> {
    return this.db.visitor.create({
      data: {
        accountId: input.accountId,
        propertyId: input.propertyId,
        firstSeenAt: now,
        lastSeenAt: now,
        visitCount: 1,
        language: input.language ?? null,
        timezone: input.timezone ?? null,
        browser: input.browser ?? null,
        os: input.os ?? null,
        deviceType: input.deviceType,
      },
    });
  }

  /**
   * Mark a returning visitor.
   *
   * `visitCount` is incremented only when a *new session* starts, not on every request - otherwise
   * a single-page app polling in the background would inflate it.
   */
  async touch(visitorId: string, now: Date, newSession: boolean): Promise<void> {
    await this.db.visitor.updateMany({
      where: { id: visitorId },
      data: {
        lastSeenAt: now,
        ...(newSession ? { visitCount: { increment: 1 } } : {}),
      },
    });
  }

  async identify(
    accountId: string,
    visitorId: string,
    traits: {
      name?: string | null;
      email?: string | null;
      phone?: string | null;
      externalId?: string | null;
      metadata?: Record<string, unknown>;
    },
  ): Promise<Visitor | null> {
    const result = await this.db.visitor.updateMany({
      where: { id: visitorId, accountId, deletedAt: null },
      data: {
        ...(traits.name !== undefined ? { name: traits.name } : {}),
        ...(traits.email !== undefined ? { email: traits.email } : {}),
        ...(traits.phone !== undefined ? { phone: traits.phone } : {}),
        ...(traits.externalId !== undefined ? { externalId: traits.externalId } : {}),
        ...(traits.metadata !== undefined ? { metadata: toJson(traits.metadata) } : {}),
      },
    });
    if (result.count === 0) return null;

    // An email is the only thing that tells us two browsers are one person, and this is the one
    // function in the system that ever writes one onto a visitor - pre-chat, the offline form and
    // `SmartChat('identify')` all arrive here. Linking anywhere else would mean three call sites
    // to keep in step, and eventually one of them forgets.
    if (traits.email) {
      await this.linkToContact(accountId, visitorId, {
        email: traits.email,
        ...(traits.name ? { name: traits.name } : {}),
        ...(traits.phone ? { phone: traits.phone } : {}),
      });
    }

    return this.db.visitor.findFirst({ where: { id: visitorId, accountId } });
  }

  /**
   * Attach this browser to the person behind it, creating that person if they are new.
   *
   * Enrichment, so it never throws into the caller: somebody must still be able to start a
   * conversation on a day when this fails. A race between two visitors giving the same address at
   * once is settled by the unique index, and the loser simply retries the read.
   */
  private async linkToContact(
    accountId: string,
    visitorId: string,
    traits: { email: string; name?: string; phone?: string },
  ): Promise<void> {
    const email = traits.email.trim().toLowerCase();
    if (email.length === 0) return;
    const now = new Date();

    try {
      const contact = await this.db.contact.upsert({
        where: { accountId_email: { accountId, email } },
        // A returning person updates what we know, but nothing already recorded is overwritten
        // with nothing: a later visit that omits a name must not erase the name we have.
        update: {
          lastSeenAt: now,
          deletedAt: null,
          ...(traits.name ? { name: traits.name } : {}),
          ...(traits.phone ? { phone: traits.phone } : {}),
        },
        create: {
          accountId,
          email,
          name: traits.name ?? null,
          phone: traits.phone ?? null,
          firstSeenAt: now,
          lastSeenAt: now,
        },
      });

      await this.db.visitor.updateMany({
        where: { accountId, id: visitorId },
        data: { contactId: contact.id },
      });
    } catch {
      /* A contact is context. Failing to record one must never cost somebody a conversation. */
    }
  }

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------

  createSession(input: VisitorContextInput, visitorId: string, now: Date): Promise<VisitorSession> {
    return this.db.visitorSession.create({
      data: {
        accountId: input.accountId,
        propertyId: input.propertyId,
        visitorId,
        startedAt: now,
        lastSeenAt: now,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        referrer: input.referrer ?? null,
        landingUrl: input.landingUrl ?? null,
        currentUrl: input.landingUrl ?? null,
        browser: input.browser ?? null,
        os: input.os ?? null,
        deviceType: input.deviceType,
        screenWidth: input.screenWidth ?? null,
        screenHeight: input.screenHeight ?? null,
        language: input.language ?? null,
      },
    });
  }

  /**
   * Resume a session if it is still current.
   *
   * A session that has been idle beyond the window is treated as finished, so "time on site" and
   * visit counts reflect actual visits rather than one browser tab left open for a week.
   */
  findResumableSession(
    accountId: string,
    visitorId: string,
    sessionId: string,
    idleCutoff: Date,
  ): Promise<VisitorSession | null> {
    return this.db.visitorSession.findFirst({
      where: {
        id: sessionId,
        accountId,
        visitorId,
        endedAt: null,
        lastSeenAt: { gte: idleCutoff },
      },
    });
  }

  async touchSession(
    sessionId: string,
    now: Date,
    page?: { url?: string | null; title?: string | null },
  ): Promise<void> {
    await this.db.visitorSession.updateMany({
      where: { id: sessionId },
      data: {
        lastSeenAt: now,
        ...(page?.url ? { currentUrl: page.url } : {}),
        ...(page?.title !== undefined ? { currentTitle: page.title } : {}),
      },
    });
  }

  async recordPageView(input: {
    accountId: string;
    propertyId: string;
    visitorId: string;
    sessionId: string;
    url: string;
    title?: string | null;
    referrer?: string | null;
    now: Date;
  }): Promise<void> {
    await this.db.visitorPageView.create({
      data: {
        accountId: input.accountId,
        propertyId: input.propertyId,
        visitorId: input.visitorId,
        sessionId: input.sessionId,
        url: input.url,
        title: input.title ?? null,
        referrer: input.referrer ?? null,
        viewedAt: input.now,
      },
    });
    await this.db.visitorSession.updateMany({
      where: { id: input.sessionId },
      data: {
        pageViewCount: { increment: 1 },
        lastSeenAt: input.now,
        currentUrl: input.url,
        currentTitle: input.title ?? null,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Dashboard
  // ---------------------------------------------------------------------------

  async list(
    context: TenantContext,
    query: {
      cursor?: string | undefined;
      limit?: number | undefined;
      propertyId?: string | undefined;
    },
  ): Promise<CursorPage<Visitor>> {
    const limit = clampLimit(query.limit);
    const restriction =
      context.propertyIds && context.propertyIds.size > 0
        ? { propertyId: { in: [...context.propertyIds] } }
        : {};

    const rows = await this.db.visitor.findMany({
      where: {
        ...tenantScope(context),
        ...notDeleted(),
        ...restriction,
        ...(query.propertyId ? { propertyId: query.propertyId } : {}),
        ...afterCursor(query.cursor),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items.at(-1);
    return {
      items,
      meta: {
        cursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
        hasMore,
      },
    };
  }

  findById(context: TenantContext, visitorId: string) {
    return this.db.visitor.findFirst({
      where: { id: visitorId, ...tenantScope(context), ...notDeleted() },
      include: {
        sessions: {
          orderBy: { startedAt: 'desc' },
          take: 10,
          include: { pageViews: { orderBy: { viewedAt: 'desc' }, take: 25 } },
        },
      },
    });
  }
}
