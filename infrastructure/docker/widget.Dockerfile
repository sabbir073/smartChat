# =============================================================================
# The widget: loader.js plus the panel bundle, served by nginx.
#
# nginx rather than Node because this is immutable, content-hashed output on the hot path of every
# customer page load - it should behave like a CDN origin.
# =============================================================================

ARG NODE_VERSION=22-alpine

FROM node:${NODE_VERSION} AS build
RUN apk add --no-cache libc6-compat
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

# Manifests first, so `pnpm install` caches independently of source changes.
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
COPY apps/widget/package.json          apps/widget/
COPY apps/test-site/package.json       apps/test-site/

RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm turbo run build --filter=@smartchat/widget...

FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/apps/widget/dist /usr/share/nginx/html
COPY infrastructure/nginx/widget.conf /etc/nginx/conf.d/default.conf
COPY infrastructure/docker/widget-entrypoint.sh /docker-entrypoint.d/40-smartchat-runtime.sh
RUN chmod +x /docker-entrypoint.d/40-smartchat-runtime.sh
EXPOSE 80
