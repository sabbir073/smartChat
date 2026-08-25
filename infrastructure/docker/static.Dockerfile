# =============================================================================
# Static asset image for the widget bundle and the demo test website.
#
# The widget is served by nginx rather than Node: it is immutable, content-hashed output on the
# hot path of every customer's page load, so it should be as close to a CDN origin as possible.
# =============================================================================

ARG NODE_VERSION=22-alpine

FROM node:${NODE_VERSION} AS build
ARG APP
RUN apk add --no-cache libc6-compat
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@smartchat/${APP}...

FROM nginx:1.27-alpine AS runtime
ARG APP
COPY --from=build /app/apps/${APP}/dist /usr/share/nginx/html
COPY infrastructure/nginx/static.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
