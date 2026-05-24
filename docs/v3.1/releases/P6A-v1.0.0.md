# P6A v1.0.0 — Release notes

**Date:** 2026-05-23
**Closes:** AC-15. All six P6A SDKs published to Verdaccio at 1.0.0.

## What ships

| Package | Version | Purpose |
|---|---|---|
| `@projexlight/sdk-ai-gateway` | 1.0.0 | Multi-provider LLM gateway (Anthropic / OpenAI / Bedrock / Gemini) with routing rules, PII redaction, circuit breaker, kill-switch |
| `@projexlight/sdk-taxonomy` | 1.0.0 | Versioned extraction schemas + prompt templates with tenant overrides |
| `@projexlight/sdk-agent-runtime` | 1.0.0 | Agent isolation runtime (G7): capability tokens · TTL · deterministic replay · sandboxed memory + lifecycle + journal/rollback |
| `@projexlight/sdk-trace` | 1.0.0 | Cross-system trace viewer (G12); ClickHouse + Postgres mirror; PDF/JSON export |
| `@projexlight/sdk-mcp-bridge` | 1.0.0 | Model Context Protocol bridge (consume + expose); HTTP transport in v1.0; SSE + stdio in v1.1 |
| `@projexlight/connector-github` | 1.0.0 | GitHub mirror tables + webhook ingest |

## Phase exit gates
- **G7 (Agent Isolation Runtime):** closed — all four primitives + tool permission boundaries + agent identity + reversible journal
- **G12 (Cross-system trace viewer):** closed — timeline endpoint < 5s for 50 spans, PDF/JSON export, regression-assert API

## Acceptance criteria coverage
AC-1 through AC-14 implementation-complete. AC-15 closed by this release.

## How to install
```bash
pnpm add @projexlight/sdk-ai-gateway@1.0.0 \
         @projexlight/sdk-agent-runtime@1.0.0 \
         @projexlight/sdk-mcp-bridge@1.0.0 \
         @projexlight/sdk-trace@1.0.0 \
         @projexlight/sdk-taxonomy@1.0.0 \
         @projexlight/connector-github@1.0.0
```

## Breaking changes since 0.1.0
None — first stable release.

## Known limitations
- MCP SSE + stdio transports raise `unsupported_transport` (HTTP only in v1.0); follow-up tracked.
- sdk-trace lineage layer dormant until sdk-lineage ships in P6B (graceful detector via `getLineageSource()`).
- sdk-semantic CapabilityGraph integration is a stub returning `is_stub:true`; sdk-semantic in P6B replaces transparently.
