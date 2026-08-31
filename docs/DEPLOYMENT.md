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

1. CI is green on `master` (format, lint, typecheck, unit tests, build, docker build, migrations
   from empty, schema-drift check, every end-to-end suite, and both rehearsals).
2. Tag the release; images are built and tagged with the commit SHA.
3. On the server: `docker compose pull`.
4. Back up the database — and confirm the backup file exists and restores.
5. `docker compose run --rm api pnpm db:deploy` (migrations are forward-only and additive).
6. `docker compose up -d` — the proxy drains and swaps containers.
7. Verify `/health` and `/ready` on api and realtime, then run the smoke suite against production.

## 4. Rollback

Say the uncomfortable part first: **a migration cannot be un-run.** Prisma has no `down`, and this
project does not pretend otherwise. What that means in practice is that rollback has two shapes, and
knowing which one you are in is the whole procedure.

**If the release was additive** — it only added tables, columns, indexes or defaults — the new schema
still serves the previous release, so putting the images back is a complete rollback and nothing is
lost:

```bash
IMAGE_TAG=<previous-sha> docker compose up -d api web realtime worker widget
```

**If the release dropped, renamed or narrowed anything**, the old image will look for something that
is no longer there. Images alone are not enough, and the pre-deploy backup taken at step 4 above is
not optional:

```bash
IMAGE_TAG=<previous-sha> docker compose up -d api web realtime worker widget   # first: stop the bleeding
./infrastructure/backup/restore.sh <pre-deploy-backup>                          # then: put the data back
```

Restoring costs every write since the backup, which is why the rule below matters more than the
procedure: a migration that removes something must be split into **expand → backfill → contract**
across two releases, so that no single deploy is ever in the second category. Enforced in review.

`node scripts/rollback-rehearsal.mjs` performs all of this rather than describing it. It checks that
the image tag flows through both compose files and can select a real image, it damages a scratch copy
of the database and restores it, and it prints **every migration in the repository classified as
additive or destructive** — which is the fact you need at 2am and the one nobody remembers. CI runs
it on every change.

Rolling back the database alone, without the images, is not a supported operation: the new code
expects the new schema.

## 5. Health and observability

- `/health` — process is alive. No dependency checks, so it never cascades.
- `/ready` — Postgres, Redis and object storage reachable. Used by the proxy and by `depends_on`.
- Structured JSON logs with request id, account id, property id and conversation id.
- Prometheus-compatible `/metrics` on api, realtime and worker; Sentry DSN optional via env.

## 6. Backups

`BACKUP_RESTORE.md` has the full procedure. Nightly `pg_dump` with retention, object storage
mirrored, and — the part that actually matters — a **scheduled restore rehearsal into a scratch
database**. An untested backup is not a backup.
