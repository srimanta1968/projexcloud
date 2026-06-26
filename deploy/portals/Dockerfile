# syntax=docker/dockerfile:1
# Generic builder for the three ProjexCloud Next.js portals (standalone output).
# Built from the repo ROOT context. One image per app via --build-arg APP=<dir>.
#
#   docker build -f deploy/portals/Dockerfile \
#     --build-arg APP=projexcloud-admin \
#     --build-arg NEXT_PUBLIC_BASE_PATH=/console \
#     --build-arg NEXT_PUBLIC_GATEWAY_URL=https://cloud.projexlight.com \
#     -t projexcloud/portal-projexcloud-admin:local .
#
# basePath/asset prefixes are baked at build time, so they MUST be passed here.

FROM node:20-alpine AS build
WORKDIR /workspace
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
# Context + install come FIRST and are app-agnostic, so this layer is shared
# (cached) across all three portal builds — one install, three quick builds.
COPY . .
RUN pnpm install --frozen-lockfile
# App-specific args declared late so they don't invalidate the install layer.
# NEXT_PUBLIC_* are baked into the client bundle at build time.
ARG APP
ARG NEXT_PUBLIC_BASE_PATH=""
ARG NEXT_PUBLIC_GATEWAY_URL="https://cloud.projexlight.com"
ARG NEXT_PUBLIC_API_BASE="https://cloud.projexlight.com"
ARG NEXT_PUBLIC_HOSTED_MCP="https://cloud.projexlight.com"
ENV NEXT_PUBLIC_BASE_PATH=$NEXT_PUBLIC_BASE_PATH \
    NEXT_PUBLIC_GATEWAY_URL=$NEXT_PUBLIC_GATEWAY_URL \
    NEXT_PUBLIC_API_BASE=$NEXT_PUBLIC_API_BASE \
    NEXT_PUBLIC_HOSTED_MCP=$NEXT_PUBLIC_HOSTED_MCP
RUN pnpm --filter "@projexlight/${APP}" build

FROM node:20-alpine AS runtime
ARG APP
ARG NEXT_PUBLIC_BASE_PATH=""
ENV APP=${APP} \
    BASE_PATH=${NEXT_PUBLIC_BASE_PATH} \
    NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app
RUN apk add --no-cache curl
# Next standalone bundles a minimal node_modules + a copy of the workspace tree.
COPY --from=build /workspace/apps/${APP}/.next/standalone ./
COPY --from=build /workspace/apps/${APP}/.next/static ./apps/${APP}/.next/static
COPY --from=build /workspace/apps/${APP}/public ./apps/${APP}/public
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=5 \
  CMD curl -fsS "http://localhost:3000${BASE_PATH}/" -o /dev/null || exit 1
CMD ["sh","-c","node apps/${APP}/server.js"]
