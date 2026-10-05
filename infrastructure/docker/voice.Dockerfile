# =============================================================================
# The voice agent (apps/voice).
#
#   docker build -f infrastructure/docker/voice.Dockerfile .
#
# Its own Dockerfile rather than another APP argument to node.Dockerfile for one reason: the
# media client (@livekit/rtc-node) ships a native binary built against glibc
# (rtc-node.linux-x64-gnu.node), which does not load on Alpine's musl, libc6-compat or not. So
# this image is Debian. Everything else mirrors node.Dockerfile step for step - pnpm through
# corepack, manifests before sources so the install layer caches, the Prisma client generated
# from the schema alone, one turbo build of the package and what it depends on, and a runtime
# stage that runs as `node`.
# =============================================================================

ARG NODE_VERSION=22-bookworm-slim

# ---- base -------------------------------------------------------------------
FROM node:${NODE_VERSION} AS base
# openssl is required by Prisma's query engine; wget by the container health check; ca-certificates
# so the fallback AI provider can be reached over TLS.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl wget ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

# ---- build ------------------------------------------------------------------
FROM base AS build
ENV NODE_ENV=development
ENV CI=true

# Manifests only, first: `pnpm install` is re-run only when a dependency changes, not on every
# source edit. Every workspace package is listed because the lockfile names them all and a
# frozen install refuses a workspace that does not match it.
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
COPY apps/realtime/package.json        apps/realtime/
COPY apps/voice/package.json           apps/voice/
COPY apps/web/package.json             apps/web/
COPY apps/widget/package.json          apps/widget/
COPY apps/test-site/package.json       apps/test-site/

RUN pnpm install --frozen-lockfile

# The Prisma client is generated from the schema alone, so it caches on the schema rather than
# on the whole source tree.
COPY packages/database/prisma packages/database/prisma
RUN pnpm --filter @smartchat/database exec prisma generate

COPY . .
# `...` builds the voice agent and everything it depends on, and nothing else.
RUN pnpm turbo run build --filter=@smartchat/voice...

# ---- runtime ----------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production

COPY --from=build --chown=node:node /app /app
WORKDIR /app/apps/voice

USER node
EXPOSE 3004
CMD ["node", "dist/index.js"]
