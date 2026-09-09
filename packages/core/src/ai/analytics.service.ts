import { Prisma, type Database } from '@smartchat/database';
import { AppError, ErrorCode, Permission, type TenantContext } from '@smartchat/types';
import { requirePermission } from '../tenancy/context.js';
import { assertPropertyInAccount } from '../tenancy/property-access.js';

/**
 * How the assistant is doing, for the owner.
 *
 * Read live from `ai_turns` rather than from the daily rollup: the table is small (one row per
 * reply), indexed by property and day, and the report the owner wants most - the questions the
 * assistant could not answer - is a list of sentences, which no rollup holds. Days are the
 * account's own timezone, like every other report.
 *
 * "Deflected" is the number that says whether the thing is worth having: conversations the
 * assistant took part in where no person ever replied, nothing was handed off and no ticket was
 * opened. Every one of those is a chat the team did not have to have.
 */

export interface AiReportTotals {
  /** Replies posted to visitors (drafts for agents are counted separately). */
  replies: number;
  answers: number;
  chats: number;
  ticketOffers: number;
  handoffs: number;
  failed: number;
  fellBack: number;
  /** Replies drafted for agents. */
  drafts: number;
  conversations: number;
  deflected: number;
  /** deflected / conversations, 0..1, or null when there were none. */
  deflectionRate: number | null;
  averageLatencyMs: number | null;
  ratedUp: number;
  ratedDown: number;
}

export interface AiReportDay {
  day: string;
  replies: number;
  answers: number;
  ticketOffers: number;
  handoffs: number;
}

export interface UnansweredQuestion {
  /** The question as a visitor last wrote it. */
  question: string;
  /** How many times something like it was asked. */
  count: number;
  lastAskedAt: string;
  /** What happened: the ticket offer, or a failure. */
  outcome: 'ticket' | 'failed';
}

export interface UnhelpfulReply {
  conversationId: string;
  question: string;
  reply: string;
  at: string;
}

export interface AiReport {
  from: string;
  to: string;
  timezone: string;
  totals: AiReportTotals;
  series: AiReportDay[];
  unanswered: UnansweredQuestion[];
  unhelpful: UnhelpfulReply[];
}

export class AiAnalyticsService {
  constructor(private readonly options: { db: Database }) {}

  async report(
    context: TenantContext,
    input: { from: Date; to: Date; propertyId?: string },
  ): Promise<AiReport> {
    requirePermission(context, Permission.REPORT_VIEW);
    const account = await this.options.db.account.findUnique({
      where: { id: context.accountId },
      select: { timezone: true },
    });
    if (!account) throw new AppError(ErrorCode.NOT_FOUND);
    const timezone = account.timezone;

    let properties: string[] | null = null;
    if (input.propertyId) {
      await assertPropertyInAccount(this.options.db, context, input.propertyId, ErrorCode.NOT_FOUND);
      properties = [input.propertyId];
    } else if (context.propertyIds && context.propertyIds.size > 0) {
      properties = [...context.propertyIds];
    }

    const fromDay = dayString(input.from);
    const toDay = dayString(input.to);
    const accountId = context.accountId;
    // The window in the account's timezone: from the start of `from` to the end of `to`.
    const scope = Prisma.sql`
      t.account_id = ${accountId}::uuid
      AND t.created_at >= (${fromDay}::date::timestamp AT TIME ZONE ${timezone})
      AND t.created_at < ((${toDay}::date + 1)::timestamp AT TIME ZONE ${timezone})
      ${properties ? Prisma.sql`AND t.property_id IN (${Prisma.join(properties.map((id) => Prisma.sql`${id}::uuid`))})` : Prisma.empty}
    `;

    const [totalsRow] = await this.options.db.$queryRaw<TotalsRow[]>`
      SELECT
        count(*) FILTER (WHERE t.decision <> 'draft')::int AS replies,
        count(*) FILTER (WHERE t.decision = 'answer')::int AS answers,
        count(*) FILTER (WHERE t.decision = 'chat')::int AS chats,
        count(*) FILTER (WHERE t.decision = 'ticket')::int AS ticket_offers,
        count(*) FILTER (WHERE t.decision = 'human')::int AS handoffs,
        count(*) FILTER (WHERE t.decision = 'failed')::int AS failed,
        count(*) FILTER (WHERE t.fell_back AND t.decision <> 'draft')::int AS fell_back,
        count(*) FILTER (WHERE t.decision = 'draft')::int AS drafts,
        count(DISTINCT t.conversation_id) FILTER (WHERE t.decision <> 'draft')::int AS conversations,
        avg(t.latency_ms) FILTER (WHERE t.decision IN ('answer', 'chat'))::float8 AS average_latency_ms,
        count(*) FILTER (WHERE t.rating = 'up')::int AS rated_up,
        count(*) FILTER (WHERE t.rating = 'down')::int AS rated_down
      FROM ai_turns t
      WHERE ${scope}`;

    const [deflectedRow] = await this.options.db.$queryRaw<Array<{ deflected: number }>>`
      SELECT count(*)::int AS deflected
      FROM conversations c
      WHERE c.account_id = ${accountId}::uuid
        AND c.ai_handoff_at IS NULL
        AND EXISTS (SELECT 1 FROM ai_turns t WHERE t.conversation_id = c.id AND t.decision <> 'draft' AND ${scope})
        AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.sender_type = 'agent')
        AND NOT EXISTS (SELECT 1 FROM tickets k WHERE k.conversation_id = c.id)`;

    const days = await this.options.db.$queryRaw<DayRow[]>`
      SELECT to_char(t.created_at AT TIME ZONE ${timezone}, 'YYYY-MM-DD') AS day,
        count(*) FILTER (WHERE t.decision <> 'draft')::int AS replies,
        count(*) FILTER (WHERE t.decision = 'answer')::int AS answers,
        count(*) FILTER (WHERE t.decision = 'ticket')::int AS ticket_offers,
        count(*) FILTER (WHERE t.decision = 'human')::int AS handoffs
      FROM ai_turns t
      WHERE ${scope}
      GROUP BY 1
      ORDER BY 1`;

    /**
     * The questions the assistant could not answer, grouped by what was asked. Grouping is on the
     * text with case, punctuation and spacing flattened, so "Do you deliver to Sylhet?" and "do
     * you deliver to sylhet" are one line. Questions about the visitor's own order are tickets by
     * design and belong here too - if they come up a lot, the owner wants an order-status page.
     */
    const unanswered = await this.options.db.$queryRaw<UnansweredRow[]>`
      SELECT
        (array_agg(m.body ORDER BY t.created_at DESC))[1] AS question,
        count(*)::int AS count,
        max(t.created_at) AS last_asked_at,
        (array_agg(t.decision::text ORDER BY t.created_at DESC))[1] AS outcome
      FROM ai_turns t
      JOIN messages m ON m.id = t.visitor_message_id
      WHERE ${scope} AND t.decision IN ('ticket', 'failed') AND length(trim(m.body)) BETWEEN 3 AND 500
      GROUP BY regexp_replace(lower(trim(m.body)), '[^[:alnum:][:space:]]+|\\s+', ' ', 'g')
      ORDER BY count DESC, last_asked_at DESC
      LIMIT 20`;

    const unhelpful = await this.options.db.$queryRaw<UnhelpfulRow[]>`
      SELECT t.conversation_id, q.body AS question, r.body AS reply, t.rated_at AS at
      FROM ai_turns t
      JOIN messages q ON q.id = t.visitor_message_id
      JOIN messages r ON r.id = t.reply_message_id
      WHERE ${scope} AND t.rating = 'down'
      ORDER BY t.rated_at DESC
      LIMIT 10`;

    const totals = totalsRow ?? emptyTotals();
    const deflected = deflectedRow?.deflected ?? 0;
    return {
      from: fromDay,
      to: toDay,
      timezone,
      totals: {
        replies: totals.replies,
        answers: totals.answers,
        chats: totals.chats,
        ticketOffers: totals.ticket_offers,
        handoffs: totals.handoffs,
        failed: totals.failed,
        fellBack: totals.fell_back,
        drafts: totals.drafts,
        conversations: totals.conversations,
        deflected,
        deflectionRate: totals.conversations > 0 ? deflected / totals.conversations : null,
        averageLatencyMs: totals.average_latency_ms === null ? null : Math.round(totals.average_latency_ms),
        ratedUp: totals.rated_up,
        ratedDown: totals.rated_down,
      },
      series: fillDays(fromDay, toDay, days),
      unanswered: unanswered.map((row) => ({
        question: row.question.trim().slice(0, 300),
        count: row.count,
        lastAskedAt: row.last_asked_at.toISOString(),
        outcome: row.outcome === 'failed' ? 'failed' : 'ticket',
      })),
      unhelpful: unhelpful.map((row) => ({
        conversationId: row.conversation_id,
        question: row.question.slice(0, 300),
        reply: row.reply.slice(0, 500),
        at: row.at.toISOString(),
      })),
    };
  }
}

interface TotalsRow {
  replies: number;
  answers: number;
  chats: number;
  ticket_offers: number;
  handoffs: number;
  failed: number;
  fell_back: number;
  drafts: number;
  conversations: number;
  average_latency_ms: number | null;
  rated_up: number;
  rated_down: number;
}

interface DayRow {
  day: string;
  replies: number;
  answers: number;
  ticket_offers: number;
  handoffs: number;
}

interface UnansweredRow {
  question: string;
  count: number;
  last_asked_at: Date;
  outcome: string;
}

interface UnhelpfulRow {
  conversation_id: string;
  question: string;
  reply: string;
  at: Date;
}

function emptyTotals(): TotalsRow {
  return {
    replies: 0,
    answers: 0,
    chats: 0,
    ticket_offers: 0,
    handoffs: 0,
    failed: 0,
    fell_back: 0,
    drafts: 0,
    conversations: 0,
    average_latency_ms: null,
    rated_up: 0,
    rated_down: 0,
  };
}

function dayString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Every day in the range, the quiet ones included, so a chart has no gaps. */
function fillDays(from: string, to: string, rows: DayRow[]): AiReportDay[] {
  const byDay = new Map(rows.map((row) => [row.day, row]));
  const out: AiReportDay[] = [];
  for (let at = Date.parse(from); at <= Date.parse(to); at += 86_400_000) {
    const day = new Date(at).toISOString().slice(0, 10);
    const row = byDay.get(day);
    out.push({
      day,
      replies: row?.replies ?? 0,
      answers: row?.answers ?? 0,
      ticketOffers: row?.ticket_offers ?? 0,
      handoffs: row?.handoffs ?? 0,
    });
  }
  return out;
}
