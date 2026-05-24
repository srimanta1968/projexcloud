/**
 * P6A cross-SDK contracts — types shared between sdk-ai-gateway,
 * sdk-agent-runtime, sdk-trace, sdk-mcp-bridge, sdk-taxonomy, and any tool
 * that participates in agent execution. Per Architecture v3.1 §0 contracts-
 * first discipline and OC-2 (event registry) doctrine: every shape an agent
 * emits or consumes lives here, not in a per-SDK type leaf.
 *
 * Source: docs/v3.1/prd/P6A-AI-Isolation-MCP.md §5.1–5.4 and
 *         docs/v3.1/datamodel/P6A-AI-Isolation-MCP-DataModel.html §4–§8.
 */

/* ============================================================
 * Agent identity, chain provenance, run context (FR-ART-17..18)
 * ============================================================ */

/** Bound to one execution. Passed alongside every sdk-ai-gateway / tool call. */
export interface AgentContext {
  /** Stable agent definition identifier. */
  agent_id: string;
  /** Per-execution surrogate. */
  run_id: string;
  /** Persona the agent is acting on behalf of (FR-ART-17). */
  acting_persona_id: string;
  /** Owning tenant; null = platform agent (Cost Steward, Safety Officer). */
  tenant_id: string | null;
  /** OTel trace identifier — must propagate through every downstream SDK. */
  trace_id: string;
  /** Optional OTel span identifier for the current step. */
  span_id?: string | null;
  /** Hard deadline; runtime terminates the run if now > ttl_deadline (FR-ART-5..7). */
  ttl_deadline: string;
  /** Materialised provenance: [human persona, ..., meta-agent, executing-agent]. */
  agent_chain: string[];
}

/* ============================================================
 * sdk-ai-gateway public surface (PRD §5.1)
 * ============================================================ */

/** LLM provider identifiers recognised by the gateway router. */
export type ProviderId =
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'bedrock'
  | 'local-llama'
  | 'local-mistral';

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** When `role === 'assistant'`, the model's requested tool calls. */
  tool_calls?: ToolCallRecord[];
  /** When `role === 'tool'`, the id of the call this message responds to. */
  tool_call_id?: string;
}

export interface ToolCallRecord {
  tool_call_id: string;
  tool_sku: string;
  args: unknown;
}

export interface CompletionRequest {
  /** Provider-qualified model name (e.g. claude-opus-4-7, gpt-4o, gemini-1.5-pro). */
  model: string;
  /** Either a single user prompt or a multi-message chat history. */
  prompt: string | ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  /** Routed against `ai_gateway.route_rule.predicate.task_tag`. */
  task_tag?: string;
  /** If set, the gateway tries this provider first (subject to routing rules). */
  provider_hint?: ProviderId;
  /** Tools the model may call; the runtime mints capability tokens per call. */
  tools?: ToolManifest[];
  /** When true, request the provider to stream tokens. */
  stream?: boolean;
}

export interface CompletionResponse {
  completion_id: string;
  provider_id: ProviderId;
  model: string;
  /** Final assistant text (or last assistant message when chat). */
  output: string;
  /** Any tool calls the model wants the runtime to dispatch. */
  tool_calls: ToolCallRecord[];
  tokens_in: number;
  tokens_out: number;
  /** Vendor cost in USD (eight decimals to match meter.pricing_rate). */
  provider_cost: number;
  /** Vendor cost plus the gateway margin (passthrough_plus_margin). */
  billed_cost: number;
  latency_ms: number;
  /** Cross-link to Langfuse for the provider call trace. */
  langfuse_trace_id?: string;
  /** OTel trace id — required (AC-11 propagation). */
  trace_id: string;
  /** True when the PII redactor stripped a match before forwarding to the provider. */
  pii_redaction_applied: boolean;
  /** Terminal reason supplied by the provider. */
  finish_reason: 'stop' | 'length' | 'tool_call' | 'content_filter' | 'cancelled';
}

export interface StreamChunk {
  completion_id: string;
  /** Cumulative chunk index (0-based). */
  index: number;
  /** New text appended this chunk (empty on tool-call chunks). */
  delta: string;
  /** Populated on the final chunk only. */
  finish_reason?: CompletionResponse['finish_reason'];
  /** Optional rolling token counter for client-side progress UIs. */
  tokens_so_far?: number;
}

/* ============================================================
 * sdk-agent-runtime — capability tokens (FR-ART-1..4)
 * ============================================================ */

export type CapabilityTokenStatus =
  | 'issued'
  | 'used'
  | 'expired'
  | 'revoked';

export interface CapabilityToken {
  token_id: string;
  run_id: string;
  agent_id: string;
  acting_persona_id: string;
  /** Bound SKU — token is invalid for any other sku. */
  tool_sku: string;
  /** Hex-encoded SHA-256 of the canonicalised args. Enforces single-args binding. */
  args_hash: string;
  tenant_scope: string;
  issued_at: string;
  expires_at: string;
  used_at?: string | null;
  used_by_invocation_id?: string | null;
  revoked_at?: string | null;
  revoked_reason?: string | null;
  /** Hex-encoded HMAC-SHA256 signature; key vaulted via sdk-vault. */
  signature: string;
}

export interface MintCapabilityTokenRequest {
  run_id: string;
  tool_sku: string;
  args: unknown;
  /** Caller-requested TTL; runtime clamps to <= 300s. */
  ttl_seconds?: number;
}

export interface ValidateCapabilityTokenResult {
  valid: boolean;
  reason?:
    | 'expired'
    | 'used'
    | 'revoked'
    | 'args_mismatch'
    | 'signature_mismatch'
    | 'not_found';
  token?: CapabilityToken;
}

/* ============================================================
 * sdk-agent-runtime — execution log (FR-ART-8..12, deterministic replay)
 * ============================================================ */

export type ExecutionLogKind =
  | 'prompt-template'
  | 'context-retrieval'
  | 'model-invocation'
  | 'tool-call'
  | 'tool-response'
  | 'final-action'
  | 'ttl-event'
  | 'kill-event';

export interface ExecutionLogEntry {
  entry_id: string;
  run_id: string;
  /** Monotonic per run; UNIQUE (run_id, seq). */
  seq: number;
  kind: ExecutionLogKind;
  /** Hex-encoded SHA-256 of the canonicalised payload (content addressing). */
  content_hash: string;
  recorded_at: string;
}

/** Verdict returned by the replay engine; `matched` is the bit-identical case. */
export type ReplayVerdict =
  | { kind: 'matched'; run_id: string }
  | { kind: 'snapshot-drift'; run_id: string; expected_snapshot: string; actual_snapshot: string }
  | { kind: 'diverged'; run_id: string; first_divergent_seq: number };

/* ============================================================
 * Tool manifest (FR-ART-21..23, G-6)
 * ============================================================ */

/** Minimum JSON Schema-shaped object; runtime validators may enforce a stricter draft. */
export type JsonSchema = Record<string, unknown>;

/**
 * Every SDK exporting an agent-callable tool ships a manifest. The meter
 * enforces `declared_skus_called` ⊆ `agent.agent_scope` at admission time
 * (denies before the tool runs, not after).
 */
export interface ToolManifest {
  /** The SKU the meter charges when the tool runs. */
  tool_sku: string;
  display_name: string;
  description?: string;
  args_schema: JsonSchema;
  /** Other SKUs this tool will call transitively (must be in the agent's scope too). */
  declared_skus_called: string[];
  /** When 'manual', the agent runtime won't invoke the tool autonomously. */
  testability?: 'auto' | 'manual';
}

/* ============================================================
 * sdk-trace public surface (PRD §5.3 / G12)
 * ============================================================ */

export type TraceSpanLayer =
  | 'gateway'
  | 'identity'
  | 'consent'
  | 'pool-router'
  | 'vault'
  | 'policy'
  | 'rebac'
  | 'meter'
  | 'sdk-body'
  | 'tool'
  | 'agent'
  | 'lineage';

export type TraceSpanStatus = 'ok' | 'error' | 'cancelled';

export interface TraceSpan {
  span_id: string;
  trace_id: string;
  parent_span_id?: string | null;
  layer: TraceSpanLayer;
  operation: string;
  started_at: string;
  ended_at: string;
  latency_ms: number;
  status: TraceSpanStatus;
  attributes: Record<string, unknown>;
  audit_entry_id?: string | null;
  usage_event_id?: string | null;
  agent_run_id?: string | null;
}

export interface TraceTimeline {
  trace_id: string;
  tenant_id: string | null;
  started_at: string;
  completed_at?: string | null;
  root_span_id: string;
  total_latency_ms: number;
  error_count: number;
  /** Per-layer SLO breaches keyed by layer. */
  budget_violations: Partial<Record<TraceSpanLayer, { budget_ms: number; actual_ms: number }>>;
  spans: TraceSpan[];
}

/* ============================================================
 * sdk-mcp-bridge public surface (PRD §5.4)
 * ============================================================ */

export type McpTransport = 'http' | 'sse' | 'stdio';

export interface McpServerRegistration {
  registration_id: string;
  tenant_id: string;
  display_name: string;
  transport: McpTransport;
  /** HTTP/SSE endpoint URL OR stdio command line. */
  endpoint_url: string;
  status: 'active' | 'disabled' | 'degraded';
  /** Agents permitted to invoke this server's tools. */
  allowed_agent_ids: string[];
}

export interface McpToolDescriptor {
  tool_id: string;
  registration_id: string;
  tool_name: string;
  args_schema: JsonSchema;
  /** When true, the server registered the tool but the tenant admin opted out. */
  opt_out: boolean;
}

export interface McpToolInvocation {
  invocation_id: string;
  tool_id: string;
  agent_run_id: string;
  capability_token_id: string;
  outcome: 'succeeded' | 'failed' | 'timeout' | 'denied';
  latency_ms: number;
  external_cost?: number | null;
}
