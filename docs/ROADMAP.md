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
| **6 — Automation** ✅ | Rule engine, triggers, shortcuts, pre-chat form, offline form | A trigger fires on a real visit; `/shortcut` expands; offline capture works |
| **7 — Files & contacts** ✅ | Signed uploads, validation, attachment rendering, contacts, custom fields | Upload from both sides; contact history assembled |
| **8 — Knowledge base** ✅ | Categories, articles, editor, search, public KB | A published article is reachable publicly and searchable |
| **9 — Tickets & email** ✅ | Tickets, ticket messages, email abstraction, notifications | Offline message becomes a ticket and sends mail (visible in Mailpit) |
| **10 — Analytics** ✅ | Rollup tables, scheduled and on-demand rebuilds, reports | Metrics match hand-computed values on seeded data |
| **11 — Integrations** ✅ | Webhooks with signing/retry/logs, scoped API keys on the same routes | Webhook delivered and verified; API key scoped and revocable |
| **12 — Super admin** ✅ | Platform console: accounts, plans, entitlements, usage, health, audit, flags | Suspend an account and observe tenant access stop immediately |
| **13 — Production** ✅ | Hardening, data retention, backups + restore rehearsal, metrics, edge proxy with TLS, CI/CD | Production images build; restore rehearsal succeeds |
| **14 — Final QA** ✅ | Regression, security audit, load test, full E2E, rollback rehearsal | All thirteen suites green (664 checks) plus both rehearsals; `SECURITY_AUDIT.md` complete — and it found five documented controls that did not exist, which are now built |
| **15 — Site & subscriptions** ✅ | Public marketing site, plans with annual billing, the `BillingProvider` port with a working manual provider, plan changes, invoices, `PlanGuard` enforcement, pause-never-destroy | A stranger can read the pricing page; a customer can change plan and an operator can decide it; a Free account is actually refused what Free excludes; a paused account keeps every read and loses every write |

Deliberately **not** in scope for v1: card processing (the billing port and a complete manual
provider are built and exercised end to end — see ADR-087; a hosted-checkout provider implements the
same five methods), mobile apps, AI answering, voice/video, Slack/Teams integrations. Each has a
designed extension point; none is implemented, and none is faked in the UI.
