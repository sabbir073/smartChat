# SmartChat — Docker Reference

## 1. File layout

| File | Purpose |
| --- | --- |
| `docker-compose.yml` | Base. Service definitions, volumes, network, health checks. Never used alone. |
| `docker-compose.dev.yml` | Dev overlay: publishes host ports, adds Mailpit, bind-mounts source, hot reload. |
| `docker-compose.prod.yml` | Prod overlay: resource limits, tuned Postgres, no published infra ports. |
| `.env` | Selects the overlay via `COMPOSE_FILE`, supplies all configuration. Gitignored. |

Because `.env` sets `COMPOSE_FILE`, plain `docker compose <cmd>` resolves the right pair. To target
production explicitly:

```bash
COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml docker compose up -d
```

## 2. Services

| Service | Image / build | Ports (dev) | Health check |
| --- | --- | --- | --- |
| `postgres` | `postgres:16-alpine` | 55432→5432 | `pg_isready` |
| `redis` | `redis:7-alpine` | 56379→6379 | `redis-cli ping` |
| `minio` | `minio/minio` | 9100→9000, 9101→9001 | `/minio/health/live` |
| `minio-init` | `minio/mc` | — | one-shot bucket creation |
| `mailpit` | `axllent/mailpit` | 1025, 8025 | built-in |
| `api` | `apps/api/Dockerfile` | 3001 | `GET /ready` |
| `realtime` | `apps/realtime/Dockerfile` | 3002 | `GET /ready` |
| `worker` | `apps/worker/Dockerfile` | — | queue heartbeat |
| `web` | `apps/web/Dockerfile` | 3000 | `GET /api/health` |
| `widget` | `apps/widget/Dockerfile` | 3003 | `GET /healthz` |
| `test-site` | `apps/test-site/Dockerfile` | 3004 | `GET /` |

## 3. Startup ordering

`depends_on` uses `condition: service_healthy` for Postgres, Redis and MinIO, so application
containers never start against a database that is still initialising. Migrations run as an explicit
step, never implicitly on boot — an application container must never mutate the schema on start.

## 4. Image strategy

- Multi-stage builds: `deps` → `build` → `runtime`, with `node:22-alpine` at runtime.
- Only production dependencies and compiled output land in the final image.
- Containers run as a non-root user.
- `.dockerignore` excludes `node_modules`, `.next`, `dist`, `.git` and `.env`, so host artefacts can
  never leak into an image.
- `node_modules` is never bind-mounted from the host — each container installs its own, so a
  Windows-built native module can never end up inside a Linux container.

## 5. Volumes

`postgres_data`, `redis_data`, `minio_data` are named volumes and survive `docker compose down`.
They do **not** survive `docker compose down -v`, which is the reset command.

## 6. Common operations

```bash
docker compose up -d --build          # rebuild changed images and start
docker compose logs -f --tail=100 api
docker compose exec api sh
docker compose exec postgres psql -U smartchat -d smartchat
docker compose ps --format '{{.Name}} {{.Status}}'
docker compose down -v                # full reset, destroys data
docker compose config                 # render the merged configuration
```

## 7. Resource expectations

The full dev stack fits comfortably in 4 GB. On a 2 vCPU / 4 GB VPS the production overlay caps
Postgres at 2 GB and Redis at 768 MB, leaving room for the application containers and the proxy.
