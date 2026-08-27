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

---
## ADR-016 — Widget configuration stored as one validated JSON document
**Context** The widget has roughly forty settings today and will have far more: colours, placement,
behaviour, copy, and two fully data-driven form definitions.
**Options** (a) a `widget_settings` table with a column per setting; (b) an entity-attribute-value
table; (c) a single `jsonb` column validated by a Zod schema.
**Chosen** (c), with `widgetConfigSchema` in `@smartchat/validation` as the contract and a `version`
integer that increments on publish.
**Reason** The config is always read and written whole and is never queried by individual field, so
a column per setting buys nothing and costs a migration per setting. Every field has a default, so
a config written by an older release is upgraded on read — which is what makes the schema additive.
**Tradeoffs** No database-level constraint on the contents. Mitigated by parsing on read *and*
write: an invalid config is rejected at the API and, if one somehow existed, `parseWidgetConfig`
falls back to defaults rather than shipping something the widget cannot render.
**Date** 2026-08-25

---
## ADR-017 — Draft and published configuration are separate
**Context** The builder autosaves. Autosaving directly to the live config would mean a customer
dragging a colour slider is changing their production website in real time.
**Chosen** `config` (live) and `draft_config` (unpublished). The builder writes only the draft;
Publish promotes it and increments the version.
**Reason** It makes autosave safe, which in turn makes the builder feel like a design tool rather
than a form. It also gives "discard my changes" a real meaning.
**Tradeoffs** Two copies of the document, and a publish step customers must not forget. The
dashboard shows an explicit unpublished-changes banner for exactly that reason.
**Date** 2026-08-25

---
## ADR-018 — The builder's live preview is the real widget, not a replica
**Context** A preview that reimplements the widget's markup in the dashboard drifts from the real
thing within a release or two, and the drift is invisible until a customer complains.
**Options** (a) a React replica of the panel inside the dashboard; (b) embed the real panel and
push the unpublished config into it over the existing postMessage bridge.
**Chosen** (b). The panel accepts `?preview=1` and renders from a `sc:host:preview-config` message
instead of bootstrapping a visitor.
**Reason** Preview and production cannot disagree, because they are the same code. It also means
preview creates no visitor, no session and no page view — a customer trying out colours does not
pollute their own analytics.
**Tradeoffs** The preview needs the widget host to be reachable from the browser, and it exercises
the bridge on a path visitors never take. Both are acceptable; the second is arguably a feature,
since the bridge is now exercised every time somebody opens the builder.
**Date** 2026-08-25

---
## ADR-019 — Runtime URLs substituted into static widget assets at container start
**Context** `loader.js` and the panel bundle are static files that must know where the API and
realtime gateway are, and that differs per environment.
**Options** (a) bake the URLs in at build time; (b) fetch a runtime config file before doing
anything; (c) ship literal placeholders and substitute them in the image's entrypoint.
**Chosen** (c).
**Reason** (a) means one image per environment and no way to promote an artefact from staging to
production. (b) adds a network round trip to every page load on every customer site, which is
exactly where we can least afford one. (c) costs a `sed` at container start and nothing at runtime.
**Tradeoffs** A silent failure mode if the entrypoint does not run. Closed by making the entrypoint
exit non-zero when it finds no placeholders — a misbuilt image fails to start rather than pointing
customers' visitors at localhost.
**Date** 2026-08-25

---
## ADR-020 — A hand-rolled signed token for visitors, not JWT
**Context** The widget needs a bearer credential identifying a visitor.
**Options** (a) JWT via a library; (b) a minimal signed token of our own.
**Chosen** (b): `base64url(payload).base64url(hmac-sha256(payload))`, verified signature-first.
**Reason** JWT carries its algorithm inside the token, which is the root of the `alg: none` and
RS256/HS256 confusion families, and we gain nothing from that flexibility for a token only we issue
and only we verify. This format has no negotiable algorithm and no header to attack; there is a
test asserting the payload contains no `alg` field at all.
**Tradeoffs** Not interoperable with JWT tooling. We do not need it to be. Rotation is handled by
the `v` field, and expiry by `exp`.
**Date** 2026-08-25

---
## ADR-021 — Retry-safety is handled outside the transaction, not inside it
**Context** A message carries a client-generated `clientMessageId`, and a unique index on
`(conversation_id, client_message_id)` is what makes "resend after a lost acknowledgement" safe.
The first implementation caught the unique violation *inside* the transaction that had just
reserved the sequence number, read the existing row, and returned it.
**Problem** That can never work on Postgres. A constraint violation aborts the entire transaction,
and every subsequent statement on that connection fails with `25P02 current transaction is aborted,
commands ignored until end of transaction block`. The recovery read was itself the second statement,
so every retry returned a 500 instead of the stored message. The realtime E2E script caught it; no
unit test could have, because a mock that does not model transaction poisoning happily passes.
**Chosen** The repository does the happy path only and lets the violation escape. The service wraps
it: a pre-check read before the transaction (the ordinary case — a client resending after a lost
ack, which now never touches the sequence counter at all), and a recovery read after the
transaction has rolled back (the race — two retries in flight, where the pre-check found nothing).
**Reason** The rollback also returns the reserved sequence number, so the counter needs no repair;
the old code's manual `decrement` was both unreachable and wrong.
**Tradeoffs** One extra indexed read per message that carries a client id. That index exists
anyway, and correctness on retry is the entire point of the field.
**Date** 2026-08-25

---
## ADR-022 — The inbox learns presence from a snapshot, not only from events
**Context** Visitor presence reaches the dashboard as `presence:visitor` events. An agent who opens
the inbox after a visitor has already connected receives no event, so the visitor appeared as
"Offline" while they were sitting in the chat.
**Chosen** `inbox:subscribe` answers with the gateway's current view of every subscribed property's
visitors, and the dashboard treats that answer as the complete truth for those properties.
**Reason** Showing "Offline" for someone who is online is worse than showing nothing: an agent
decides whether to reply now or send an email based on it. Presence already lives in Redis with a
TTL, so the snapshot is a read the gateway can always answer.
**Tradeoffs** A snapshot replaces rather than merges, so a `presence:visitor` event that arrives
in the same millisecond as the ack could be overwritten. The heartbeat re-asserts within
`PRESENCE_HEARTBEAT_SECONDS`, and the cost of being briefly wrong in that direction is one stale
dot rather than a missed conversation.
**Date** 2026-08-25

---
## ADR-023 — The host replays `open` when the panel signals ready
**Context** The panel iframe is created lazily, by the first click on the launcher. The loader then
posted `open` immediately — to a frame that had not loaded yet, so the message was dropped. The
panel therefore believed it was closed for the whole session.
**Problem** Two visible consequences: the unread badge counted messages the visitor was looking at,
and the panel never sent a read receipt, so `visitor_unread_count` never returned to zero.
**Chosen** The loader replays the current open state when the panel sends `ready`.
**Reason** `ready` is the only moment the host knows the panel is listening. Replaying state there
also makes a panel reload recover correctly, which the original code did not.
**Tradeoffs** None material; the message is idempotent.
**Date** 2026-08-25

---
## ADR-024 — Inbox search covers message bodies, backed by trigram indexes
**Context** Agents look for a conversation by what was said in it at least as often as by who said
it. The first implementation searched only the subject and the visitor's name and email, which are
exactly the fields that are most often empty.
**Chosen** Search matches the subject, the visitor's name, the visitor's email, and the body of any
non-deleted message in the conversation. Every one of those columns has a `gin_trgm_ops` index.
**Reason** A substring match cannot use a B-tree, so without trigram indexes searching `messages` —
the largest table in the system — is a sequential scan across the whole tenant's history. `pg_trgm`
was already enabled in the first migration for exactly this.
**Tradeoffs** The indexes are single-column rather than `(account_id, column)` composites, because
Prisma cannot express a `btree_gin` composite containing a uuid and a raw-SQL migration for it would
be silently dropped by the next `prisma migrate dev`. The planner combines the trigram bitmap with
the existing `account_id` indexes instead, so the tenant filter still happens before rows are read;
the cost is a slightly wider bitmap. Choosing the expressible form over the marginally faster one
removes a real footgun.
**Note** Search reaches internal notes. Agents can already read every note in a conversation they
can open, and the tenant and assignment scopes are applied before the search, so this exposes
nothing new — it just stops the search lying about what is in the record.
**Date** 2026-08-25

---
## ADR-025 — Conversation actions are not optimistic
**Context** Assigning, closing, reopening, re-prioritising and tagging all have an obvious
optimistic implementation: change the row, fire the request, roll back on failure.
**Chosen** None of them are optimistic. The control disables while the request is in flight and the
row is rewritten only from the server's answer.
**Reason** These are not private UI state; they are decisions other agents act on. Showing a
conversation as assigned to someone, then silently un-assigning it a second later when the server
refuses, is worse than a moment of latency — an agent may already have moved on believing it was
handled. Messages *are* optimistic, because the sender is the only person who sees a pending bubble.
**Tradeoffs** A visible pause on a slow connection. Accepted deliberately.
**Date** 2026-08-25

---
## ADR-026 — The open conversation is held outside the list
**Context** The thread was rendered by looking the selected id up in the loaded list. Closing a
conversation removes it from the "Open" filter, so the moment an agent clicked Close the entire
thread vanished — no confirmation of what had happened, and no way to reopen it without going to
find it again in the closed list.
**Chosen** The open conversation is its own piece of state. The list is consulted first so live
updates still flow into it, but if the list no longer contains it, the held copy keeps it on screen
until the agent selects something else.
**Reason** A filter describes what an agent is browsing, not what they are currently working on.
**Tradeoffs** Two places hold a conversation, so every mutation updates both. Contained to one
helper.
**Date** 2026-08-25

---
## ADR-027 — A visitor can end their own chat, and ending is a message
**Context** Only agents could close a conversation. A visitor who was finished had no way to say
so, and the panel's only closed-state affordance was a banner reading "This conversation was closed.
Send a message to reopen it." next to a composer that was disabled — an instruction the product
could not carry out.
**Chosen** The panel offers "End chat" in the header, behind an inline confirmation. Ending is
recorded as a **system message** in the transcript rather than only flipping a flag.
**Reason** A status change is something both sides need to see now and still see tomorrow. As a
message it gets a sequence number, rides the same broadcast as everything else, survives a reload,
and replays correctly through `sync:since` — none of which a boolean on the conversation row gives
you. It also means the transcript is honest about what happened and when, which matters as soon as
anybody reads one back.
**Wording** The row stores a machine-readable `metadata` bag (`kind`, `by`, `actorName`) and an
English `body` as an export fallback. Each client writes its own copy from the metadata, so the
visitor reads "You ended this chat" where the agent reads "The visitor ended this chat" — the same
event told from each side, and no stored English to re-translate later.
**Counters** System messages touch no unread counter. An unread badge means "somebody said
something you have not read"; a chat ending is not that.
**No visitor-facing reopen** A visitor who wants to talk again presses "Start a new chat", and
`startOrContinue` gives them a fresh conversation because the last one is closed. Reopening is an
agent's decision about their own queue.
**Tradeoffs** One extra row per status change. Worth it for a transcript that explains itself.
**Date** 2026-08-25

---
## ADR-028 — Agent names are resolved from the record, not only from the sender's context
**Context** `senderName` was populated from the sending agent's own request context. That worked
for live delivery and for nothing else: reload the widget and every agent reply became anonymous.
Worse, the context never carried a name at all, because the membership lookup behind it did not
load the user — so in practice visitors never saw who they were talking to.
**Chosen** The membership query selects the user's name, and message history joins the sender
(display name, falling back to the user's name). The live sender's context still wins when present;
the relation is the fallback that makes a replayed transcript read like the live one.
**Reason** "Who am I talking to" is not a rendering detail. A support conversation where the other
party is nameless reads as automated, and a transcript that loses the name on reload is worse than
one that never had it.
**Tradeoffs** One join on the message list query, selecting two columns. Only the name is selected:
a message payload has no business carrying the rest of a user row.
**Date** 2026-08-25

---
## ADR-029 — An agent's inbox is "mine, and the queue"
**Context** An `agent` holds `CONVERSATION_VIEW_ASSIGNED` and not `CONVERSATION_VIEW_ALL`. The list
query read that as "assigned to me", full stop.
**Problem** A conversation is assigned to nobody the moment it arrives. So on a team of agents with
no manager online, every incoming chat was invisible to precisely the people whose job is to answer
it. Worse, the two guards disagreed: `assertCanSee` had always allowed the unassigned queue, so an
agent could open a conversation by id that the list refused to show them.
**Chosen** `CONVERSATION_VIEW_ASSIGNED` means *assigned to me, or to nobody*. An explicit
`assigned=` filter still narrows within that, and asking for another agent's queue is allowed to
ask and guaranteed to be empty.
**Reason** A queue somebody can claim from is the whole point of the permission. The alternative -
giving every agent `VIEW_ALL` - would have widened access to solve a bug in a list query.
**Also fixed here** The visibility clause and the search clause were both disjunctions written as
`OR` keys on the same Prisma `where` object, where the second silently replaces the first. Left
alone, adding a search term would have turned "my queue AND matching" into "anyone's queue OR
matching" - a search that widens visibility. They now compose under `AND`, with a test asserting a
search cannot reach another website's conversations.
**Date** 2026-08-27

---
## ADR-030 — Invited users exist before they accept, with no password
**Context** An invitation has to be attachable to a membership row so the team list can show
somebody as pending, but the invited address may never have had a SmartChat login.
**Chosen** The user row is created at invitation time with `password_hash` NULL, and the membership
is created with `invited` status. Accepting sets the password (if they need one) and flips the
membership to `active`.
**Reason** The alternative - keeping the invitation only in the token table - means the team page
cannot show pending people without a second source of truth, and accepting has to create a
membership at exactly the moment it is least convenient to fail.
**Safety** `verifyPassword` returns false for a null hash, so an un-accepted account can never be
signed into, and the login route treats it identically to a wrong password - otherwise the sign-in
form becomes a way to discover who has been invited. There is a smoke check for this.
**Tradeoffs** A user row exists for somebody who may never accept. Revoking soft-deletes the
membership and invalidates the token; the orphan user row carries nothing but an address.
**Date** 2026-08-27

---
## ADR-031 — Permissions reach the browser through `/auth/me`
**Context** The dashboard was deciding what to render from `Boolean(user)`, so an agent was shown
an "Invite someone" button that answered 403, and a bare permission error where a page should have
been.
**Chosen** `/auth/me` returns the caller's permissions and role for the active account, and the
auth context exposes `can(permission)`.
**Reason** It had to be `/auth/me` rather than `/account`: `/account` requires `ACCOUNT_VIEW`, which
an agent does not have, so the one endpoint every signed-in person can reach is the only one that
can carry this. Switching accounts re-reads it, because permissions are per-account.
**Boundary** This is for *rendering*. Every route re-derives the same permissions server-side from
the membership; a client that lies to itself here gains nothing but a button that fails.
**Date** 2026-08-27

---
## ADR-032 — A rejected session takes its cookie with it
**Context** The dashboard middleware routes on the session cookie being *present* - it runs at the
edge and cannot validate one. A cookie the API had already rejected therefore stranded the person:
every page said "your session has expired, sign in again", and `/login` redirected them straight
back out because the cookie was still there. The cookie is HttpOnly, so the browser could not drop
it either.
**Chosen** The API clears the auth cookies at the moment it rejects a session, and the client
redirects to `/login?expired=1`.
**Reason** The server is the only party that can end this, and the rejection is the moment it knows.
**Date** 2026-08-27

---
## ADR-033 — The widget entrypoint tolerates a restart
**Context** The widget image ships with placeholder URLs that its entrypoint substitutes at
container start, and fails loudly if it finds none - a guard against a build whose define step
silently stopped working (ADR-019).
**Problem** A container that is *restarted* rather than recreated keeps the filesystem it wrote on
its first boot. The placeholders are gone and the real URLs are in their place: a healthy widget,
which the guard killed on every subsequent start. `docker compose restart widget` took the widget
down until somebody recreated the container.
**Chosen** The error is raised only when there is neither a placeholder to substitute nor an
already-substituted URL to find.
**Reason** "No placeholders" was never the condition worth failing on; "nothing that looks like a
configured bundle" is.
**Date** 2026-08-27
