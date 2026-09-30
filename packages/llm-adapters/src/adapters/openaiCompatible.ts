import type {
  ChatMessage,
  CompletionRequest,
  CompletionResponse,
  ProviderId,
  StreamChunk,
  ToolCallRecord,
} from '@projexlight/contracts';
import type { ProviderAdapter, ProviderCompletionResult } from '../providerAdapter';
import { providerCost } from '../modelPricing';
import { chatMessages, credentialKey, parseArgs, postJson, sseData } from './http';

/**
 * OpenAI-compatible chat adapter (VA·E5 · TK-4493).
 *
 * Speaks the OpenAI Chat Completions wire format against ANY base URL, so one adapter
 * serves OpenAI, Azure OpenAI (via its OpenAI-compatible endpoint), Groq, Cerebras,
 * Together, Fireworks, DeepInfra, Mistral, xAI and a tenant's own vLLM. Supports tools
 * (function calling) in both complete and stream, and records the provider-reported
 * token usage (stream_options.include_usage on streams).
 */

export interface OpenAiCompatibleOptions {
  provider_id: ProviderId | string;
  /** API root including the version segment, e.g. https://api.groq.com/openai/v1. */
  base_url: string;
  /** Header carrying the key; default Authorization: Bearer <key>. Azure uses api-key. */
  auth?: 'bearer' | 'api-key';
  /** Extra static headers (e.g. OpenAI-Organization). */
  headers?: Record<string, string>;
}

/** Default API roots for the OpenAI-compatible hosts (overridable per registration). */
export const OPENAI_COMPATIBLE_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  cerebras: 'https://api.cerebras.ai/v1',
  together: 'https://api.together.xyz/v1',
  fireworks: 'https://api.fireworks.ai/inference/v1',
  deepinfra: 'https://api.deepinfra.com/v1/openai',
  mistral: 'https://api.mistral.ai/v1',
  xai: 'https://api.x.ai/v1',
};

interface OaiToolCall { id?: string; index?: number; type?: string; function?: { name?: string; arguments?: string } }
interface OaiMessage { role: string; content: string | null; tool_calls?: OaiToolCall[]; tool_call_id?: string }
interface OaiUsage { prompt_tokens?: number; completion_tokens?: number }

const FINISH: Record<string, CompletionResponse['finish_reason']> = {
  stop: 'stop',
  length: 'length',
  tool_calls: 'tool_call',
  function_call: 'tool_call',
  content_filter: 'content_filter',
};

function toOaiMessages(messages: ChatMessage[]): OaiMessage[] {
  return messages.map((m) => {
    if (m.role === 'tool') return { role: 'tool', content: m.content, tool_call_id: m.tool_call_id };
    if (m.role === 'assistant' && m.tool_calls?.length) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.tool_calls.map((c) => ({
          id: c.tool_call_id,
          type: 'function',
          function: { name: c.tool_sku, arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args ?? {}) },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

function requestBody(request: CompletionRequest, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: toOaiMessages(chatMessages(request)),
  };
  if (request.max_tokens !== undefined) body.max_tokens = request.max_tokens;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.top_p !== undefined) body.top_p = request.top_p;
  if (request.stop_sequences?.length) body.stop = request.stop_sequences;
  if (request.tools?.length) {
    body.tools = request.tools.map((t) => ({
      type: 'function',
      function: { name: t.tool_sku, description: t.description ?? t.display_name, parameters: t.args_schema },
    }));
  }
  if (stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }
  return body;
}

const toToolCalls = (calls: OaiToolCall[] | undefined): ToolCallRecord[] =>
  (calls ?? [])
    .filter((c) => c.function?.name)
    .map((c, i) => ({ tool_call_id: c.id ?? `call_${i}`, tool_sku: c.function!.name!, args: parseArgs(c.function?.arguments) }));

export function makeOpenAiCompatibleAdapter(opts: OpenAiCompatibleOptions): ProviderAdapter {
  const root = opts.base_url.replace(/\/+$/, '');
  const provider = String(opts.provider_id);
  const authHeaders = (key: string): Record<string, string> => ({
    ...(opts.auth === 'api-key' ? { 'api-key': key } : { Authorization: `Bearer ${key}` }),
    ...(opts.headers ?? {}),
  });

  return {
    provider_id: opts.provider_id as ProviderId,

    async complete(request, credential): Promise<ProviderCompletionResult> {
      const res = await postJson(provider, `${root}/chat/completions`, authHeaders(credentialKey(credential)), requestBody(request, false));
      const json = (await res.json()) as { choices?: { message?: OaiMessage; finish_reason?: string }[]; usage?: OaiUsage };
      const choice = json.choices?.[0];
      const tokens_in = json.usage?.prompt_tokens ?? 0;
      const tokens_out = json.usage?.completion_tokens ?? 0;
      const tool_calls = toToolCalls(choice?.message?.tool_calls);
      return {
        output: choice?.message?.content ?? '',
        tool_calls,
        tokens_in,
        tokens_out,
        provider_cost: await providerCost(provider, request.model, tokens_in, tokens_out),
        finish_reason: FINISH[choice?.finish_reason ?? ''] ?? (tool_calls.length ? 'tool_call' : 'stop'),
      };
    },

    async *stream(request, credential, opts): AsyncIterable<StreamChunk> {
      const res = await postJson(provider, `${root}/chat/completions`, authHeaders(credentialKey(credential)), requestBody(request, true), opts?.signal);
      let index = 0;
      let finish: CompletionResponse['finish_reason'] | undefined;
      let usage: OaiUsage | undefined;
      const calls = new Map<number, { id?: string; name: string; args: string }>();

      for await (const { data } of sseData(res)) {
        if (data === '[DONE]') break;
        let evt: { choices?: { delta?: { content?: string | null; tool_calls?: OaiToolCall[] }; finish_reason?: string | null }[]; usage?: OaiUsage | null };
        try { evt = JSON.parse(data); } catch { continue; }
        if (evt.usage) usage = evt.usage;
        const choice = evt.choices?.[0];
        if (!choice) continue;
        for (const tc of choice.delta?.tool_calls ?? []) {
          const i = tc.index ?? 0;
          const cur = calls.get(i) ?? { name: '', args: '' };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          calls.set(i, cur);
        }
        if (choice.finish_reason) finish = FINISH[choice.finish_reason] ?? 'stop';
        const delta = choice.delta?.content ?? '';
        if (delta) yield { completion_id: '', index: index++, delta };
      }

      const tool_calls = [...calls.entries()]
        .sort(([a], [b]) => a - b)
        .filter(([, c]) => c.name)
        .map(([i, c]) => ({ tool_call_id: c.id ?? `call_${i}`, tool_sku: c.name, args: parseArgs(c.args) }));
      const tokens_in = usage?.prompt_tokens ?? 0;
      const tokens_out = usage?.completion_tokens ?? 0;
      yield {
        completion_id: '',
        index,
        delta: '',
        finish_reason: finish ?? (tool_calls.length ? 'tool_call' : 'stop'),
        tokens_so_far: tokens_out,
        tool_calls,
        usage: { tokens_in, tokens_out, provider_cost: await providerCost(provider, request.model, tokens_in, tokens_out) },
      };
    },
  };
}
