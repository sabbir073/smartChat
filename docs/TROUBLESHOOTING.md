# SmartChat — Troubleshooting

Problems that have actually happened, and what fixed them.

## Docker Compose

**`GetFileAttributesEx ...docker-compose.yml:docker-compose.dev.yml: The system cannot find the file`**
Windows. Compose splits `COMPOSE_FILE` on `;` there, not `:`. `.env` must contain
`COMPOSE_PATH_SEPARATOR=:` alongside `COMPOSE_FILE`.

**A service will not start and `docker compose logs <service>` mentions a missing variable**
Every required value has a `${VAR:?message}` guard in `docker-compose.yml`, so Compose names the
variable it needs. Compare your `.env` against `.env.example`.

**Port already in use**
Change the relevant `*_PORT` in `.env` and run `docker compose up -d` again. Development ports are
deliberately non-default (Postgres 55432, Redis 56379) because developer machines usually already
have something on 5432 and 6379.

**`docker compose up` succeeds but a container keeps restarting**
`docker compose logs -f <service>`. Application containers exit deliberately on invalid
configuration rather than starting in a broken state, and the reason is the first line of output.

## pnpm

**`pnpm install` appears to hang with no output**
It is waiting on `The modules directories will be removed and reinstalled from scratch. Proceed?`
`.npmrc` sets `confirm-modules-purge=false` to prevent this. If you see it, your `.npmrc` is stale.

**devDependencies are missing after install**
`NODE_ENV` is set to `production` in your shell. pnpm skips devDependencies when it is. Run
`NODE_ENV=development pnpm install` (PowerShell: `$env:NODE_ENV='development'`).

**`ERR_PNPM_OUTDATED_LOCKFILE` during a Docker build**
A `package.json` changed without `pnpm install` being run. Run it on the host to refresh
`pnpm-lock.yaml`, then rebuild.

## Prisma

**`type "citext" does not exist` when creating a migration**
Prisma's shadow database is a fresh database without our extensions. They are created at the top of
the first migration for exactly this reason — do not move them out into an init script only.

**`prisma migrate dev` cannot reach the database from a host shell**
Containers use `DATABASE_URL` (host `postgres`); a host shell needs `DATABASE_URL_HOST`
(`localhost:55432`). `packages/database/.env` carries the host URL for the CLI, and is gitignored
and dockerignored so it can never leak into an image.

**`Unknown argument 'accountId'` in a nested create**
Child tables reference their parent with a composite key that includes `account_id`, so Prisma
derives it from the parent in a nested write. Set it explicitly only in a top-level create.

## Build

**`error TS5074: Option '--incremental' can only be specified using tsconfig...`**
tsup's declaration build conflicts with `incremental`. It is deliberately absent from
`tsconfig.base.json`.

**`EPERM: operation not permitted, symlink` during `next build`**
Windows cannot create symlinks without elevation, and Next's standalone output needs them.
Standalone is enabled only when `NEXT_OUTPUT_STANDALONE=1`, which only the Dockerfile sets — see
ADR-013. A plain `pnpm build` on Windows is expected to produce a non-standalone build.

**`Cannot access ambient const enums when 'isolatedModules' is enabled`**
A dependency exported a `const enum`. Pin the value locally with a comment and a test that asserts
it still matches, rather than turning off `isolatedModules`.

## Runtime

**The worker exits with `BullMQ: Your redis options maxRetriesPerRequest must be null`**
BullMQ needs a connection with blocking commands enabled. `createRedisClient` preserves an explicit
`null` (an earlier version used `?? 3`, which silently replaced it). Covered by a regression test in
`packages/core/src/redis/client.test.ts`.

**The dashboard shows "Could not reach the server"**
The browser is calling the API URL rendered into the page. Check `API_URL` in `.env`, that the api
container is healthy (`docker compose ps`), and that the browser's origin is in
`CORS_DASHBOARD_ORIGINS`.

**Every request fails with 403 CSRF_TOKEN_INVALID**
The `sc_csrf` cookie is missing or does not match the session. Sign out and back in. It is set
alongside the session and is deliberately readable by script — that is what makes the double-submit
check work.

**The smoke test fails with a cascade of 401s**
The registration limiter tripped. `scripts/smoke.mjs` clears rate-limit keys before running; set
`SMOKE_RESET_LIMITS=0` to keep them if the limiter itself is what you are investigating.
