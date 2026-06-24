# ProjexCloud api-gateway — production image.
# Multi-stage: build the whole workspace, then ship the runtime with only the
# compiled dist + node_modules. Mirrors services/semantic-service/Dockerfile.
#
# The api-gateway imports ~90 workspace SDKs (packages/*) and auto-runs every
# SDK migration on first boot, so the build stage needs the full packages/ and
# services/ trees. apps/, tools/ and native/ are NOT required by the gateway.
FROM node:20-alpine AS build
WORKDIR /workspace
# corepack ships pnpm 9 pinned by package.json "packageManager".
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json .npmrc ./
COPY packages ./packages
COPY services ./services
# All @projexlight/* deps are workspace:* so the install never hits the
# Verdaccio registry referenced by .npmrc — it resolves from the workspace.
RUN pnpm install --frozen-lockfile && pnpm -w build

FROM node:20-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache curl   # used by the compose healthcheck
COPY --from=build /workspace /app
EXPOSE 3000
ENV NODE_ENV=production
# Migrations run automatically inside app.ts on boot (runMigrations[...]).
CMD ["node", "services/api-gateway/dist/app.js"]
