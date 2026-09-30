import type { ChatMessage, CompletionRequest, CompletionResponse, StreamChunk, ToolCallRecord } from '@projexlight/contracts';
import type { ProviderAdapter, ProviderCompletionResult } from '../providerAdapter';
import { providerCost } from '../modelPricing';
import { chatMessages, credentialKey, parseArgs, postJson, sseData } from './http';

/**
 * Anthropic Messages API adapter (VA·E5 · TK-4494). Native tool use (tool_use /
 * tool_result blocks), streaming over SSE, and prompt caching: the system prompt and the
 * tool list carry an ephemeral cache breakpoint, so a voice agent's long, stable prefix is
 * billed at the cache-read rate after the first turn. Cache reads and writes count as input
 * tokens in the usage recorded on the completion.
 */

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 1024;

type Block =
  | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string };

interface AnthropicMessage { role: 'user' | 'assistant'; content: Block[] }
interface AnthropicUsage { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }

const FINISH: Record<string, CompletionResponse['finish_reason']> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_call',
  refusal: 'content_filter',
};

/** Splits system messages out and folds tool results into user turns, as the API requires. */
function toAnthropic(messages: ChatMessage[]): { system: string; messages: AnthropicMessage[] } {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const out: AnthropicMessage[] = [];
  const push = (role: 'user' | 'assistant', blocks: Block[]): void => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id ?? '', content: m.content }]);
    } else if (m.role === 'assistant') {
      const blocks: Block[] = m.content ? [{ type: 'text', text: m.content }] : [];
      for (const c of m.tool_calls ?? []) blocks.push({ type: 'tool_use', id: c.tool_call_id, name: c.tool_sku, input: parseArgs(c.args) });
      if (blocks.length) push('assistant', blocks);
    } else {
      push('user', [{ type: 'text', text: m.content }]);
    }
  }
  return { system, messages: out };
}

function requestBody(request: CompletionRequest, stream: boolean): Record<string, unknown> {
  const { system, messages } = toAnthropic(chatMessages(request));
  const body: Record<string, unknown> = { model: request.model, max_tokens: request.max_tokens ?? DEFAULT_MAX_TOKENS, messages };
  if (system) body.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.top_p !== undefined) body.top_p = request.top_p;
  if (request.stop_sequences?.length) body.stop_sequences = request.stop_sequences;
  if (request.tools?.length) {
    body.tools = request.tools.map((t, i, all) => ({
      name: t.tool_sku,
      description: t.description ?? t.display_name,
      input_schema: t.args_schema,
      // Breakpoint on the last tool caches the whole tool list.
      ...(i === all.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
    }));
  }
  if (stream) body.stream = true;
  return body;
}

const inputTokens = (u: AnthropicUsage | undefined): number =>
  (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0);

export interface AnthropicOptions {
  /** API root, default https://api.anthropic.com/v1. */
  base_url: string;
}

export function makeAnthropicAdapter(opts: AnthropicOptions): ProviderAdapter {
  const root = opts.base_url.replace(/\/+$/, '');
  const headers = (key: string): Record<string, string> => ({ 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION });

  return {
    provider_id: 'anthropic',

    async complete(request, credential): Promise<ProviderCompletionResult> {
      const res = await postJson('anthropic', `${root}/messages`, headers(credentialKey(credential)), requestBody(request, false));
      const json = (await res.json()) as { content?: Block[]; stop_reason?: string; usage?: AnthropicUsage };
      const content = json.content ?? [];
      const output = content.filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('');
      const tool_calls: ToolCallRecord[] = content
        .filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use')
        .map((b) => ({ tool_call_id: b.id, tool_sku: b.name, args: b.input ?? {} }));
      const tokens_in = inputTokens(json.usage);
      const tokens_out = json.usage?.output_tokens ?? 0;
      return {
        output,
        tool_calls,
        tokens_in,
        tokens_out,
        provider_cost: await providerCost('anthropic', request.model, tokens_in, tokens_out),
        finish_reason: FINISH[json.stop_reason ?? ''] ?? (tool_calls.length ? 'tool_call' : 'stop'),
      };
    },

    async *stream(request, credential): AsyncIterable<StreamChunk> {
      const res = await postJson('anthropic', `${root}/messages`, headers(credentialKey(credential)), requestBody(request, true));
      let index = 0;
      let usage: AnthropicUsage = {};
      let stop: string | undefined;
      const tools = new Map<number, { id: string; name: string; json: string }>();

      for await (const { data } of sseData(res)) {
        let evt: {
          type?: string;
          index?: number;
          message?: { usage?: AnthropicUsage };
          content_block?: { type?: string; id?: string; name?: string };
          delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
          usage?: AnthropicUsage;
          error?: { message?: string };
        };
        try { evt = JSON.parse(data); } catch { continue; }
        switch (evt.type) {
          case 'message_start':
            usage = { ...usage, ...(evt.message?.usage ?? {}) };
            break;
          case 'content_block_start':
            if (evt.content_block?.type === 'tool_use') {
              tools.set(evt.index ?? 0, { id: evt.content_block.id ?? `toolu_${evt.index}`, name: evt.content_block.name ?? '', json: '' });
            }
            break;
          case 'content_block_delta':
            if (evt.delta?.type === 'text_delta' && evt.delta.text) {
              yield { completion_id: '', index: index++, delta: evt.delta.text };
            } else if (evt.delta?.type === 'input_json_delta') {
              const t = tools.get(evt.index ?? 0);
              if (t) t.json += evt.delta.partial_json ?? '';
            }
            break;
          case 'message_delta':
            if (evt.delta?.stop_reason) stop = evt.delta.stop_reason;
            if (evt.usage) usage = { ...usage, ...evt.usage };
            break;
          case 'error':
            throw new Error(`anthropic stream error: ${evt.error?.message ?? 'unknown'}`);
          default:
            break;
        }
      }

      const tool_calls = [...tools.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, t]) => ({ tool_call_id: t.id, tool_sku: t.name, args: parseArgs(t.json) }));
      const tokens_in = inputTokens(usage);
      const tokens_out = usage.output_tokens ?? 0;
      yield {
        completion_id: '',
        index,
        delta: '',
        finish_reason: FINISH[stop ?? ''] ?? (tool_calls.length ? 'tool_call' : 'stop'),
        tokens_so_far: tokens_out,
        tool_calls,
        usage: { tokens_in, tokens_out, provider_cost: await providerCost('anthropic', request.model, tokens_in, tokens_out) },
      };
    },
  };
}
