# SmartChat — Testing Strategy

## 1. Layers

This table describes what exists. An earlier version of it described a testing strategy nobody had
built — Playwright suites, Testcontainers, k6 — and a plan written in the present tense is the same
kind of lie as a "Coming soon" button. If a row is here, `pnpm` can run it today.

| Layer | Tool | Scope | Runs on |
| --- | --- | --- | --- |
| Unit | Vitest | domain logic in `@smartchat/core`, validation schemas, the rule engine, cursors, the markdown renderer, the SigV4 signer, the webhook signature, the outbound address guard, config loading | every commit, no I/O |
| Component | Vitest + Testing Library + jsdom | the dashboard components whose bugs are invisible server-side — the modal's focus management is pinned here because that bug was found in a browser and no server test could have seen it | every commit |
| Migrations | `prisma migrate deploy` + `migrate diff --exit-code` | every migration applied in order to an *empty* database, then checked for drift against the schema Prisma expects | every commit |
| End-to-end | Node scripts in `scripts/`, against the real Docker stack | fourteen suites, listed below. Real HTTP with a cookie jar, real sockets, real Postgres, real Redis, real MinIO, real SMTP | every commit |
| Isolation (security) | `scripts/e2e-isolation.mjs` | cross-tenant access, per resource, on every path | **blocking**, every commit |
| Abuse control | `scripts/e2e-abuse.mjs` | a ban that survives the reload that is meant to defeat it | every commit |
| Load | `scripts/loadtest.mjs` | concurrent sockets and message throughput — and, more importantly, whether sequence numbers stay gapless while busy | before release |
| Recovery | `scripts/restore-rehearsal.mjs`, `scripts/rollback-rehearsal.mjs` | a backup that is actually restored and interrogated; a rollback that is actually performed | every commit |

There is no Playwright suite. Browser behaviour is covered by the component tests plus manual
verification against the test site, and where that has not been enough it has been said so rather
than papered over: see the modal focus bug in `apps/web/src/components/ui/modal.test.tsx`.

## 2. The acceptance flow

The definition of "the product works". Steps 1–2 and 5–9 are asserted by the scripted suites below;
steps 3–4 are the browser check performed by hand against `apps/test-site` at the end of each phase,
because "the launcher appears and looks right on somebody else's page" is not a claim a script in
this repository can honestly make.

1. Register an account → verify email (read from Mailpit's API) → log in.
2. Create a property; configure the widget; read the generated installation snippet.
3. Open the test website (`apps/test-site`) which has that snippet installed.
4. The launcher appears; open it; complete the pre-chat form; send a message.
5. In a second browser context, the agent's inbox shows the conversation live.
6. The agent replies; the visitor receives it over the socket without reloading.
7. The visitor replies; the agent sees it.
8. The agent uploads a file, adds an internal note (invisible to the visitor), assigns, then closes.
9. The conversation appears in history with the full transcript in the right order.

## 2a. Scripted checks that run against the live stack

Fourteen scripts exist so that "it works" is a command rather than an opinion. All need
`docker compose up -d` and each creates its own throwaway account, so they can be run repeatedly.

| Command | What it proves |
| --- | --- |
| `pnpm smoke` | The HTTP surface: registration, sessions, CSRF, rate limits, property CRUD, the public widget surface, and tenant isolation returning 404 rather than 403. |
| `pnpm e2e:realtime` | The Phase 3 guarantees over real sockets: single-use tickets, the presence snapshot on subscribe, live delivery in both directions, gapless sequence numbers, idempotent resend, internal notes never reaching the visitor, and `sync:since` replaying exactly what a reconnecting visitor missed. Then the Phase 4 workflow over HTTP: assignment (including a member id from another account being refused), the `me` / `unassigned` filters, tag filtering that narrows rather than widens, search reaching message bodies, and close/reopen — with a reply to a closed conversation refused and an internal note still accepted. |

| `pnpm e2e:team` | Phase 5: departments and roles, the invitation round trip (the link is read out of the delivered email in Mailpit, so a broken template fails the test), an invited address being unable to sign in before accepting, single-use links, and then the thing that actually matters — a scoped agent seeing their own website and not the other one, in the list, by direct id, by message, by search, and when trying to reply. Plus the owner guards and immediate effect of a scope change. |

| `pnpm e2e:automation` | Phase 6, over real sockets: a trigger firing on a real visit and its tag, priority and bot attribution landing on a real conversation; "once per visit" surviving a reload; a different visitor still being greeted; a rule scoped to one website staying off another; a negative condition on an unknown fact staying silent (ADR-035); pre-chat answers reaching the agent with an unconfigured key dropped; the offline form refusing an incomplete submission and accepting a complete one into the inbox; shortcut CRUD with a duplicate key refused; cross-account reads answering 404; and a paused trigger sending nothing. |

| `pnpm e2e:files` | Phase 7, against the real object store: a file uploaded and downloaded and compared byte for byte, from both sides; an executable named and declared as a picture refused by its signature *and deleted from the bucket*; a client that understated its size caught by measuring the real object; a storage key with nothing from the file name in it; cross-account and cross-visitor reads answering 404; a replayed transcript that still carries its files; and a contact assembled from two browsers that gave the same address in different casing, with custom-field validation. |

| `pnpm e2e:kb` | Phase 8: categories and articles, slugs, publishing, trigram search, and the public help centre — with a draft invisible to a stranger both in the index and by direct slug. |

| `pnpm e2e:tickets` | Phase 9: an offline message becoming a ticket, per-account ticket numbering that cannot collide, public replies reaching the requester and internal ones not, and every notification read back out of Mailpit rather than assumed. |

| `pnpm e2e:reports` | Phase 10: rollups recomputed on demand and compared against hand-computed values, bucketed in the account's own timezone, with a `propertyId` from another account answering 404 rather than a page of zeros. |

| `pnpm e2e:integrations` | Phase 11: an API key that works on the same routes with fewer permissions and stops working when revoked; a webhook delivered, its signature verified by a checker written from the documentation rather than imported from the signer, a tampered body refused, and the retry schedule and sweeper both exercised. |

| `pnpm e2e:platform` | Phase 12: the operator console's separate session and permission space, suspending an account and watching tenant access stop, and a feature flag turning a capability off without destroying anything. |

| `pnpm e2e:retention` | Phase 13: a conversation past the retention window deleted along with its messages and its storage objects, and the tickets, contacts and audit rows that must survive it surviving it. |

| `pnpm e2e:billing` | Phase 15: the pricing page's data with no credential; that a new account really has a subscription; that a Free plan is refused what Free excludes, **with a negative control on a plan that includes it**; the request / approve / refuse cycle and a customer being unable to approve their own; a downgrade that is dated rather than lost; annual billing as a real interval; switching interval on the same plan; pause meaning every read still works and every write is refused; a downgrade leaving the excess website read-only rather than removed; and invoices staying inside one account. |

| `pnpm e2e:isolation` | Phase 14, and the one that blocks: see §3. |

| `pnpm e2e:abuse` | Phase 14: a banned visitor refused on the token they hold, on a fresh gateway ticket, **and on the page reload that mints a new token** — which is the door the ban used to leave open. Plus: the ban is one person and not the website, an agent cannot apply one, another account cannot apply one to your visitor, a ban that ends in the past is refused, and lifting it lifts it. |

| `pnpm loadtest` | Correctness under concurrency: forty visitors sending ten messages each over real sockets, then every transcript re-read to confirm the count, that sequence numbers are strictly increasing and unique, and that nothing was written twice. Latency percentiles are reported; they are the least interesting output. |

| `pnpm backup:rehearse` / `pnpm rollback:rehearse` | See §7. |

`pnpm e2e:files` is also what proves the hand-written SigV4 signer (ADR-043) actually works, which
is the only way that decision was defensible: it uploads with a signed URL, downloads with another,
and compares the bytes.

`pnpm e2e:billing` found two things in its first run, both of the same shape - code that reported
success and did nothing. Registration created accounts with **no subscription at all**, which made
every plan limit resolve to "unlimited" while the pricing page advertised numbers (ADR-089); and a
downgrade to a cheaper paid plan returned "applied", wrote no request row, and left the customer on
the expensive plan for ever. Neither was visible in the code, which read correctly in both cases,
and neither would have been caught by a test that only checked for a 200.

`pnpm e2e:automation` earned its place immediately: it found ADR-037, where the server validated
form answers against "no configuration" on any property whose widget row had not been created yet -
so every pre-chat answer on a brand-new website was silently discarded. No amount of reading the
code would have found that; the test simply reported `{}` where a name should have been.

`pnpm e2e:realtime` is the script that caught ADR-021: a retry with a repeated `clientMessageId`
returned a 500 because the recovery read ran inside an already-aborted transaction. Unit tests had
not caught it and could not have, since a database double that does not model transaction poisoning
passes either implementation. The regression is now pinned by
`packages/core/src/services/conversation.idempotency.test.ts`, whose fake behaves the way Postgres
actually behaves.

## 3. Tenant isolation suite

`scripts/e2e-isolation.mjs`. It builds two complete accounts — website, conversation with an agent
reply, contact, ticket, category, draft article, trigger, shortcut, API key, webhook — and then hands
account B every real identifier account A owns. Fifteen reads and nineteen writes must each answer
**404**; 403 is a failure, because "you may not see conversation X" confirms that conversation X
exists, and that is enough to enumerate a competitor's customer list one id at a time.

Then it checks the things a 404 does not cover: that A's data is genuinely unchanged afterwards, that
none of A's ids appear anywhere in B's own lists, that an API key is scoped to its own account, that
a visitor cannot read, write, resync or close a conversation belonging to another account's visitor,
that the public help centre does not leak a draft, that a forged `x-account-id` header and a cursor
forged from A's row grant nothing, and that a single-use gateway ticket really is single-use.

One check in it exists because of a mistake worth recording. The first version of this suite spent
five checks on `/widget/conversations/:id/messages` — a route this API does not have. Every one of
them passed, on Fastify's route-not-found handler, proving nothing. So the suite now probes every
path it uses **unauthenticated** before it uses it: a real route rejects an anonymous caller with 401
in its auth hook, while a route that does not exist answers 404. If any path answers anything else,
the suite fails and says which. That is what makes every 404 below it mean "not yours" rather than
"not there".

New tenant-owned models must add a case here. A model without an isolation test is not done.

## 4. Rules

- No test asserts against a mock of our own code where the real thing can run. Integration tests use
  a real database.
- Tests own their data: unique per-test tenants, no shared mutable fixtures, no ordering dependence.
- Time is injected. Nothing sleeps to wait for a state change; tests await conditions.
- A flaky test is a bug. It gets fixed or deleted, never retried into green.
- Coverage is a diagnostic, not a target. The isolation and E2E suites are the real gate.

## 5. Commands

```
pnpm verify             # format, lint, typecheck, build, unit tests - the whole gate
pnpm test:unit          # just the unit and component tests

# Against a running stack (docker compose up -d):
pnpm smoke
pnpm e2e:realtime  e2e:team  e2e:automation  e2e:files  e2e:kb  e2e:tickets
pnpm e2e:reports   e2e:integrations  e2e:platform  e2e:retention
pnpm e2e:isolation e2e:abuse
pnpm loadtest           # LOAD_VISITORS / LOAD_MESSAGES / LOAD_BATCH to change the shape
pnpm backup:rehearse
pnpm rollback:rehearse
```

There is no `pnpm test:integration` or `pnpm test:e2e`. Both were listed here, and in `package.json`,
and in the CI workflow, for several phases — pointing at a vitest config that had never existed. CI
ran them, they exited zero because there were no matching files, and the pipeline reported success
for tests nobody had written. They were removed in Phase 13; this paragraph stays as the reason the
list above is now checked against `package.json` rather than remembered.

## 6. `pnpm smoke`

`scripts/smoke.mjs` drives the real HTTP surface with a cookie jar, so it exercises exactly what a
browser does: session cookies and their attributes, the CSRF double-submit, the active-account
header, cursor pagination and every cross-tenant path. It is deliberately dependency-free and runs
against any environment, which makes it usable as a post-deploy check as well as a local one.

It clears rate-limit keys before running (the registration limiter is real, and the test registers
several accounts). `SMOKE_RESET_LIMITS=0` keeps them, for when the limiter is what you are
investigating.

As of Phase 2 it asserts 62 checks, including:

- an unknown email and a wrong password return **identical** status and error code
- the session cookie is httpOnly and SameSite=Lax; the CSRF cookie deliberately is not httpOnly
- a mutation without, or with a wrong, CSRF token is rejected
- the installation snippet contains no secret, key or internal id
- account B receives **404, not 403**, for every one of account A's resources - read, update,
  delete, installation snippet and domain creation - and cannot borrow A's account through either
  the switch endpoint or the `x-account-id` header
- repeated registration attempts for one address are rate limited
- the widget surface serves any origin but **never** with `Access-Control-Allow-Credentials`
- a visitor token whose payload has been edited to name a different visitor is refused, because
  the signature is checked before the payload is parsed
- the widget config response contains no account id, no internal property id and no draft
- serving the widget is what marks a property installed — there is no separate verification step

## 7. The two rehearsals

Both exist because of the same sentence: *a backup that has never been restored is not considered
reliable*. Neither checks that a script exited zero.

`pnpm backup:rehearse` takes a real dump of the live database, restores it into a scratch database,
and then **asks the restored copy questions**: row counts against the original, a tenant-scoped join,
a trigram search that only works if the index came back, the enum types, and a deliberately invalid
insert that must still be *refused* — because a restore that loses a foreign key restores cleanly and
breaks the application a week later. Every intermediate failure produces a file: a truncated dump is
a file, and so is a dump of an empty database.

`pnpm rollback:rehearse` answers the harder question. Migrations are forward-only, so it does not
pretend to un-run one. Instead it verifies the procedure that actually exists: that `IMAGE_TAG` flows
through both compose files and can select a real image, that a pre-deploy backup restores over a
database somebody has just damaged (a dropped column and a truncated table), that the dropped column
and every row come back, and that the `_prisma_migrations` ledger comes back with them. Then it reads
every migration in the repository and prints each one as **additive** or **BACKUP FIRST** — which is
the fact the runbook needs and the one nobody can recall under pressure.
