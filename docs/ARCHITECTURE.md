# SmartChat — System Architecture

Status: living document. Last updated: 2026-08-25 (Phase 0).

## 1. What SmartChat is

SmartChat is a self-hosted, multi-tenant live-chat SaaS platform. One deployment serves many
independent customer organisations ("accounts"). Each account manages one or more websites
("properties"), each property exposes an embeddable chat widget, and each account's agents work
conversations from a shared dashboard.

## 2. Design constraints that shaped this architecture

| Constraint | Consequence |
| --- | --- |
| Must run on one VPS and on a developer's Docker Desktop with the *same* topology | Modular monolith + two dedicated side processes, not microservices |
| Tenant data leakage is the worst possible bug | Tenancy enforced in a repository layer that cannot be bypassed, plus automated isolation tests |
| The widget runs on **customer** websites | Widget must never break the host page; strict origin validation; no secrets in the snippet |
| Real-time is the product | WebSocket-first, Redis pub/sub fan-out, Postgres as durable truth |
| We will add features for years | Rule engine, permissions, entitlements and analytics are all data-driven, not hardcoded |

## 3. Runtime topology

```
                              ┌──────────────────────────┐
  Customer website  ─────────►│  loader.js  (Shadow DOM) │
  (any domain)                │  + panel iframe          │
                              └───────────┬──────────────┘
                                          │ HTTPS + WSS
  Agent browser ──► apps/web ─────────────┤
  (dashboard, Next.js)                    │
                                          ▼
                        ┌─────────────────────────────────┐
                        │  reverse proxy (nginx / Caddy)  │
                        └───┬──────────────┬──────────────┘
                            │              │
                   ┌────────▼───────┐  ┌───▼─────────────┐
                   │  apps/api      │  │ apps/realtime   │
                   │  Fastify HTTP  │  │ Socket.IO       │
                   └───┬────────┬───┘  └───┬─────────┬───┘
                       │        │          │         │
                       │        └────┬─────┘         │
                       │             │               │
                  ┌────▼────┐   ┌────▼────┐    ┌─────▼──────┐
                  │Postgres │   │  Redis  │    │  MinIO/S3  │
                  └────▲────┘   └────▲────┘    └────────────┘
                       │             │
                   ┌───┴─────────────┴───┐
                   │   apps/worker       │
                   │   BullMQ consumers  │
                   └─────────────────────┘
```

Five application processes, three infrastructure services. Every process is stateless and
horizontally scalable; all shared state lives in Postgres, Redis or object storage.

## 4. Processes

### apps/api — Fastify HTTP API
The only writer of business data. Owns authentication, authorisation, tenancy, validation and all
domain mutations. Exposes three surfaces on one process:

- `/api/v1/*` — dashboard + public API (session cookie or API key)
- `/api/v1/widget/*` — visitor-facing endpoints (visitor token, origin-validated)
- `/api/internal/*` — service-to-service, network-internal only (used by realtime/worker)

### apps/realtime — Socket.IO gateway
Holds WebSocket connections, presence and typing state. It does **not** own business rules: when a
visitor or agent sends a message, the gateway calls the shared domain service (same code the API
uses) so persistence, validation and authorisation are identical on both paths. Uses
`@socket.io/redis-adapter` so any instance can reach any connected socket.

### apps/worker — BullMQ consumers
Email, webhook delivery with backoff, trigger execution, analytics rollups, retention cleanup,
file post-processing. Every job is retryable and idempotent.

### apps/web — Next.js dashboard
Agent dashboard, account settings, widget builder, super-admin console and public knowledge base.
Server components fetch through the API; it never talks to Postgres directly.

### apps/widget — the embeddable surface
Two artefacts built by Vite:
- `loader.js` — tiny, dependency-free, async, wrapped in try/catch. Renders the launcher in a
  Shadow DOM and lazily creates the panel iframe.
- `panel` — the full chat UI, served from **our** origin inside the iframe, so its CSS, JS and
  `localStorage` are completely isolated from the host page.

### apps/test-site — a real customer website
A static multi-page site with the widget installed exactly the way a real customer installs it.
It is the acceptance harness for the whole system, not a mock.

## 5. Shared packages

| Package | Responsibility |
| --- | --- |
| `@smartchat/config` | Zod-validated environment parsing. Fails fast at boot on bad config. |
| `@smartchat/logger` | Pino structured logging with request/tenant correlation fields. |
| `@smartchat/types` | Shared DTOs, enums, event names, error codes. No runtime deps. |
| `@smartchat/validation` | Zod schemas shared by API, dashboard and widget. One source of truth. |
| `@smartchat/database` | Prisma schema, migrations, generated client, seed. |
| `@smartchat/core` | Domain services: auth, tenancy, conversations, messages, presence, triggers. Used by api, realtime and worker. |
| `@smartchat/ui` | React design system (tokens, primitives, patterns). |

The rule that keeps this honest: **`apps/*` contain transport and presentation only.** Business
rules live in `@smartchat/core`, so the HTTP path and the WebSocket path can never disagree.

## 6. Multi-tenancy model

Single database, shared schema, discriminator column. Chosen over schema-per-tenant because 10,000
accounts × 30 tables is unmanageable for migrations, and over database-per-tenant because it makes
platform analytics and connection pooling impractical at our target scale.

Enforcement is layered:

1. **Schema** — every tenant-owned table carries `account_id`, and child rows carry composite
   foreign keys that include `account_id`, so a conversation can never reference a property from
   another account even if application code is wrong.
2. **Repository layer** — `@smartchat/core` repositories take a `TenantContext` as their first
   argument and inject `accountId` into every `where` clause. Raw Prisma access to tenant models
   outside the repository layer fails code review and is caught by an architecture test.
3. **Authorisation layer** — every route resolves the actor's account/property membership and
   permissions before the repository is reached.
4. **Tests** — `tests/isolation` asserts, per resource, that account A receives 404 for account B's
   objects. This suite is mandatory and blocks CI.

## 7. Identity and authentication

| Actor | Credential | Storage | Revocation |
| --- | --- | --- | --- |
| User (owner/admin/agent) | Opaque 256-bit session token | httpOnly, SameSite=Lax cookie; record in Postgres + Redis cache | Instant — delete the session row |
| Visitor | Signed visitor token (HS256, bound to property + visitor + session) | `localStorage` of the **widget iframe origin**, unreachable from the host page | Rotate the property's visitor secret |
| Realtime connection | Short-lived (60 s) single-use connection ticket minted by the API | Never stored | Expiry |
| Integration | API key `sc_live_<keyid>_<secret>`, SHA-256 hash at rest, shown once | Postgres | Revoke flag |

Passwords are hashed with Argon2id. Opaque sessions were chosen over stateless JWTs specifically so
that suspending an account or removing an agent takes effect immediately.

## 8. Message durability

The system never acknowledges a message it has not persisted.

```
client ──message:send{clientMessageId, body}──► gateway
                                                  │  (single Postgres transaction)
                                                  │  1. authorise
                                                  │  2. INSERT message
                                                  │  3. UPDATE conversation SET
                                                  │       message_seq = message_seq + 1,
                                                  │       last_message_at = now()
                                                  ▼
client ◄──message:ack{id, seq, createdAt}────── gateway ──publish──► Redis ──► other instances
```

- `clientMessageId` + a unique index on `(conversation_id, client_message_id)` makes retries
  idempotent, which is what makes reconnect-and-resend safe.
- Ordering uses the gapless per-conversation `seq`, never wall-clock timestamps.
- On reconnect the client sends its highest known `seq` and receives everything after it.

## 9. Scaling path

The first deployment is one VPS running Docker Compose. Nothing in the design blocks the next steps:

| Pressure | Response — no rewrite required |
| --- | --- |
| More HTTP traffic | More `api` replicas behind the proxy (already stateless) |
| More concurrent sockets | More `realtime` replicas (Redis adapter already fans out) |
| More background work | More `worker` replicas / more queues |
| Database load | Managed Postgres, read replicas for analytics, partition `messages` by month |
| Redis load | Managed Redis, separate instance for queues vs pub/sub |
| Search load | `SearchProvider` interface swaps Postgres FTS for OpenSearch |
| Asset delivery | Point `WIDGET_URL` at a CDN; the loader is already cache-friendly and versioned |

## 10. Failure behaviour

- **Chat backend down** — `loader.js` catches every error, the launcher simply does not appear, and
  the customer's website is completely unaffected. It never patches globals or blocks rendering.
- **Realtime down, API up** — the widget degrades to a "reconnecting" state and retries with
  exponential backoff plus jitter; queued outbound messages are flushed on reconnect.
- **Redis down** — presence and typing degrade; messages still persist through the API path.
- **Postgres down** — writes are rejected with a clear error; nothing is silently dropped or
  acknowledged.
- **Worker down** — jobs accumulate in Redis and drain when it returns; no data loss.
