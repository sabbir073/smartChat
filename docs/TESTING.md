# SmartChat — Testing Strategy

## 1. Layers

| Layer | Tool | Scope | Runs on |
| --- | --- | --- | --- |
| Unit | Vitest | pure domain logic in `@smartchat/core`, validation schemas, the rule engine, pagination cursors, sanitisers | every commit, no I/O |
| Integration | Vitest + Testcontainers-style ephemeral Postgres/Redis | repositories, API routes, transactions, migrations | every commit |
| Component | Vitest + Testing Library | dashboard and widget components with real state, no network mocks in the assertion path | every commit |
| Realtime | Vitest + socket.io-client | connect, auth failure, reconnect, resync, idempotent resend, presence expiry | every commit |
| Widget | Playwright | loader on a real page, Shadow DOM isolation, iframe bridge, CSP compliance, host-page-unaffected assertions | every commit |
| End-to-end | Playwright | the acceptance flow below, against the real Docker stack | every commit |
| Isolation (security) | Vitest | cross-tenant access per resource | **blocking**, every commit |
| Load | k6 | concurrent sockets, message throughput, inbox queries | before release |

## 2. The end-to-end acceptance flow

This single test is the definition of "the product works". It runs against `docker compose up`, not
against mocks.

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

Two scripts exist so that "it works" is a command rather than an opinion. Both need
`docker compose up -d` and both create their own throwaway account, so they can be run repeatedly.

| Command | What it proves |
| --- | --- |
| `pnpm smoke` | The HTTP surface: registration, sessions, CSRF, rate limits, property CRUD, the public widget surface, and tenant isolation returning 404 rather than 403. |
| `pnpm e2e:realtime` | The Phase 3 guarantees over real sockets: single-use tickets, the presence snapshot on subscribe, live delivery in both directions, gapless sequence numbers, idempotent resend, internal notes never reaching the visitor, and `sync:since` replaying exactly what a reconnecting visitor missed. |

`pnpm e2e:realtime` is the script that caught ADR-021: a retry with a repeated `clientMessageId`
returned a 500 because the recovery read ran inside an already-aborted transaction. Unit tests had
not caught it and could not have, since a database double that does not model transaction poisoning
passes either implementation. The regression is now pinned by
`packages/core/src/services/conversation.idempotency.test.ts`, whose fake behaves the way Postgres
actually behaves.

## 3. Tenant isolation suite

For every tenant-owned resource — properties, widgets, visitors, conversations, messages,
attachments, contacts, shortcuts, triggers, tickets, knowledge base articles, webhooks, API keys,
reports — the suite asserts, using account A's credential against account B's object id:

- read → 404
- update → 404
- delete → 404
- list → the object never appears
- and the same for the realtime surface: joining B's conversation room fails

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
pnpm verify             # format, lint, typecheck, build, unit tests - what CI runs
pnpm test:unit
pnpm smoke              # end-to-end HTTP checks against a running stack, including the
                        # tenant-isolation suite. Requires `docker compose up -d`.
pnpm test:integration   # requires docker compose up -d
pnpm test:e2e           # playwright, requires the full stack
```

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
