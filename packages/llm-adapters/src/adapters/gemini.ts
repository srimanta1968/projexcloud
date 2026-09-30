import type { ChatMessage, CompletionRequest, CompletionResponse, StreamChunk, ToolCallRecord } from '@projexlight/contracts';
import type { ProviderAdapter, ProviderCompletionResult } from '../providerAdapter';
import { providerCost } from '../modelPricing';
import { chatMessages, credentialKey, parseArgs, postJson, sseData } from './http';

/**
 * Google Gemini adapter (generateContent / streamGenerateContent?alt=sse), VA·E5 ·
 * TK-4494. Function calling in both directions: tools become functionDeclarations, a
 * functionCall part comes back as a tool call, and a tool result goes back as a
 * functionResponse (Gemini matches responses by function NAME, recovered from the
 * assistant turn that made the call). Gemini caches repeated prefixes implicitly;
 * cached tokens are included in promptTokenCount.
 */

type Part =
  | { text: string }
  | { functionCall: { name: string; args?: unknown; id?: string } }
  | { functionResponse: { name: string; response: Record<string, unknown>; id?: string } };

interface Content { role: 'user' | 'model'; parts: Part[] }
interface UsageMetadata { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number }
interface GeminiResponse {
  candidates?: { content?: { parts?: Part[] }; finishReason?: string }[];
  usageMetadata?: UsageMetadata;
}

const FINISH: Record<string, CompletionResponse['finish_reason']> = {
  STOP: 'stop',
  MAX_TOKENS: 'length',
  SAFETY: 'content_filter',
  RECITATION: 'content_filter',
  PROHIBITED_CONTENT: 'content_filter',
  BLOCKLIST: 'content_filter',
  SPII: 'content_filter',
};

function toGemini(messages: ChatMessage[]): { system: string; contents: Content[] } {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const nameOf = new Map<string, string>();
  const contents: Content[] = [];
  const push = (role: 'user' | 'model', parts: Part[]): void => {
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'assistant') {
      const parts: Part[] = m.content ? [{ text: m.content }] : [];
      for (const c of m.tool_calls ?? []) {
        nameOf.set(c.tool_call_id, c.tool_sku);
        parts.push({ functionCall: { name: c.tool_sku, args: parseArgs(c.args) } });
      }
      if (parts.length) push('model', parts);
    } else if (m.role === 'tool') {
      const name = nameOf.get(m.tool_call_id ?? '') ?? m.tool_call_id ?? 'tool';
      const parsed = parseArgs(m.content);
      const response = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { result: m.content };
      push('user', [{ functionResponse: { name, response } }]);
    } else {
      push('user', [{ text: m.content }]);
    }
  }
  return { system, contents };
}

function requestBody(request: CompletionRequest): Record<string, unknown> {
  const { system, contents } = toGemini(chatMessages(request));
  const body: Record<string, unknown> = { contents };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const gen: Record<string, unknown> = {};
  if (request.max_tokens !== undefined) gen.maxOutputTokens = request.max_tokens;
  if (request.temperature !== undefined) gen.temperature = request.temperature;
  if (request.top_p !== undefined) gen.topP = request.top_p;
  if (request.stop_sequences?.length) gen.stopSequences = request.stop_sequences;
  if (Object.keys(gen).length) body.generationConfig = gen;
  if (request.tools?.length) {
    body.tools = [{ functionDeclarations: request.tools.map((t) => ({ name: t.tool_sku, description: t.description ?? t.display_name, parameters: t.args_schema })) }];
  }
  return body;
}

const callsFrom = (parts: Part[], offset = 0): ToolCallRecord[] =>
  parts
    .filter((p): p is Extract<Part, { functionCall: unknown }> => 'functionCall' in p)
    .map((p, i) => ({ tool_call_id: p.functionCall.id ?? `call_${offset + i}`, tool_sku: p.functionCall.name, args: p.functionCall.args ?? {} }));
const textFrom = (parts: Part[]): string =>
  parts.filter((p): p is Extract<Part, { text: string }> => 'text' in p).map((p) => p.text).join('');
const tokensOut = (u: UsageMetadata | undefined): number => (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0);

export interface GeminiOptions {
  /** API root, default https://generativelanguage.googleapis.com/v1beta. */
  base_url: string;
}

export function makeGeminiAdapter(opts: GeminiOptions): ProviderAdapter {
  const root = opts.base_url.replace(/\/+$/, '');
  const url = (model: string, action: string): string => `${root}/models/${encodeURIComponent(model)}:${action}`;
  const headers = (key: string): Record<string, string> => ({ 'x-goog-api-key': key });

  return {
    provider_id: 'gemini',

    async complete(request, credential): Promise<ProviderCompletionResult> {
      const res = await postJson('gemini', url(request.model, 'generateContent'), headers(credentialKey(credential)), requestBody(request));
      const json = (await res.json()) as GeminiResponse;
      const cand = json.candidates?.[0];
      const parts = cand?.content?.parts ?? [];
      const tool_calls = callsFrom(parts);
      const tokens_in = json.usageMetadata?.promptTokenCount ?? 0;
      const tokens_out = tokensOut(json.usageMetadata);
      return {
        output: textFrom(parts),
        tool_calls,
        tokens_in,
        tokens_out,
        provider_cost: await providerCost('gemini', request.model, tokens_in, tokens_out),
        finish_reason: tool_calls.length ? 'tool_call' : FINISH[cand?.finishReason ?? ''] ?? 'stop',
      };
    },

    async *stream(request, credential): AsyncIterable<StreamChunk> {
      const res = await postJson('gemini', `${url(request.model, 'streamGenerateContent')}?alt=sse`, headers(credentialKey(credential)), requestBody(request));
      let index = 0;
      let usage: UsageMetadata | undefined;
      let finish: string | undefined;
      const tool_calls: ToolCallRecord[] = [];
      for await (const { data } of sseData(res)) {
        let evt: GeminiResponse;
        try { evt = JSON.parse(data); } catch { continue; }
        if (evt.usageMetadata) usage = evt.usageMetadata;
        const cand = evt.candidates?.[0];
        if (!cand) continue;
        if (cand.finishReason) finish = cand.finishReason;
        const parts = cand.content?.parts ?? [];
        tool_calls.push(...callsFrom(parts, tool_calls.length));
        const delta = textFrom(parts);
        if (delta) yield { completion_id: '', index: index++, delta };
      }
      const tokens_in = usage?.promptTokenCount ?? 0;
      const tokens_out = tokensOut(usage);
      yield {
        completion_id: '',
        index,
        delta: '',
        finish_reason: tool_calls.length ? 'tool_call' : FINISH[finish ?? ''] ?? 'stop',
        tokens_so_far: tokens_out,
        tool_calls,
        usage: { tokens_in, tokens_out, provider_cost: await providerCost('gemini', request.model, tokens_in, tokens_out) },
      };
    },
  };
}
