import { createHmac } from 'crypto';
import type { ToolManifest } from '@projexlight/contracts';
import type { ControlPlane, RuntimeTool } from '../controlPlane';
import { log } from '../log';
import type { SessionContext } from '../session/sessionStore';

/**
 * Tool execution for a live call (VA·E1 · TK-4462).
 *
 * The agent version's app-registered tools (from the call bootstrap) are offered to the LLM.
 * When the model calls them:
 *   1. The call's session capability token is validated for that tool (control plane; an
 *      authorized check is audited as voice.tool.invoked.v1). A token the platform no
 *      longer honours — call ended, tool disabled — stops the tool.
 *   2. The tenant's endpoint is called over HTTPS, signed with the tool's secret:
 *        X-Projexcloud-Signature: t=<unix s>,v1=HMAC-SHA256(secret, "<t>.<Idempotency-Key>.<body>")
 *        Idempotency-Key:         <call_id>:<turn_index>:<tool>
 *      (verify with @projexlight/voice-client verifyToolRequest).
 *   3. Each call has the tool's own timeout; independent calls in one model turn run in
 *      parallel. A tool that fails 3 times in a row is skipped for 30 s (circuit breaker).
 * Every outcome — result, timeout, error — goes back to the model as a tool message, so it
 * can answer gracefully; nothing a tool does can leave the caller in silence.
 */

export interface ToolCallRequest {
  tool_call_id: string;
  name: string;
  args: unknown;
}

export interface ToolOutcome {
  tool_call_id: string;
  name: string;
  ok: boolean;
  result?: unknown;
  error?: 'timeout' | 'unavailable' | 'not_authorized' | 'unknown_tool' | 'http_error' | 'cancelled';
  message?: string;
  status?: number;
  ms: number;
}

const MAX_RESULT_CHARS = 4000;
const BREAKER_FAILURES = 3;
const BREAKER_OPEN_MS = 30_000;

interface Breaker { failures: number; openUntil: number }

export class ToolExecutor {
  private readonly tools = new Map<string, RuntimeTool>();
  private readonly breakers = new Map<string, Breaker>();
  /** Recent latency per tool (EWMA), for latency-masking fillers (TK-4463). */
  private readonly latency = new Map<string, number>();

  constructor(private readonly session: SessionContext, private readonly controlPlane: ControlPlane) {
    for (const t of session.boot.tools) this.tools.set(t.name, t);
  }

  get size(): number {
    return this.tools.size;
  }

  /** Tool definitions for the LLM request. */
  manifest(): ToolManifest[] {
    return [...this.tools.values()].map((t) => ({
      tool_sku: t.name,
      display_name: t.name,
      description: t.description ?? undefined,
      args_schema: t.json_schema as ToolManifest['args_schema'],
      declared_skus_called: [],
    }));
  }

  /** How long these calls are expected to take: recent latency, else the configured timeout. */
  expectedMs(names: string[]): number {
    return Math.max(0, ...names.map((n) => this.latency.get(n) ?? this.tools.get(n)?.timeout_ms ?? 0));
  }

  /** Runs the model's tool calls for one turn, in parallel. Never throws. */
  run(calls: ToolCallRequest[], turnIndex: number, signal: AbortSignal): Promise<ToolOutcome[]> {
    return Promise.all(calls.map((c) => this.runOne(c, turnIndex, signal)));
  }

  private async runOne(call: ToolCallRequest, turnIndex: number, signal: AbortSignal): Promise<ToolOutcome> {
    const started = Date.now();
    const done = (o: Omit<ToolOutcome, 'tool_call_id' | 'name' | 'ms'>): ToolOutcome => {
      const out = { tool_call_id: call.tool_call_id, name: call.name, ms: Date.now() - started, ...o };
      log.info('tool call', { callId: this.session.callId, turn: turnIndex, tool: call.name, ok: out.ok, error: out.error, status: out.status, ms: out.ms });
      return out;
    };
    const tool = this.tools.get(call.name);
    if (!tool) return done({ ok: false, error: 'unknown_tool', message: `no tool named ${call.name}` });
    const br = this.breakers.get(tool.name) ?? { failures: 0, openUntil: 0 };
    if (br.openUntil > Date.now()) return done({ ok: false, error: 'unavailable', message: 'the tool is temporarily unavailable' });

    try {
      const check = await this.controlPlane.validateTool(this.session.callId, this.session.boot.session_token.token, tool.name);
      if (!check.valid) return done({ ok: false, error: 'not_authorized', message: check.reason ?? 'not authorized' });
    } catch (err) {
      return this.fail(tool, done({ ok: false, error: 'unavailable', message: `could not authorize the tool: ${(err as Error).message}` }));
    }

    const body = JSON.stringify({
      call_id: this.session.callId,
      tenant_id: this.session.tenantId,
      agent_id: this.session.boot.agent.agent_id,
      turn_index: turnIndex,
      tool: tool.name,
      arguments: call.args ?? {},
    });
    const idem = `${this.session.callId}:${turnIndex}:${tool.name}`;
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', tool.signing_secret).update(`${t}.${idem}.${body}`).digest('hex');
    const timeout = AbortSignal.timeout(tool.timeout_ms);
    let res: Response;
    try {
      res = await fetch(tool.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': idem,
          'x-projexcloud-signature': `t=${t},v1=${sig}`,
          'x-projexcloud-call-id': this.session.callId,
        },
        body,
        signal: AbortSignal.any([signal, timeout]),
      });
    } catch (err) {
      if (signal.aborted) return done({ ok: false, error: 'cancelled' });
      if (timeout.aborted) return this.fail(tool, done({ ok: false, error: 'timeout', message: `the tool did not answer within ${tool.timeout_ms} ms` }));
      return this.fail(tool, done({ ok: false, error: 'http_error', message: `could not reach the tool: ${(err as Error).message}` }));
    }
    let text = '';
    try {
      text = await res.text();
    } catch (err) {
      if (timeout.aborted) return this.fail(tool, done({ ok: false, error: 'timeout', message: `the tool did not answer within ${tool.timeout_ms} ms` }));
      text = '';
    }
    if (!res.ok) return this.fail(tool, done({ ok: false, error: 'http_error', status: res.status, message: `the tool answered HTTP ${res.status}` }));
    let result: unknown = text;
    try { result = text ? JSON.parse(text) : {}; } catch { /* plain text result */ }
    br.failures = 0;
    this.breakers.set(tool.name, br);
    const out = done({ ok: true, result, status: res.status });
    this.latency.set(tool.name, Math.round(0.7 * (this.latency.get(tool.name) ?? out.ms) + 0.3 * out.ms));
    return out;
  }

  private fail(tool: RuntimeTool, out: ToolOutcome): ToolOutcome {
    const br = this.breakers.get(tool.name) ?? { failures: 0, openUntil: 0 };
    br.failures += 1;
    if (br.failures >= BREAKER_FAILURES) {
      br.openUntil = Date.now() + BREAKER_OPEN_MS;
      br.failures = 0;
      log.warn('tool circuit open', { callId: this.session.callId, tool: tool.name, forMs: BREAKER_OPEN_MS });
    }
    this.breakers.set(tool.name, br);
    if (out.error === 'timeout') this.latency.set(tool.name, tool.timeout_ms);
    return out;
  }
}

/** The tool message content the model sees for an outcome (bounded). */
export function toolMessage(o: ToolOutcome): string {
  const payload = o.ok
    ? { ok: true, result: o.result }
    : { ok: false, error: o.error, message: o.message ?? 'the tool failed', instruction: 'Apologise briefly, do not invent the result, and offer an alternative (a callback or another way to help).' };
  const s = JSON.stringify(payload);
  return s.length > MAX_RESULT_CHARS ? `${s.slice(0, MAX_RESULT_CHARS)}…` : s;
}
