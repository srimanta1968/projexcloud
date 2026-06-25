# Local LLM & SDK Discovery

Answers a common question: **"is the local LLM we use for discovery part of the
Docker setup?"**

**Short answer:** SDK *discovery* does **not** run as a separate LLM container.
The discovery model is an **in-process embedding model** — there is no LLM
server to add to `docker-compose`. The only Docker concern is caching that
model's weights (~33 MB) so it isn't re-downloaded. A *separate, optional* local
**generation** LLM (Ollama / vLLM) exists only for on-prem/air-gapped
deployments and is operator-supplied. Both are covered below for dev and prod.

## 1. The two things people mean by "local LLM"

| | **Discovery embeddings** | **On-prem generation LLM** |
|---|---|---|
| Purpose | Intent → SDK semantic search (catalog RAG) | Text/chat completions for tenants |
| Model | `Xenova/bge-small-en-v1.5` (INT8 ONNX, 384-dim) | e.g. `llama-3.1-70b-instruct` |
| Runtime | **In-process** via `@huggingface/transformers` | **External server**: Ollama / vLLM |
| Container? | **No** — runs inside `registry-mcp` / gateway | Operator-run, in-cluster (P8 Variant C only) |
| Needed by default? | Yes (discovery) | No (only air-gapped/sovereign deploys) |
| Code | `packages/sdk-registry/src/embeddings.ts` | `sdk-ai-gateway` `localProviderResolver` + `sdk-onprem` |

## 2. How discovery actually works (no server)

- The SDK catalog and a **prebuilt vector index ship committed** in
  `packages/sdk-registry/dist/`:
  `registry.catalog.json`, `registry.embeddings.bin`, `registry.embeddings.meta.json`.
- The **`registry-mcp` service** (port `3600`) is the discovery / MCP surface.
  It loads that prebuilt index at boot (`embeddings=loaded`).
- To answer a query it embeds the **live intent string** with the in-process
  `bge-small` ONNX model (lazy-loaded on first query). The model file is fetched
  once from Hugging Face and cached, then runs fully offline — no per-query API
  cost, no network.
- The `api-gateway` only embeds the **whole catalog** when
  `CATALOG_SYNC_ON_BOOT=true` (a one-time/CI reindex job, off by default).

So the "local LLM for discovery" is a 33 MB ONNX file loaded by Node, not a
service. The Docker task is **persisting that file**, not running a container.

## 3. Developer setup

Discovery needs nothing extra for the API gateway. To run the **discovery
service** locally:

```bash
pnpm --filter @projexlight/registry-mcp build
REGISTRY_MCP_CATALOG_PATH=packages/sdk-registry/dist/registry.catalog.json \
REGISTRY_MCP_EMBEDDINGS_BIN=packages/sdk-registry/dist/registry.embeddings.bin \
REGISTRY_MCP_EMBEDDINGS_META=packages/sdk-registry/dist/registry.embeddings.meta.json \
REGISTRY_MCP_AUTH_MODE=disabled \
pnpm --filter @projexlight/registry-mcp start
# → registry-mcp listening on 0.0.0.0:3600 — catalog=NN SDKs, embeddings=loaded
```

The **first** semantic query downloads `bge-small-en-v1.5` (~33 MB) from Hugging
Face; subsequent queries are offline. No GPU required (INT8 CPU ONNX).

> On a machine with no internet, pre-populate the transformers.js cache (set
> `HF_HOME` to a directory you copied from an online machine) before the first
> query.

## 4. Production setup (Docker)

A `discovery` profile is included in `scripts/setup/docker-compose.prod.yml`.
It builds `services/registry-mcp/Dockerfile`, serves the committed catalog +
index, and mounts a named volume (`hf_cache`) so the model downloads **once** and
survives container recreates.

```bash
# Bring up the gateway AND the discovery service:
docker compose --env-file .env.prod -f scripts/setup/docker-compose.prod.yml \
  --profile selfhosted --profile discovery up -d --build
# or, with managed DB/Redis:
docker compose --env-file .env.prod -f scripts/setup/docker-compose.prod.yml \
  --profile managed --profile discovery up -d --build

curl -fsS http://localhost:3600/healthz
```

Relevant env (already defaulted in the image; override in `.env.prod` if needed):

| Variable | Default | Meaning |
|----------|---------|---------|
| `DISCOVERY_PORT` | `3600` | Host port for registry-mcp |
| `REGISTRY_MCP_AUTH_MODE` | `disabled` | `jwt` to require per-tenant auth when exposed |
| `HF_HOME` | `/app/.hf-cache` | transformers.js model cache (mounted as the `hf_cache` volume) |

### Air-gapped / no egress at runtime

Bake the model into the image so no network is needed at runtime: uncomment the
pre-warm `RUN` line in `services/registry-mcp/Dockerfile` (it embeds one string
at build time, populating `HF_HOME`). For air-gapped **builds**, instead copy a
pre-downloaded cache into `/app/.hf-cache` (or mount the `hf_cache` volume
pre-populated). The committed `registry.embeddings.bin` already covers the
catalog vectors; the model is only needed to embed live queries.

## 5. On-prem generation LLM (Ollama / vLLM) — optional, P8 Variant C only

This is **separate from discovery** and only relevant to on-prem/sovereign
deployments that must not call cloud LLMs (`FR-ONP-5/8`):

- The operator runs **Ollama or vLLM in-cluster** and registers each model
  (endpoint URL + model id) in the `onprem.local_llm_model` table.
- `sdk-onprem` registers a resolver into `sdk-ai-gateway`'s
  `localProviderResolver`; the AI gateway then prefers the local model over any
  cloud route. A latency probe (`localLlmProbe`, `ONPREM_PROBE_*` env) disables a
  model whose p99 exceeds budget.
- ProjexCloud ships the **contract**, not the LLM server — the operator supplies
  the Ollama/vLLM deployment and endpoint. It is **not** part of the default
  `docker-compose.prod.yml`. To experiment locally:

  ```bash
  docker run -d --name ollama -p 11434:11434 ollama/ollama
  docker exec -it ollama ollama pull llama3.1
  # then register the endpoint via the on-prem admin flow (sdk-onprem)
  ```

Cloud (non-sovereign) deployments skip this entirely and use the configured
cloud provider keys via `sdk-ai-gateway`.

## 6. So, did the Docker setup miss anything?

No model server was missing — discovery is in-process. What this update adds:

- `services/registry-mcp/Dockerfile` (the discovery service had none).
- A `discovery` profile + persistent `hf_cache` volume in
  `docker-compose.prod.yml` so the embedding model is cached, not re-downloaded.
- This document, covering dev + prod + the air-gapped and on-prem paths.
