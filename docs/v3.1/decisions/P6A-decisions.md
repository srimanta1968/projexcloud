# P6A · Decisions log (D-1 / TK-3324)

Closes PRD §13 Q-1..Q-6. Each row is a binding decision; revisit cadence noted.

| # | Question | Decision | DRI | Date | Rationale | Revisit |
|---|---|---|---|---|---|---|
| **Q-1** | Default execution-TTL caps | **30s sync · 300s orchestration · 3600s batch** (enforced via `agent_definition.default_ttl_seconds` CHECK 0 < x ≤ 3600) | AI Platform Lead | 2026-05-23 | Sync caps match typical user-facing latency budgets. Orchestration matches typical 5-min agent loops. Batch caps to the 1h pricing tier boundary. | After 90d of prod data — review TTL-expiry rate by tier; raise sync to 60s if expiry rate > 2%. |
| **Q-2** | Capability-token signing-key rotation cadence | **Quarterly automated rotation** with 10-minute grace window (current + previous key both valid). Emergency `rotateNow()` for compromise. | Security | 2026-05-23 | Quarterly balances forensic key lifetime vs operational burden. 10-min grace is wider than the longest mint→use latency we've measured (< 2 min). | On any signing-key compromise — switch to monthly + reduce grace to 60s for 1 quarter. |
| **Q-3** | Execution-log retention default | **90 days** (env override `AGENT_LOG_RETENTION_DAYS`). Worker (TK-3310) prunes nightly. | AI Platform Lead | 2026-05-23 | Matches FR-ART-11's "max(90, longest compensation window)" floor. Most production agents have compensation windows ≤ 90d. | Per-tenant override request triggers ad-hoc bump; review at first 6-month renewal cycle. |
| **Q-4** | MCP transport priority for v1 | **HTTP first** (shipped in v1.0). SSE + stdio in v1.1 (`unsupported_transport` until then). | AI Platform | 2026-05-23 | HTTP covers > 80% of public MCP servers we've cataloged; SSE adoption is still nascent; stdio is dev-tool only. | Promote SSE to "supported" once Anthropic publishes the official Claude Desktop SSE bridge (tracked: H1 2026). |
| **Q-5** | Vector store for Tier-G | **Qdrant managed cluster** (see [`p6a-vector-store.md`](./p6a-vector-store.md)) | AI Platform Lead | 2026-05-23 | Self-host option, native per-collection RBAC, lower cost at 100M+ vectors, already in HDK/Search benchmarks. | After 6 months OR when any Tier-G tenant crosses 50M embeddings. |
| **Q-6** | Which P5 SDKs to expose as MCP servers in v1 | **`sdk-crm`, `sdk-engagement`, `sdk-content`** (`mcp.exposed_server` seed shipped with v1.0) | AI Platform Lead | 2026-05-23 | These three are read-heavy + write-low-risk + already shipped at v1.0. Highest demand from early customer interviews. | Expand quarterly based on customer requests; `sdk-payment` deliberately excluded until manual approval flow lands. |

## Cross-cutting notes
- All decisions above are CI-enforced where possible (TTL caps via schema CHECK, retention via env-driven worker, signing key rotation via boot-time scheduler).
- Decisions that remain runtime-configurable (env vars) are documented in [`../runbook/P6A-Service-Extraction.md`](../runbook/P6A-Service-Extraction.md).
- Any decision revisit must update this file with a new row + supersede the prior decision; never edit historical rows in place.
