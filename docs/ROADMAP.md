# SmartChat — Roadmap

Each phase ends healthy: lint, typecheck, tests and build pass, the Docker stack runs, the feature is
verified in a browser, docs are updated, and the work is committed. No phase starts before the
previous one is green.

| Phase | Scope | Exit criteria |
| --- | --- | --- |
| **0 — Foundation** ✅ | Architecture, docs, monorepo, Docker infra, CI skeleton | `docker compose up -d` → postgres, redis, minio, mailpit all healthy; docs written |
| **1 — Auth & tenancy** ✅ | Prisma schema + migrations, Argon2id auth, email verification, sessions, RBAC, accounts, properties, dashboard shell, rate limiting, audit log | Register → verify → log in → create property, in a browser. Isolation suite green |
| **2 — Widget** ✅ | loader.js, Shadow DOM launcher, panel iframe, widget config API, installation snippet, domain allowlist, visitor identity, test site | Widget appears on the test site via the real snippet and identifies the visitor |
| **3 — Realtime** ✅ | Socket.IO gateway, Redis adapter, tickets, presence, typing, idempotent persistence, delivery/read receipts | Visitor ↔ agent messages both directions, live, surviving a server restart |
| **4 — Inbox** ✅ | Conversation list, filters, search, assignment, transfer, close/reopen, tags, priority, notes, visitor panel | An agent can work a full conversation end to end |
| **5 — Team** ✅ | Invitations, roles, permissions, property membership, departments, agent availability | Invite an agent, scope them to a property, verify they see only that property |
| **6 — Automation** | Rule engine, triggers, shortcuts, pre-chat form, offline form | A trigger fires on a real visit; `/shortcut` expands; offline capture works |
| **7 — Files & contacts** | Signed uploads, validation, attachment rendering, contacts, custom fields | Upload from both sides; contact history assembled |
| **8 — Knowledge base** | Categories, articles, editor, search, public KB | A published article is reachable publicly and searchable |
| **9 — Tickets & email** | Tickets, ticket messages, email abstraction, notifications | Offline message becomes a ticket and sends mail (visible in Mailpit) |
| **10 — Analytics** | Event tables, rollup jobs, reports | Metrics match hand-computed values on seeded data |
| **11 — Integrations** | Webhooks with signing/retry/logs, public API, API keys | Webhook delivered and verified; API key scoped and revocable |
| **12 — Super admin** | Platform console: accounts, plans, entitlements, usage, health, audit, flags | Suspend an account and observe tenant access stop immediately |
| **13 — Production** | Hardening, performance, backups, monitoring, CI/CD, prod compose, SSL | Production images build; restore rehearsal succeeds |
| **14 — Final QA** | Regression, security audit, load test, full E2E, rollback rehearsal | Every item in the acceptance criteria passes; `SECURITY_AUDIT.md` complete |

Deliberately **not** in scope for v1: payment processing (the entitlement model is built, the
gateway is not), mobile apps, AI answering, voice/video, Slack/Teams integrations. Each has a
designed extension point; none is implemented, and none is faked in the UI.
