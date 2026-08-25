# =============================================================================
# Shared image for the Node services (api, realtime, worker).
#
#   docker build -f infrastructure/docker/node.Dockerfile --build-arg APP=api .
#
# One Dockerfile rather than three near-identical ones: the services differ only in which
# workspace package is built and which entrypoint runs.
# =============================================================================

ARG NODE_VERSION=22-alpine

# ---- base -------------------------------------------------------------------
FROM node:${NODE_VERSION} AS base
# openssl is required by Prisma's query engine, libc6-compat by some native modules on musl,
# and wget by the container health checks.
RUN apk add --no-cache openssl libc6-compat wget
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

# ---- build ------------------------------------------------------------------
FROM base AS build
ARG APP
ENV NODE_ENV=development
ENV CI=true

# Manifests only, first.
#
# `pnpm install` is the slowest step in the image by a wide margin. Copying just the manifests
# means it is re-run only when a dependency actually changes, instead of on every source edit.
# Adding a workspace package means adding a line here - the cost of one line for a two-minute
# saving on every rebuild.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc turbo.json tsconfig.base.json ./
COPY packages/config/package.json      packages/config/
COPY packages/core/package.json        packages/core/
COPY packages/database/package.json    packages/database/
COPY packages/logger/package.json      packages/logger/
COPY packages/types/package.json       packages/types/
COPY packages/ui/package.json          packages/ui/
COPY packages/validation/package.json  packages/validation/
COPY apps/api/package.json             apps/api/
COPY apps/worker/package.json          apps/worker/
COPY apps/web/package.json             apps/web/

RUN pnpm install --frozen-lockfile

# The Prisma client is generated from the schema alone, so it caches on the schema rather than
# on the whole source tree.
COPY packages/database/prisma packages/database/prisma
RUN pnpm --filter @smartchat/database exec prisma generate

COPY . .
# `...` builds the target package and everything it depends on, and nothing else.
RUN pnpm turbo run build --filter=@smartchat/${APP}...

# ---- runtime ----------------------------------------------------------------
FROM base AS runtime
ARG APP
ENV NODE_ENV=production

COPY --from=build --chown=node:node /app /app
WORKDIR /app/apps/${APP}

USER node
EXPOSE 3001
CMD ["node", "dist/index.js"]
