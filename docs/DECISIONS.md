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
matching" - a search that widens visibility. They now compose under `AND`.
**On proving it** The first test written for this could not have caught it: it searched for a
conversation on *another* website, which the separate property `restriction` key excludes whether or
not the two `OR` keys collided. The case that actually exercises the collision is a conversation on
the agent's **own** website that is assigned to a colleague. That test now exists, and it was
verified by negative control - the compiled query was reverted to the two-`OR`-key form inside the
running container, at which point the new check failed and the old one still passed. A regression
test nobody has watched fail is a comment, not a test.
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
**Guarded by** `scripts/e2e-team.mjs` asserts the payload itself - an agent is not told they may
invite or read the member list, an owner is told both, and each is told which role they hold. Trim
the payload and the suite fails rather than the UI quietly reverting to an owner's toolbar.
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

---
## ADR-034 — `ON DELETE SET NULL` across a tenant-composite key
**Context** Tenant-owned references are composite: `(account_id, assigned_member_id)` pointing at
`account_members(account_id, id)`, so a row can never be paired with a member from another account.
Several of those columns are nullable, and the relation is declared `onDelete: SetNull`.
**Problem** Prisma emits a bare `ON DELETE SET NULL`, which tells Postgres to null *every* column in
the key - including `account_id`, which is `NOT NULL`. Deleting a referenced row therefore does not
null the reference; it fails outright. Confirmed against the real database:
`null value in column "a" of relation "t_child" violates not-null constraint`, with the context line
showing `SET "a" = NULL, "b" = NULL`.
**Chosen** Postgres 15's column-list form - `ON DELETE SET NULL (assigned_member_id)` - applied to
all six composite keys in a hand-written section of the automation migration.
**Reason** It is what the schema always meant. Prisma cannot express it, but a migration can, and
`prisma migrate dev` reports no drift afterwards (verified). The alternatives were worse: `Cascade`
would delete a member's conversations along with the member, and `NoAction` risks failing during an
account cascade, where the order in which Postgres processes the tree is not something to rely on.
**Reachable today?** No - members and departments are soft-deleted, so nothing hard-deletes a
referenced row. This repairs a fault that would have surfaced the first time somebody implemented a
GDPR erase, which is the worst possible moment to discover it.
**Date** 2026-08-27

---
## ADR-035 — An unknown fact never matches, not even a negative condition
**Context** A trigger condition reads one field from a snapshot the gateway assembles. Some fields
are legitimately unknown: a visitor who arrived by typing the address has no referrer, and a socket
that connected before the first page report has no URL.
**Problem** `not_contains` reads as though it should be true when the value is missing - we have no
URL, so it certainly does not contain `/checkout`.
**Chosen** A condition whose fact is null evaluates false, whatever the operator.
**Reason** The honest reading of a missing value is "we do not know", and a rule that messages
somebody *because* a fact was absent is acting on nothing. The failure direction matters here:
staying quiet when we are unsure costs a missed greeting, while the opposite interrupts people at
random and looks broken from the outside. Absence of information is not evidence.
**Date** 2026-08-27

---
## ADR-036 — Pre-chat does not gate a conversation; the offline form does
**Context** Both forms are configured the same way, with required and optional fields, and both are
re-validated server-side against the property's own field list.
**Chosen** A pre-chat answer that is missing or fails validation is dropped, and the conversation
starts anyway. An offline submission with a missing required answer is refused.
**Reason** They are not the same situation. Pre-chat sits in front of a live conversation: refusing
to let somebody ask for help because they skipped a field is the wrong failure direction for a
support product, and the agent can simply ask. An offline message is the person's only channel - one
with no way to reply to it helps nobody, so that form is worth being strict about.
**Also** Unknown keys are dropped from both rather than stored. The widget renders the configured
fields, but it runs on somebody else's page and the request can be replayed by hand; without this a
conversation record is a place to park arbitrary visitor-controlled data.
**Date** 2026-08-27

---
## ADR-037 — What the visitor was shown is what the server validates against
**Context** The widget row is created lazily, so a property can serve a widget before that row
exists. `findPublishedByPublicId` has always handled this by serving `DEFAULT_WIDGET_CONFIG`.
**Problem** The new server-side form validation looked the config up separately and treated "no
widget row" as "no configuration", which discarded every pre-chat answer and refused every offline
message on any property whose widget had never been saved - which is every brand-new property. Found
by the phase 6 suite, not by reasoning: the visitor was shown a default pre-chat form and the answers
arrived as `{}`.
**Chosen** The visitor-facing config lookup falls back to the same defaults, and returns null only
when the property genuinely does not exist.
**Reason** There must be one answer to "what did we ask this person?". Two lookups that disagree
about it will always disagree in the direction that throws the visitor's input away.
**Date** 2026-08-27

---
## ADR-038 — A firing is claimed before anything is sent
**Context** "Once per visit" and "once per person" have to hold across gateway processes: the same
visitor's socket could be on any instance, and a proactive message that arrives twice reads as a
malfunction.
**Chosen** Firing is a row in `trigger_firings` guarded by `UNIQUE (trigger_id, dedupe_key)`, and it
is inserted *before* the message is sent. If the insert loses, this process stops. If the actions
then fail, the claim is deleted again.
**Reason** A read-then-act check is a race with no upper bound on how often it loses. Postgres
treats nulls in a unique index as distinct, so the same index enforces at-most-once for the two
capped frequencies and imposes nothing on `every_time` - which is bounded by a per-visitor cooldown
instead. Releasing the claim on failure matters because a visitor should not lose their only
greeting to a transient database error.
**Date** 2026-08-27

---
## ADR-039 — Time-based rules live on the socket, not in a queue
**Context** "After 30 seconds on the site" needs something to wake up 30 seconds later. BullMQ is
already in the stack and was the obvious home for it.
**Chosen** A timer held by the visitor's own socket, cleared on disconnect.
**Reason** A delayed job would happily message somebody who closed the tab twenty seconds ago, and
"we noticed you have been reading for a while" is only true while they are still reading. Making the
pending rule die with the connection is not an optimisation, it is the correct behaviour. The delay
is measured from when the *session* started rather than from when this socket connected, so a
visitor who navigates does not reset every clock. Pending timers are capped per socket, because a
socket is something anybody on the internet can open.
**Date** 2026-08-27

---
## ADR-040 — Visitors are told whether anybody is available, and nothing more
**Context** The panel decided its online indicator - and would have decided whether to show the
offline form - from whether its socket was connected.
**Problem** Those are different facts. A connected socket with nobody on the other end is exactly
the situation the offline form exists for, and telling a visitor they are talking to an online team
when they are not is the kind of small lie that becomes a complaint about response times.
**Chosen** Agent presence changes recompute `hasAvailableAgent` for the account and emit one
boolean to the `/visitor` namespace room for that account. Visitors join a room named after the
account in their own namespace; nothing about which people are online crosses that boundary.
**Reason** It is a property of the whole team, so it has to be recomputed rather than inferred from
the one member whose status changed.
**Date** 2026-08-27

---
## ADR-041 — Conditions and actions are JSON, parsed on write and on read
**Context** A rule is always read whole, written whole, and never queried by its contents.
**Chosen** Two `jsonb` columns, with `@smartchat/validation` as the only way in or out.
**Reason** A join table would buy nothing and cost a multi-row write on every edit. What keeps JSON
honest is that it is never trusted: an action shape that no longer exists cannot be stored, and one
that survived a downgrade is dropped at read rather than half-executed. A partial update is merged
into the stored rule and re-validated *whole*, so changing only the event cannot leave a rule that
waits forever or tags a conversation that will never exist.
**Date** 2026-08-27

---
## ADR-042 — Shortcuts are account-wide and shared
**Context** Saved replies could be scoped per property, per member, or both.
**Chosen** One flat set per account, `UNIQUE (account_id, key)`.
**Reason** A saved reply is a team asset. Per-agent private shortcuts would mean two people typing
`/refund` and getting different text, which is exactly the inconsistency the feature removes. It
also avoids a real trap: scoping by a nullable `property_id` cannot be made unique in Postgres
without a partial index, because multiple nulls are distinct - so two account-wide shortcuts could
share a key and the picker would show both.
**Expansion happens in the composer**, not on the server: the agent sees and can edit the final
wording before sending. A placeholder we cannot fill is left visible rather than blanked, because an
agent who can see `{{visitor.email}}` in the box will fix it, and one who sees "We will write to ."
will not.
**Date** 2026-08-27

---
## ADR-043 — S3 request signing is written here, not imported
**Context** Attachments need three things from object storage: a URL a browser can PUT to, a read
of the object so the server can check what it actually is, and a delete for the ones it refuses.
**Chosen** SigV4 implemented in `packages/core/src/storage/sigv4.ts` - about seventy lines of
HMAC-SHA256 over a canonical string - rather than `@aws-sdk/client-s3`.
**Reason** The SDK is the right default when a project uses S3 broadly. This one uses three
operations against one bucket, and the SDK brings roughly two hundred packages and twenty megabytes
into two production images to provide them. The primitive is the same one the visitor token already
uses.
**Why this is safe to hand-roll where a crypto primitive would not be** A wrong signature fails
loudly and immediately with `SignatureDoesNotMatch`. There is no quiet-wrongness mode where files
are stored insecurely without anybody noticing - either the upload works or it does not. It is
verified against the real MinIO by `scripts/e2e-files.mjs`, which uploads, downloads and compares
the bytes, rather than by inspection.
**Honest disclosure** The install of the SDK also stalled repeatedly in this environment, which is
what prompted the question. That is not why the answer came out this way, but it is why the
question was asked, and a reader deserves to know that.
**Revisit when** Multipart uploads, cross-region replication, or anything else that needs more of
S3 than a single PUT and GET. At that point the SDK earns its size.
**Date** 2026-08-27

---
## ADR-044 — What a file is, is decided by reading it
**Context** A browser sends a `Content-Type` and a file name. Both are chosen by whoever is
uploading.
**Chosen** Neither is stored. After the object is uploaded the server reads its first bytes and
matches them against a closed allow-list of formats; the type and extension recorded on the row are
the ones that check produced. Anything unrecognised is deleted from the bucket and the row is marked
rejected.
**Reason** This is the entire difference between an upload feature and an arbitrary file host. A
PHP script called `photo.png`, declared as `image/png`, is recognised as text - and served as
`text/plain`, which nothing will execute for us. An ELF or PE binary matches nothing and is refused
outright.
**Also** The name is forced to end in what the bytes really are, so a file can never be handed back
under a description that misrepresents it. Bidi override characters are stripped from names, because
`report<U+202E>gnp.exe` renders as `report.exe.png` in a file list and somebody clicks it.
**Date** 2026-08-27

---
## ADR-045 — A storage key contains nothing a client chose
**Context** The key has to be fixed when the upload is signed, which is before the bytes exist.
**Chosen** `a/{accountId}/{propertyId}/{attachmentId}` - three uuids this service generated, and no
extension. The builder asserts each one is a uuid and throws otherwise.
**Reason** There is no traversal to defend against if nothing traversable ever reaches the key.
The extension is left out for a subtler reason: at signing time the only thing known about the file
type is what the client claimed, and a key that ends in `.png` would be a stored path asserting
something nobody has checked. Nothing is lost - a download URL pins the content type and file name
into its own signature, both taken from the verified row.
**Date** 2026-08-27

---
## ADR-046 — Bytes never pass through the API
**Context** An upload could be proxied through the service, or sent straight to the store with a
signed URL.
**Chosen** Straight to the store. The service signs a target, the browser PUTs, and then tells the
service it is done - at which point the object is read back and verified.
**Reason** Proxying would put a twenty-five megabyte body through an API process for no security
benefit, because the verification happens after the write either way. What the signed URL grants is
deliberately narrow: one method, one key, a few minutes, no read and no listing. Handing that to a
visitor's browser on somebody else's website gives that page no reach beyond the single object we
chose for it.
**The gap this leaves, and how it is closed** The store enforces nothing on our behalf - a client
that declared one megabyte can upload forty. So the size is measured again from the real object at
confirmation, not trusted from the declaration, and an object over the limit is deleted. Tested.
**Date** 2026-08-27

---
## ADR-047 — A contact is a person; a visitor is a browser
**Context** The same human writes in from a laptop and a phone, on two of an account's websites.
That is four `Visitor` rows and one person.
**Chosen** A `Contact` at account level, joined to visitors the moment an email address appears -
and joined *only* then.
**Reason** An email is the one identifier a support product can actually rely on. "These four
visits are the same person, because they all gave us this address" is a claim we can show and
defend; "these visits look similar" is a guess dressed up as a fact, and an agent who acts on it
will eventually tell somebody about a conversation that was not theirs.
**Where the join happens** In `VisitorRepository.identify`, which is the one function in the system
that ever writes an email onto a visitor - pre-chat, the offline form and `SmartChat('identify')`
all arrive there. Doing it in the callers would mean three places to keep in step, and eventually
one of them forgets.
**Scope** A restricted agent sees the whole person but only the parts of their history that
happened on websites they work on. The person is not partitioned; the history is.
**Date** 2026-08-27

---
## ADR-048 — Attachments reference the conversation, not the message
**Context** An attachment belongs to a message. The obvious foreign key is to `messages`.
**Problem** Tenant-scoped references in this schema are composite, so that key would require a
unique index on `messages(account_id, id)` - gigabytes on a table targeting 10^8 rows.
**Chosen** A real composite foreign key to `conversations`, and `message_id` as a plain indexed
column with no constraint.
**Reason** The integrity that matters is already there: deleting a conversation cascades to its
messages and its attachments together, so an attachment cannot outlive the message it belongs to.
The unique index would buy a guarantee we already have, at a cost measured in gigabytes.
**Date** 2026-08-27

---
## ADR-049 — The public help centre is a separate scope with no auth hook
**Context** The reading side of the knowledge base has to be reachable by somebody with no account,
no session and no cookie. The obvious implementation is one set of routes with the authentication
hook made optional on three of them.
**Chosen** Two functions in two Fastify scopes. `kbRoutes` adds `authenticateTenant` as a
`preHandler`; `publicKbRoutes` has no authentication hook at all and is registered separately.
**Reason** "Authentication that usually passes" is one edit away from "authentication that always
passes". If the public routes lived in the authenticated scope with per-route exemptions, then the
day somebody adds a route and forgets the exemption, a public page 401s - annoying but safe - and
the day somebody restructures the hook, every public route inherits a tenant context derived from
an identifier that authorises nothing. Separating the scopes makes the dangerous mistake
structurally impossible rather than merely unlikely.
**What the public scope may do** Read `published` rows for one property, resolved from its public
id through the same lookup the widget uses. It has no write path, and the shapes it returns are
built by hand so nothing internal can be added to them by adding a column.
**Date** 2026-08-30

---
## ADR-050 — Article bodies are escaped at render, not sanitised at write
**Context** Authors write markdown. Markdown permits raw HTML, and an author is a person we trust
to write documentation, not a person we should trust to run code in a stranger's browser.
**Rejected** Sanitising on the way in with a tag allow-list. It destroys the record of what the
author actually wrote, it has to be re-run over stored rows whenever the allow-list changes, and
every sanitiser is a block-list wearing a better hat - the bypasses are found in the parser, not in
the list.
**Chosen** Store the body byte-for-byte. Render it through a small renderer that escapes **every**
character of the author's text first, and only then inserts our own tags around the escaped text.
**Reason** By the time any tag exists in the output, the author's angle brackets are already
entities. There is no allow-list to get wrong because no author-supplied tag is ever constructed.
The attack surface shrinks to one place - our own tag construction - which is a hundred lines and
is unit-tested against the attacks.
**The one place author input reaches an attribute** A link target. That goes through an allow-list
(`http:`, `https:`, `mailto:`, relative), never a `javascript:` block-list: a block-list loses to a
leading tab, to mixed case and to an entity mid-word, and none of those start with `https`.
**Date** 2026-08-30

---
## ADR-051 — A publication date records the first publication, not the last edit
**Context** An article is published in March, corrected in August, and published again.
**Chosen** `published_at` is set on the first transition into `published` and never moved.
`updated_at` records the correction, and the article page shows both when they differ.
**Reason** A reader who sees "published in March" is being told something true and useful: this
guidance is five months old. Resetting the date on every correction would make a five-year-old
article look new after a typo fix, and a help centre accumulates enough of those that nobody trusts
any date on it. Two facts need two columns.
**Date** 2026-08-30

---
## ADR-052 — Deleting a section keeps its articles
**Context** Categories group articles. The referential-integrity default for a parent row that goes
away is to take its children with it.
**Chosen** Deleting a category nulls `category_id` on its articles inside the same transaction and
soft-deletes the category. The articles stay published, at their own addresses.
**Reason** A section is a filing decision, not ownership. Nobody who tidies up their sections
expects a month of writing to disappear with them, and the recovery from that mistake - restore
from backup, in a hurry, with an audience - is out of proportion to the tidying. The confirmation
dialog states the outcome and counts the surviving articles, so the safe behaviour is also the
visible one.
**Date** 2026-08-30

---
## ADR-053 — The help centre is server-rendered; the dashboard is not
**Context** Every other page in `apps/web` is a client component that fetches from the browser,
because every request carries the reader's session.
**Chosen** The two `/help` routes are server components that fetch through `INTERNAL_API_URL`.
**Reason** A help centre has no reader identity to carry, so the reason for client fetching does
not apply - and three things follow from rendering on the server that matter for this page in
particular: it arrives complete, it works with JavaScript switched off, and a search engine can
read it. Publishing help articles that a search engine cannot read defeats most of the point of
publishing them.
**Consequence** The web container needs an address for the API that exists inside the network,
because `localhost` there is the web container. `INTERNAL_API_URL` defaults to `http://api:3001`
and falls back to the browser-facing `API_URL` so `next dev` on a laptop is unaffected.
**Date** 2026-08-30

---
## ADR-054 — A dialog holds its close handler in a ref, not in a dependency array
**Context** `Modal` runs one effect on open: it remembers what was focused, locks background
scrolling, installs the Escape and Tab-trap handler, and moves focus to the first field. The effect
listed `onClose` among its dependencies, which is what the lint rule asks for.
**The bug** Every caller passes an inline arrow - `onClose={() => setDraft(null)}` - so `onClose`
is a new function on every render, and every keystroke in a dialog re-renders the parent. The
effect therefore tore down and set up again on each character, and its setup moves focus to the
first field. Typing into the third field of a dialog put two characters there and the rest of the
sentence into the first one. Every modal in the dashboard had it.
**Chosen** Keep the latest `onClose` in a ref that a tiny unconditional effect refreshes, and
depend only on `open`.
**Rejected** Asking every caller to wrap its handler in `useCallback`. That moves a correctness
requirement onto ten call sites and is one forgotten wrapper away from returning, silently.
**How it was found, and how it stays fixed** In a browser, by typing a long article body into the
editor and watching it land in the title field. No server-side test could see it. It is pinned by
`modal.test.tsx`, which was confirmed to fail on the old dependency array before the fix was
restored.
**Date** 2026-08-30

---
## ADR-055 — Ticket message visibility has no default, anywhere
**Context** A ticket message is either sent to the customer or kept inside the account. Every
schema in this codebase gives sensible defaults to optional fields.
**Chosen** `visibility` is required in `replyToTicketSchema`, in the service signature and in the
route. There is no default at any layer.
**Reason** Both possible defaults are unacceptable in different directions. Defaulting to `public`
means the day a caller forgets the field, an agent's private note about a customer is emailed to
that customer - a failure no apology repairs, and one that is invisible until it has happened.
Defaulting to `internal` means replies silently never leave, and support quietly stops working
while every screen says it is fine. When both defaults are wrong, the field is not optional.
**Supporting decisions** The send branch sits four lines below the insert in one method, so nobody
changes one without seeing the other. The composer is a permanently visible two-button choice
rather than a checkbox. The e2e suite asserts *absence* - it counts the mailbox before and after a
note and greps every delivered message for its words - because a test that trusts the flag tests
nothing.
**Date** 2026-08-30

---
## ADR-056 — Ticket numbers come from a counter on the account row
**Context** Tickets need a short number people can quote. UUIDs cannot be read down a phone.
**Rejected** `SELECT max(number) + 1`: two simultaneous creations read the same maximum and both
insert it. The unique index then fails one of them, so the visible symptom is an intermittent 500
under exactly the load where support matters most.
**Rejected** A Postgres sequence per account: sequences are not transactional, so a rolled-back
ticket burns a number - and "gapless" is the property that makes a missing number worth
investigating rather than shrugging at.
**Chosen** `UPDATE accounts SET ticket_seq = ticket_seq + 1 ... RETURNING`, inside the ticket's own
transaction. The row lock serialises concurrent creations in the same account, and a rollback
returns the number.
**Cost, stated plainly** Ticket creation in one account is serialised on one row. For a support
queue that is nothing; if an account ever creates thousands of tickets a second, this is the line
to revisit, and it is one function.
**Date** 2026-08-30

---
## ADR-057 — No Reply-To unless there is a mailbox behind it
**Context** Ticket email invites a reply. SmartChat has no inbound mail path, and building one is
not in this phase.
**Rejected** A `Reply-To` at an address we own but do not read. Every reply a worried customer
writes vanishes, and they conclude they were ignored. That is worse than telling them not to reply.
**Rejected** Faking it - a reply address that silently forwards nowhere, or a "we'll get back to
you" that nothing implements.
**Chosen** A per-website `support_email` that the account sets to *their own* mailbox. When it is
set, ticket email carries it as `Reply-To` and the footer says replies reach them there - true,
because it is their inbox. When it is not set, no `Reply-To` header is written and the footer says
the mailbox is not monitored.
**The extension point** Every ticket email carries `X-SmartChat-Ticket` and a `[#number]` subject
prefix, so inbound ingestion, when it exists, resolves a reply to its ticket without guessing.
**Date** 2026-08-30

---
## ADR-058 — Every ticket email gets a delivery row, written before the job
**Context** "Did the customer ever hear back?" was answerable only by asking the customer. A queued
job that fails is a line in a log nobody reads, and a provider silently rejecting a whole domain
looks exactly like a quiet week.
**Chosen** An `email_deliveries` row written *before* the job is enqueued, carrying its id; the
worker updates it to `sent` or `failed`.
**Reason** The row is created by the same request that created the ticket, so a queue that is down
produces a `queued` row that never moves - a visible, greppable alarm - rather than nothing at all.
**Ordering, inside the worker** Send first, then record. A crash between the two leaves a row
saying `queued` for a message that was sent, which somebody can investigate; the opposite order
leaves a row saying `sent` for a message that never left, which nobody would ever think to check.
And recording never throws: the email has already gone, so failing the job would retry a delivered
message and send it twice.
**What is deliberately excluded** Password resets and verification emails get no row. Their
subjects carry tokens, and a table people browse is not where tokens belong.
**Date** 2026-08-30

---
## ADR-059 — Ticket email wears the account's name, not ours
**Context** These are the only messages this product sends to somebody who is not its user.
**Chosen** Ticket email carries the account's name and its own layout. The product's own shell is
used only for the assignment notification, which goes to an agent.
**Reason** The recipient is a customer of our customer. They have never heard of SmartChat, and a
support reply arriving under an unfamiliar name reads as phishing - which is both a worse
experience and a worse security posture, because it teaches people that odd-looking support mail is
normal.
**A related restriction** The assignment notification carries the subject and the requester but not
the customer's message. A notification that reproduces customer data into a mailbox we do not
control is a copy of that data somewhere nobody is auditing.
**Date** 2026-08-30

---
## ADR-060 — An offline message with no address does not become a ticket
**Context** The offline form's fields are configurable, so an account can remove the email field.
**Chosen** No address, no ticket. The conversation is still created and still lands in the inbox.
**Reason** A ticket exists to be answered by email. One with nowhere to send an answer can only
ever be closed unanswered, and a queue padded with rows nobody can act on is a queue people stop
trusting. The message is not lost - it is in the inbox, which is where a message from somebody we
cannot email has to be handled.
**Date** 2026-08-30

---
## ADR-061 — `TicketService` for the domain; `ConnectionTicketService` for handshakes
**Context** A class called `TicketService` already existed - it issues single-use WebSocket
connection tickets - and this phase introduced support tickets.
**Chosen** Rename the realtime one to `ConnectionTicketService`, and `container.tickets` to
`container.connectionTickets`.
**Reason** Two unrelated meanings of "ticket" in one codebase is a trap laid for whoever reads it
next, and the one that had to move was the one whose name was already an abbreviation of what it
does. Ten lines across six files, done before either name had a chance to spread.
**Date** 2026-08-30

---
## ADR-062 — Reports are derived from the source tables, not from an event stream
**Context** The conventional analytics design is an append-only event log written alongside every
domain write, rolled up into reporting tables.
**Rejected** The event log. It is a second copy of the truth, written at the same moment as the
first and free to drift from it - a message inserted whose event was dropped, a retry that wrote
the event twice. When the two disagree nobody can say which is right, and the report becomes a
thing people argue about instead of act on.
**Chosen** `DailyMetric` and `DailyAgentMetric`, derived from conversations, messages, tickets and
visitors by a rollup that can be run again at any time.
**Reason** A derived table is a cache, and a cache can be thrown away. A wrong number is fixable
in one command rather than being a permanent scar in an append-only log. What is bought is speed
alone: ninety days of report reads ninety rows instead of aggregating millions of messages, so the
report does not get slower as an account gets busier.
**The cost, stated plainly** Anything not reconstructible from the source cannot be reported on.
"How many people clicked the launcher and did not write" needs an event, and when that question is
asked, an event table is the right answer for that question - not a reason to log everything now
against questions nobody has yet.
**Date** 2026-08-30

---
## ADR-063 — Rollups store sums and counts; averages are computed at read time
**Context** The obvious column is `average_first_response_seconds`.
**Chosen** `first_response_count` and `first_response_seconds`. The division happens once, in the
reader, from the summed numerator and the summed denominator.
**Reason** An average of averages is wrong. A day with one 10-second reply and a day with a
hundred 600-second replies do not average to 305 seconds, and any report spanning more than one
day would be quietly incorrect in a direction nobody can see. Storing both parts makes a week's
figure computable from seven days' rows.
**A related rule** An average over nothing is `null`, never `0`. Zero means "answered instantly",
which is the opposite of "not answered at all", and a dashboard reading `0s` next to a quiet week
is a lie that flatters.
**Date** 2026-08-30

---
## ADR-064 — Days are the account's days
**Context** Bucketing by `date_trunc('day', started_at)` is simpler and uses UTC.
**Chosen** Every bucket is cut with `AT TIME ZONE` using the account's own timezone.
**Reason** "Yesterday" for a team in Auckland is thirteen hours off a UTC day, so half their
morning lands in the wrong bucket. A daily report whose days do not match the days people worked is
worse than no report, because it is wrong in a way that looks right - the totals are plausible, the
shape is plausible, and only somebody reconciling against their own memory would ever notice.
**Consequence** The rollup takes a timezone parameter and the scheduled job asks each account what
"today" means to it, rather than assuming one midnight for everybody.
**Date** 2026-08-30

---
## ADR-065 — Rebuild deletes the range before inserting it
**Context** `INSERT ... ON CONFLICT DO UPDATE` is the usual shape for an idempotent rollup and
avoids a delete.
**Problem** Upsert only touches rows it recomputes. A day whose source data has since gone - a
conversation removed under a retention policy, a website deleted - keeps its old row forever. A
metric that outlives the thing it counted can never be corrected, only explained.
**Chosen** Delete the range, then insert what the source currently says, in one transaction.
**Reason** It makes the rollup a pure function of the source data at the time it runs, which is
the property that makes "run it again" a complete answer to any doubt about a number.
**Date** 2026-08-30

---
## ADR-066 — The chart is hand-drawn SVG
**Context** The reports page needs a daily bar chart.
**Chosen** About fifty lines of SVG: two rectangles per day, a baseline, and a hover target.
**Reason** A charting library brings a layout engine, an animation system and its own event
handling to draw two rectangles - a large amount of third-party surface, and one more thing to keep
current, for a picture we can describe exactly. It also keeps the chart a real element in the page:
selectable, printable and inspectable, rather than a canvas nobody can read.
**When to revisit** The first time somebody asks for a chart type that needs real scales, axes and
tick logic. That is the point where writing it ourselves stops being cheaper.
**Date** 2026-08-30

---
## ADR-067 — Permission is not existence: a filtering property id must be checked against the account
**Context** `requirePropertyAccess` answers one question - "is this member restricted, and if so is
this website on their list". For an unrestricted owner the answer is always yes, for *any* id.
**The bug it hid** That is sufficient when the id comes from a row already loaded under the tenant
predicate: the row proves the property is ours. It is not sufficient when the id is itself the
filter. `WHERE account_id = mine AND property_id = theirs` matches nothing, so a cross-tenant id
produced a cheerful, entirely empty answer - a report of zeros, an empty article list, an empty
ticket queue - with a 200.
**Why it mattered** Nothing leaked; the response is identical to one for an id that never existed.
But the rule this codebase holds everywhere else is that a resource which is not yours answers 404,
and "your report is empty" is a much worse answer than an error for the far more common case:
somebody pasted the wrong id.
**Chosen** `assertPropertyInAccount(db, context, propertyId)` - one lookup for existence in this
account, then the permission check - used at every entry point where a property id arrives as a
filter rather than as a field of a row we already hold: reports, the knowledge base, the ticket
queue.
**How it was found** By an e2e assertion written for the reports phase that expected 404 and got
200. It had been true in two earlier phases and no test had asked.
**Date** 2026-08-30

---
## ADR-068 — Two enum columns were quoted into the database in camelCase
**Context** `Message.senderType` and `TicketMessage.authorType` were declared without `@map`, so
Prisma created `"senderType"` and `"authorType"` while every other column in the schema is
snake_case.
**How it surfaced** Not through Prisma, which quotes its own names and never noticed - but through
the first piece of raw SQL to touch those tables. The analytics rollup failed with
`column "sender_type" does not exist` against a table that plainly has a sender type.
**Chosen** Add the `@map`s and rename the columns.
**Written by hand as a RENAME.** Prisma's own diff expresses a rename as a DROP and an ADD, which
would have silently discarded every existing message's sender. `prisma migrate diff` confirms no
drift afterwards.
**The general lesson** An inconsistency that only one access path can see is not harmless; it is a
trap with a delay on it. The check that would have caught it years earlier is one query:
`SELECT ... FROM information_schema.columns WHERE column_name ~ '[A-Z]'`.
**Date** 2026-08-30

---
## ADR-069 — An API key is another actor on the same routes, not a second API
**Context** The obvious design for a public API is a parallel surface - `/public-api/...` - with
its own middleware, its own authorisation and its own handlers.
**Chosen** The same routes. A key authenticates in `authenticateTenant` alongside the session
cookie, produces an ordinary `TenantContext` with `actorType: api_key`, and goes through the same
permission checks and audit log.
**Reason** `ActorType.api_key` was already in the schema from phase 1, which is the shape of the
answer. Two authorisation paths drift: the day somebody tightens a check on one, the other keeps
the old behaviour, and nobody notices until it matters. One path, with a key simply carrying fewer
permissions into it, cannot drift from itself.
**What follows from it** Anything that needs a member - assigning a conversation to oneself - fails
on its own terms with a key, because `memberId` is genuinely absent rather than faked. And there is
no CSRF check on the key path, which is correct rather than missing: CSRF exists because browsers
attach cookies by themselves, and nothing attaches an Authorization header on anybody's behalf.
**Date** 2026-08-30

---
## ADR-070 — API keys are hashed with SHA-256, not Argon2
**Context** Passwords in this system use Argon2id. The reflex is to use it for keys too.
**Chosen** SHA-256, the same as session tokens.
**Reason** Argon2's cost is the point *for passwords*, because passwords are low-entropy and
guessable and the defence is making each guess expensive. An API key is 256 bits of CSPRNG output:
there is nothing to guess, so the slow hash buys nothing. It costs a great deal, though - it would
run on **every API request**, turning authentication into a denial-of-service amplifier where one
attacker with a stream of invalid keys saturates the CPU.
**The general rule** Slow hashes protect low-entropy secrets. Fast hashes are correct for
high-entropy ones. Applying the password reflex to a random token is a performance bug wearing a
security costume.
**Date** 2026-08-30

---
## ADR-071 — The webhook queue is the database
**Context** The conventional design publishes an event to a queue and lets a consumer deliver it.
**Rejected** That. It loses events whenever the queue does - Redis restarted, flushed, briefly
unreachable - and the loss is silent. For an integration somebody has built a business process on,
"we published something and hoped somebody was listening" is a different claim from "we told
them", and the difference only becomes visible on the day it costs money.
**Chosen** A `webhook_deliveries` row written by the same request that caused the event, before
anything is enqueued. The BullMQ job is an optimisation for latency; a sweeper every minute asks
the database what is due and picks up anything the job never reached.
**What this buys** The row is durable the moment the event is. A dead queue costs latency, not
deliveries. And the realtime gateway - which has no queue producer at all - can emit webhooks by
writing rows and letting the sweeper find them, which matters because almost every conversation in
this product starts over a socket.
**Cost** A row per delivery, and a query every minute. Both are cheap; losing an event is not.
**Date** 2026-08-30

---
## ADR-072 — The timestamp is signed with the body
**Context** The minimum viable signature is an HMAC of the request body.
**Problem** It answers "did SmartChat send this" but not "is this fresh". A delivery captured once
can be replayed a year later and will verify perfectly - same body, same HMAC, our secret.
**Chosen** `t=<unix>,v1=<hmac of "timestamp.body">`, with a five-minute tolerance, and `sentAt`
inside the signed payload as well.
**Reason** Signing the timestamp is what makes it unforgeable; sending it unsigned would let an
attacker replay an old body with a fresh timestamp. The tolerance check runs *before* the HMAC, so
a replay is rejected on age rather than on cryptography.
**On the header format** Deliberately the shape several well-known products use. An integrator has
probably written this verification before, and a familiar shape is one they are less likely to get
wrong. `v1` is a version so a future scheme can ship without breaking every endpoint.
**How it is tested** The e2e suite's verifier is written from the documentation, not imported from
our code. Two copies of one function only prove that the function agrees with itself.
**Date** 2026-08-30

---
## ADR-073 — Webhook URLs are an allow-list, and the relaxation is configuration-only
**Context** A webhook URL is an address this server makes outbound requests to, on a schedule the
account controls. That is a server-side request forgery primitive.
**Chosen** https only, on a host that looks public: no loopback, no RFC1918 literal, no bare
hostname without a dot, and none of the service names on this compose network.
**Why https and not merely "not private"** The signature proves who sent a payload; it does not
hide what is in it. A ticket body crossing the internet in clear text is a customer's words in
clear text.
**The development hole, and where it is** `ALLOW_PRIVATE_WEBHOOK_URLS` relaxes the host rule so a
test receiver can run on the developer's machine. It defaults to **false**, is set only in the
development compose overlay, and is read from configuration once at boot - so no header, body field
or query parameter can widen it, and production inherits the safe behaviour by doing nothing.
**Date** 2026-08-30

---
## ADR-074 — The event list is what is emitted, and there is no wildcard
**Context** Phase 0 drafted eight webhook events. Four of them - `message.created`,
`visitor.created`, `conversation.updated`, `ticket.updated` - were never emitted by anything.
**Chosen** Cut the list to the five that are emitted, plus `ping`. It grows when an emitter does.
**Reason** Offering a subscription to an event that never arrives is worse than not offering it.
The integrator wires it up, tests nothing - because nothing comes - and discovers months later that
the silence was our product rather than their bug. A speculative enum entry is a promise, and this
one had been sitting there since phase 0.
**No wildcard** `*` would silently start delivering a new event shape to an endpoint that has never
seen it, on the day we add one. An explicit list means adding an event cannot break anybody.
**Date** 2026-08-30

---
## ADR-075 — The platform console does not use TenantContext
**Context** Every service in this codebase takes a `TenantContext` and every repository injects
`accountId` from it. The console needs to read and change accounts.
**Chosen** A separate `PlatformPrincipal`, a separate permission vocabulary, separate routes and a
separate audit table. No `TenantContext` anywhere in the console path.
**Reason** `TenantContext` exists to make tenant scoping impossible to forget. An operator
suspending an account is deliberately not scoped to it, so using that object here would either be
a lie - a context whose account id means nothing - or would have to be defeated, and a codebase in
which the tenant guard is sometimes bypassed is one where nobody can say when.
**Consequence** Two authorisation systems, which is normally a smell. Here it is the point: they
protect different things, and the console's is smaller and stricter.
**Date** 2026-08-30

---
## ADR-076 — Suspension is immediate because authorisation is never cached
**Context** The exit criterion for this phase is that suspending an account stops access
*immediately*, not at the next sign-in.
**How it works** Nothing had to be built. `authenticateTenant` calls `requireMembership` on every
request, which reads the account row and refuses a suspended one; API-key authentication checks the
account is active; the widget's public lookup requires an active account. There is no cached
authorisation decision anywhere, so there is nothing to expire.
**Why that was the right design earlier** It costs one indexed read per request, which is the price
of being able to answer "is this still allowed?" with "yes, as of now" rather than "yes, as of some
point in the last few minutes". Suspension is the case that makes the difference visible, but the
same property is what makes revoking a member, or an API key, actually work.
**How it is tested** The e2e signs in first and suspends second, with the session still live. A
test that suspends and *then* signs in would pass against a system where suspension only blocks new
logins - which is the failure worth catching.
**Date** 2026-08-30

---
## ADR-077 — Feature flags are a closed list, fail open, and never destroy data
**Context** "Feature flags" usually means a general-purpose experiment framework with arbitrary
keys.
**Chosen** Three flags, each read in exactly one place, with the key set defined in code. A key
that is not on the list is refused rather than created.
**Reason** A flag nothing consults is worse than no flag. Somebody flips it during an incident,
watches nothing change, and loses the minutes it takes to work out why - and those are the minutes
that matter. Keeping the list closed means every switch in the console is a switch that does
something.
**Fail open** A missing row, or a database that will not answer, means the capability is on. The
alternative is that a hiccup in a table nobody was thinking about silently turns off uploads for
every customer. A kill switch should require a deliberate act to kill.
**Pause, never destroy** `uploads` stops new targets being signed and leaves existing files
readable; `webhooks` stops new deliveries being queued and lets queued ones go. That distinction is
what makes a flag safe to use at three in the morning.
**Not 402** The refusal is `TEMPORARILY_UNAVAILABLE` (503), not `FEATURE_NOT_AVAILABLE` (402). 402
means "upgrade your plan", which is an infuriating thing to tell somebody during an incident on our
side.
**Date** 2026-08-30

---
## ADR-078 — The console has its own cookie, and no sign-in conveniences
**Context** The dashboard's auth has registration, invitations, password reset by email, long
sessions and "remember me".
**Chosen** For the console: a separate cookie name (`sc_platform`), `SameSite=Strict`, an eight-hour
session, and none of those conveniences. Administrators are created by somebody with database
access.
**Reason on the cookie** Two names make "a stolen tenant session cannot be used as a platform one"
structural rather than a matter of remembering to check - and signing out of the dashboard stops
being able to sign an operator out of the console by accident. `Strict` costs nothing here because
there are no email links to arrive from.
**Reason on the conveniences** Each is a door. Password reset by email makes the most privileged
credential in the system only as strong as an inbox; a thirty-day session makes it only as strong
as the laptop it is on. The console is used rarely and deliberately, so the inconvenience is
cheap.
**Date** 2026-08-30

---
## ADR-079 — `dataRetentionDays` was a promise nothing kept
**Context** The column has been in the schema since phase 1, the setting has been in the product's
API since phase 1, and the job that was supposed to honour it logged
`retention job: nothing to apply yet` for twelve phases.
**Why this is worse than an obvious gap** Nobody could see it. An account that set 90 days believed
its customers' transcripts were being deleted; they were not. A missing feature is a disappointment;
a feature that reports success and does nothing is a false statement about somebody else's data.
**Chosen** `RetentionService`, applied nightly and on demand from the console.
**What it deletes** Conversations past the window and everything hanging off them - messages,
attachments, read markers - plus the objects behind those attachments, and visitors left with no
conversations and no contact.
**What it deliberately does not** Tickets, because a ticket is a commercial record of what was
asked and promised, and deleting it because a chat aged out would destroy the account's own history
of its obligations. The audit log, because a policy that erased the record of its own operation
would be self-defeating. Contacts, because a person is not a conversation and erasing an individual
is a separate, deliberate act.
**The ordering that matters** Object keys are collected *before* the rows are deleted. Afterwards
nothing knows which files belonged to them, and an object store full of unreferenced files is a
bill nobody can explain and personal data nobody can find. Rows go first and objects second, so a
storage failure leaves an orphaned file rather than a retained transcript - and the count of
orphans is logged as a warning, because the alternative is discovering it from an invoice.
**Date** 2026-08-30

---
## ADR-080 — The restore rehearsal asks the restored copy questions
**Context** "A backup that has never been restored is not considered reliable."
**The problem with checking a backup exists** Every intermediate failure produces a file. A
truncated dump is a file. A dump of an empty database is a file. A dump taken before the last
migration is a file that restores cleanly and breaks the application on its first query.
**Chosen** `scripts/restore-rehearsal.mjs` takes a real dump, restores it into a scratch database,
and then interrogates the result: row counts table by table against the source, a tenant-scoped
join, a substring search that needs a trigram index, the presence of the enum types, and - the one
that matters most - an insert that **must be refused**, proving the composite foreign keys came
back rather than merely appearing in a listing.
**Base64 in the pipe** `docker compose exec` mangles binary output often enough on some platforms
to make the rehearsal fail intermittently, and a test that fails half the time is one people learn
to re-run. A third more bytes buys exact reproducibility everywhere.
**Date** 2026-08-30

---
## ADR-081 — Metrics are opt-in and behind a constant-time token
**Context** A `/metrics` endpoint is standard, and standard practice is to leave it open on an
internal port.
**Chosen** No `METRICS_TOKEN` means the endpoint returns **404 and does not exist**. With one, the
Authorization header is compared in constant time, and a wrong token also gets 404 - an endpoint
that answers "wrong token" has confirmed it exists.
**Reason** These numbers say how many customers this installation has and whether its queues are
backing up. "We forgot to set a token" is a far more common failure than "we forgot to enable
metrics", so the safe state is the default one. The edge proxy denies the path as well; two
independent refusals, because "it is only on the internal network" has been the last words of many
exposed dashboards.
**Counted at scrape time, not in the process** The API runs as several replicas. A process-local
counter answers "what did this container see since its last restart", which is a question nobody
has and whose answer looks like an outage every time a container is replaced.
**Date** 2026-08-30

---
## ADR-082 — The widget gets its own origin in production
**Context** The edge proxy could serve everything from one hostname with paths.
**Chosen** Four hostnames: the dashboard, the API, the gateway, and the widget - each with its own
certificate.
**Reason** The widget runs inside other people's pages, and its panel renders content those pages
supply. Serving it from the dashboard's origin would put customer-controlled content one
same-origin bug away from a signed-in session and its cookies. Separate origins make that a
cross-origin problem for an attacker rather than a same-origin one.
**What follows** The realtime hostname gets a 3600-second proxy read timeout, because a chat socket
is idle far more often than it is busy and the default 60 seconds would drop every conversation in
which nobody typed for a minute. Sign-in paths get their own far stricter rate-limit bucket at the
edge, in addition to the application's own per-account limiter - the edge one knows nothing and is
therefore still standing when the application is the thing being overwhelmed.
**Date** 2026-08-30

---
## ADR-083 — Banning a visitor is a `contact:update` right, not a permission of its own
**Context** The schema has carried `is_banned` and `banned_until` since phase 1 and the visitor
service has always refused a banned identity — but nothing could switch it on. The control existed
and was unreachable, which is the same as not existing while reading as though it does.
**Chosen** Two routes, `POST` and `DELETE /visitors/:id/ban`, authorised by `contact:update`.
**Reason** A new permission would have to be added to `ALL_PERMISSIONS`, to three role presets, and
then backfilled onto every role row that already exists in every deployed database — a migration
whose only purpose is to name a right that an existing right already describes. `contact:update` is
the "manage this person" permission: owners, admins and managers hold it, and agents deliberately do
not. An agent working a queue should not decide who is allowed to come back.
**What follows** A ban takes effect on the *next* request, not on the open socket. The connection
was authenticated when it was made and the gateway does not re-check mid-stream; what the ban
guarantees is that the next page load, token refresh or gateway ticket is refused, and a socket that
drops cannot come back. The panel says exactly that rather than implying an instant disconnect.
Bootstrap checks the ban as well as `authenticate` — without that second check a reload would mint a
fresh token for a banned visitor and the ban would last precisely one page view.
**Date** 2026-08-31

---
## ADR-084 — The dashboard's Content Security Policy is built per request, in middleware
**Context** `SECURITY.md` claimed a strict CSP with a nonce on the dashboard. There was none: the
API had one (it serves JSON, where it costs nothing) and the Next application had `X-Frame-Options`
and little else.
**Chosen** A per-request nonce and a `strict-dynamic` policy assembled in `middleware.ts`, with the
API, gateway and storage origins read from the environment at request time.
**Reason** A static policy cannot carry a nonce, and `script-src 'unsafe-inline'` would make the
header decorative — it would allow exactly the injected script it is there to stop. The origins
cannot be baked in at build time either, because one image is promoted through every environment;
they are read from `process.env` in the middleware, where the values are the running container's.
**What follows** `style-src` keeps `'unsafe-inline'`. Next inlines critical CSS and React writes
style attributes at runtime, neither of which can carry a nonce; a style cannot execute, so this is a
bounded concession rather than a hole in `script-src`, and it is named here so nobody has to
rediscover why it is there. Development gets a relaxed policy, because `next dev` compiles with
`eval` — pretending the strict policy holds there would be a worse lie than admitting it does not.
The widget panel gets its own policy from nginx, with the origins substituted by the same entrypoint
that already points the bundle at them.
**Date** 2026-08-31

---
## ADR-085 — Webhook delivery re-resolves the address and pins the connection to it
**Context** The URL was validated when it was saved: https, no private literal, no bare hostname.
Delivery then called `fetch` on it. A name is not an address, and `https://hooks.example.com` can
resolve to `169.254.169.254` — tomorrow, or on the second of two answers, or between the check and
the connection.
**Chosen** `createOutboundFetch()`: re-validate the URL, resolve the host, require **every** answer
to be a public address, then issue the request through `node:http`/`node:https` with a `lookup` that
returns only those vetted addresses.
**Reason** Checking the resolved address and then letting the HTTP client resolve the name again
leaves a window between the two — which is the whole of DNS rebinding. Pinning closes it. Requiring
every answer rather than the first closes the variant where a hostile zone returns one public and
one private address and lets the resolver choose.
**What follows** Redirects are not followed — `node:http` does not follow them, which is the
behaviour we want, and a 3xx is recorded as a failed delivery rather than as a hop to an address
nobody vetted. The response body is capped at 64 KB as it arrives, so a receiver cannot use the
dispatcher's memory as a landing zone. `ALLOW_PRIVATE_WEBHOOK_URLS` relaxes all of this for
development, is set from configuration and never from a request, and the production compose file
sets it to `false` explicitly.
**Date** 2026-08-31

---
## ADR-086 — Every authenticated request consumes one budget, applied in the auth hook
**Context** `RATE_LIMITS.dashboardApi` existed, `SECURITY.md` documented it as 600/min per session,
and no route consumed it. Three routes had their own `mutation` limit; everything else was unlimited.
**Chosen** Consume `dashboardApi` inside `authenticateTenant`, keyed by session id for a browser
caller and by API key id for a key.
**Reason** A limit applied route by route is a limit somebody forgets on the next route. Applying it
where the principal is established means a route added tomorrow is limited on the day it ships. The
tighter per-route limits stay: this is the floor, not the ceiling.
**What follows** Keyed to the session rather than the user, so a runaway script in one tab does not
lock the person out of the tab they are working in; and to the key rather than the IP, so one
customer's integration cannot spend another's budget from a shared address. Anonymous requests are
refused before the limiter runs, so an unauthenticated flood is still the edge proxy's problem —
which is where it belongs, and where ADR-082 already put it.
**Date** 2026-08-31

---
## ADR-087 — Billing is a port with one honest implementation, not a Stripe integration deferred
**Context** The product had plans in the database and no way for a customer to be on one, change
one, or pay for one. The obvious move was to wire in a card processor; the obvious problem was that
doing so would put a third party, a set of secrets and a webhook endpoint between us and every test
of the subscription behaviour, before any of that behaviour existed to test.
**Chosen** A `BillingProvider` interface — request a change, apply a decided change, cancel, resume,
invoice a period — with `ManualBillingProvider` behind it. A customer chooses a plan, an operator
approves it in the console, invoices are written when a period rolls over and marked paid when
somebody records the payment.
**Reason** Everything that makes a subscription *mean* something — entitlements, limits, the pause
behaviour, usage, invoices, the customer's billing screen — is above the seam and is exercised end
to end today with no external dependency. The manual provider is not a placeholder: approving plan
changes and recording bank transfers is how a great deal of B2B software is actually sold. A card
processor implements the same five methods and changes nothing above them.
**What follows** The interface talks about intent (`requestChange`) rather than mechanism (`create a
checkout session`), so a provider is free to answer with an approval queue, an immediate switch or a
redirect. `PlanChangeOutcome` carries a `redirect` case that the manual provider never returns,
because the shape has to exist before the second implementation does or adding it becomes a
breaking change. Approval and self-serve both end in `applyApprovedChange`, so a subscription only
ever moves between plans down one path.
**Date** 2026-08-31

---
## ADR-088 — Over a limit means read-only, never removed
**Context** A downgrade, a lapsed payment or a cancellation all leave an account holding more than
its plan covers. The cheap answer is to delete the excess — the fourth website, the conversations
past the retention window, the eleventh agent. The cheap answer is also how a customer loses work
over an invoice they never saw.
**Chosen** Pause, never destroy. Nothing is deleted, unpublished or edited. A paused account keeps
every read — the inbox, the transcripts, the exports, the reports — and loses only the ability to
write. Websites past the allowance stop taking *new* conversations, oldest-first so which ones keep
serving is predictable; everything on them stays intact and comes back whole when the plan does.
**Reason** A lapsed invoice is a commercial problem. Holding somebody's support history hostage over
one is not a remedy, it is a hostage — and it is irreversible in a way the missed payment is not.
Read-only is recoverable from in one click by both sides.
**What follows** The write refusal is applied once, in the tenant authentication hook, so a route
written next month is covered on the day it ships; `/billing/*` is the deliberate hole, because an
account that cannot reach its own billing screen can never stop being paused. Which websites keep
serving is oldest-first rather than by traffic or by name, because a customer has to be able to
predict it without asking. `resume` has to work on an already-paused subscription and not only on
one still inside its period — the first version refused that and made pausing a one-way door.
The visitor-facing refusal is the same `PROPERTY_NOT_FOUND` a deleted website gives: a stranger on
somebody else's page has no business learning that the owner is behind on a bill.
**Date** 2026-08-31

---
## ADR-089 — Every account is given a subscription the moment it is created
**Context** Registration created an account, its roles and its owner membership, and no
subscription. `EntitlementService` reads limits from the subscription's plan; with no subscription
there were no limits, and an absent limit means unlimited. So every account ever created through
the product's own sign-up was silently on an unmetered plan, while the pricing page advertised
limits and the code read as though it enforced them.
**Chosen** `ensureSubscription` runs inside account creation, giving a fourteen-day trial on the
full product. When the trial ends the subscription falls back to the free plan rather than
activating the paid one nobody agreed to pay for. `EntitlementService` falls back to the cheapest
published plan when no subscription row exists at all, and a data migration backfills accounts
created before this.
**Reason** Three layers because the failure was silent and expensive. The creation path is the fix;
the entitlement fallback means a row lost to a restore or a manual edit fails closed rather than
handing out the whole product; the migration repairs what already exists. Falling back to *free*
rather than to *nothing* is the load-bearing half — "nothing" was the bug.
**What follows** A trial on the free plan would be a trial of nothing, so the trial runs on Pro and
lands on Free. Nothing is deleted at the end of it: whatever was built during the trial stays, and
anything past the free plan's limits becomes read-only under ADR-088 — the same rule a lapse
follows, applied to the one moment every customer goes through. A database with no plans at all
makes account creation fail loudly, because the alternative is an account with no entitlements,
which is where this started.
**Date** 2026-08-31

---
## ADR-090 — The job-to-queue map is keyed by `JobName`, so an unrouted job cannot compile
**Context** `QUEUE_FOR_JOB` was `Record<string, QueueName>`, maintained by hand. Phase 15 added two
job names — `email.billing` and `maintenance.subscription_lifecycle` — and did not add them here.
Nothing failed to compile. What happened instead was worse than a missing job: the worker schedules
its repeatable jobs at boot, scheduling an unrouted job throws, and the **whole worker process
refused to start**. Every email in the product stopped — invitations, ticket notifications,
password resets — along with every webhook delivery. Three E2E suites went red in ways that pointed
at email templates and webhook signing, none of which were wrong.
**Chosen** `Record<JobName, QueueName>`. A job name added to `JobPayloadMap` without a queue is now
a type error at the point it is introduced.
**Reason** The map is the kind of thing that is obviously complete on the day it is written and
quietly incomplete six months later. `Record<string, ...>` accepts any key and demands none, which
is precisely the wrong shape for an exhaustive routing table. This is the same argument as making
`PlanGuard` a required constructor option rather than an optional one: put the obligation where the
compiler can see it.
**What follows** The runtime `throw` stays. It is now unreachable from TypeScript, but it is the
only thing standing between a JavaScript caller and a silently dropped job, and it costs one
comparison. The blast radius is also worth naming: one unrouted job takes down the entire worker,
because scheduling happens at startup. That is the right failure — loud, immediate, and visible in
the container's health status — but it means this map is load-bearing far beyond the job it omits.
**Date** 2026-09-01

---
## ADR-091 — The route map in `API.md` is the routes, not the plan
**Context** `API.md` §5 was headed "Route map (target)" and had been written in phase 0. Fifteen
phases later it documented the Platform surface at `/api/v1/admin/...` — which has never
existed — and named about twenty endpoints the router does not register: `/webhooks` instead of
`/integrations/webhooks`, `/account/members/invite` instead of `POST /team/members`,
`/conversations/:id/close` instead of a `PATCH`, `GET /visitors`, `POST /widget/messages`. The
word "(target)" was doing a lot of work that nobody reading it would notice.
**Chosen** Replace it with the actual route table, enumerated from the route files, and drop the
qualifier. Same for the surfaces table's `/admin` prefix.
**Reason** A route map is not prose about intentions — it is the thing somebody builds a client
against, and one that is aspirational in places nobody can identify is worse than none at all.
This is the documentation form of the failure this project keeps finding in code: something that
reads as a promise and is not connected to anything.
**What follows** Rule 4 was rewritten in the same pass. It said "every mutating route is rate
limited", which pointed at the named `mutation` budget — consumed by three routes out of about
sixty. That is not false, because ADR-086's `dashboardApi` floor covers every authenticated
request, but it named the wrong mechanism. The rule now says which limit actually does the work
and which routes carry a tighter one on top.
**Date** 2026-09-01

---
## ADR-092 — A required secret must be one somebody can rotate to some effect
**Context** `SESSION_SECRET`, `JWT_SECRET` and `ENCRYPTION_KEY` were all mandatory 32-character
secrets, validated at boot, refused as placeholders in production, and read by **nothing**.
Sessions are opaque random tokens compared by hash and need no signing key; there are no JWTs in
this product; and the AES-GCM module `ENCRYPTION_KEY` existed for was called from nowhere but its
own test. `ACCESS_TOKEN_TTL_MINUTES` and `DATABASE_POOL_MAX` were the same shape.
**Chosen** Remove the three secrets and the token TTL from the config schema and from every
compose file and example; delete the unreachable encryption module; and make `DATABASE_POOL_MAX`
actually apply, by putting `connection_limit` on the connection string in `createPrismaClient` —
the only place Prisma reads it from, which is why it had never done anything.
**Reason** A required secret that has no effect is worse than an absent one, in a specific way:
an operator who rotates it after a suspected compromise believes they have changed something.
`VISITOR_TOKEN_SECRET` stays, because rotating it really does invalidate every visitor token.
**What follows** A test in `packages/config` now asserts that the secrets schema contains
`VISITOR_TOKEN_SECRET` and does *not* contain the other three, so any one of them coming back has
to come back with a reader. The encryption module is recoverable from git if 2FA is ever built;
what is not acceptable is shipping the key requirement before the feature.
**Date** 2026-09-01
