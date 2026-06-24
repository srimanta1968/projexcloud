# ProjexCloud registry-mcp — SDK discovery / MCP surface.
#
# Serves the SDK catalog + semantic search used for "discovery" (intent → SDK).
# The discovery embedding model (Xenova/bge-small-en-v1.5, INT8 ONNX) runs
# IN-PROCESS via @huggingface/transformers — there is no separate LLM server.
# The catalog + prebuilt vector index ship in packages/sdk-registry/dist; the
# ~33MB model is fetched once on the first live query and cached under HF_HOME.
FROM node:20-alpine AS build
WORKDIR /workspace
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json .npmrc ./
COPY packages ./packages
COPY services ./services
RUN pnpm install --frozen-lockfile && pnpm -w build

FROM node:20-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache curl
COPY --from=build /workspace /app
# Persisted transformers.js model cache (mount a volume here to avoid
# re-downloading the model on every container recreate / for air-gapped warmups).
ENV HF_HOME=/app/.hf-cache
ENV REGISTRY_MCP_CATALOG_PATH=/app/packages/sdk-registry/dist/registry.catalog.json
ENV REGISTRY_MCP_EMBEDDINGS_BIN=/app/packages/sdk-registry/dist/registry.embeddings.bin
ENV REGISTRY_MCP_EMBEDDINGS_META=/app/packages/sdk-registry/dist/registry.embeddings.meta.json
ENV REGISTRY_MCP_PORT=3600
EXPOSE 3600
ENV NODE_ENV=production
# Optional: pre-warm the model into the image so the first query is instant and
# no network is needed at runtime. Requires network at build time; comment out
# for air-gapped builds and mount a pre-populated /app/.hf-cache instead.
# RUN node -e "import('@projexlight/sdk-registry').then(m=>m.createEmbedder()).then(e=>e.embed('warmup')).then(()=>console.log('model cached')).catch(e=>{console.error(e);process.exit(1)})"
CMD ["node", "services/registry-mcp/dist/index.js"]
