# SmartChat — Project Plan

## 1. Product

SmartChat is a self-hosted, multi-tenant live-chat SaaS platform. One installation serves many
customer organisations; each manages multiple websites, each website carries an embeddable chat
widget, and agents work every conversation from one real-time dashboard.

It is built from scratch. It borrows the *category* of functionality that mature live-chat products
have — nothing else. No third-party source, branding, UI, copy or assets are reused.

## 2. Starting point

The repository was empty at the start of Phase 0. Everything is new work, so there is no legacy to
preserve and no migration path to honour.

## 3. Technology

| Concern | Choice |
| --- | --- |
| Language | TypeScript, strict, everywhere |
| Repo | pnpm workspaces + Turborepo |
| API | Fastify 5 + Zod |
| Dashboard | Next.js 15 (App Router) + React 19 |
| Realtime | Socket.IO 4 + Redis adapter |
| Jobs | BullMQ |
| Database | PostgreSQL 16 + Prisma |
| Cache / bus / presence | Redis 7 |
| Object storage | MinIO in dev, any S3-compatible service in production |
| Email | provider abstraction; Mailpit in dev, SMTP/SES/Resend/Postmark in production |
| Widget build | Vite (two artefacts: `loader.js` and the panel bundle) |
| Tests | Vitest, Playwright, k6 |
| Runtime | Docker + Docker Compose, identical topology in dev and production |

Rationale for each significant choice is recorded in `DECISIONS.md`.

## 4. Repository layout

```
apps/
  api/          Fastify HTTP API — the only writer of business data
  realtime/     Socket.IO gateway
  worker/       BullMQ consumers
  web/          Next.js dashboard, super-admin console, public knowledge base
  widget/       loader.js + panel (the embeddable surface)
  test-site/    a real customer website with the widget installed the real way
packages/
  core/         domain services shared by api, realtime and worker
  database/     Prisma schema, migrations, seed
  types/        shared DTOs, enums, event names, error codes
  validation/   Zod schemas shared by api, web and widget
  config/       Zod-validated environment parsing
  logger/       Pino structured logging
  ui/           React design system
infrastructure/ nginx, postgres init, deployment assets
docs/           this documentation set
```

## 5. Working agreement

- One coherent phase at a time. A phase is done when lint, typecheck, tests and build pass, the
  Docker stack runs, the feature is verified in a browser, docs are updated and the work is
  committed.
- No placeholder UI. A control that appears in the product does what it says. Features not yet built
  are absent, not stubbed.
- Errors are diagnosed, not bypassed. A failing build, migration, test or console error blocks
  progress.
- Every architectural decision of consequence is recorded in `DECISIONS.md` on the day it is made.
- Documentation is updated in the same commit as the change it describes.

## 6. Phase status

| Phase | Status |
| --- | --- |
| 0 — Foundation | ✅ complete |
| 1 — Auth, accounts, properties | ✅ complete |
| 2 — Widget | ✅ complete |
| 3 — Realtime chat | ⏳ in progress |
| 4 → 14 | ☐ planned (see `ROADMAP.md`) |

## 7. Definition of done for the product

The acceptance criteria in `TESTING.md` §2, the tenant isolation suite in §3, the security review in
`SECURITY.md` §6, and a rehearsed deploy **and rollback** on a real VPS. Until all four hold, the
product is not finished, and it will not be described as finished.
