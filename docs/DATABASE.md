# SmartChat — Database Architecture

PostgreSQL 16. Prisma is the schema authority and migration tool; the generated SQL is reviewed and
committed under `packages/database/prisma/migrations`.

## 1. Conventions

- **Primary keys** — UUIDv7, generated in the application. Time-sortable, so index locality is close
  to a bigserial while remaining globally unique and non-enumerable.
- **Public identifiers** — anything exposed to a browser that is not already authenticated gets a
  separate, prefixed, random public id (`prp_…` for properties). Internal UUIDs are never used as
  widget keys.
- **Timestamps** — `timestamptz`, always stored in UTC. `created_at` / `updated_at` on every table.
- **Attachments hang off the conversation, not the message.** A composite foreign key to
  `messages` would need a unique index on `(account_id, id)` over a table targeting 10^8 rows -
  gigabytes to enforce a guarantee the conversation key already gives, since deleting a conversation
  takes its messages and its attachments together. `message_id` is a plain indexed column. ADR-048.
- **Contacts are account-level, visitors are per-property.** They are joined only when an email
  address appears, which is the one identifier worth joining on. ADR-047.
- **Soft delete** — `deleted_at` on tenant-visible content (conversations, contacts, articles,
  properties). Hard delete only for privacy erasure requests and expired ephemeral rows.
- **Tenancy** — every tenant-owned table carries `account_id`. Child tables carry it too and use a
  composite FK back to the parent `(account_id, id)`, so cross-tenant references are impossible at
  the database level.
- **Enums** — native Postgres enums for closed sets (message type, conversation status), lookup
  tables for sets customers extend (tags, departments).
- **Money / counters** — `bigint` for counters, `numeric` for money. Never `float`.

## 2. Entity map

```
accounts ──┬── users (via account_members) ── roles ── permissions
           ├── properties ──┬── widgets ── widget_settings
           │                ├── property_members
           │                ├── visitors ── visitor_sessions ── visitor_page_views
           │                ├── conversations ──┬── messages
           │                │                   ├── attachments
           │                │                   └── conversation_reads
           ├── contacts (account level; visitors join by email)
           ├── contact_field_definitions
           ├── triggers ── trigger_firings
           ├── shortcuts
           │                ├── departments
           │                ├── knowledge_bases ── kb_categories ── kb_articles
           │                ├── tickets ── ticket_messages
           │                └── webhooks ── webhook_deliveries
           ├── api_keys
           ├── subscriptions ── plans ── plan_features ── usage_records
           ├── audit_logs
           └── notifications
```

Platform-level tables that are **not** tenant-scoped: `plans`, `plan_features`, `feature_flags`,
`platform_admins`, `system_settings`.

## 3. Tables that need care

### `messages` — the largest table (target: 10^8 rows)

| Column | Notes |
| --- | --- |
| `id` | UUIDv7 |
| `account_id`, `property_id`, `conversation_id` | denormalised tenancy + query keys |
| `seq` | `bigint`, gapless per conversation, assigned in the same transaction as the insert |
| `client_message_id` | client-generated, unique per conversation → idempotent retries |
| `sender_type` | `visitor` \| `agent` \| `system` \| `bot` |
| `sender_id` | nullable (system messages have none) |
| `type` | `text` \| `file` \| `image` \| `system` \| `note` |
| `body` | text, stored raw; sanitised on render, never on write |
| `metadata` | `jsonb` |
| `delivered_at`, `read_at`, `edited_at`, `deleted_at` | lifecycle |

Indexes:
```
UNIQUE (conversation_id, seq)
UNIQUE (conversation_id, client_message_id)
INDEX  (conversation_id, id DESC)              -- keyset pagination
INDEX  (account_id, created_at DESC)
INDEX  USING GIN (to_tsvector('simple', body)) -- search, added in Phase 4
```
Partitioning by `created_at` (monthly) is the planned response to volume. The schema keeps
`created_at` in every index prefix that would need it, so partitioning later is a migration, not a
redesign.

### `conversations`

`message_seq bigint not null default 0` is the counter that produces gapless message ordering.
`last_message_at` is maintained in the same transaction as the message insert, so the inbox list
never needs to touch `messages`.

Indexes: `(account_id, property_id, status, last_message_at DESC)` drives the inbox;
`(account_id, assigned_agent_id, status, last_message_at DESC)` drives "assigned to me".

### `visitors` / `visitor_sessions`

Visitors are high-churn. `visitors` holds the durable identity (per property), `visitor_sessions`
holds one browsing session with page views. Retention policy prunes sessions older than the
account's configured window; visitors with conversations are kept.

### `audit_logs`

Append-only. No updates, no deletes from application code. `(account_id, created_at DESC)` index,
plus `(actor_id, created_at DESC)`.

## 4. Query rules

- **No offset pagination on large sets.** Keyset (cursor) pagination on `(created_at, id)` or
  `(seq)` for messages and conversations. Offset is allowed only for small admin tables.
- **No N+1.** Prisma `include`/`select` are explicit; list endpoints assemble in one round trip.
- **Nothing unbounded.** Every list query has a server-enforced `limit` (default 25, max 100).
- **Counts are cached.** Unread counts and inbox badges come from maintained counters in Redis with
  a Postgres fallback, never from `SELECT count(*)` on `messages`.

## 5. Migrations

- `pnpm db:migrate` — create + apply a migration in development.
- `pnpm db:deploy` — apply committed migrations in CI and production. Never `db push` outside a
  throwaway database.
- Every migration must be forward-only and safe on a live table: add nullable, backfill in a job,
  then enforce. No `ALTER TABLE … SET NOT NULL` on a large table without a validated constraint
  first.
- Both paths are tested: migrate from an empty database, and migrate from the previous release's
  seeded database.

## Departments

A department is a named desk — "Billing", "Sales" — that a conversation can belong to, so an
account can divide an inbox by responsibility rather than by website. Membership is many-to-many
(`department_members`): one person is usually on two desks.

At most one department per account is the default. That is enforced in the service rather than by
a partial unique index, which Prisma cannot express — setting a new default clears the previous one
in the same call.

Deleting a department is a soft delete that also detaches its conversations (`department_id` set to
NULL) and drops its membership rows. Conversations keep their whole history; they simply stop
belonging to a desk that no longer exists.

## Invited users

`users.password_hash` is nullable. A user row is created the moment somebody is invited, so a
membership can point at it, but nobody can sign in as them until they accept and choose one.
`verifyPassword` returns false for a null hash, and the login route treats that identically to a
wrong password — otherwise the sign-in form would become a way to discover who has been invited.
See ADR-030.
