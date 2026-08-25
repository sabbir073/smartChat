# =============================================================================
# Next.js dashboard.
#
# Uses Next's standalone output: the final image contains the server bundle and only the
# node_modules files tracing found to be reachable, rather than the whole workspace.
# =============================================================================

ARG NODE_VERSION=22-alpine

FROM node:${NODE_VERSION} AS base
RUN apk add --no-cache libc6-compat wget
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

FROM base AS build
# development, deliberately: `pnpm install` skips devDependencies when NODE_ENV=production, and
# the build needs TypeScript and Tailwind. Only the runtime stage is production.
ENV NODE_ENV=development
ENV NEXT_TELEMETRY_DISABLED=1

# Manifests first, so `pnpm install` is cached independently of source changes.
# See node.Dockerfile for the reasoning; keep the two lists in step.
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
COPY apps/web/package.json             apps/web/
COPY apps/widget/package.json          apps/widget/
COPY apps/test-site/package.json       apps/test-site/

RUN pnpm install --frozen-lockfile

COPY . .
# build.mjs pins NODE_ENV=production for `next build` itself; the install above deliberately ran
# with NODE_ENV=development so devDependencies were present.
RUN NEXT_OUTPUT_STANDALONE=1 pnpm turbo run build --filter=@smartchat/web...

FROM node:${NODE_VERSION} AS runtime
RUN apk add --no-cache wget
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

# The standalone output already contains its own trimmed node_modules.
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/public ./apps/web/public

USER node
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
CMD ["node", "apps/web/server.js"]
