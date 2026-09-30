import type { TurnRecord } from './session/sessionStore';
import { log } from './log';

/**
 * The runtime's view of the control plane (sdk-voice-agent via the api-gateway, operator
 * token). The types mirror POST /api/admin/voice-agent/runtime/bootstrap — an HTTP contract,
 * kept here rather than imported so the runtime does not build the SDK closure.
 */

export interface LayerConfig {
  provider: string;
  model?: string;
  voice?: string;
  options?: Record<string, unknown>;
}

export interface KeyHandle {
  binding_id: string;
  provider: string;
  priority: 'primary' | 'secondary';
  /** Decrypted provider key: memory only, never logged or persisted. */
  key: string;
}

export interface RuntimeLayerConfig extends LayerConfig {
  primary: KeyHandle;
  secondary: (KeyHandle & { config: LayerConfig }) | null;
}

export type RuntimeLayer = 'stt' | 'llm_fast' | 'llm_complex' | 'tts';

export interface RuntimeTool {
  tool_id: string;
  name: string;
  description: string | null;
  json_schema: Record<string, unknown>;
  url: string;
  timeout_ms: number;
  idempotent: boolean;
  signing_secret: string;
}

export interface Bootstrap {
  action: 'agent';
  call: {
    call_id: string;
    tenant_id: string;
    direction: 'inbound' | 'outbound';
    is_test: boolean;
    status: string;
    from_number: string | null;
    to_number: string | null;
    subject_ref: string | null;
    jurisdiction: string | null;
    recording_consent: boolean | null;
    gate_verdicts: unknown;
    context: Record<string, unknown>;
  };
  agent: {
    agent_id: string;
    name: string;
    version_id: string;
    version_no: number;
    system_prompt: string;
    greeting: string | null;
    language: string;
    escalation_rules: Record<string, unknown>;
    business_hours: Record<string, unknown>;
    kb_corpus_ids: string[];
  };
  stack: { profile_id: string; preset_key: string; certified: boolean; layers: Record<RuntimeLayer, RuntimeLayerConfig> };
  tools: RuntimeTool[];
  /** voice.fast / voice.complex as resolved from the tenant's route rules (TK-4460). */
  routing?: Record<'voice.fast' | 'voice.complex', { layer: 'llm_fast' | 'llm_complex'; provider: string; model: string | null; rule_id: string | null; note?: string }>;
  /** Recording permission; `notice` means the opening must include the recording notice (TK-4461). */
  recording?: { permitted: boolean; notice: boolean; basis: string; rule: string | null; jurisdiction: string | null };
  session_token: { token: string; token_id: string; expires_at: string; allowed_tools: string[] };
  expires_at: string;
  first_bootstrap: boolean;
}

export interface Fallback {
  action: 'fallback';
  phone_number: string;
  tenant_id: string;
  agent_id: string;
  reason: string | null;
  fallback: string;
  fallback_target: string | null;
  kill_message: string | null;
}

export type BootstrapRequest =
  | { call_id: string }
  | { inbound: { to: string; from?: string; room: string; sip_call_id?: string } };

/** A queued evaluation run as the control plane hands it to a worker (sdk-voice-agent EvalRunJob). */
export interface EvalRunJob {
  eval_run_id: string;
  tenant_id: string;
  agent_id: string;
  version_id: string;
  mode: 'sandbox' | 'evaluation';
  scenarios: import('./sim/scenarioRunner').Scenario[];
}

/** What the runtime reports when a call ends (sdk-voice-agent CompleteCallInput). */
export interface CallCloseOut {
  status: 'completed' | 'failed';
  turns: TurnRecord[];
  started_at: string;
  ended_at: string;
  duration_s: number;
}

export class ControlPlaneError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'ControlPlaneError';
  }
}

export interface ControlPlaneOptions {
  baseUrl: string;
  opsToken: string;
  timeoutMs?: number;
  retries?: number;
}

export class ControlPlane {
  /** Requests made (for the "one request per call" guarantee and /status). */
  requests = 0;

  constructor(private readonly opts: ControlPlaneOptions) {}

  private async post<T>(path: string, body: unknown, retriesOverride?: number): Promise<T> {
    const retries = retriesOverride ?? this.opts.retries ?? 2;
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      this.requests += 1;
      let res: Response;
      try {
        res = await fetch(`${this.opts.baseUrl.replace(/\/+$/, '')}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-admin-ops-token': this.opts.opsToken },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5000),
        });
      } catch (err) {
        lastErr = err as Error;
        log.warn('control plane unreachable', { path, attempt, error: lastErr.message });
        await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
        continue;
      }
      const json = (await res.json().catch(() => null)) as { data?: T; error?: string; details?: string[] } | null;
      if (res.ok && json?.data !== undefined) return json.data;
      const err = new ControlPlaneError(res.status, json?.error ?? 'HttpError', json?.details?.[0] ?? `HTTP ${res.status}`);
      // 4xx is the control plane's answer, not a blip: do not retry it.
      if (res.status < 500) throw err;
      lastErr = err;
      log.warn('control plane error, retrying', { path, attempt, status: res.status });
      await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
    }
    throw lastErr ?? new Error('control plane request failed');
  }

  /** The call's whole session in one request (TK-4456). */
  bootstrap(req: BootstrapRequest): Promise<Bootstrap | Fallback> {
    return this.post<Bootstrap | Fallback>('/api/admin/voice-agent/runtime/bootstrap', req);
  }

  /**
   * Checks the call's session capability token authorizes `tool` right before it runs
   * (TK-4508/4462); the control plane audits an authorized check as voice.tool.invoked.v1.
   * One quick request per TOOL CALL, never per turn.
   */
  validateTool(callId: string, token: string, tool: string): Promise<{ valid: boolean; reason?: string }> {
    return this.post(`/api/admin/voice-agent/calls/${encodeURIComponent(callId)}/session-token/validate`, { token, tool });
  }

  /** Escalates the call to the agent's human (TK-4464): handoff + REFER / bridge / callback. */
  transfer(callId: string, body: {
    reason: string; summary: string; room: string; caller_identity: string | null; caller_is_sip: boolean;
    transcript: { speaker: string; text: string }[];
  }): Promise<{ handoff_id: string; mode: 'refer' | 'bridge' | 'callback'; target_number: string; note?: string }> {
    return this.post(`/api/admin/voice-agent/calls/${encodeURIComponent(callId)}/transfer`, body);
  }

  /** A layer's primary failed mid-call (TK-4465): recorded + voice.credential.degraded.v1. */
  credentialDegraded(callId: string, body: {
    layer: string; binding_id: string; provider: string; status: number; error: string;
    switched_to_binding_id: string | null; switched_to_provider: string | null;
  }): Promise<unknown> {
    return this.post(`/api/admin/voice-agent/calls/${encodeURIComponent(callId)}/credential-degraded`, body);
  }

  /**
   * End-of-call report (TK-4467): the whole transcript + outcome in one write. No in-request
   * retries — the close-out buffer owns retrying, durably.
   */
  completeCall(callId: string, body: CallCloseOut): Promise<{ call_id: string; status: string; turns: number }> {
    return this.post(`/api/admin/voice-agent/calls/${encodeURIComponent(callId)}/complete`, body, 0);
  }

  // Evaluation runs (TK-4517/4518): claim a queued run, open a test call per scenario, finish it.
  claimEvalRun(worker: string): Promise<{ eval_run: EvalRunJob | null }> {
    return this.post('/api/admin/voice-agent/eval-runs/claim', { worker });
  }

  createEvalCall(evalRunId: string, worker: string, scenarioIndex: number): Promise<{ call_id: string; tenant_id: string }> {
    return this.post(`/api/admin/voice-agent/eval-runs/${encodeURIComponent(evalRunId)}/calls`, { worker, scenario_index: scenarioIndex });
  }

  finishEvalRun(evalRunId: string, body: {
    worker: string; status: 'completed' | 'error'; passed?: boolean; score?: number; metrics?: Record<string, unknown>; results?: unknown[]; error?: string;
  }): Promise<{ eval_run: EvalRunJob }> {
    return this.post(`/api/admin/voice-agent/eval-runs/${encodeURIComponent(evalRunId)}/finish`, body);
  }

  // Catalog certification runs (TK-4519): claim one (with its vault keys), report it.
  claimCertificationRun(worker: string): Promise<{ job: import('./sim/certify').CertificationJob | null }> {
    return this.post('/api/admin/speech/certification-runs/claim', { worker });
  }

  finishCertificationRun(runId: string, body: { worker: string; status: 'completed' | 'error'; passed?: boolean; metrics?: Record<string, unknown>; error?: string }): Promise<unknown> {
    return this.post(`/api/admin/speech/certification-runs/${encodeURIComponent(runId)}/finish`, body);
  }

  /** Batch form: the tool calls of one model turn in one request, so they can start together. */
  async validateTools(callId: string, token: string, tools: string[]): Promise<Map<string, { valid: boolean; reason?: string }>> {
    const r = await this.post<{ results: { tool: string; valid: boolean; reason?: string }[] }>(
      `/api/admin/voice-agent/calls/${encodeURIComponent(callId)}/session-token/validate`, { token, tools },
    );
    return new Map(r.results.map((x) => [x.tool, { valid: x.valid, reason: x.reason }]));
  }
}
