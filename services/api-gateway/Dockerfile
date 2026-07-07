# syntax=docker/dockerfile:1.7
# ProjexCloud api-gateway — production image.
# Multi-stage: build the whole workspace, then ship the runtime with only the
# compiled dist + node_modules. Mirrors services/semantic-service/Dockerfile.
#
# The api-gateway imports ~90 workspace SDKs (packages/*) and auto-runs every
# SDK migration on first boot, so the build stage needs the full packages/ and
# services/ trees. native/ and tools/ are workspace members too (some packages
# depend on them), so the frozen-lockfile install needs them present.
#
# INCREMENTAL BUILDS: the pnpm store and Turbo (v2) cache are BuildKit cache
# mounts that PERSIST across image builds on this host. So a rebuild:
#   - does NOT re-download the ~780 deps (pnpm reuses the mounted store), and
#   - does NOT recompile unchanged packages — `turbo run build` restores their
#     dist/ from the mounted .turbo cache; only packages whose inputs changed
#     (and their dependents) actually run tsc.
# A one-file change therefore rebuilds in minutes instead of recompiling all ~90
# packages. Requires BuildKit (Compose v2 / DOCKER_BUILDKIT=1) — the `# syntax`
# line above enables the RUN --mount=type=cache directives.
#
# Further scope reduction (optional): swap `pnpm -w build` for
#   pnpm exec turbo run build --filter=@projexlight/api-gateway...
# to compile ONLY the gateway + its workspace deps (skips the other services and
# apps that ship as their own images). Left as `-w build` here so the image is
# byte-for-byte the same graph it has always built; enable the filter once the
# gateway's package.json is confirmed to declare every SDK it imports.
FROM node:20-alpine AS build
WORKDIR /workspace
# corepack ships pnpm 9 pinned by package.json "packageManager".
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json turbo.json .npmrc ./
COPY packages ./packages
COPY services ./services
COPY native ./native
COPY tools ./tools
# sdk-asset / sdk-trace / sdk-diagnostic-telemetry build scripts run
# `node ../../scripts/copy-ch-migrations.mjs`, so scripts/ must be in the image.
COPY scripts ./scripts
# All @projexlight/* deps are workspace:* so the install never hits the
# Verdaccio registry referenced by .npmrc — it resolves from the workspace.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    --mount=type=cache,id=turbo-cache,target=/workspace/.turbo \
    pnpm install --frozen-lockfile --store-dir=/pnpm-store && \
    pnpm -w build

FROM node:20-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache curl   # used by the compose healthcheck
COPY --from=build /workspace /app
EXPOSE 3000
ENV NODE_ENV=production
# Migrations run automatically inside app.ts on boot (runMigrations[...]).
CMD ["node", "services/api-gateway/dist/app.js"]
