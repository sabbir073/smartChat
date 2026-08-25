# SmartChat — Local Development Setup

Target environment: Windows + Docker Desktop (macOS and Linux work identically).

## 1. Prerequisites

| Tool | Minimum | Check |
| --- | --- | --- |
| Docker Desktop | 24+ with Compose v2 | `docker compose version` |
| Node.js | 20.11+ | `node -v` |
| pnpm | 9+ | `corepack enable && pnpm -v` |
| Git | 2.40+ | `git --version` |

Docker Desktop needs at least 4 GB of memory allocated (Settings → Resources).

## 2. First run

```bash
git clone <repo> smartchat && cd smartchat
cp .env.example .env          # Windows PowerShell: Copy-Item .env.example .env
docker compose up -d
```

`.env` already selects the dev overlay:

```
COMPOSE_PATH_SEPARATOR=:
COMPOSE_FILE=docker-compose.yml:docker-compose.dev.yml
```

`COMPOSE_PATH_SEPARATOR` matters on Windows — without it, Compose splits `COMPOSE_FILE` on `;` and
fails to find the files.

Then apply the schema and load demo data:

```bash
docker compose exec api pnpm db:deploy
docker compose exec api pnpm db:seed
```

## 3. Where things are

| Service | URL |
| --- | --- |
| Dashboard | http://localhost:3000 |
| API | http://localhost:3001 |
| Realtime | http://localhost:3002 |
| Widget assets | http://localhost:3003 |
| **Test website** | http://localhost:3004 |
| Mailpit (all outbound email) | http://localhost:8025 |
| MinIO console | http://localhost:9101 |
| Postgres | `localhost:55432` |
| Redis | `localhost:56379` |

Credentials for local infrastructure are in `.env`. They are development values and are safe only
because nothing here is exposed beyond your machine.

## 4. Seeded accounts

Created by `pnpm db:seed`. These exist only in development seeds and are never used anywhere else.

| Role | Email | Password |
| --- | --- | --- |
| Account owner | `owner@demo.test` | `Demo!Passw0rd` |
| Agent | `agent@demo.test` | `Demo!Passw0rd` |
| Platform super admin | value of `SUPERADMIN_EMAIL` | value of `SUPERADMIN_PASSWORD` |

## 5. Everyday commands

```bash
docker compose ps                     # what is running and healthy
docker compose logs -f api            # follow one service
docker compose restart api            # restart one service
docker compose down                   # stop everything, keep data
docker compose down -v                # stop and DELETE all data volumes
docker compose exec postgres psql -U smartchat -d smartchat

pnpm db:migrate                       # create + apply a migration
pnpm db:reset                         # drop, re-migrate, re-seed
pnpm db:studio                        # Prisma Studio

pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

## 6. Running an app outside Docker

Useful for debugger attach. Point the app at the published host ports instead of the internal ones:

```bash
DATABASE_URL=$DATABASE_URL_HOST REDIS_URL=$REDIS_URL_HOST pnpm --filter @smartchat/api dev
```

Stop the containerised copy of that one service first (`docker compose stop api`) so the port is
free.

## 7. Windows notes

- Keep the repository on the Windows filesystem (`C:\...`) and let Docker Desktop bind-mount it, or
  move it into WSL2 for faster file watching. Do not mix the two.
- `node_modules` is never bind-mounted into containers — each container installs its own — so
  Windows-built native binaries can never leak into a Linux container.
- Line endings are pinned to LF by `.gitattributes`. If you cloned before that landed:
  `git config core.autocrlf false && git rm --cached -r . && git reset --hard`.

## 8. Troubleshooting

See `TROUBLESHOOTING.md`. The three most common issues:

- **Port already in use** — change the `*_PORT` value in `.env` and `docker compose up -d` again.
- **`db:deploy` cannot reach the database** — the api container reads `DATABASE_URL` (host
  `postgres`); a host shell needs `DATABASE_URL_HOST` (host `localhost:55432`).
- **Widget does not appear on the test site** — check the property's allowed domains include
  `localhost`, and look at the browser console and `docker compose logs api`.
