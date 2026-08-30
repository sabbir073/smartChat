import { Prisma, type Database } from '@smartchat/database';
import { AppError, ErrorCode, Permission, type TenantContext } from '@smartchat/types';
import { requirePermission } from '../tenancy/context.js';
import { assertPropertyInAccount } from '../tenancy/property-access.js';
import { systemClock, type Clock } from '../time.js';

/**
 * Reporting.
 *
 * Rollups, not an event stream. Every number here is derivable from tables this product already
 * keeps, so a parallel event log would be a second copy of the truth that can disagree with the
 * first - and when the two disagree, nobody can say which is wrong. What the rollup buys is speed
 * and repairability: ninety days of report is ninety rows rather than an aggregate over millions
 * of messages, and any day can be recomputed from the source at any time.
 *
 * **Sums and counts, never stored averages.** An average of averages is wrong, and a week's figure
 * has to be computable from seven days' rows. So the numerator and the denominator are both kept
 * and the division happens at the last possible moment.
 *
 * **Days are the account's days.** Every bucket is cut with `AT TIME ZONE` using the account's own
 * timezone. "Yesterday" for a team in Auckland is not the window a UTC `date_trunc` would give
 * them, and a daily report whose days do not match the days people worked is worse than none.
 */

export interface AnalyticsServiceOptions {
  db: Database;
  clock?: Clock;
}

export interface DaySeriesPoint {
  day: string;
  conversationsStarted: number;
  conversationsClosed: number;
  messagesFromVisitors: number;
  messagesFromAgents: number;
  newVisitors: number;
  engagedVisitors: number;
  ticketsOpened: number;
  ticketsResolved: number;
  firstResponseCount: number;
  firstResponseSeconds: number;
  resolutionCount: number;
  resolutionSeconds: number;
}

export interface OverviewTotals {
  conversationsStarted: number;
  conversationsClosed: number;
  messagesFromVisitors: number;
  messagesFromAgents: number;
  newVisitors: number;
  engagedVisitors: number;
  ticketsOpened: number;
  ticketsResolved: number;
  /** Null rather than zero when nothing was answered: an unmeasured average is not "instant". */
  averageFirstResponseSeconds: number | null;
  averageResolutionSeconds: number | null;
  firstResponseCount: number;
  resolutionCount: number;
}

export interface Overview {
  from: string;
  to: string;
  timezone: string;
  totals: OverviewTotals;
  series: DaySeriesPoint[];
}

export interface AgentRow {
  memberId: string;
  name: string;
  messagesSent: number;
  conversationsClosed: number;
  ticketRepliesSent: number;
  firstResponseCount: number;
  averageFirstResponseSeconds: number | null;
}

export interface ArticleRow {
  id: string;
  title: string;
  slug: string;
  status: string;
  viewCount: number;
}

/** The most days one request may cover. A year of daily rows is a chart nobody can read anyway. */
export const MAX_REPORT_DAYS = 366;

function toDayString(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export class AnalyticsService {
  private readonly clock: Clock;

  constructor(private readonly options: AnalyticsServiceOptions) {
    this.clock = options.clock ?? systemClock;
  }

  // ---------------------------------------------------------------------------
  // Building the rollup
  // ---------------------------------------------------------------------------

  private async timezoneFor(accountId: string): Promise<string> {
    const account = await this.options.db.account.findUnique({
      where: { id: accountId },
      select: { timezone: true },
    });
    if (!account) throw new AppError(ErrorCode.NOT_FOUND);
    return account.timezone;
  }

  /**
   * Recompute a date range from the source tables.
   *
   * Delete-then-insert rather than upsert, inside one transaction. Upsert leaves behind rows for
   * days whose source data has since gone - a conversation deleted under a retention policy, a
   * website removed - and a metric that survives the thing it counted is a number that can never
   * be corrected, only explained.
   */
  async rebuild(accountId: string, from: Date, to: Date): Promise<{ days: number }> {
    const timezone = await this.timezoneFor(accountId);
    const fromDay = toDayString(from);
    const toDay = toDayString(to);

    const days = Math.floor((Date.parse(toDay) - Date.parse(fromDay)) / 86_400_000) + 1;
    if (days < 1 || days > MAX_REPORT_DAYS) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'That date range is not usable');
    }

    await this.options.db.$transaction([
      this.options.db.$executeRaw`
        DELETE FROM daily_metrics
        WHERE account_id = ${accountId}::uuid AND day BETWEEN ${fromDay}::date AND ${toDay}::date
      `,
      this.options.db.$executeRaw`
        WITH conv AS (
          SELECT property_id,
                 (started_at AT TIME ZONE ${timezone})::date AS day,
                 count(*)::int AS started,
                 count(DISTINCT visitor_id)::int AS engaged
          FROM conversations
          WHERE account_id = ${accountId}::uuid
            AND deleted_at IS NULL
            AND (started_at AT TIME ZONE ${timezone})::date
                BETWEEN ${fromDay}::date AND ${toDay}::date
          GROUP BY 1, 2
        ),
        closed AS (
          SELECT property_id,
                 (closed_at AT TIME ZONE ${timezone})::date AS day,
                 count(*)::int AS closed,
                 COALESCE(sum(EXTRACT(EPOCH FROM (closed_at - started_at))), 0)::int AS seconds
          FROM conversations
          WHERE account_id = ${accountId}::uuid
            AND deleted_at IS NULL
            AND closed_at IS NOT NULL
            AND (closed_at AT TIME ZONE ${timezone})::date
                BETWEEN ${fromDay}::date AND ${toDay}::date
          GROUP BY 1, 2
        ),
        resp AS (
          SELECT property_id,
                 (first_response_at AT TIME ZONE ${timezone})::date AS day,
                 count(*)::int AS cnt,
                 COALESCE(sum(EXTRACT(EPOCH FROM (first_response_at - started_at))), 0)::int AS seconds
          FROM conversations
          WHERE account_id = ${accountId}::uuid
            AND deleted_at IS NULL
            AND first_response_at IS NOT NULL
            AND (first_response_at AT TIME ZONE ${timezone})::date
                BETWEEN ${fromDay}::date AND ${toDay}::date
          GROUP BY 1, 2
        ),
        msg AS (
          SELECT property_id,
                 (created_at AT TIME ZONE ${timezone})::date AS day,
                 count(*) FILTER (WHERE sender_type = 'visitor')::int AS from_visitors,
                 count(*) FILTER (WHERE sender_type = 'agent')::int AS from_agents
          FROM messages
          WHERE account_id = ${accountId}::uuid
            AND deleted_at IS NULL
            -- An internal note is work, but it is not something anybody said to anybody.
            AND type <> 'note'
            AND (created_at AT TIME ZONE ${timezone})::date
                BETWEEN ${fromDay}::date AND ${toDay}::date
          GROUP BY 1, 2
        ),
        vis AS (
          SELECT property_id,
                 (first_seen_at AT TIME ZONE ${timezone})::date AS day,
                 count(*)::int AS new_visitors
          FROM visitors
          WHERE account_id = ${accountId}::uuid
            AND (first_seen_at AT TIME ZONE ${timezone})::date
                BETWEEN ${fromDay}::date AND ${toDay}::date
          GROUP BY 1, 2
        ),
        topened AS (
          SELECT property_id,
                 (created_at AT TIME ZONE ${timezone})::date AS day,
                 count(*)::int AS opened
          FROM tickets
          WHERE account_id = ${accountId}::uuid
            AND deleted_at IS NULL
            AND (created_at AT TIME ZONE ${timezone})::date
                BETWEEN ${fromDay}::date AND ${toDay}::date
          GROUP BY 1, 2
        ),
        tresolved AS (
          SELECT property_id,
                 (resolved_at AT TIME ZONE ${timezone})::date AS day,
                 count(*)::int AS resolved
          FROM tickets
          WHERE account_id = ${accountId}::uuid
            AND deleted_at IS NULL
            AND resolved_at IS NOT NULL
            AND (resolved_at AT TIME ZONE ${timezone})::date
                BETWEEN ${fromDay}::date AND ${toDay}::date
          GROUP BY 1, 2
        ),
        keys AS (
          SELECT property_id, day FROM conv
          UNION SELECT property_id, day FROM closed
          UNION SELECT property_id, day FROM resp
          UNION SELECT property_id, day FROM msg
          UNION SELECT property_id, day FROM vis
          UNION SELECT property_id, day FROM topened
          UNION SELECT property_id, day FROM tresolved
        )
        INSERT INTO daily_metrics (
          id, account_id, property_id, day,
          conversations_started, conversations_closed,
          messages_from_visitors, messages_from_agents,
          first_response_count, first_response_seconds,
          resolution_count, resolution_seconds,
          new_visitors, engaged_visitors,
          tickets_opened, tickets_resolved, computed_at
        )
        SELECT gen_random_uuid(), ${accountId}::uuid, k.property_id, k.day,
               COALESCE(conv.started, 0), COALESCE(closed.closed, 0),
               COALESCE(msg.from_visitors, 0), COALESCE(msg.from_agents, 0),
               COALESCE(resp.cnt, 0), COALESCE(resp.seconds, 0),
               COALESCE(closed.closed, 0), COALESCE(closed.seconds, 0),
               COALESCE(vis.new_visitors, 0), COALESCE(conv.engaged, 0),
               COALESCE(topened.opened, 0), COALESCE(tresolved.resolved, 0),
               now()
        FROM keys k
        LEFT JOIN conv ON conv.property_id = k.property_id AND conv.day = k.day
        LEFT JOIN closed ON closed.property_id = k.property_id AND closed.day = k.day
        LEFT JOIN resp ON resp.property_id = k.property_id AND resp.day = k.day
        LEFT JOIN msg ON msg.property_id = k.property_id AND msg.day = k.day
        LEFT JOIN vis ON vis.property_id = k.property_id AND vis.day = k.day
        LEFT JOIN topened ON topened.property_id = k.property_id AND topened.day = k.day
        LEFT JOIN tresolved ON tresolved.property_id = k.property_id AND tresolved.day = k.day
        -- A property row can be removed while its conversations are still being retained; a
        -- metric row for a website that no longer exists would break the foreign key and, worse,
        -- appear in a report with no name against it.
        WHERE EXISTS (
          SELECT 1 FROM properties p
          WHERE p.account_id = ${accountId}::uuid AND p.id = k.property_id
        )
      `,
      this.options.db.$executeRaw`
        DELETE FROM daily_agent_metrics
        WHERE account_id = ${accountId}::uuid AND day BETWEEN ${fromDay}::date AND ${toDay}::date
      `,
      this.options.db.$executeRaw`
        WITH sent AS (
          SELECT sender_member_id AS member_id,
                 (created_at AT TIME ZONE ${timezone})::date AS day,
                 count(*)::int AS messages
          FROM messages
          WHERE account_id = ${accountId}::uuid
            AND deleted_at IS NULL
            AND sender_type = 'agent'
            AND sender_member_id IS NOT NULL
            AND type <> 'note'
            AND (created_at AT TIME ZONE ${timezone})::date
                BETWEEN ${fromDay}::date AND ${toDay}::date
          GROUP BY 1, 2
        ),
        closed AS (
          SELECT closed_by_member_id AS member_id,
                 (closed_at AT TIME ZONE ${timezone})::date AS day,
                 count(*)::int AS conversations
          FROM conversations
          WHERE account_id = ${accountId}::uuid
            AND deleted_at IS NULL
            AND closed_at IS NOT NULL
            AND closed_by_member_id IS NOT NULL
            AND (closed_at AT TIME ZONE ${timezone})::date
                BETWEEN ${fromDay}::date AND ${toDay}::date
          GROUP BY 1, 2
        ),
        -- Who actually answered first.
        --
        -- first_response_at is written with the same clock value as the message that caused it,
        -- in the same transaction, so the responding message is the agent message at exactly that
        -- instant. DISTINCT ON with an explicit seq order makes the pick deterministic if two
        -- ever share a timestamp, rather than leaving it to the planner.
        first_responses AS (
          SELECT DISTINCT ON (c.id) c.id, m.sender_member_id AS member_id,
                 (c.first_response_at AT TIME ZONE ${timezone})::date AS day,
                 EXTRACT(EPOCH FROM (c.first_response_at - c.started_at))::int AS seconds
          FROM conversations c
          JOIN messages m
            ON m.conversation_id = c.id
           AND m.created_at = c.first_response_at
           AND m.sender_type = 'agent'
           AND m.sender_member_id IS NOT NULL
          WHERE c.account_id = ${accountId}::uuid
            AND c.deleted_at IS NULL
            AND c.first_response_at IS NOT NULL
            AND (c.first_response_at AT TIME ZONE ${timezone})::date
                BETWEEN ${fromDay}::date AND ${toDay}::date
          ORDER BY c.id, m.seq ASC
        ),
        resp AS (
          SELECT member_id, day, count(*)::int AS cnt, COALESCE(sum(seconds), 0)::int AS seconds
          FROM first_responses
          GROUP BY 1, 2
        ),
        replies AS (
          SELECT author_member_id AS member_id,
                 (created_at AT TIME ZONE ${timezone})::date AS day,
                 count(*)::int AS replies
          FROM ticket_messages
          WHERE account_id = ${accountId}::uuid
            AND deleted_at IS NULL
            AND author_type = 'agent'
            AND author_member_id IS NOT NULL
            AND visibility = 'public'
            AND (created_at AT TIME ZONE ${timezone})::date
                BETWEEN ${fromDay}::date AND ${toDay}::date
          GROUP BY 1, 2
        ),
        keys AS (
          SELECT member_id, day FROM sent
          UNION SELECT member_id, day FROM closed
          UNION SELECT member_id, day FROM resp
          UNION SELECT member_id, day FROM replies
        )
        INSERT INTO daily_agent_metrics (
          id, account_id, member_id, day,
          messages_sent, conversations_closed,
          first_response_count, first_response_seconds, ticket_replies_sent, computed_at
        )
        SELECT gen_random_uuid(), ${accountId}::uuid, k.member_id, k.day,
               COALESCE(sent.messages, 0), COALESCE(closed.conversations, 0),
               COALESCE(resp.cnt, 0), COALESCE(resp.seconds, 0),
               COALESCE(replies.replies, 0), now()
        FROM keys k
        LEFT JOIN sent ON sent.member_id = k.member_id AND sent.day = k.day
        LEFT JOIN closed ON closed.member_id = k.member_id AND closed.day = k.day
        LEFT JOIN resp ON resp.member_id = k.member_id AND resp.day = k.day
        LEFT JOIN replies ON replies.member_id = k.member_id AND replies.day = k.day
        WHERE EXISTS (
          SELECT 1 FROM account_members am
          WHERE am.account_id = ${accountId}::uuid AND am.id = k.member_id
        )
      `,
    ]);

    return { days };
  }

  /**
   * Every account that could have anything to roll up.
   *
   * Used by the scheduled job. Suspended and deleted accounts are skipped - nothing is happening
   * in them, and recomputing empty days for a thousand dormant accounts every quarter of an hour
   * is work nobody asked for.
   */
  async activeAccountIds(): Promise<string[]> {
    const rows = await this.options.db.account.findMany({
      where: { deletedAt: null, status: 'active' },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  // ---------------------------------------------------------------------------
  // Reading it
  // ---------------------------------------------------------------------------

  /**
   * Which websites this request may cover.
   *
   * A named property is checked for existence *in this account*, not merely for permission - see
   * `assertPropertyInAccount`. Without that, an owner of one account asking for another account's
   * website gets a report full of zeros rather than a 404, which is both a broken promise and a
   * bad answer for somebody who mistyped an id.
   */
  private async restriction(context: TenantContext, propertyId?: string): Promise<string[] | null> {
    if (propertyId) {
      await assertPropertyInAccount(this.options.db, context, propertyId, ErrorCode.NOT_FOUND);
      return [propertyId];
    }
    if (context.propertyIds && context.propertyIds.size > 0) return [...context.propertyIds];
    return null;
  }

  async overview(
    context: TenantContext,
    input: { from: Date; to: Date; propertyId?: string },
  ): Promise<Overview> {
    requirePermission(context, Permission.REPORT_VIEW);
    const timezone = await this.timezoneFor(context.accountId);
    const properties = await this.restriction(context, input.propertyId);
    const fromDay = toDayString(input.from);
    const toDay = toDayString(input.to);

    const rows = await this.options.db.dailyMetric.findMany({
      where: {
        accountId: context.accountId,
        day: { gte: new Date(`${fromDay}T00:00:00.000Z`), lte: new Date(`${toDay}T00:00:00.000Z`) },
        ...(properties ? { propertyId: { in: properties } } : {}),
      },
      orderBy: [{ day: 'asc' }],
    });

    /**
     * Several websites' rows for one day are summed into one point.
     *
     * The map is keyed by the day string rather than the Date, because two `Date` objects for the
     * same day are never equal and the bug that produces - a series with duplicate days - looks
     * exactly like a data problem rather than a code one.
     */
    const byDay = new Map<string, DaySeriesPoint>();
    for (const row of rows) {
      const key = toDayString(row.day);
      const point = byDay.get(key) ?? {
        day: key,
        conversationsStarted: 0,
        conversationsClosed: 0,
        messagesFromVisitors: 0,
        messagesFromAgents: 0,
        newVisitors: 0,
        engagedVisitors: 0,
        ticketsOpened: 0,
        ticketsResolved: 0,
        firstResponseCount: 0,
        firstResponseSeconds: 0,
        resolutionCount: 0,
        resolutionSeconds: 0,
      };
      point.conversationsStarted += row.conversationsStarted;
      point.conversationsClosed += row.conversationsClosed;
      point.messagesFromVisitors += row.messagesFromVisitors;
      point.messagesFromAgents += row.messagesFromAgents;
      point.newVisitors += row.newVisitors;
      point.engagedVisitors += row.engagedVisitors;
      point.ticketsOpened += row.ticketsOpened;
      point.ticketsResolved += row.ticketsResolved;
      point.firstResponseCount += row.firstResponseCount;
      point.firstResponseSeconds += row.firstResponseSeconds;
      point.resolutionCount += row.resolutionCount;
      point.resolutionSeconds += row.resolutionSeconds;
      byDay.set(key, point);
    }

    // Days with nothing in them are still days. A chart that silently omits them draws a straight
    // line through a quiet weekend and makes it look like a busy one.
    const series: DaySeriesPoint[] = [];
    for (let cursor = Date.parse(fromDay); cursor <= Date.parse(toDay); cursor += 86_400_000) {
      const key = new Date(cursor).toISOString().slice(0, 10);
      series.push(
        byDay.get(key) ?? {
          day: key,
          conversationsStarted: 0,
          conversationsClosed: 0,
          messagesFromVisitors: 0,
          messagesFromAgents: 0,
          newVisitors: 0,
          engagedVisitors: 0,
          ticketsOpened: 0,
          ticketsResolved: 0,
          firstResponseCount: 0,
          firstResponseSeconds: 0,
          resolutionCount: 0,
          resolutionSeconds: 0,
        },
      );
    }

    const totals = series.reduce<OverviewTotals>(
      (accumulator, point) => ({
        conversationsStarted: accumulator.conversationsStarted + point.conversationsStarted,
        conversationsClosed: accumulator.conversationsClosed + point.conversationsClosed,
        messagesFromVisitors: accumulator.messagesFromVisitors + point.messagesFromVisitors,
        messagesFromAgents: accumulator.messagesFromAgents + point.messagesFromAgents,
        newVisitors: accumulator.newVisitors + point.newVisitors,
        engagedVisitors: accumulator.engagedVisitors + point.engagedVisitors,
        ticketsOpened: accumulator.ticketsOpened + point.ticketsOpened,
        ticketsResolved: accumulator.ticketsResolved + point.ticketsResolved,
        firstResponseCount: accumulator.firstResponseCount + point.firstResponseCount,
        resolutionCount: accumulator.resolutionCount + point.resolutionCount,
        averageFirstResponseSeconds: accumulator.averageFirstResponseSeconds,
        averageResolutionSeconds: accumulator.averageResolutionSeconds,
      }),
      {
        conversationsStarted: 0,
        conversationsClosed: 0,
        messagesFromVisitors: 0,
        messagesFromAgents: 0,
        newVisitors: 0,
        engagedVisitors: 0,
        ticketsOpened: 0,
        ticketsResolved: 0,
        firstResponseCount: 0,
        resolutionCount: 0,
        averageFirstResponseSeconds: null,
        averageResolutionSeconds: null,
      },
    );

    // Divided once, at the end, from the summed numerator and denominator.
    const responseSeconds = series.reduce((sum, point) => sum + point.firstResponseSeconds, 0);
    const resolutionSeconds = series.reduce((sum, point) => sum + point.resolutionSeconds, 0);
    totals.averageFirstResponseSeconds =
      totals.firstResponseCount > 0 ? Math.round(responseSeconds / totals.firstResponseCount) : null;
    totals.averageResolutionSeconds =
      totals.resolutionCount > 0 ? Math.round(resolutionSeconds / totals.resolutionCount) : null;

    return { from: fromDay, to: toDay, timezone, totals, series };
  }

  async agents(
    context: TenantContext,
    input: { from: Date; to: Date },
  ): Promise<AgentRow[]> {
    requirePermission(context, Permission.REPORT_VIEW);
    const fromDay = toDayString(input.from);
    const toDay = toDayString(input.to);

    const rows = await this.options.db.dailyAgentMetric.findMany({
      where: {
        accountId: context.accountId,
        day: { gte: new Date(`${fromDay}T00:00:00.000Z`), lte: new Date(`${toDay}T00:00:00.000Z`) },
      },
      include: {
        member: { select: { id: true, displayName: true, user: { select: { name: true } } } },
      },
    });

    const byMember = new Map<string, AgentRow & { seconds: number }>();
    for (const row of rows) {
      const existing = byMember.get(row.memberId) ?? {
        memberId: row.memberId,
        name: row.member.displayName ?? row.member.user?.name ?? 'Removed member',
        messagesSent: 0,
        conversationsClosed: 0,
        ticketRepliesSent: 0,
        firstResponseCount: 0,
        averageFirstResponseSeconds: null,
        seconds: 0,
      };
      existing.messagesSent += row.messagesSent;
      existing.conversationsClosed += row.conversationsClosed;
      existing.ticketRepliesSent += row.ticketRepliesSent;
      existing.firstResponseCount += row.firstResponseCount;
      existing.seconds += row.firstResponseSeconds;
      byMember.set(row.memberId, existing);
    }

    return [...byMember.values()]
      .map(({ seconds, ...agent }) => ({
        ...agent,
        averageFirstResponseSeconds:
          agent.firstResponseCount > 0 ? Math.round(seconds / agent.firstResponseCount) : null,
      }))
      .sort((a, b) => b.messagesSent - a.messagesSent);
  }

  /**
   * The help centre's own numbers.
   *
   * Read live from `kb_articles.view_count` rather than rolled up: it is a cumulative counter on a
   * small table, and pretending it has a daily shape it does not have would be inventing detail.
   */
  async articles(
    context: TenantContext,
    input: { propertyId?: string; limit: number },
  ): Promise<ArticleRow[]> {
    requirePermission(context, Permission.REPORT_VIEW);
    const properties = await this.restriction(context, input.propertyId);

    const rows = await this.options.db.kbArticle.findMany({
      where: {
        accountId: context.accountId,
        deletedAt: null,
        ...(properties ? { propertyId: { in: properties } } : {}),
      },
      orderBy: [{ viewCount: 'desc' }],
      take: input.limit,
      select: { id: true, title: true, slug: true, status: true, viewCount: true },
    });
    return rows;
  }

  /** Exposed for the scheduled job and the manual rebuild, both of which need "today, there". */
  async accountToday(accountId: string): Promise<Date> {
    const timezone = await this.timezoneFor(accountId);
    const rows = await this.options.db.$queryRaw<{ today: Date }[]>(
      Prisma.sql`SELECT (${this.clock.now()}::timestamptz AT TIME ZONE ${timezone})::date AS today`,
    );
    const today = rows[0]?.today;
    if (!today) throw new AppError(ErrorCode.INTERNAL_ERROR);
    return today;
  }
}
