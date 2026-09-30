import type {
  CallDetail,
  CallingWindowCheck,
  CallingWindowInput,
  CallPage,
  CapacitySnapshot,
  ListCallsFilter,
  LiveTicket,
  PlaceCallInput,
  PlaceCallOptions,
  PlaceCallResult,
  StartTestSessionInput,
  TestSession,
} from './types';

export interface VoiceClientOptions {
  /** Gateway origin, e.g. https://cloud.projexlight.com (no trailing path). */
  baseUrl: string;
  /** Bearer credential: a tenant JWT or a tenant app API key (pk_live_…). */
  token?: string;
  /** Called before every request instead of `token` — for credentials that rotate. */
  getToken?: () => string | Promise<string>;
  /** Per-request timeout in ms (default 15 000). */
  timeoutMs?: number;
  /** Alternative fetch implementation (tests, proxies). Defaults to the global fetch. */
  fetch?: typeof fetch;
}

/** A non-2xx response from the gateway, with its status and the server's error body. */
export class VoiceClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly details: string[],
    public readonly body: unknown,
  ) {
    super(`${status} ${code}${details.length ? `: ${details.join('; ')}` : ''}`);
    this.name = 'VoiceClientError';
  }
}

type Query = Record<string, string | number | boolean | undefined>;

/**
 * Typed wrapper over the ProjexCloud voice APIs. The tenant is always the one the bearer
 * credential belongs to — the gateway pins it — so no method takes a tenant id.
 *
 *   const voice = new VoiceClient({ baseUrl, token });
 *   const { call } = await voice.placeCall({ agent_id, to: '+14155550100', person_id }, { idempotencyKey: leadId });
 *   const record = await voice.getCall(call.call_id);
 */
export class VoiceClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: VoiceClientOptions) {
    if (!opts.baseUrl) throw new Error('VoiceClient: baseUrl is required');
    if (!opts.token && !opts.getToken) throw new Error('VoiceClient: token or getToken is required');
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    const f = opts.fetch ?? (globalThis as { fetch?: typeof fetch }).fetch;
    if (!f) throw new Error('VoiceClient: no fetch available (Node >= 18, or pass options.fetch)');
    this.fetchImpl = f;
  }

  // ---- calls -------------------------------------------------------------------------------

  /** Places an outbound AI call. 201 = placed now; a retried idempotency key replays it. */
  async placeCall(input: PlaceCallInput, options: PlaceCallOptions = {}): Promise<PlaceCallResult> {
    const headers: Record<string, string> = options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {};
    const res = await this.request<{ data: PlaceCallResult }>('POST', '/api/voice-agent/calls', { body: input, headers });
    return res.data;
  }

  /** A call's record with its transcript; null when it does not exist (or is not this tenant's). */
  async getCall(callId: string): Promise<CallDetail | null> {
    try {
      const res = await this.request<{ data: { call: CallDetail } }>('GET', `/api/voice-agent/calls/${encodeURIComponent(callId)}`);
      return res.data.call;
    } catch (err) {
      if (err instanceof VoiceClientError && err.status === 404) return null;
      throw err;
    }
  }

  /** The tenant's calls, newest first. */
  async listCalls(filter: ListCallsFilter = {}): Promise<CallPage> {
    const res = await this.request<{ data: CallPage }>('GET', '/api/voice-agent/calls', { query: filter as Query });
    return res.data;
  }

  /** A browser test session with a draft or published agent (LiveKit room + token). */
  async startTestSession(input: StartTestSessionInput): Promise<TestSession> {
    const res = await this.request<{ data: { session: TestSession } }>('POST', '/api/voice-agent/test-sessions', { body: input });
    return res.data.session;
  }

  /** A single-use ticket for the call's live-transcript WebSocket (/api/voice-agent/calls/:id/live). */
  async issueLiveTicket(callId: string): Promise<LiveTicket> {
    const res = await this.request<{ data: { ticket: LiveTicket } }>('POST', `/api/voice-agent/calls/${encodeURIComponent(callId)}/live-ticket`, { body: {} });
    return res.data.ticket;
  }

  // ---- dialer ------------------------------------------------------------------------------

  /** Whether a recipient may be called now, in their local time zone(s), and when they next may. */
  async checkCallingWindow(input: CallingWindowInput): Promise<CallingWindowCheck> {
    const body = { ...input, at: input.at instanceof Date ? input.at.toISOString() : input.at };
    const res = await this.request<{ data: { check: CallingWindowCheck } }>('POST', '/api/dialer/calling-window/check', { body });
    return res.data.check;
  }

  /** Concurrent calls in use against the plan cap (and its 80 % alert point). */
  async getCapacity(): Promise<CapacitySnapshot> {
    const res = await this.request<{ data: { capacity: CapacitySnapshot } }>('GET', '/api/dialer/capacity');
    return res.data.capacity;
  }

  // ---- transport ---------------------------------------------------------------------------

  private async request<T>(method: 'GET' | 'POST', path: string, init: { body?: unknown; query?: Query; headers?: Record<string, string> } = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(init.query ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const token = this.opts.getToken ? await this.opts.getToken() : this.opts.token;
    const headers: Record<string, string> = { Accept: 'application/json', Authorization: `Bearer ${token}`, ...(init.headers ?? {}) };
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    if (!res.ok) {
      const b = (parsed ?? {}) as { error?: unknown; code?: unknown; details?: unknown };
      const code = typeof b.code === 'string' ? b.code : typeof b.error === 'string' ? b.error : 'HttpError';
      const details = Array.isArray(b.details) ? b.details.map(String) : [];
      throw new VoiceClientError(res.status, code, details, parsed);
    }
    return parsed as T;
  }
}
