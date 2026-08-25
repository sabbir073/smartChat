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

---
## ADR-011 — Role permissions stored as a text[] column, not a join table
**Context** The schema sketch called for `roles` and `permissions` tables joined by `role_permissions`.
**Options** (a) three tables; (b) `roles.permissions text[]`.
**Chosen** (b).
**Reason** The permission set for a role is small (tens of entries), always read whole when a
request resolves its `TenantContext`, and never queried *by* permission ("which roles include
conversation:reply?" is not a question the product asks). A join table would add two queries per
request to model a relationship nothing traverses.
**Tradeoffs** No referential integrity on permission strings. Handled in `resolvePermissions`,
which drops values that are not current `Permission` members — so a permission removed from the
product cannot linger in a stored role and grant something unintended.
**Date** 2026-08-25

---
## ADR-012 — Runtime configuration injected into the page, not `NEXT_PUBLIC_*`
**Context** The dashboard needs the API, realtime and widget URLs in the browser.
**Options** (a) `NEXT_PUBLIC_*` variables; (b) the server renders a config object into the document.
**Chosen** (b).
**Reason** `NEXT_PUBLIC_*` is inlined at build time, which means one image per environment — the
same artefact could not be promoted from staging to production. Injecting at request time makes
the image environment-agnostic, which is what makes "build once, deploy anywhere" true.
**Tradeoffs** One inline script tag, and its content must be escaped (`<` is escaped so a value
cannot terminate the tag early). Values come from our own environment, but the sink is closed
regardless of who currently controls the source.
**Date** 2026-08-25

---
## ADR-013 — Next.js standalone output only inside the Docker build
**Context** `output: 'standalone'` recreates pnpm's symlinked `node_modules` layout. Creating
symlinks on Windows requires elevation or Developer Mode, so `pnpm build` failed with EPERM on the
target development machine.
**Options** (a) switch pnpm to a hoisted node-linker; (b) require Developer Mode; (c) enable
standalone output only when `NEXT_OUTPUT_STANDALONE=1`, which the Dockerfile sets.
**Chosen** (c).
**Reason** (a) gives up pnpm's protection against phantom dependencies for the whole repository to
solve a problem in one build mode. (b) makes the repo depend on a machine setting a new developer
would have to discover from an error. (c) confines the difference to the one place the output is
actually consumed — the Linux production image.
**Tradeoffs** `pnpm build` on a developer machine does not produce exactly the production artefact.
The Docker build in CI does, and that is the artefact that ships.
**Date** 2026-08-25

---
## ADR-014 — Registration rate limit raised to 10/hour per IP, with a per-address limit added
**Context** The first policy was 3 registrations per hour per IP.
**Options** (a) keep 3/IP; (b) 10/IP plus 3 per email address.
**Chosen** (b).
**Reason** An agency or a shared office behind one NAT legitimately creates several accounts in an
hour, and locking out real customers is a worse failure than the abuse a tight IP limit prevents.
The abuse pattern that matters — repeated attempts against one address — is caught more precisely
by the per-address limit, and bulk signup is already gated by email verification.
**Tradeoffs** Slightly more headroom for scripted signups from one host. Acceptable: those accounts
cannot do anything until an address is verified.
**Date** 2026-08-25

---
## ADR-015 — `gen_random_uuid()` column defaults behind application-generated UUIDv7
**Context** With no column default, `id` is a required field in Prisma's generated input types, so
every create — including nested relation writes — would have to pass one explicitly.
**Options** (a) no default, pass ids everywhere; (b) `gen_random_uuid()` default plus a Prisma
client extension that fills in a v7 id before every create.
**Chosen** (b).
**Reason** The extension means no caller can forget, which is the actual risk. The column default
makes `id` optional in the generated types (so nested writes compose) and acts as a last-resort
safety net rather than the normal path.
**Tradeoffs** A create that somehow bypasses the extension gets a v4 id, losing index locality but
staying correct. The extension is applied at `$allModels`, so that path does not exist in practice.
**Date** 2026-08-25
