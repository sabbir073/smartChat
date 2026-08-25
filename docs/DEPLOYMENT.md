# SmartChat — Deployment

The same Docker topology runs in both environments. Only the overlay file and the environment
variables differ. There is no separate production architecture to drift out of sync.

```
development : docker-compose.yml + docker-compose.dev.yml   (Docker Desktop, Windows/macOS/Linux)
production  : docker-compose.yml + docker-compose.prod.yml  (one Linux VPS)
```

## 1. Local (Docker Desktop)

Full instructions in `LOCAL_SETUP.md`. Summary:

```bash
cp .env.example .env
docker compose up -d
docker compose exec api pnpm db:deploy
docker compose exec api pnpm db:seed
```

| Service | URL |
| --- | --- |
| Dashboard | http://localhost:3000 |
| API | http://localhost:3001 |
| Realtime | http://localhost:3002 |
| Widget assets | http://localhost:3003 |
| Test website | http://localhost:3004 |
| Mailpit | http://localhost:8025 |
| MinIO console | http://localhost:9101 |
| Postgres | localhost:55432 |
| Redis | localhost:56379 |

Non-default host ports are deliberate: developer machines usually already have something on 5432 and
6379.

## 2. Production (single VPS)

Full instructions in `PRODUCTION_DEPLOYMENT.md`. Shape:

```
internet ──► nginx (TLS termination, Let's Encrypt)
                ├── app.example.com   → web
                ├── api.example.com   → api
                ├── ws.example.com    → realtime  (WebSocket upgrade)
                └── cdn.example.com   → widget assets
```

Infrastructure ports are not published to the host in the production overlay; only the proxy is
exposed. Postgres, Redis and MinIO are reachable on the internal Docker network only.

## 3. Release procedure

1. CI is green on `main` (lint, typecheck, unit, integration, isolation, build, docker build).
2. Tag the release; images are built and tagged with the commit SHA.
3. On the server: `docker compose pull`.
4. Back up the database — and confirm the backup file exists and restores.
5. `docker compose run --rm api pnpm db:deploy` (migrations are forward-only and additive).
6. `docker compose up -d` — the proxy drains and swaps containers.
7. Verify `/health` and `/ready` on api and realtime, then run the smoke suite against production.

## 4. Rollback

Because migrations are additive and deploy-before-cutover, rollback is an image rollback:

```bash
docker compose down api web realtime worker
IMAGE_TAG=<previous-sha> docker compose up -d api web realtime worker
```

A migration that cannot be rolled back this way must be split into expand → backfill → contract
across two releases. That rule is what makes rollback safe, and it is enforced in review.

## 5. Health and observability

- `/health` — process is alive. No dependency checks, so it never cascades.
- `/ready` — Postgres, Redis and object storage reachable. Used by the proxy and by `depends_on`.
- Structured JSON logs with request id, account id, property id and conversation id.
- Prometheus-compatible `/metrics` on api, realtime and worker; Sentry DSN optional via env.

## 6. Backups

`BACKUP_RESTORE.md` has the full procedure. Nightly `pg_dump` with retention, object storage
mirrored, and — the part that actually matters — a **scheduled restore rehearsal into a scratch
database**. An untested backup is not a backup.
