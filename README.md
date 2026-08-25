# SmartChat

A self-hosted, multi-tenant live-chat platform: an embeddable chat widget for customer websites, a
real-time agent dashboard, and the tenancy, automation and administration a SaaS needs behind it.

Built from scratch in TypeScript. No third-party product's code, branding, UI or assets are used.

## Quick start

```bash
cp .env.example .env
docker compose up -d
docker compose exec api pnpm db:deploy
docker compose exec api pnpm db:seed
```

Dashboard http://localhost:3000 · Test website http://localhost:3004 · Mailpit http://localhost:8025

Full instructions: [`docs/LOCAL_SETUP.md`](docs/LOCAL_SETUP.md)

## What is here

| Path | What it is |
| --- | --- |
| `apps/api` | Fastify HTTP API — the only writer of business data |
| `apps/realtime` | Socket.IO gateway (presence, typing, message delivery) |
| `apps/worker` | Background jobs: email, webhooks, triggers, analytics, retention |
| `apps/web` | Next.js dashboard, super-admin console, public knowledge base |
| `apps/widget` | `loader.js` + the panel — the surface that runs on customer sites |
| `apps/test-site` | A real website with the widget installed the way a customer installs it |
| `packages/core` | Domain services shared by api, realtime and worker |
| `packages/database` | Prisma schema, migrations, seed |
| `docs/` | Architecture, database, API, realtime, widget, security, testing, deployment |

## Documentation

[Project plan](docs/PROJECT_PLAN.md) ·
[Architecture](docs/ARCHITECTURE.md) ·
[Database](docs/DATABASE.md) ·
[API](docs/API.md) ·
[Realtime](docs/REALTIME.md) ·
[Widget](docs/WIDGET.md) ·
[Security](docs/SECURITY.md) ·
[Testing](docs/TESTING.md) ·
[Deployment](docs/DEPLOYMENT.md) ·
[Docker](docs/DOCKER.md) ·
[Roadmap](docs/ROADMAP.md) ·
[Decisions](docs/DECISIONS.md)

## Status

Phase 0 (foundation) complete. See [`docs/ROADMAP.md`](docs/ROADMAP.md) for the current phase.
