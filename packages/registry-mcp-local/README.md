# @projexlight/registry-mcp-local

> P9 / E3 — Local MCP (Model Context Protocol) server for the ProjexCloud SDK catalog.

Plug this into any MCP-aware AI coding tool (Claude Code, Cursor, Windsurf, Cline)
and your AI sees every ProjexCloud SDK by description, can search them semantically,
fetch full manifests, get runnable scenario code, and find compatible SDKs — all
without reading 70 READMEs.

## Why local?

P9's MCP layer is split into a local + hosted pair (per PRD §5.3 / §5.3b):

| | Local (this package) | Hosted (`services/registry-mcp`) |
|---|---|---|
| Lives on | Dev machine, via stdio | Per-region cluster behind api-gateway, via SSE |
| Tools | Read tools (search, manifest, examples, compat) | Read + write (scaffold, deploy, list-my-*) |
| Auth | Local catalog cache | Tenant API key → SixLayer JWT |
| Offline | ✅ Yes — embedded catalog | ❌ No — but local handles reads when offline |
| Latency | <100 ms warm | 100–300 ms (SSE roundtrip) |

Local owns reads (~95% of traffic). Hosted owns writes and tenant-scoped tools.
Same wire protocol — AI clients see no difference.

## Installation

```sh
# Once published to npm:
npm i -g @projexlight/registry-mcp-local

# Or use without install via npx (auto-downloads on first run):
npx -y @projexlight/registry-mcp-local
```

For monorepo development, see `examples/` for the dev-mode config that points
at the in-repo `packages/sdk-registry/dist/registry.catalog.json`.

## Configure your AI tool

See `examples/` for ready-to-paste configs:

- `examples/claude-code-mcp.json` — Claude Code (`~/.claude/mcp.json`)
- `examples/cursor-mcp.json` — Cursor (project root `.cursor/mcp.json`)
- `examples/windsurf-mcp.json` — Windsurf
- `examples/dev-mode-mcp.json` — talks to the in-repo dev catalog (no install needed)

After configuring, restart your AI tool and ask:

> "Search ProjexCloud SDKs for consent management for healthcare"

The AI will call `projex_registry_search_sdks` and return ranked hits.

## Available tools

All tools are prefixed `projex_registry_*` so they coexist with the Projexlight
dev MCP (`projexlight_*` prefix) without name collisions.

| Tool | Use case |
|---|---|
| `projex_registry_search_sdks` | "Find SDKs that handle X" — semantic search via bge-small embeddings |
| `projex_registry_get_manifest` | Full manifest for a named SDK |
| `projex_registry_get_example` | Single runnable scenario from a manifest |
| `projex_registry_list_compatible_sdks` | SDKs that naturally compose (event consume/produce overlap) |
| `projex_registry_list_blueprints` | Vertical blueprints to install (stub until E4) |
| `projex_registry_get_blueprint` | Full blueprint definition (stub until E4) |

## Catalog lookup order

The server searches for the catalog in this order:

1. **`PROJEX_CATALOG_PATH`** env var (absolute path) — overrides everything
2. **`~/.projex/cache/registry.catalog.json`** — user cache (populated by `projex registry refresh` once the CLI ships in E5)
3. **`<PROJEX_DEV_ROOT>/packages/sdk-registry/dist/registry.catalog.json`** — dev-mode fallback

If embeddings are present beside the catalog as `registry.embeddings.bin` +
`registry.embeddings.meta.json`, semantic search uses them; otherwise
substring matching is the fallback.

## Building locally (monorepo dev)

```sh
# From the repo root, build the catalog + embeddings:
pnpm --filter @projexlight/sdk-registry build
node packages/sdk-registry/dist/cli.js --repo . --out-dir packages/sdk-registry/dist

# Build this package:
pnpm --filter @projexlight/registry-mcp-local build

# Smoke test the binary directly:
PROJEX_DEV_ROOT=$(pwd) node packages/registry-mcp-local/dist/cli.js
# (then in another terminal, send JSON-RPC over stdin/stdout)
```

## Tests

```sh
pnpm --filter @projexlight/registry-mcp-local test
```

22 unit tests covering tool dispatch + catalog path resolution.

## Status

P9 / E3 Phase 1. Phase 2 (hosted SSE MCP) and Phase 3 (CLI auto-config writer)
land in future commits.
