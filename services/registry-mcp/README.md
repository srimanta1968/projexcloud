# @projexlight/registry-mcp

P9 / E3 Phase 2 — **hosted** registry MCP service.

Counterpart to `packages/registry-mcp-local` (which runs in-process via stdio
for developers checked out against the monorepo). This service runs as a long-
lived HTTP daemon and exposes the same `projex_registry_*` tool surface over
SSE so non-monorepo ProjexCloud customers can use the discovery + install loop
from any MCP-aware AI client.

## Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET    | `/healthz`        | none  | catalog + embedding + session counters |
| GET    | `/mcp/sse`        | JWT   | open the SSE event stream + start an MCP session |
| POST   | `/mcp/messages?sessionId=…` | JWT | client → server JSON-RPC message channel |

`/mcp/sse` is the entry point: the client establishes an SSE connection and
the server returns a `sessionId` it must pass on subsequent POSTs.

## Configuration

```
REGISTRY_MCP_PORT                 default 3600
REGISTRY_MCP_HOST                 default 0.0.0.0
REGISTRY_MCP_CATALOG_PATH         REQUIRED — path to registry.catalog.json
REGISTRY_MCP_EMBEDDINGS_BIN       optional — path to registry.embeddings.bin
REGISTRY_MCP_EMBEDDINGS_META      optional — path to registry.embeddings.meta.json
REGISTRY_MCP_AUTH_MODE            "jwt" (default) | "disabled"
REGISTRY_MCP_RATE_LIMIT           default 120 — per-tenant calls/minute
JWT_SECRET                        REQUIRED for jwt mode (six-layer claim shape)
```

## Auth

Bearer-token JWTs verified against `sdk-identity`'s six-layer claim shape
(`sub`, `tenant_id`, `org_id`, …). Every tool call is annotated with the
caller's `tenant_id` (or `sub` for org-less tokens) for metering + audit.

## Rate limit

Per-tenant token bucket, in-process. For prod replicas, swap
`createInProcessRateLimiter` for a Redis-backed limiter so the quota survives
horizontal scale.

## Tool set

Re-exports `READ_TOOLS` + `dispatchTool` from `@projexlight/registry-mcp-local`
so behavior matches the stdio variant byte-for-byte. Hosted-only additions
(scaffold-with-server-side-persist, deploy) are deferred to a later phase.
