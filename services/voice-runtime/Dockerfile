# voice-runtime (VA·E1) — LiveKit agent worker.
#
# Debian (glibc), not Alpine: @livekit/rtc-node's native media binding ships glibc builds
# only. Builds ONLY this service and its workspace deps (turbo filter) with the same
# BuildKit cache mounts as the gateway image, so it does not rebuild the ~90 SDKs.
#
#   docker build -f services/voice-runtime/Dockerfile -t projexcloud/voice-runtime .
FROM node:20-bookworm-slim AS build
WORKDIR /workspace
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json turbo.json .npmrc ./
COPY packages ./packages
COPY services ./services
COPY native ./native
COPY tools ./tools
COPY scripts ./scripts
RUN --mount=type=cache,id=pnpm-store-glibc,target=/pnpm-store \
    --mount=type=cache,id=turbo-cache-voice,target=/workspace/.turbo \
    pnpm install --frozen-lockfile --store-dir=/pnpm-store --filter "@projexlight/voice-runtime..." && \
    pnpm exec turbo run build --filter="@projexlight/voice-runtime..." && \
    pnpm --filter @projexlight/voice-runtime --prod deploy /deploy

# Only the service and its production dependency closure (pnpm deploy), not the whole
# workspace's node_modules — keeps the image small.
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
COPY --from=build /deploy /app
ENV NODE_ENV=production \
    VOICE_RUNTIME_HEALTH_PORT=8081
EXPOSE 8081
# SIGTERM starts a drain: no new calls, live calls run to completion. The orchestrator's
# grace period (compose stop_grace_period) must cover VOICE_RUNTIME_DRAIN_TIMEOUT_MS.
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.VOICE_RUNTIME_HEALTH_PORT||8081)+'/livez').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/main.js"]
