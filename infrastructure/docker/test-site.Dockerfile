# =============================================================================
# The demo customer website.
#
# Plain static HTML with the installation snippet injected at build time, served by nginx. It has
# no dependency on anything of ours at runtime, which is the point.
# =============================================================================

ARG NODE_VERSION=22-alpine

FROM node:${NODE_VERSION} AS build
WORKDIR /app
COPY apps/test-site/ ./
ARG WIDGET_URL=http://localhost:3003
ARG TEST_SITE_PROPERTY_ID=prp_DEMKTESTSTE00001
ENV WIDGET_URL=${WIDGET_URL}
ENV TEST_SITE_PROPERTY_ID=${TEST_SITE_PROPERTY_ID}
RUN node build.mjs

FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/dist /usr/share/nginx/html
COPY infrastructure/nginx/test-site.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
