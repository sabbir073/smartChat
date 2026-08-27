import type { Database } from '@smartchat/database';
import type { TriggerFacts } from './engine.js';

/**
 * The stable half of a fact snapshot: who this visitor is and how long they have been here.
 *
 * Read once when the socket connects and kept for the life of the connection. Re-reading it on
 * every page change would put two queries on a path that fires whenever anyone clicks a link, and
 * none of these values can change mid-session in a way a rule should react to.
 */
export interface VisitorFactBase {
  visitor: TriggerFacts['visitor'];
  sessionStartedAt: Date;
  pageViewCount: number;
  landing: { url: string | null; title: string | null; referrer: string | null };
}

export async function loadVisitorFactBase(
  db: Database,
  identity: { accountId: string; visitorId: string; sessionId: string },
  now: Date,
): Promise<VisitorFactBase> {
  const [visitor, session] = await Promise.all([
    db.visitor.findFirst({
      where: { accountId: identity.accountId, id: identity.visitorId },
      select: {
        country: true,
        language: true,
        deviceType: true,
        visitCount: true,
        name: true,
        email: true,
      },
    }),
    identity.sessionId
      ? db.visitorSession.findFirst({
          where: { accountId: identity.accountId, id: identity.sessionId },
          select: {
            startedAt: true,
            pageViewCount: true,
            currentUrl: true,
            landingUrl: true,
            currentTitle: true,
            referrer: true,
          },
        })
      : Promise.resolve(null),
  ]);

  return {
    visitor: {
      country: visitor?.country ?? null,
      language: visitor?.language ?? null,
      deviceType: visitor?.deviceType ?? null,
      // A first visit is visit 1. Anything above that is somebody who has been here before.
      isReturning: (visitor?.visitCount ?? 1) > 1,
      isIdentified: Boolean(visitor?.name || visitor?.email),
      visitCount: visitor?.visitCount ?? 1,
    },
    sessionStartedAt: session?.startedAt ?? now,
    pageViewCount: session?.pageViewCount ?? 0,
    landing: {
      url: session?.currentUrl ?? session?.landingUrl ?? null,
      title: session?.currentTitle ?? null,
      referrer: session?.referrer ?? null,
    },
  };
}

/**
 * Assemble the snapshot a rule is evaluated against.
 *
 * `secondsOnSite` is computed here rather than stored, so a rule reading it always sees the truth
 * at the moment of evaluation instead of whatever a background job last wrote.
 */
export function buildTriggerFacts(input: {
  base: VisitorFactBase;
  page: { url: string | null; title: string | null; referrer: string | null };
  pageViewCount: number;
  agentsAvailable: boolean;
  now: Date;
}): TriggerFacts {
  const elapsed = Math.max(
    0,
    Math.floor((input.now.getTime() - input.base.sessionStartedAt.getTime()) / 1000),
  );

  return {
    page: {
      url: input.page.url ?? input.base.landing.url,
      title: input.page.title ?? input.base.landing.title,
      referrer: input.page.referrer ?? input.base.landing.referrer,
    },
    visitor: input.base.visitor,
    session: {
      pageViewCount: Math.max(input.pageViewCount, input.base.pageViewCount),
      secondsOnSite: elapsed,
    },
    agents: { available: input.agentsAvailable },
  };
}
