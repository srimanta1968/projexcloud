import type { ChatMessage, CompletionRequest, CompletionResponse, StreamChunk, ToolCallRecord } from '@projexlight/contracts';
import type { ProviderAdapter, ProviderCompletionResult } from '../providerAdapter';
import { providerCost } from '../modelPricing';
import { chatMessages, credentialKey, parseArgs, postJson, ProviderHttpError } from './http';
import { signV4, type AwsCredentials } from './sigv4';
import { eventStreamMessages } from './eventStream';

/**
 * Amazon Bedrock adapter on the Converse / ConverseStream APIs (VA·E5 · TK-4494), which
 * give one tool-use shape across Bedrock's model families. Streams use AWS binary
 * event-stream framing. System prompt and tools carry a cachePoint for models with
 * Bedrock prompt caching.
 *
 * Credential formats (the tenant's stored key):
 *   <AccessKeyId>:<SecretAccessKey>[:<SessionToken>]   signed with SigV4
 *   <Bedrock API key>                                   sent as a bearer token
 * Region: AI_GATEWAY_BEDROCK_REGION (default us-east-1).
 */

type Block =
  | { text: string }
  | { toolUse: { toolUseId: string; name: string; input: unknown } }
  | { toolResult: { toolUseId: string; content: { text: string }[] } }
  | { cachePoint: { type: 'default' } };

interface BedrockMessage { role: 'user' | 'assistant'; content: Block[] }
interface BedrockUsage { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheWriteInputTokens?: number }

const FINISH: Record<string, CompletionResponse['finish_reason']> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_call',
  guardrail_intervened: 'content_filter',
  content_filtered: 'content_filter',
};

/** Parses the stored credential into SigV4 keys or a bearer API key. */
export function bedrockAuth(key: string): { sigv4: AwsCredentials } | { bearer: string } {
  const parts = key.split(':');
  if (parts.length >= 2 && /^(AKIA|ASIA)[A-Z0-9]{12,}$/.test(parts[0])) {
    return { sigv4: { access_key_id: parts[0], secret_access_key: parts[1], session_token: parts.slice(2).join(':') || undefined } };
  }
  return { bearer: key };
}

function toBedrock(messages: ChatMessage[]): { system: string; messages: BedrockMessage[] } {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const out: BedrockMessage[] = [];
  const push = (role: 'user' | 'assistant', blocks: Block[]): void => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      push('user', [{ toolResult: { toolUseId: m.tool_call_id ?? '', content: [{ text: m.content }] } }]);
    } else if (m.role === 'assistant') {
      const blocks: Block[] = m.content ? [{ text: m.content }] : [];
      for (const c of m.tool_calls ?? []) blocks.push({ toolUse: { toolUseId: c.tool_call_id, name: c.tool_sku, input: parseArgs(c.args) } });
      if (blocks.length) push('assistant', blocks);
    } else {
      push('user', [{ text: m.content }]);
    }
  }
  return { system, messages: out };
}

function requestBody(request: CompletionRequest): Record<string, unknown> {
  const { system, messages } = toBedrock(chatMessages(request));
  const body: Record<string, unknown> = { messages };
  if (system) body.system = [{ text: system }, { cachePoint: { type: 'default' } }];
  const inf: Record<string, unknown> = {};
  if (request.max_tokens !== undefined) inf.maxTokens = request.max_tokens;
  if (request.temperature !== undefined) inf.temperature = request.temperature;
  if (request.top_p !== undefined) inf.topP = request.top_p;
  if (request.stop_sequences?.length) inf.stopSequences = request.stop_sequences;
  if (Object.keys(inf).length) body.inferenceConfig = inf;
  if (request.tools?.length) {
    body.toolConfig = {
      tools: [
        ...request.tools.map((t) => ({ toolSpec: { name: t.tool_sku, description: t.description ?? t.display_name, inputSchema: { json: t.args_schema } } })),
        { cachePoint: { type: 'default' } },
      ],
    };
  }
  return body;
}

const inputTokens = (u: BedrockUsage | undefined): number =>
  (u?.inputTokens ?? 0) + (u?.cacheReadInputTokens ?? 0) + (u?.cacheWriteInputTokens ?? 0);

export interface BedrockOptions {
  region: string;
  /** Endpoint root; default https://bedrock-runtime.<region>.amazonaws.com. */
  base_url?: string;
}

export function makeBedrockAdapter(opts: BedrockOptions): ProviderAdapter {
  const root = (opts.base_url || `https://bedrock-runtime.${opts.region}.amazonaws.com`).replace(/\/+$/, '');

  async function send(request: CompletionRequest, credential: Buffer, action: 'converse' | 'converse-stream', signal?: AbortSignal): Promise<Response> {
    const url = new URL(`${root}/model/${encodeURIComponent(request.model)}/${action}`);
    const body = JSON.stringify(requestBody(request));
    const auth = bedrockAuth(credentialKey(credential));
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: action === 'converse' ? 'application/json' : 'application/vnd.amazon.eventstream' };
    const signed = 'sigv4' in auth
      ? signV4({ method: 'POST', url, headers, body, region: opts.region, service: 'bedrock', credentials: auth.sigv4 })
      : { ...headers, Authorization: `Bearer ${auth.bearer}` };
    // host is set by fetch itself; sending it explicitly is harmless but redundant.
    delete signed.host;
    return postJson('bedrock', url.toString(), signed, body, signal);
  }

  return {
    provider_id: 'bedrock',

    async complete(request, credential): Promise<ProviderCompletionResult> {
      const res = await send(request, credential, 'converse');
      const json = (await res.json()) as { output?: { message?: { content?: Block[] } }; stopReason?: string; usage?: BedrockUsage };
      const content = json.output?.message?.content ?? [];
      const output = content.filter((b): b is Extract<Block, { text: string }> => 'text' in b).map((b) => b.text).join('');
      const tool_calls: ToolCallRecord[] = content
        .filter((b): b is Extract<Block, { toolUse: unknown }> => 'toolUse' in b)
        .map((b) => ({ tool_call_id: b.toolUse.toolUseId, tool_sku: b.toolUse.name, args: b.toolUse.input ?? {} }));
      const tokens_in = inputTokens(json.usage);
      const tokens_out = json.usage?.outputTokens ?? 0;
      return {
        output,
        tool_calls,
        tokens_in,
        tokens_out,
        provider_cost: await providerCost('bedrock', request.model, tokens_in, tokens_out),
        finish_reason: FINISH[json.stopReason ?? ''] ?? (tool_calls.length ? 'tool_call' : 'stop'),
      };
    },

    async *stream(request, credential, opts): AsyncIterable<StreamChunk> {
      const res = await send(request, credential, 'converse-stream', opts?.signal);
      let index = 0;
      let usage: BedrockUsage | undefined;
      let stop: string | undefined;
      const tools = new Map<number, { id: string; name: string; json: string }>();

      for await (const msg of eventStreamMessages(res)) {
        const type = msg.headers[':event-type'];
        if (msg.headers[':message-type'] === 'exception') {
          throw new ProviderHttpError('bedrock', 502, `bedrock stream ${msg.headers[':exception-type'] ?? 'exception'}: ${msg.payload.toString('utf8').slice(0, 200)}`);
        }
        let evt: {
          contentBlockIndex?: number;
          start?: { toolUse?: { toolUseId?: string; name?: string } };
          delta?: { text?: string; toolUse?: { input?: string } };
          stopReason?: string;
          usage?: BedrockUsage;
        };
        try { evt = JSON.parse(msg.payload.toString('utf8')); } catch { continue; }
        if (type === 'contentBlockStart' && evt.start?.toolUse) {
          tools.set(evt.contentBlockIndex ?? 0, { id: evt.start.toolUse.toolUseId ?? `tooluse_${evt.contentBlockIndex}`, name: evt.start.toolUse.name ?? '', json: '' });
        } else if (type === 'contentBlockDelta') {
          if (evt.delta?.text) yield { completion_id: '', index: index++, delta: evt.delta.text };
          else if (evt.delta?.toolUse) {
            const t = tools.get(evt.contentBlockIndex ?? 0);
            if (t) t.json += evt.delta.toolUse.input ?? '';
          }
        } else if (type === 'messageStop') {
          stop = evt.stopReason;
        } else if (type === 'metadata') {
          usage = evt.usage;
        }
      }

      const tool_calls = [...tools.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, t]) => ({ tool_call_id: t.id, tool_sku: t.name, args: parseArgs(t.json) }));
      const tokens_in = inputTokens(usage);
      const tokens_out = usage?.outputTokens ?? 0;
      yield {
        completion_id: '',
        index,
        delta: '',
        finish_reason: FINISH[stop ?? ''] ?? (tool_calls.length ? 'tool_call' : 'stop'),
        tokens_so_far: tokens_out,
        tool_calls,
        usage: { tokens_in, tokens_out, provider_cost: await providerCost('bedrock', request.model, tokens_in, tokens_out) },
      };
    },
  };
}
