/**
 * Wire types of the ProjexCloud voice APIs, as a consumer sees them (JSON: timestamps are
 * ISO-8601 strings). Mirrors sdk-voice-agent / sdk-dialer responses; this package has no
 * dependency on either, so it installs on its own.
 */

export type CallStatus =
  | 'queued' | 'deferred' | 'refused' | 'dialing' | 'ringing' | 'in_progress' | 'transferred' | 'completed' | 'failed';
export type CallDirection = 'inbound' | 'outbound';

export interface CallTurn {
  turn_index: number;
  speaker: 'caller' | 'agent' | 'system';
  text: string;
  started_ms: number | null;
  stt_ms: number | null;
  ttft_ms: number | null;
  ttfa_ms: number | null;
  interrupted: boolean;
  tool_calls: unknown[];
  created_at: string;
}

export interface Call {
  call_id: string;
  tenant_id: string;
  agent_id: string;
  agent_version_id: string | null;
  direction: CallDirection;
  subject_ref: string | null;
  from_number: string | null;
  to_number: string | null;
  carrier_call_ref: string | null;
  status: CallStatus;
  answered_by: string | null;
  disposition: string | null;
  summary: string | null;
  context: Record<string, unknown>;
  gate_verdicts: Record<string, unknown>;
  recording_consent: boolean | null;
  recording_ref: string | null;
  cost_breakdown: Record<string, unknown>;
  is_test: boolean;
  idempotency_key: string | null;
  requested_by: string | null;
  crm_encounter_id: string | null;
  conversation_thread_id: string | null;
  person_id: string | null;
  jurisdiction: string | null;
  recipient_timezone: string | null;
  voicemail_action: string | null;
  caller_id_attestation: string | null;
  post_call: Record<string, unknown>;
  next_attempt_at: string | null;
  started_at: string | null;
  answered_at: string | null;
  ended_at: string | null;
  duration_s: number | null;
  created_at: string;
  updated_at: string;
}

export interface CallDetail extends Call {
  transcript: CallTurn[];
}

export interface PlaceCallInput {
  agent_id: string;
  /** E.164 number to call. */
  to: string;
  /** E.164 caller ID; omitted = the dialer picks one from the tenant's pool. */
  from?: string;
  /** Your app's reference for who is called, e.g. 'lead:123'. */
  subject_ref?: string;
  /** Free-form context handed to the agent. */
  context?: Record<string, unknown>;
  /** sdk-crm encounter whose timeline receives the call activity. */
  crm_encounter_id?: string;
  /** sdk-conversation thread to mirror the turns onto. */
  conversation_thread_id?: string;
  /** sdk-consent person whose ai_voice_outbound consent is checked before dialling. */
  person_id?: string;
  /** Consent jurisdiction (ISO country, optionally -region), e.g. US, US-CA. */
  jurisdiction?: string;
  /** Recipient's IANA time zone for the calling window, e.g. America/Chicago. */
  timezone?: string;
}

export interface PlaceCallOptions {
  /** Retrying with the same key returns the original call instead of placing another. */
  idempotencyKey?: string;
}

export interface PlaceCallResult {
  call: Call;
  /** true when an earlier request with the same idempotency key produced this call. */
  replayed: boolean;
}

export interface ListCallsFilter {
  agent_id?: string;
  status?: CallStatus;
  direction?: CallDirection;
  subject_ref?: string;
  is_test?: boolean;
  limit?: number;
  offset?: number;
}

export interface CallPage {
  calls: Call[];
  limit: number;
  offset: number;
}

export interface StartTestSessionInput {
  agent_id: string;
  /** A draft version to test; omitted = the agent's latest version. */
  version_id?: string;
  /** Session lifetime in seconds. */
  ttl_s?: number;
}

export interface TestSession {
  call_id: string;
  agent_id: string;
  agent_version_id: string;
  version_no: number;
  room: string;
  livekit_url: string;
  token: string;
  expires_at: string;
  is_test: true;
}

export interface LiveTicket {
  ticket: string;
  expires_at: string;
  [key: string]: unknown;
}

export interface CallingWindowInput {
  to_number: string;
  recipient_timezone?: string;
  campaign_id?: string;
  /** Evaluate another instant (default now). */
  at?: string | Date;
}

export interface CallingWindowCheck {
  allowed: boolean;
  reason: 'inside_calling_window' | 'outside_calling_window' | 'calling_window_unreachable';
  window_start: string;
  window_end: string;
  timezones: string[];
  timezone_source: string;
  local_times: Record<string, string>;
  closed_timezones: string[];
  next_open_at: string | null;
}

export interface CapacitySnapshot {
  backend: 'redis' | 'postgres';
  plan_cap: number | null;
  alert_at: number | null;
  active: number;
  by_campaign: { campaign_id: string; active: number; cap: number }[];
}

/** The body of a voice webhook delivery (the gateway's audit -> webhook bridge). */
export interface VoiceWebhookEvent<T = Record<string, unknown>> {
  event_id: string;
  event_type: string;
  occurred_at: string;
  tenant_id: string;
  subject_kind: string | null;
  subject_id: string | null;
  data: T;
}

// ---- agents, tools, campaigns, catalog --------------------------------------------------
// Core fields are typed; the gateway returns more, which stay reachable through the index
// signature so a server-side addition never breaks a consumer build.

export interface Agent {
  agent_id: string;
  tenant_id: string;
  name: string;
  direction: 'inbound' | 'outbound' | 'both';
  status: string;
  published_version_id: string | null;
  [key: string]: unknown;
}

export interface AgentVersion {
  version_id: string;
  agent_id: string;
  version_no: number;
  system_prompt: string;
  stack_profile_id: string;
  tool_ids: string[];
  published_at: string | null;
  [key: string]: unknown;
}

export interface AppTool {
  tool_id: string;
  name: string;
  description: string | null;
  json_schema: Record<string, unknown>;
  url: string;
  signing_secret_ref: string;
  timeout_ms: number;
  idempotent: boolean;
  enabled: boolean;
  [key: string]: unknown;
}

export interface RegisterToolInput {
  name: string;
  description?: string;
  json_schema: Record<string, unknown>;
  /** https:// endpoint the agent calls. */
  url: string;
  /** sdk-secrets reference, e.g. secret://app/my-tools (never the secret itself). */
  signing_secret_ref: string;
  timeout_ms?: number;
  idempotent?: boolean;
  app_id?: string;
}

export interface Campaign {
  campaign_id: string;
  agent_id: string;
  name: string;
  status: string;
  window_start: string;
  window_end: string;
  default_timezone: string;
  max_concurrency: number;
  [key: string]: unknown;
}

export type CampaignAction = 'start' | 'pause' | 'resume' | 'cancel';

export interface CatalogEntry {
  entry_id: string;
  [key: string]: unknown;
}

// ---- evaluation runs (VA·E10 · TK-4517/4518) -------------------------------------------------

/** One simulated-caller scenario. Sandbox mode needs `turns`; `agent` scripts are sandbox-only. */
export interface EvalScenario {
  name: string;
  /** Evaluation mode without `turns`: an LLM plays the caller. */
  caller?: { persona?: string; goal?: string };
  turns?: {
    say: string;
    /** Say it while the agent is still talking (barge-in probe). */
    interrupt?: boolean;
    /** Sandbox: the scripted agent's tool calls and reply for this line. Args may reference an
     *  earlier tool's result: "{{tool:capture_lead.lead_id}}". */
    agent?: { reply?: string; tool_calls?: { name: string; args?: Record<string, unknown> }[] };
  }[];
  max_turns?: number;
  expect?: { tools_called?: string[]; tools_not_called?: string[]; transfer?: boolean; says_any?: string[]; says_none?: string[] };
}

export interface StartEvalRunInput {
  /** sandbox: fake providers + scripted agent, free, never unlocks publish. evaluation (default): real LLM, gates publish. */
  mode?: 'sandbox' | 'evaluation';
  /** Omitted: the default suite for the mode. */
  scenarios?: EvalScenario[];
  suite?: string;
}

export interface EvalCheck { name: string; passed: boolean; detail?: string }

export interface EvalScenarioResult {
  name: string;
  call_id: string;
  passed: boolean;
  checks: EvalCheck[];
  error: string | null;
  tools: { name: string; ok: boolean; error: string | null; ms: number }[];
  transfer_requested: boolean;
  ttft_ms: number[];
  barge_in_stop_ms: number[];
  transcript: { speaker: string; text: string; interrupted: boolean }[];
  duration_ms: number;
}

export interface EvalRun {
  eval_run_id: string;
  agent_id: string;
  version_id: string;
  suite: string;
  mode: 'reported' | 'sandbox' | 'evaluation';
  status: 'queued' | 'running' | 'completed' | 'error';
  passed: boolean | null;
  score: number | null;
  scenarios: EvalScenario[];
  results: EvalScenarioResult[];
  metrics: Record<string, unknown>;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}
