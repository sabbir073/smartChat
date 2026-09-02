# SmartChat — Reporting

Every number in a SmartChat report is derived from tables the product already keeps —
conversations, messages, tickets, visitors. There is no event stream, and that is a decision
rather than an omission.

## Why rollups and not events

An event log would be a **second copy of the truth**, written at the same moment as the first and
able to drift from it. When the two disagree — a message inserted but its event dropped, a retry
that wrote the event twice — nobody can say which is right, and the report becomes a thing people
argue about instead of act on.

Deriving from the source has the opposite property: the rollup is a cache, and a cache can always
be thrown away and rebuilt. A wrong number is fixable in one command instead of being a permanent
scar in an append-only log.

What the rollup buys is speed. Ninety days of report reads ninety rows instead of aggregating
millions of messages, so the report does not get slower as an account gets busier — which is the
thing that decides whether anybody keeps opening it.

## The tables

```
DailyMetric      (account, property, day)  — one website's day
DailyAgentMetric (account, member, day)    — one person's day
```

Two tables rather than one wide one, because the questions are different. "How is this website
doing" and "how is this person doing" have almost no columns in common, and joining them would
make every query carry columns it does not want.

### Sums and counts, never stored averages

`firstResponseCount` and `firstResponseSeconds`, not `averageFirstResponse`.

An average of averages is wrong: a day with one 10-second reply and a day with a hundred
600-second replies do not average to 305 seconds. A week's figure has to be computable from seven
days' rows, so the numerator and denominator are both stored and the division happens once, at the
last possible moment, in the reader.

### Days are the account's days

Every bucket is cut with `AT TIME ZONE` using the **account's own timezone**:

```sql
(started_at AT TIME ZONE 'Pacific/Auckland')::date
```

"Yesterday" for a team in Auckland is not the window a UTC `date_trunc` would give them. A daily
report whose days do not match the days people actually worked is worse than no report, because it
is wrong in a way that looks right.

### What each number means

| Column | Bucketed by | Notes |
| --- | --- | --- |
| `conversationsStarted` | `started_at` | |
| `conversationsClosed` / `resolutionCount` | `closed_at` | The day it was *finished*, not the day it began |
| `firstResponseCount` / `Seconds` | `first_response_at` | The day it was *answered* |
| `messagesFromVisitors` / `FromAgents` | `created_at` | Internal notes are excluded — a note is work, but it is not something anybody said to anybody |
| `newVisitors` | `first_seen_at` | Their first-ever sight of this website |
| `engagedVisitors` | `started_at` | Distinct visitors who started a conversation |
| `ticketsOpened` | `created_at` | |
| `ticketsResolved` | `resolved_at` | |

Attribution for the per-agent first-response figure is exact rather than approximate.
`first_response_at` is written with the same clock value as the message that caused it, in the same
transaction, so the responding message is the agent message at exactly that instant. The query
joins on that equality and uses `DISTINCT ON ... ORDER BY seq` so that a tie, if one ever occurred,
resolves deterministically rather than being left to the planner.

## Rebuilding

`rebuild(accountId, from, to)` **deletes** the range and re-derives it, inside one transaction.

Delete-then-insert rather than upsert, because upsert leaves behind rows for days whose source data
has since gone — a conversation removed under a retention policy, a website deleted. A metric that
outlives the thing it counted is a number that can never be corrected, only explained.

It is idempotent by construction: running it once, twice or a hundred times produces identical
rows. That is what makes it safe to run on a schedule and safe to retry after a failure.

**On a schedule.** A repeatable job every fifteen minutes recomputes the last two days for every
active account. Two days, not one: a conversation that started at 23:58 and was answered at 00:03
changes yesterday's numbers after yesterday has ended. Anything older only changes when somebody
edits history — which is what the manual rebuild is for. One account failing is caught, logged and
stepped over, so a single pathological tenant cannot freeze everybody else's reports.

**On demand.** `POST /reports/rebuild { from, to }` needs `account:update`, not `report:view` — it
is a write that reads every conversation in the range, so it is not something an agent should be
able to start. It exists for the case a schedule cannot serve: somebody corrects data, or a bug in
the rollup is fixed, and the numbers have to be repairable without waiting or editing the table by
hand.

Reports are therefore up to fifteen minutes stale, and the page says so rather than implying it is
live.

## Reading

```
GET  /api/v1/reports/overview?from=&to=&propertyId=
GET  /api/v1/reports/agents?from=&to=
GET  /api/v1/reports/articles?propertyId=&limit=
POST /api/v1/reports/rebuild   { from, to }
```

`report:view` for the three reads; owners, administrators and managers have it by default.

The overview and the article report are property-scoped: a restricted agent's numbers cover only
the websites they work on, and asking for one they do not is a **404**, not a filtered zero — a
filtered zero would tell them the website exists and is quiet.

The **agent report is not**, and cannot be. `daily_agent_metrics` counts an agent's messages,
closes and replies per agent; there is no property column to filter on, because an agent's day is
not divisible by website. So a member restricted to particular websites is **refused** it with a
403 rather than shown account-wide figures. This page used to say "everything is property-scoped",
which was true of two reads out of three, and the third was quietly showing scoped members every
colleague's totals.

Dates are `YYYY-MM-DD`, not timestamps. A report is asked for in days, and accepting an instant
would invite a client to send its browser's midnight and get back a window nobody worked. Ranges
are capped at 366 days: a year of daily rows is a chart nobody can read, and an unbounded range is
an unbounded query.

The series contains **every day in the range**, including the empty ones. A chart that omits quiet
days draws a straight line through a weekend and makes it look busy.

An average over nothing is `null`, not `0`. Zero would mean "answered instantly", which is the
opposite of what happened.

## The article numbers

Read live from `kb_articles.view_count` rather than rolled up. It is a cumulative counter on a
small table, and giving it a daily shape it does not have would be inventing detail. The report
says so: "for the whole life of the article rather than this range".

## The chart

Drawn by hand — an `<svg>`, two rectangles per day, and an axis. A charting library ships a layout
engine, an animation system and its own event handling to draw that, which is a lot of surface for
a picture we can describe in fifty lines. It also keeps the chart a real element in the page:
readable, printable and inspectable, rather than a canvas nobody can select text from.

## Verifying it

```
node scripts/e2e-reports.mjs
```

The suite builds a world whose numbers a person can work out on paper — 3 conversations, 6 visitor
messages, 4 agent replies, 1 internal note, 2 tickets, 1 resolved — and asserts those exact figures.
Not "greater than zero", and not "the same as a second query", which would only prove the code
agrees with itself.
