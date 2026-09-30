import type { ToolManifest } from '@projexlight/contracts';
import { llmAdapter } from '../providers/llm';
import type { TurnRecord } from '../session/sessionStore';

/**
 * Warm transfer helpers (VA·E1 · TK-4464). The agent gets a built-in `transfer_to_human` tool
 * when its version configures escalation_rules.transfer; the control plane does the rest
 * (sdk-handoff record + SIP REFER / bridge / callback).
 */

export const TRANSFER_TOOL = 'transfer_to_human';

export function transferAvailable(escalationRules: Record<string, unknown> | undefined): boolean {
  const t = (escalationRules?.transfer ?? null) as Record<string, unknown> | null;
  return !!t && typeof t.number === 'string' && /^\+[1-9]\d{6,14}$/.test(t.number);
}

export const transferToolManifest: ToolManifest = {
  tool_sku: TRANSFER_TOOL,
  display_name: TRANSFER_TOOL,
  description: 'Transfer the caller to a human colleague. Use it when the caller asks for a person, is upset, or needs something you cannot do. Say nothing else after calling it.',
  args_schema: {
    type: 'object',
    properties: { reason: { type: 'string', description: 'Why the caller needs a person, in a few words.' } },
    required: ['reason'],
  } as ToolManifest['args_schema'],
  declared_skus_called: [],
};

/** A last-resort summary when the model cannot write one: who asked for what, and why. */
export function extractiveSummary(turns: TurnRecord[], reason: string): string {
  const caller = turns.filter((t) => t.speaker === 'caller' && t.text).map((t) => t.text);
  const last = caller.slice(-3).join(' / ');
  return `Transfer reason: ${reason}.${last ? ` Caller said: ${last}` : ''}`.slice(0, 1000);
}

/**
 * Two or three sentences for the human taking the call, written by the fast model from the
 * transcript; falls back to the extractive summary when the model fails or is slow.
 */
export async function summarizeForHandoff(layer: { provider: string; model?: string; key: string }, turns: TurnRecord[], reason: string, timeoutMs = 4000): Promise<string> {
  const transcript = turns.filter((t) => t.text).map((t) => `${t.speaker === 'caller' ? 'Caller' : 'Agent'}: ${t.text}`).join('\n').slice(-6000);
  try {
    const r = await Promise.race([
      llmAdapter(layer.provider).complete({
        model: layer.model ?? '',
        prompt: [
          { role: 'system', content: 'You write handoff notes for a human colleague taking over a phone call. Two or three plain sentences: who is calling, what they want, what has been done, what is still open. No preamble.' },
          { role: 'user', content: `Reason for transfer: ${reason}\n\nTranscript:\n${transcript}` },
        ],
        max_tokens: 160,
        temperature: 0.2,
      }, Buffer.from(layer.key)),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    const text = r && 'output' in r ? r.output.trim() : '';
    if (text) return text.slice(0, 2000);
  } catch { /* fall back */ }
  return extractiveSummary(turns, reason);
}
