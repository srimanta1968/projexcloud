# PRD · P6A — AI Infrastructure + Agent Isolation + MCP Bridge

| Field | Value |
|---|---|
| **Phase** | P6A |
| **Window** | Weeks 35–40 (~5 weeks) |
| **Maps to wave(s)** | W6 first half |
| **Gates closed** | G7 (Agent Isolation Runtime) · G12 (sdk-trace) |
| **Status** | DRAFT |
| **Owner (DRI)** | AI Platform Lead |
| **Companion docs** | `../docs/v3.1/Architecture-v3.1.html` §18A (Agent Isolation Runtime) · `../docs/v3.1/AgenticIntegration-v3.1.html` §2 · §4 |

---

## 1 · TL;DR

P6A makes **AI agents safely deployable at enterprise scale**. AI Gateway provides multi-provider LLM access; Taxonomy holds extraction schemas and prompt templates; Agent Runtime ships with the **full isolation runtime** (capability tokens · execution TTL · deterministic replay · sandboxed memory) that turns agents from "powerful but dangerous" into "deployable with audit-grade containment." **sdk-trace** delivers the cross-system trace viewer so debugging six-layer failures becomes one timeline. **sdk-mcp-bridge** opens bidirectional Model Context Protocol support — the strategic primitive that lets agents reach any external system with a public MCP server (Slack · GitHub · Snowflake · Notion · …).

---

## 2 · Why this phase now

If we ship P6B (Knowledge · Semantic · Conversation · Lineage) before agent isolation, a single Phase 6B agent using P6A's runtime without isolation primitives leaks one tenant's prompt context into another's. The leak is **catastrophic and irreversible**. G7 closure must precede any P6B SDK that uses agents. G12 (sdk-trace) lands here because the trace viewer is the only way to debug agent runs across the 6+ subsystems they touch — without it, ops drowns the moment agents are turned on.

---

## 3 · What ships in this phase

| Component | Type | Effort | Owner | Notes |
|---|---|---|---|---|
| `@projexlight/sdk-ai-gateway` | SDK · NEW | L · 6w | AI Platform | Multi-provider abstraction (Anthropic · OpenAI · Gemini · Bedrock); routing rules; PII redaction; per-tenant budget caps delegated to sdk-meter; per-agent kill-switch (sdk-feature-flags); Langfuse trace on every call |
| `@projexlight/sdk-taxonomy` | SDK · NEW | M · 4w | AI Platform | Versioned artifact taxonomies; extraction schemas; prompt templates; per-tenant profile overrides; migration plans |
| `@projexlight/sdk-agent-runtime` | SDK · NEW v3 + v3.1 | L · 6w | AI Platform | Agent definitions; execution loops; memory snapshots; tool dispatch; retry state; kill-switch state. **v3.1 full Agent Isolation Runtime**: capability tokens · execution TTL · deterministic replay · sandboxed memory · tool permission boundaries |
| `@projexlight/sdk-trace` | SDK · NEW v3.1 | M · 4w | Platform / Observability | Cross-system trace viewer; one `trace_id` resolves into unified timeline (identity + consent + routing + pool + key + policy + meter + execution + lineage); per-layer latency budget violations; PDF/JSON export |
| `@projexlight/sdk-mcp-bridge` | SDK · NEW v3.1 | M · 4w | AI Platform | Bidirectional Model Context Protocol. Consume side: register external MCP servers per tenant; tools auto-register in CapabilityGraph; gated through capability tokens. Expose side: surface selected ProjexCloud SDKs as MCP servers for external AI systems (Claude Desktop · custom OpenAI assistants) |
| `@projexlight/connector-github` | Connector · NEW v3.1 | S · 2w | Integrations | Bulk operations; complements public MCP server (which most agents will reach via mcp-bridge first) |
| `services/ai-gateway-service` | Service · NEW | M · 4w | AI Platform | Multi-provider gateway runtime; routing + retries + circuit breakers |
| `services/agent-runtime-service` | Service · NEW | L · 5w | AI Platform | Sandboxed agent execution; capability issuer; TTL enforcer; replay engine |
| `services/trace-collector` | Service · NEW | M · 3w | Platform | sdk-trace backend — aggregates spans from OTel + audit + meter + lineage |

---

## 4 · User stories

### As an **Agent Developer** (vertical or platform team)
- **US-AD-1**: I define an agent with `agent_id`, `agent_persona` (the persona it acts on behalf of), and `agent_scope` (typed capability allow-list); the runtime mints capability tokens for each tool call.
- **US-AD-2**: I set `ttl_seconds: 300` on my agent run; if it doesn't complete in 5 minutes, the runtime terminates it cleanly and refunds the unspent meter budget.
- **US-AD-3**: I replay last week's agent execution to debug a production incident; deterministic replay reproduces bit-identical outputs against the same model snapshot.
- **US-AD-4**: I register an external MCP server (Salesforce, Snowflake, Slack) for my tenant; its tools automatically appear in the agent's CapabilityGraph; I don't write per-target integration code.

### As a **Platform Engineer**
- **US-PE-1**: I add `@meter` to my SDK and the agent gateway automatically sees the SKU; agent calls to my SDK are gated like any other call.
- **US-PE-2**: I open sdk-trace UI with a `trace_id`; I see the entire timeline (identity resolution + consent + routing + pool + Vault key + policy + meter + SDK body + lineage) for one request in <5 seconds — not 6 different tools.

### As a **ProjexCloud Operator**
- **US-OP-1**: I detect a runaway agent in real-time via the Cost & Safety Steward Agent's alerts; one kill-switch flip stops every instance of that agent across all tenants.
- **US-OP-2**: A tenant reports unexpected billing — I open sdk-trace, search by tenant + time, and see exactly which agent runs caused the cost spike.

### As a **Tenant Admin**
- **US-TA-1**: I configure my tenant's allowed LLM providers (Anthropic only; or Anthropic + OpenAI with routing rules); my agents respect the config.
- **US-TA-2**: I register a custom MCP server for my company's proprietary pricing tool; my agents can query it; OAuth credentials vaulted.
- **US-TA-3**: I set per-agent execution TTL caps in Tenant Admin Portal (e.g., max 60s for synchronous agents; 1h for batch agents).

### As a **Security / Compliance Lead**
- **US-SC-1**: I run the cross-tenant prompt-leakage CI test on a PR that modifies sdk-agent-runtime; if any of the 1,000 synthetic Tenant A → Tenant B collisions surface a leak, the build fails closed.
- **US-SC-2**: I verify all capability tokens are short-lived (< 5 min default), scope-limited, and single-use; runtime refuses to invoke a tool without one.

### As a **Tenant Developer** (custom app)
- **US-TD-1**: My agent reads a SemanticIntent (P6B), walks the CapabilityGraph to produce a multi-step plan including calls into my customer's Salesforce via MCP, posts results to Slack via connector-slack, and creates a Jira issue via MCP — one orchestration, one trace_id, fully audited.

---

## 5 · Functional requirements (per SDK / component)

### 5.1 · `@projexlight/sdk-ai-gateway`

**Owns:**
- FR-AGW-1: Provider abstraction with typed completion API (Anthropic · OpenAI · Gemini · Bedrock · local models like Llama/Mistral)
- FR-AGW-2: Routing rules per tenant (e.g., "use Claude for clinical analysis, GPT for code generation")
- FR-AGW-3: PII redaction pass on prompts before forwarding to providers
- FR-AGW-4: Provider cost capture per call (tokens in/out · model · provider rate)
- FR-AGW-5: Langfuse trace integration on every call (composes with sdk-trace)
- FR-AGW-6: Budget enforcement DELEGATED to sdk-meter (no duplicate quota logic)
- FR-AGW-7: Per-agent kill-switch via sdk-feature-flags (operator can halt one agent across all tenants)
- FR-AGW-8: Streaming + non-streaming responses
- FR-AGW-9: Retry with exponential backoff on provider 5xx; circuit breaker per provider

**Public API surface:**
```ts
export async function complete(request: CompletionRequest, ctx: AgentContext): Promise<CompletionResponse>;
export async function stream(request: CompletionRequest, ctx: AgentContext): AsyncIterable<StreamChunk>;
```

**Pool placement:** Stateless gateway; Langfuse trace target.

**SKUs:** `ai-gateway.complete` · `ai-gateway.stream` — `passthrough_plus_margin` (provider cost + 15%).

### 5.2 · `@projexlight/sdk-agent-runtime` — the heart of P6A

**Owns the four primitives that make agents safe:**

**Primitive 1 · Capability Tokens (FR-ART-1 to FR-ART-4):**
- FR-ART-1: Capability issuer mints signed, scope-limited, single-use tokens for each tool invocation
- FR-ART-2: Token names: agent_id · acting_persona · tool_sku · args_bound · tenant_scope · expires_at
- FR-ART-3: Tools refuse invocation without a valid token; meter validates token at gate
- FR-ART-4: Mid-flight revocation — revoking a token kills the in-flight action

**Primitive 2 · Execution TTL (FR-ART-5 to FR-ART-7):**
- FR-ART-5: Every agent run has a hard deadline at start (default 30s sync, 5min orchestration, 1h batch)
- FR-ART-6: Runtime terminates on expiry; in-flight tools cancelled; compensable steps rolled back
- FR-ART-7: Per-agent and per-tenant TTL caps configurable

**Primitive 3 · Deterministic Replay (FR-ART-8 to FR-ART-12):**
- FR-ART-8: Content-addressed execution log captures: prompt template version + filled values, retrieved context, model invocation params, tool calls with token IDs + args, tool responses, final action
- FR-ART-9: Replaying the log against the same model snapshot produces bit-identical outputs
- FR-ART-10: Replay enables: rollback within retention; production bug reproduction; model-upgrade regression testing
- FR-ART-11: Log retention = longer of (90 days, longest action's compensation window)
- FR-ART-12: Logs are deterministic-replay artifacts, NOT telemetry — different storage budget

**Primitive 4 · Sandboxed Memory (FR-ART-13 to FR-ART-16):**
- FR-ART-13: Hard physical partitions per tenant in vector store (Pinecone namespaces · pgvector schemas)
- FR-ART-14: Prompt context, vector store, conversation buffers NEVER cross tenant boundaries
- FR-ART-15: Cross-tenant prompt-leakage CI test runs synthetic Tenant A → Tenant B collisions on every PR
- FR-ART-16: Runtime refuses to start if a single vector namespace spans multiple tenant_ids

**Plus agent identity types (already in contracts):**
- FR-ART-17: `agent_id · agent_persona · agent_scope · agent_chain` (provenance: human → meta-agent → executing agent)
- FR-ART-18: Audited as `actor.kind='agent'` with full chain on every action

**Plus delegated authority:**
- FR-ART-19: Agents acting beyond scope route through sdk-approval for human sign-off
- FR-ART-20: Reversible-action journaling (every agent decision can be rolled back within retention)

**Plus tool permission boundaries:**
- FR-ART-21: Every tool declares the SKUs it calls in a manifest
- FR-ART-22: Meter enforces the manifest at gate time
- FR-ART-23: Agent calling a tool that exceeds its scope denied at admission, not after the fact

**Database / storage:** `agents` schema in Admin Pool (agent defs, execution logs); Vector store namespace per tenant.

**Events published:** `agent.run.started.v1` · `agent.run.completed.v1` · `agent.run.terminated.v1` (TTL expiry) · `agent.run.replayed.v1` · `agent.tool.invoked.v1` (sampled) · `agent.scope.exceeded.v1` (route to approval)

**Pool placement:** Agent defs in Admin Pool; memory in Vector store per-tenant partition.

**SKUs:** `agent-runtime.run.start` · `agent-runtime.tool.invoke` · `agent-runtime.replay` · `agent-runtime.capability-token.mint` — `tiered_per_call`.

### 5.3 · `@projexlight/sdk-trace`

**Owns:**
- FR-TRC-1: Cross-system trace viewer aggregating spans from sdk-telemetry (OTel) + sdk-audit + sdk-meter + sdk-lineage (P6B)
- FR-TRC-2: One `trace_id` propagated end-to-end resolves into unified timeline UI
- FR-TRC-3: Timeline shows: identity resolution → consent → pool routing → Vault key → policy decision (with IQL eval tree) → meter gate → SDK body → tool calls → audit emit → lineage edges
- FR-TRC-4: Sub-15-min MTTD; trace renders < 5s after request completion
- FR-TRC-5: Per-layer latency budget violations highlighted automatically
- FR-TRC-6: Trace export to PDF + JSON
- FR-TRC-7: Customer self-serve access via /billing/verify (sdk-billing integration)
- FR-TRC-8: Regression test API — assert trace structure matches expected layer composition

**Pool placement:** Stateless reader; reads from telemetry + audit + meter + lineage stores.

**SKUs:** `trace.query` · `trace.export.pdf` · `trace.export.json` — `flat_per_call`.

### 5.4 · `@projexlight/sdk-mcp-bridge` — the strategic primitive

**Owns:**
- FR-MCP-1 (Consume side): Register external MCP servers per tenant (with vaulted credentials)
- FR-MCP-2: Auto-register each MCP server's tools in the agent's CapabilityGraph (sdk-semantic — stubs available; full integration P6B)
- FR-MCP-3: On agent invocation of MCP tool, mint capability token + invoke external server + record request/response in audit + lineage + trace — same gated/metered/audited contract as internal tools
- FR-MCP-4: Three transport options: stdio · SSE · HTTP
- FR-MCP-5 (Expose side): Surface selected ProjexCloud SDKs as MCP servers
- FR-MCP-6: Scoped per tenant via sdk-api-keys; gated through sdk-meter; full audit trail
- FR-MCP-7: Tenant admin registers MCP servers in Tenant Admin → AI → MCP Registry
- FR-MCP-8: Per-server: name · transport · vaulted credentials · allowed agents · allowed tools (opt-out per tool)

**Pool placement:** MCP registry in Admin Pool; credentials in Vault.

**SKUs:** `mcp.tool.invoke` · `mcp.server.register` — `passthrough_plus_margin` for external MCP (external system cost varies); `flat_per_call` for register operations.

### 5.5 · `@projexlight/connector-github`

(Small connector; complements public MCP server. Bulk operations + webhook ingestion of repo events.)

---

## 6 · Non-functional requirements

| Dimension | Target |
|---|---|
| AI Gateway latency overhead | ≤ 10ms p99 (excluding model time) |
| Capability token mint latency | ≤ 5ms p99 |
| Agent execution TTL enforcement | ≤ 100ms after expiry |
| Deterministic replay reproduction | bit-identical (100%) |
| Cross-tenant prompt-leakage CI test | 1,000 synthetic collisions per PR; 0 leaks allowed |
| sdk-trace timeline render | ≤ 5s after request completion |
| MCP tool invocation overhead (excluding external system time) | ≤ 50ms p99 |
| Vector store namespace isolation | 100% physical partition (deployment refuses to start otherwise) |

---

## 7 · Acceptance criteria (the phase exit gate · matches §0A.4 P6A)

| # | Criterion | Owner | Test plan |
|---|---|---|---|
| **AC-1** | LLM call through Gateway records consent, budget, redaction, Langfuse trace | AI Platform | Integration test |
| **AC-2** | **Agent Isolation: cross-tenant prompt-leakage CI test fails closed** (1,000 synthetic Tenant A→B collisions; 0 leaks) | Security | CI gate |
| **AC-3** | **Capability token enforcement verified** — tool refuses without; revocation kills in-flight | AI Platform | Chaos drill |
| **AC-4** | **Execution TTL terminates a runaway agent** within deadline; refunds unspent budget | AI Platform | Chaos drill |
| **AC-5** | **Deterministic replay** reproduces last week's decision bit-identical against the same model snapshot | AI Platform | Replay test |
| **AC-6** | Sandboxed memory: runtime refuses to start if a single namespace spans multiple tenant_ids | Security | Deployment gate |
| **AC-7** | Beyond-scope agent action routes through sdk-approval | AI Platform | Integration test |
| **AC-8** | Reversible-action journaling: any agent decision rolls back within retention via replay + compensable step | AI Platform | Rollback test |
| **AC-9** | Tool permission boundaries: agent calling out-of-manifest SKU denied at admission | AI Platform | Integration test |
| **AC-10** | **sdk-trace** renders an end-to-end request crossing identity + consent + routing + pool + key + policy + meter + lineage in one timeline within 5s | Platform | UX walk-through |
| **AC-11** | trace_id propagates end-to-end through all P1–P5 SDKs | Platform | Integration test |
| **AC-12** | **sdk-mcp-bridge**: agent plan that includes "post to Slack" + "query Snowflake" + "create Jira issue" executes through three different MCP servers with one trace_id, full audit trail, meter billing per tool invocation | AI Platform | End-to-end scenario test |
| **AC-13** | ProjexCloud's sdk-crm exposed as MCP server, callable from Claude Desktop with a tenant token | AI Platform | External-system integration test |
| **AC-14** | `connector-github` works alongside public MCP github server (no conflict) | Integrations | Integration test |
| **AC-15** | All P6A SDKs published as v1.0.0 | Platform | `npm view` |

---

## 8 · Test plan (selected)

### AC-2 · Cross-tenant prompt-leakage

**Scenario:** CI fixture creates two test tenants (A and B), each with distinct sensitive data in their vector stores. Run 1,000 synthetic prompt collisions: Tenant A's agent queries something that COULD reference Tenant B's data; system should never return B's data to A.

**Pass condition:** 0 leaks across 1,000 attempts; any leak fails the CI build immediately.

### AC-4 · Execution TTL

**Scenario:** Configure an agent with `ttl_seconds: 30`. Plant a tool call that takes 60s (synthetic). Run agent.

**Pass condition:** At T+30s, runtime terminates the agent; in-flight tool cancelled (verified by tool's cancellation handler firing); compensable step rolled back; meter refunds T+30s onward; final agent status = TERMINATED_TTL_EXPIRED; audit entry recorded.

### AC-5 · Deterministic replay

**Scenario:**
- Day 1: Agent runs, makes 3 tool calls, produces output X; execution log saved
- Day 8: Re-run the saved execution log against the same model snapshot
- Compare output to original X byte-for-byte

**Pass condition:** Identical output. (If model snapshot has changed, replay surfaces a diff — that's also a pass; the test asserts deterministic behavior under matching conditions.)

### AC-12 · MCP three-server scenario

**Scenario:** Agent plan executes:
1. `mcp.slack.post-message` (channel: #engineering, "Alert: critical issue")
2. `mcp.snowflake.query` ("SELECT COUNT(*) FROM incidents WHERE date = CURRENT_DATE")
3. `mcp.jira.create-issue` (title: "Investigate spike", labels: [...])

All three external MCP servers respond; agent receives results; produces summary.

**Pass condition:** All three tool calls audited with `mcp_server_id`; one trace_id covers the whole orchestration; meter records cost per tool; capability tokens scoped per call.

---

## 9 · Dependencies

- ✅ P5 exit gate green
- ✅ sdk-engagement + sdk-crm working (agents use them via SemanticIntent in P6B)
- ✅ sdk-feature-flags running (per-agent kill switches)
- ✅ sdk-approval available (delegated authority)
- ✅ Vector store cluster ready (pgvector per pool; Pinecone/Qdrant for Tier-G)
- ✅ Langfuse instance provisioned for AI traces
- ✅ LLM provider accounts: Anthropic + OpenAI + Bedrock (Gemini optional)
- ✅ Test MCP servers running for AC-12 (Slack MCP · Snowflake MCP · Jira MCP)

---

## 10 · Out of scope (deferred to P6B)

- ❌ sdk-knowledge-rag — P6B
- ❌ sdk-parsing — P6B
- ❌ sdk-conversation — P6B
- ❌ sdk-recommendation — P6B
- ❌ sdk-analytics with Iceberg — P6B (P7 for full lakehouse)
- ❌ sdk-lineage with cross-pool projection — P6B
- ❌ sdk-semantic full 6 types — P6B (stubs in contracts from P1)
- ❌ connector-snowflake — P6B

---

## 11 · Risks

| # | Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|---|
| R-1 | A single prompt-engineering bug leaks Tenant A's data into Tenant B's agent | H | M | Cross-tenant leakage CI on every PR; hard physical partitions; deployment gate refuses misconfigured namespaces |
| R-2 | Capability token signing key compromise | H | L | Vaulted signing keys; per-region rotation; meter-side validation |
| R-3 | Execution TTL too aggressive — kills legitimate long-running agents | M | M | Per-agent-class defaults; per-tenant override; alert if TTL-expiry rate spikes |
| R-4 | Deterministic replay breaks when model providers change snapshots without notice | M | M | Snapshot ID captured in log; replay surfaces "model snapshot drift" rather than silent failure |
| R-5 | sdk-trace overwhelms storage (too many spans) | M | M | Sampling per latency tier; long-term archival to S3; hot store ≤ 7d |
| R-6 | MCP-bridge external server returns malicious payload | H | M | Schema validation on responses; capability tokens prevent escalation; sandbox the agent's interpretation |
| R-7 | Provider cost spikes when agent loops via MCP | M | M | Execution TTL caps the loop; meter enforces per-agent budgets; Cost & Safety Steward Agent alerts |

---

## 12 · Rollout plan

1. **Week 35**: sdk-ai-gateway + sdk-taxonomy in parallel
2. **Week 36–39**: sdk-agent-runtime (long pole; isolation runtime work)
3. **Week 35–38**: sdk-trace (long pole at 4w; needs to be ready when agents start running)
4. **Week 36–39**: sdk-mcp-bridge
5. **Week 37**: First cross-tenant prompt-leakage CI test results
6. **Week 38**: First deterministic replay test
7. **Week 39**: Three-MCP-server orchestration end-to-end test
8. **Week 40**: Phase exit-gate review (P6A must close before P6B can use agent runtime)

---

## 13 · Open questions / decisions needed

- [ ] Q-1: Default execution TTL caps — 30s sync · 5min orchestration · 1h batch — confirm with platform team
- [ ] Q-2: Capability token signing key rotation cadence — quarterly default; emergency rotation procedure
- [ ] Q-3: Execution log retention — 90 days default; per-tenant override?
- [ ] Q-4: MCP transport priority — HTTP first (most server implementations); SSE + stdio in v1.1?
- [ ] Q-5: Vector store choice for Tier-G — Pinecone vs Qdrant vs continued pgvector? Decision needed week 36
- [ ] Q-6: Which P5 SDKs to expose as MCP servers in v1 — recommend sdk-crm + sdk-engagement + sdk-content; expand later

---

## 14 · Sign-off

| Role | Name | Date | Status |
|---|---|---|---|
| Phase DRI | AI Platform Lead | | |
| Platform Architect | Tanveer | | |
| Security / Compliance | | | |
| Working Group · AI Safety | | | |
