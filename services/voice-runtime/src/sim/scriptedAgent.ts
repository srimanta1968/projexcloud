import type { ChatMessage, CompletionRequest, StreamChunk } from '@projexlight/contracts';
import type { ProviderAdapter, ProviderCompletionResult } from '@projexlight/llm-adapters';

/**
 * The sandbox agent "LLM" (VA·E10 · TK-4517): deterministic, keyless. It follows the scenario:
 * for caller line N it makes the tool calls scripted on turn N (real, signed app-tool calls —
 * that is what a consumer app's CI is testing), then speaks the scripted reply.
 *
 * Tool arguments may reference an earlier tool's result, e.g. book_meeting after capture_lead:
 *   { "lead_id": "{{tool:capture_lead.lead_id}}" }
 * A whole-string reference keeps the value's type; inside a longer string it is interpolated.
 */

export interface ScriptTurn {
  say: string;
  agent?: { reply?: string; tool_calls?: { name: string; args?: Record<string, unknown> }[] };
}

const REF_RE = /\{\{tool:([a-z][a-z0-9_]*)\.([A-Za-z0-9_.[\]]+)\}\}/g;

function pick(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.replace(/\[(\d+)\]/g, '.$1').split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Tool results so far in the conversation, by tool name (the latest wins). */
function toolResults(messages: ChatMessage[]): Map<string, unknown> {
  const nameById = new Map<string, string>();
  const out = new Map<string, unknown>();
  for (const m of messages) {
    for (const c of m.tool_calls ?? []) nameById.set(c.tool_call_id, c.tool_sku);
    if (m.role === 'tool' && m.tool_call_id) {
      const name = nameById.get(m.tool_call_id);
      if (!name) continue;
      try {
        const parsed = JSON.parse(m.content) as { ok?: boolean; result?: unknown };
        if (parsed.ok) out.set(name, parsed.result);
      } catch { /* a truncated result: not referenceable */ }
    }
  }
  return out;
}

/** Resolves {{tool:name.path}} references in scripted arguments. Exported for the unit test. */
export function resolveArgs(value: unknown, results: Map<string, unknown>): unknown {
  if (typeof value === 'string') {
    const whole = /^\{\{tool:([a-z][a-z0-9_]*)\.([A-Za-z0-9_.[\]]+)\}\}$/.exec(value);
    if (whole) return pick(results.get(whole[1]), whole[2]) ?? null;
    return value.replace(REF_RE, (_m, name: string, path: string) => {
      const v = pick(results.get(name), path);
      return v === undefined || v === null ? '' : String(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => resolveArgs(v, results));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveArgs(v, results)]));
  }
  return value;
}

export function scriptedAgentLlm(turns: ScriptTurn[]): ProviderAdapter {
  let seq = 0;
  const plan = (request: CompletionRequest): { text: string; calls: { tool_call_id: string; tool_sku: string; args: unknown }[] } => {
    const messages = typeof request.prompt === 'string' ? [{ role: 'user', content: request.prompt } as ChatMessage] : request.prompt;
    const userCount = messages.filter((m) => m.role === 'user').length;
    const turn = turns[Math.max(0, userCount - 1)];
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content.split('\n').pop() ?? '';
    const reply = turn?.agent?.reply ?? `Thanks. You said: ${lastUser.slice(0, 120).replace(/[.!?\s]+$/, '')}. How else can I help?`;
    // After this caller line's tool results came back: answer.
    const lastUserIdx = messages.map((m) => m.role).lastIndexOf('user');
    const toolsDone = messages.slice(lastUserIdx + 1).some((m) => m.role === 'tool');
    const scripted = turn?.agent?.tool_calls ?? [];
    if (!toolsDone && scripted.length > 0 && (request.tools?.length ?? 0) > 0) {
      const results = toolResults(messages);
      return {
        text: '',
        calls: scripted.map((c) => ({ tool_call_id: `sandbox-${++seq}`, tool_sku: c.name, args: resolveArgs(c.args ?? {}, results) })),
      };
    }
    return { text: reply, calls: [] };
  };

  return {
    provider_id: 'sandbox' as ProviderAdapter['provider_id'],
    async complete(request: CompletionRequest): Promise<ProviderCompletionResult> {
      const p = plan(request);
      const output = p.calls.length ? '' : (p.text || 'Sandbox call summary.');
      return { output, tool_calls: p.calls, tokens_in: 0, tokens_out: 0, provider_cost: 0, finish_reason: p.calls.length ? 'tool_call' : 'stop' };
    },
    async *stream(request: CompletionRequest): AsyncIterable<StreamChunk> {
      const p = plan(request);
      if (p.calls.length) {
        yield { completion_id: 'sandbox', index: 0, delta: '', finish_reason: 'tool_call', tool_calls: p.calls };
        return;
      }
      const words = p.text.split(/(\s+)/);
      let i = 0;
      for (const w of words) {
        yield { completion_id: 'sandbox', index: i++, delta: w };
        await new Promise((r) => setTimeout(r, 5));
      }
      yield { completion_id: 'sandbox', index: i, delta: '', finish_reason: 'stop' };
    },
  };
}
