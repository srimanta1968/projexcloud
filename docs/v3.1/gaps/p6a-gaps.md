Audit — P6A coverage vs. the three source docs

✅ What's covered

┌──────────────────────────────────────────────────────────────────────────────────────────────────┬───────────────────────────────────────────────────────────────────────────────────────────────┐
│ Source artifact │ Status │
├──────────────────────────────────────────────────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────┤
│ 6 SDKs (sdk-ai-gateway, sdk-taxonomy, sdk-agent-runtime, sdk-trace, sdk-mcp-bridge, │ All have features + tasks │
│ connector-github) │ │
├──────────────────────────────────────────────────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────┤
│ 7 sdk-agent-runtime tables (datamodel §6) │ Code written: 001_init_agents.sql covers all 7 with constraints + indexes; wired into │
│ │ auto-migrate │
├──────────────────────────────────────────────────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────┤
│ 4 isolation primitives (capability tokens · TTL · replay · sandboxed memory) │ Each is a feature + task (TK-3275/3276/3277/3278/3279) │
├──────────────────────────────────────────────────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────┤
│ AC-1, AC-2, AC-3, AC-4, AC-5, AC-6, AC-7, AC-9, AC-10, AC-12, AC-13, AC-14 │ Scenarios + tasks mapped │
├──────────────────────────────────────────────────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────┤
│ FR-AGW-1..6, 8, 9; FR-ART-1..18, 22, 23; FR-TRC-1..7; FR-MCP-1..4 │ Tasks mapped │
├──────────────────────────────────────────────────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────┤
│ Migration auto-apply for all 44 SDKs │ Wired in services/api-gateway/src/app.ts │
└──────────────────────────────────────────────────────────────────────────────────────────────────┴───────────────────────────────────────────────────────────────────────────────────────────────┘

🟠 Gaps — functional (will fail acceptance gates if not added)

┌──────┬─────────────────────────────────────────────────────┬────────────────────────────┬─────────────────────────────────────────┬─────────────────────────────────────────────────────────────┐
│ # │ Gap │ Source ref │ Why it matters │ Suggested action │
├──────┼─────────────────────────────────────────────────────┼────────────────────────────┼─────────────────────────────────────────┼─────────────────────────────────────────────────────────────┤
│ │ Contracts package not updated — no event-type │ │ Producer-side schema validator (per │ Add task: "P6A: register agent., ai-gateway., trace., mcp. │
│ G-1 │ registration for the 8 agent._.v1 events, no │ OC-2 doctrine; PRD §5.2 │ EventTypeRegistry) will reject every │ event types + types in @projexlight/contracts" — must land │
│ │ AgentContext / CapabilityToken / CompletionRequest │ "Events published" │ emission. CI gates on this. │ BEFORE any backend task that emits │
│ │ types in @projexlight/contracts │ │ │ │
├──────┼─────────────────────────────────────────────────────┼────────────────────────────┼─────────────────────────────────────────┼─────────────────────────────────────────────────────────────┤
│ │ SKU registration in meter.pricing_catalog / │ │ Without rates the meter will not gate; │ │
│ G-2 │ meter.pricing_rate missing — none of the P6A SKUs │ OC-1; PRD §5.1-5.5 SKU │ every billable call fails or runs │ Add task: SQL seed file 001_seed_p6a_skus.sql in sdk-meter, │
│ │ (agent-runtime._, ai-gateway._, trace._, mcp._, │ rows │ unmetered. │ or a bootstrap call │
│ │ taxonomy._, connector.github.\*) are seeded │ │ │ │
├──────┼─────────────────────────────────────────────────────┼────────────────────────────┼─────────────────────────────────────────┼─────────────────────────────────────────────────────────────┤
│ │ AC-8 (Reversible-action journaling / rollback test) │ │ Phase exit gate requires "any agent │ │
│ G-3 │ has no dedicated task — only mentioned in the │ PRD §7 AC-8; FR-ART-20 │ decision rolls back within retention │ Add task: backend journal of agent action → compensable │
│ │ FR-ART-20 description on the agent-identity feature │ │ via replay + compensable step." Not │ step + rollback API │
│ │ │ │ implemented. │ │
├──────┼─────────────────────────────────────────────────────┼────────────────────────────┼─────────────────────────────────────────┼─────────────────────────────────────────────────────────────┤
│ │ AC-11 (trace_id propagates through all P1–P5 SDKs) │ │ Trace viewer renders empty/partial │ Add task: pass-through trace_id audit across existing SDKs │
│ G-4 │ has no integration task │ PRD §7 AC-11 │ without upstream SDKs emitting trace_id │ (~25 SDKs touched) │
│ │ │ │ consistently. │ │
├──────┼─────────────────────────────────────────────────────┼────────────────────────────┼─────────────────────────────────────────┼─────────────────────────────────────────────────────────────┤
│ G-5 │ AC-15 (publish all P6A SDKs as v1.0.0) has no │ PRD §7 AC-15 │ Phase doesn't close without published │ Add task: bump versions, pnpm publish via Verdaccio, smoke │
│ │ release task │ │ packages. │ test npm view │
├──────┼─────────────────────────────────────────────────────┼────────────────────────────┼─────────────────────────────────────────┼─────────────────────────────────────────────────────────────┤
│ │ FR-ART-21 (tools declare SKUs in manifest) — only │ │ Boundary enforcement can't read a │ Add task: tool_manifest.json convention + │
│ G-6 │ the consumer-side check is modeled; no task for │ PRD §5.2 Primitive 4 │ manifest that doesn't exist. │ @projexlight/contracts/tool-manifest.ts registry │
│ │ tools/SDKs to publish their SKU manifest │ │ │ │
├──────┼─────────────────────────────────────────────────────┼────────────────────────────┼─────────────────────────────────────────┼─────────────────────────────────────────────────────────────┤
│ │ FR-TRC-8 (regression test API) — "assert trace │ │ Lets us catch silent regressions in the │ │
│ G-7 │ structure matches expected layer composition" — no │ PRD §5.3 │ 8-layer composition. │ Add task: assertion DSL + sample regression test │
│ │ task │ │ │ │
├──────┼─────────────────────────────────────────────────────┼────────────────────────────┼─────────────────────────────────────────┼─────────────────────────────────────────────────────────────┤
│ │ FR-MCP-7/8 (Tenant Admin → AI → MCP Registry UI) — │ │ Admins have no way to register MCP │ │
│ G-8 │ no frontend task for registering MCP servers per │ PRD §5.4; build plan │ servers (only backend API exists). │ Add task in apps/tenant-admin for MCP registry page │
│ │ tenant │ "Tenant config" row │ Blocks AC-12 chaos test from being │ │
│ │ │ │ driven by real admin user. │ │
├──────┼─────────────────────────────────────────────────────┼────────────────────────────┼─────────────────────────────────────────┼─────────────────────────────────────────────────────────────┤
│ │ Kill-switch wiring from sdk-feature-flags into │ │ Schema has kill_switch_flag_id but no │ │
│ G-9 │ sdk-ai-gateway and sdk-agent-runtime — referenced │ PRD §5.1 FR-AGW-7; PRD │ runtime evaluator. Operator can't │ Add backend task: flag-evaluation middleware in │
│ │ in FR-AGW-7, but no task adds the flag-evaluation │ §5.2 (kill_switch_flag_id) │ actually halt an agent. │ agent_runtime + ai-gateway hot path │
│ │ gate on each call │ │ │ │
├──────┼─────────────────────────────────────────────────────┼────────────────────────────┼─────────────────────────────────────────┼─────────────────────────────────────────────────────────────┤
│ G-10 │ Execution log retention worker (90d or longest │ PRD §5.2 Primitive 3 │ Logs grow unbounded. Storage budget │ Add backend task: nightly purger reading retention metadata │
│ │ compensation window — FR-ART-11) │ │ violated. │ │
├──────┼─────────────────────────────────────────────────────┼────────────────────────────┼─────────────────────────────────────────┼─────────────────────────────────────────────────────────────┤
│ G-11 │ Capability-token signing key rotation (PRD §13 Q-2, │ PRD §13 Q-2 │ Compromise of a non-rotated key is the │ Add task: scheduler in sdk-vault rotating the │
│ │ FR-ART-1 implies vaulted signing key) │ │ highest-impact attack surface. R-2. │ capability-token signing key quarterly │
└──────┴─────────────────────────────────────────────────────┴────────────────────────────┴─────────────────────────────────────────┴─────────────────────────────────────────────────────────────┘

🟡 Gaps — infra / fixtures (block AC tests)

┌─────┬──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┬─────────────────┐
│ # │ Gap │ Source ref │
├─────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┼─────────────────┤
│ I-1 │ Langfuse instance provisioning + connection string in vault │ PRD §9 │
├─────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┼─────────────────┤
│ I-2 │ Vector store cluster setup — pgvector schema in each app pool; Pinecone/Qdrant decision deferred (Q-5) │ PRD §9, §13 Q-5 │
├─────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┼─────────────────┤
│ I-3 │ LLM provider credentials vaulted (Anthropic + OpenAI + Bedrock; Gemini optional) │ PRD §9 │
├─────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┼─────────────────┤
│ I-4 │ Synthetic MCP test servers (Slack-MCP, Snowflake-MCP, Jira-MCP) for AC-12 fixture │ PRD §8 AC-12, │
│ │ │ §9 │
├─────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┼─────────────────┤
│ I-5 │ ClickHouse trace.span table provisioning (DataModel §7.1 says "typically in ClickHouse for OLAP") — the clickhouse-runtime/ package exists but no migration task for │ DataModel §7.1 │
│ │ trace.span │ │
└─────┴──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┴─────────────────┘

🟣 Gaps — services & dependencies missed

┌─────┬─────────────────────────────────────────────────────────────────────────────┬────────────────────────────────────────────────────┬─────────────────────────────────────────────────────────┐
│ # │ Gap │ Source ref │ Note │
├─────┼─────────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────┼─────────────────────────────────────────────────────────┤
│ │ PRD §3 names 3 new services (services/ai-gateway-service, │ │ Acceptable for prototype (api-gateway hosts all SDKs in │
│ S-1 │ services/agent-runtime-service, services/trace-collector). None modeled │ PRD §3 components table │ one process per app.ts line 180-182), but should be │
│ │ separately. │ │ tracked as an extraction milestone. │
├─────┼─────────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────┼─────────────────────────────────────────────────────────┤
│ │ sdk-agent-runtime depends on sdk-ai-gateway per build plan §wave-6 — but my │ Build plan: "agent-runtime Depends on: contracts · │ │
│ S-2 │ packages/sdk-agent-runtime/package.json does not list it as a workspace │ sdk-ai-gateway · sdk-audit · sdk-policy · │ Add to package.json so the import order is enforceable │
│ │ dep │ sdk-rebac · sdk-workflow" │ │
├─────┼─────────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────┼─────────────────────────────────────────────────────────┤
│ │ sdk-mcp-bridge depends on sdk-semantic (CapabilityGraph) — sdk-semantic is │ │ Acceptable: PRD §5.4 says "stubs available; full │
│ S-3 │ P6B │ Build plan §wave-6 │ integration P6B" — but no task captures the stub │
│ │ │ │ interface │
├─────┼─────────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────┼─────────────────────────────────────────────────────────┤
│ S-4 │ sdk-trace depends on sdk-telemetry + sdk-lineage — sdk-telemetry exists │ Build plan §wave-6 │ OK to defer lineage integration to P6B; track as a │
│ │ (packages/telemetry/) but sdk-lineage is P6B │ │ known gap │
├─────┼─────────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────┼─────────────────────────────────────────────────────────┤
│ S-5 │ "idempotence helpers" (build plan calls out as sdk-agent-runtime owns │ Build plan §wave-6 sdk-agent-runtime │ Add task: idempotency key store + middleware │
│ │ these) — not modeled │ │ │
└─────┴─────────────────────────────────────────────────────────────────────────────┴────────────────────────────────────────────────────┴─────────────────────────────────────────────────────────┘

🔵 Gaps — non-functional & decisions

┌─────┬─────────────────────────────────────────────────────────────────────────────────────────────────────────┬────────────┐
│ # │ Gap │ Source ref │
├─────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────┼────────────┤
│ N-1 │ No perf test task for AI Gateway p99 ≤ 10ms overhead │ PRD §6 │
├─────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────┼────────────┤
│ N-2 │ No perf test task for capability token mint p99 ≤ 5ms │ PRD §6 │
├─────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────┼────────────┤
│ N-3 │ No perf test task for MCP tool invocation overhead p99 ≤ 50ms │ PRD §6 │
├─────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────┼────────────┤
│ D-1 │ PRD §13 Q-1, Q-3, Q-4, Q-5, Q-6 are unresolved decisions — no decisions tracked anywhere in Projexlight │ PRD §13 │
└─────┴─────────────────────────────────────────────────────────────────────────────────────────────────────────┴────────────┘

🟢 Organizational issue from the original import

O-1: projexlight_import_full deduped all 3 P6A epics to a single UUID (02b0f542-bcc8-4179-a7ca-7aada1c162ab). The "iso" and "trc" epics map to the gateway epic — so the board shows one giant P6A epic
instead of the intended three (Gateway / Isolation-G7 / Trace-G12). Two features also collapsed (feat-agw-redaction → feat-agw-provider; feat-mcp-expose → feat-mcp-consume). All work is anchored,
but the granularity is lost.

Remediation options:

- Live with it (everything is one big P6A epic — fine for an MVP)
- Re-import the two missing epics under distinct source_module values (#isolation, #trace) per the memory note, then re-anchor features

---

Recommendation: what to add to Projexlight next

Tier-1 (must-add to close phase gates): G-1, G-2, G-3, G-4, G-9, plus I-3 (LLM credentials) and I-4 (synthetic MCP test servers).

Tier-2 (must-add before production, can wait a sprint): G-5, G-6, G-7, G-10, G-11, S-2 (deps fix), S-5, N-1..N-3.

Tier-3 (nice to track but not blocking): G-8 (UI), I-1, I-2, I-5, S-1, S-3, S-4, D-1, O-1.

Want me to create the Tier-1 tasks now in Projexlight (and fix S-2 in the package.json)?

✻ Sautéed for 2m 47s
