# SmartChat — Decision Log

Format per entry: Decision · Context · Options considered · Chosen · Reason · Tradeoffs · Date.

---
## ADR-001 — Modular monolith plus two side processes, not microservices
**Context** The product must run on a single VPS and on a developer laptop with identical topology,
while still scaling to thousands of accounts.
**Options** (a) one process for everything; (b) modular monolith + dedicated realtime + worker;
(c) microservices per domain.
**Chosen** (b). `apps/api`, `apps/realtime`, `apps/worker`, `apps/web` share `@smartchat/core`.
**Reason** WebSocket connections and background jobs have completely different scaling and failure
characteristics from request/response traffic, so they get their own processes. Splitting further
would buy nothing today and cost distributed transactions, tracing and deployment complexity.
**Tradeoffs** All three processes share one deploy unit for the domain layer; a core change rebuilds
all of them. Accepted — the interfaces are already package boundaries, so extraction stays cheap.
**Date** 2026-08-25

---
## ADR-002 — Shared-schema multi-tenancy with a discriminator column
**Context** Tenant isolation is the highest-severity risk in the product.
**Options** (a) database per tenant; (b) schema per tenant; (c) shared schema with `account_id`.
**Chosen** (c), enforced at four layers: composite foreign keys, a repository layer that requires a
`TenantContext`, per-route authorisation, and a blocking automated isolation suite.
**Reason** (a) and (b) make migrations, connection pooling and platform analytics impractical at
10,000 accounts. The real risk in (c) is a missing `where` clause, and that is fixed by making it
impossible to write a query without tenant scope rather than by trusting discipline.
**Tradeoffs** A bug in the repository layer is a cross-tenant bug. Mitigated by concentrating that
risk in one small, heavily tested module instead of spreading it across every handler.
**Date** 2026-08-25

---
## ADR-003 — Opaque server-side sessions, not stateless JWTs, for dashboard auth
**Context** Suspending an account or removing an agent must take effect immediately.
**Options** (a) stateless JWT access + refresh; (b) opaque session token in Postgres, cached in Redis.
**Chosen** (b). httpOnly, SameSite=Lax cookie; session rows are listable and individually revocable.
**Reason** A stateless JWT is valid until it expires. "Suspend account" that keeps working for
another 15 minutes is not an acceptable security control for a platform admin.
**Tradeoffs** One Redis lookup per request. Negligible, and it buys instant revocation plus a
session list the user can inspect.
**Date** 2026-08-25

---
## ADR-004 — Socket.IO rather than raw `ws`
**Context** We need reconnect, heartbeat, acknowledgements, rooms and multi-instance fan-out.
**Options** (a) raw `ws` + custom protocol; (b) Socket.IO + Redis adapter; (c) a hosted realtime SaaS.
**Chosen** (b).
**Reason** (a) means reimplementing four solved problems and getting reconnect semantics subtly
wrong. (c) breaks the self-hosting requirement. Socket.IO's ack callback maps exactly onto our
persist-before-ack rule.
**Tradeoffs** Slightly larger client bundle and a protocol we do not control. Acceptable; the panel
is lazily loaded, so it does not affect the customer's page weight.
**Date** 2026-08-25

---
## ADR-005 — Shadow DOM launcher + cross-origin iframe panel
**Context** The widget runs on customer sites with unknown CSS, unknown JS and unknown CSP.
**Options** (a) inject everything into the host DOM; (b) whole widget in one iframe; (c) Shadow DOM
launcher + iframe panel loaded on demand.
**Chosen** (c).
**Reason** (a) guarantees CSS conflicts eventually. (b) forces a large iframe to exist on every page
view even for visitors who never chat. (c) keeps the always-present part to a few kilobytes with
perfect style isolation, and puts the heavy, stateful part on our own origin — which also means the
visitor token lives in **our** `localStorage`, not the host's.
**Tradeoffs** A postMessage bridge to maintain. Contained: the message set is small, closed, and
origin-pinned on both sides.
**Date** 2026-08-25

---
## ADR-006 — Gapless per-conversation `seq` for message ordering
**Context** Timestamps are unreliable for ordering (clock skew, same-millisecond writes) and make
reconnect replay ambiguous.
**Options** (a) order by `created_at`; (b) order by ULID; (c) per-conversation counter incremented in
the insert transaction.
**Chosen** (c), with `clientMessageId` + a unique index for idempotency.
**Reason** Replay after reconnect becomes exact: "send me everything after seq N". Ordering is
total and stable, and duplicate detection is a database constraint rather than application logic.
**Tradeoffs** One extra row update per message and a write hotspot per conversation. A conversation
is a low-concurrency object, so this is not a real contention point.
**Date** 2026-08-25

---
## ADR-007 — UUIDv7 primary keys, separate public ids for exposed objects
**Context** Sequential integer ids are enumerable; random UUIDv4 primary keys destroy index locality
at 10^8 rows.
**Options** (a) bigserial; (b) UUIDv4; (c) UUIDv7; (d) cuid2.
**Chosen** (c) for primary keys, plus prefixed random public ids (`prp_…`) for anything a browser
sees before authentication.
**Reason** UUIDv7 is time-sortable, so B-tree inserts stay at the right edge, while remaining
non-enumerable. Separating the public id means we can rotate what customers paste into their site
without touching foreign keys.
**Tradeoffs** 16 bytes per key instead of 8. Worth it.
**Date** 2026-08-25

---
## ADR-008 — Prisma as the ORM and migration tool
**Context** We need type-safe queries shared across four processes and reviewable migrations.
**Options** (a) Prisma; (b) Drizzle; (c) Kysely + hand-written SQL migrations.
**Chosen** (a), with `$queryRaw` (tagged templates only) available for the few analytics queries that
need it.
**Reason** Best-in-class generated types, a migration workflow that produces reviewable SQL, and a
single schema file that doubles as documentation.
**Tradeoffs** Less control over generated SQL than (c), and a heavier client. We mitigate by writing
the hot analytics paths as raw parameterised SQL where the planner needs help.
**Date** 2026-08-25

---
## ADR-009 — Non-default host ports in development
**Context** Developer machines commonly already run Postgres on 5432 and Redis on 6379; this machine
already had another project's containers running.
**Chosen** Postgres 55432, Redis 56379, MinIO 9100/9101, Mailpit 8025/1025, apps 3000–3004.
**Reason** Avoids silent connection to the wrong database — the worst kind of local bug.
**Tradeoffs** One more thing to read from `.env`. Documented in `LOCAL_SETUP.md`.
**Date** 2026-08-25

---
## ADR-010 — `COMPOSE_FILE` overlays selected from `.env`
**Context** The same base compose file must serve dev and prod without a fork.
**Chosen** `docker-compose.yml` (base) + `docker-compose.dev.yml` / `docker-compose.prod.yml`
overlays, selected by `COMPOSE_FILE` in `.env`, with `COMPOSE_PATH_SEPARATOR=:` so the same value
works on Windows and Linux.
**Reason** Plain `docker compose up -d` does the right thing on a developer machine, and production
differs by one variable rather than by a divergent file.
**Tradeoffs** Overlay semantics must be understood when editing; documented in `DOCKER.md`.
**Date** 2026-08-25
