import type { ChatMessage, CompletionRequest } from '@projexlight/contracts';

/**
 * Shared plumbing for the real provider adapters (VA·E5 · TK-4493/4494): credential
 * decoding, a typed HTTP error, prompt normalisation and a Server-Sent-Events reader.
 */

/**
 * An upstream provider failure. `retryable` tells withRetry whether another attempt can
 * help: 429 and 5xx can, other 4xx (bad key, bad request) cannot. The message carries the
 * HTTP status and the provider's error text — never the credential.
 */
export class ProviderHttpError extends Error {
  constructor(
    public readonly provider_id: string,
    public readonly status: number,
    message: string,
    public readonly retryable: boolean = status === 429 || status >= 500,
  ) {
    super(message);
    this.name = 'ProviderHttpError';
  }
}

/** The raw API key from an unwrapped credential buffer. */
export function credentialKey(credential: Buffer): string {
  const text = credential.toString('utf8').trim();
  if (!text) throw new ProviderHttpError('unknown', 401, 'no credential available for this provider', false);
  return text;
}

/** A request's prompt as chat messages (a plain string is one user message). */
export function chatMessages(request: CompletionRequest): ChatMessage[] {
  return typeof request.prompt === 'string' ? [{ role: 'user', content: request.prompt }] : request.prompt;
}

/** Parses a tool call's JSON arguments; malformed JSON is kept as the raw string. */
export function parseArgs(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? {};
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

const timeoutMs = (): number => Number(process.env.AI_GATEWAY_PROVIDER_TIMEOUT_MS ?? 60000);

/** POSTs JSON to a provider; throws ProviderHttpError on a non-2xx or a network failure. */
export async function postJson(provider: string, url: string, headers: Record<string, string>, body: unknown): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs()),
    });
  } catch (err) {
    const timedOut = (err as Error)?.name === 'TimeoutError';
    throw new ProviderHttpError(provider, 504, timedOut ? `${provider} did not answer in time` : `could not reach ${provider}`, true);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
      detail = (typeof j.error === 'string' ? j.error : j.error?.message) ?? j.message ?? detail;
    } catch { /* not JSON */ }
    throw new ProviderHttpError(provider, res.status, `${provider} answered HTTP ${res.status}: ${detail}`);
  }
  return res;
}

/** Yields each SSE event's data payload (without the `data: ` prefix) until the stream ends. */
export async function* sseData(res: Response): AsyncIterable<{ event: string | null; data: string }> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event: string | null = null;
  let data: string[] = [];
  const flush = function* (): Generator<{ event: string | null; data: string }> {
    if (data.length > 0) yield { event, data: data.join('\n') };
    event = null;
    data = [];
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (line === '') { yield* flush(); continue; }
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
  }
  if (buffer.trim().startsWith('data:')) data.push(buffer.trim().slice(5).replace(/^ /, ''));
  yield* flush();
}
