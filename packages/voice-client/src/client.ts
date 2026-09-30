import type {
  Agent,
  AgentVersion,
  AppTool,
  Campaign,
  CampaignAction,
  CatalogEntry,
  RegisterToolInput,
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
  EvalRun,
  StartEvalRunInput,
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

  // ---- agents & tools ----------------------------------------------------------------------

  async createAgent(input: Record<string, unknown>): Promise<Agent> {
    return (await this.request<{ data: { agent: Agent } }>('POST', '/api/voice-agent/agents', { body: input })).data.agent;
  }

  async listAgents(filter: { status?: string; direction?: string; limit?: number; offset?: number } = {}): Promise<{ agents: Agent[]; limit: number; offset: number }> {
    return (await this.request<{ data: { agents: Agent[]; limit: number; offset: number } }>('GET', '/api/voice-agent/agents', { query: filter })).data;
  }

  async getAgent(agentId: string): Promise<Agent | null> {
    return this.orNull(async () => (await this.request<{ data: { agent: Agent } }>('GET', `/api/voice-agent/agents/${encodeURIComponent(agentId)}`)).data.agent);
  }

  /** A new draft version (prompt, stack profile, tools); publishing goes through approval. */
  async createAgentVersion(agentId: string, input: Record<string, unknown>): Promise<AgentVersion> {
    return (await this.request<{ data: { version: AgentVersion } }>('POST', `/api/voice-agent/agents/${encodeURIComponent(agentId)}/versions`, { body: input })).data.version;
  }

  async listAgentVersions(agentId: string, page: { limit?: number; offset?: number } = {}): Promise<{ versions: AgentVersion[]; limit: number; offset: number }> {
    return (await this.request<{ data: { versions: AgentVersion[]; limit: number; offset: number } }>('GET', `/api/voice-agent/agents/${encodeURIComponent(agentId)}/versions`, { query: page })).data;
  }

  // ---- evaluation & publish (TK-4517/4518) --------------------------------------------------

  /**
   * Starts a simulated-caller run against a version. `mode: 'sandbox'` runs on fake providers
   * with a scripted agent — no provider keys, nothing billed — and exercises your app tools for
   * real (use it in CI). `mode: 'evaluation'` uses the tenant's real LLM and is what publish
   * requires. The run is queued; poll it with getEvalRun or waitForEvalRun.
   */
  async startEvalRun(agentId: string, versionId: string, input: StartEvalRunInput = {}): Promise<EvalRun> {
    return (await this.request<{ data: { eval_run: EvalRun } }>(
      'POST', `/api/voice-agent/agents/${encodeURIComponent(agentId)}/versions/${encodeURIComponent(versionId)}/eval-runs/start`, { body: input },
    )).data.eval_run;
  }

  async getEvalRun(evalRunId: string): Promise<EvalRun | null> {
    return this.orNull(async () => (await this.request<{ data: { eval_run: EvalRun } }>('GET', `/api/voice-agent/eval-runs/${encodeURIComponent(evalRunId)}`)).data.eval_run);
  }

  async listEvalRuns(agentId: string, versionId: string, page: { limit?: number; offset?: number } = {}): Promise<{ eval_runs: EvalRun[]; total: number; limit: number; offset: number }> {
    return (await this.request<{ data: { eval_runs: EvalRun[]; total: number; limit: number; offset: number } }>(
      'GET', `/api/voice-agent/agents/${encodeURIComponent(agentId)}/versions/${encodeURIComponent(versionId)}/eval-runs`, { query: page },
    )).data;
  }

  /** Polls until the run completes or errors (or `timeoutMs` passes, which throws). */
  async waitForEvalRun(evalRunId: string, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<EvalRun> {
    const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
    for (;;) {
      const run = await this.getEvalRun(evalRunId);
      if (!run) throw new VoiceClientError(404, 'NotFound', ['evaluation run not found'], null);
      if (run.status === 'completed' || run.status === 'error') return run;
      if (Date.now() > deadline) throw new VoiceClientError(408, 'Timeout', [`evaluation run still ${run.status}`], null);
      await new Promise((r) => setTimeout(r, opts.intervalMs ?? 3000));
    }
  }

  /** Opens (or returns the open) approval request for publishing a version. */
  async requestPublish(agentId: string, versionId: string, input: { route_id: string; initiator_persona_id?: string; reason?: string }): Promise<Record<string, unknown>> {
    return (await this.request<{ data: Record<string, unknown> }>(
      'POST', `/api/voice-agent/agents/${encodeURIComponent(agentId)}/versions/${encodeURIComponent(versionId)}/publish-request`, { body: input },
    )).data;
  }

  /** Puts a version live: needs a passing evaluation run (not sandbox) and an approved request. 409 PublishBlocked names the unmet gate. */
  async publishAgent(agentId: string, versionId: string): Promise<{ agent: Agent; version: AgentVersion }> {
    return (await this.request<{ data: { agent: Agent; version: AgentVersion } }>(
      'POST', `/api/voice-agent/agents/${encodeURIComponent(agentId)}/versions/${encodeURIComponent(versionId)}/publish`, { body: {} },
    )).data;
  }

  /** Registers an app tool: an https endpoint the agent may call mid-conversation. */
  async registerTool(input: RegisterToolInput): Promise<AppTool> {
    return (await this.request<{ data: { tool: AppTool } }>('POST', '/api/voice-agent/tools', { body: input })).data.tool;
  }

  async listTools(filter: { app_id?: string; enabled?: boolean; limit?: number; offset?: number } = {}): Promise<{ tools: AppTool[]; limit: number; offset: number }> {
    return (await this.request<{ data: { tools: AppTool[]; limit: number; offset: number } }>('GET', '/api/voice-agent/tools', { query: filter })).data;
  }

  async getTool(toolId: string): Promise<AppTool | null> {
    return this.orNull(async () => (await this.request<{ data: { tool: AppTool } }>('GET', `/api/voice-agent/tools/${encodeURIComponent(toolId)}`)).data.tool);
  }

  /** Updates a tool; enabled:false withdraws it from new calls without a new agent version. */
  async updateTool(toolId: string, patch: Partial<Omit<RegisterToolInput, 'name' | 'app_id'>> & { enabled?: boolean }): Promise<AppTool> {
    return (await this.request<{ data: { tool: AppTool } }>('PATCH', `/api/voice-agent/tools/${encodeURIComponent(toolId)}`, { body: patch })).data.tool;
  }

  // ---- campaigns ---------------------------------------------------------------------------

  async createCampaign(input: Record<string, unknown>): Promise<Campaign> {
    return (await this.request<{ data: { campaign: Campaign } }>('POST', '/api/dialer/campaigns', { body: input })).data.campaign;
  }

  async listCampaigns(filter: { status?: string; agent_id?: string; limit?: number; offset?: number } = {}): Promise<{ campaigns: Campaign[]; [key: string]: unknown }> {
    return (await this.request<{ data: { campaigns: Campaign[] } }>('GET', '/api/dialer/campaigns', { query: filter })).data;
  }

  async getCampaign(campaignId: string): Promise<Campaign | null> {
    return this.orNull(async () => (await this.request<{ data: { campaign: Campaign } }>('GET', `/api/dialer/campaigns/${encodeURIComponent(campaignId)}`)).data.campaign);
  }

  /** Adds or updates contacts on a campaign. */
  async addCampaignContacts(campaignId: string, body: { contacts: Record<string, unknown>[] }): Promise<Record<string, unknown>> {
    return (await this.request<{ data: Record<string, unknown> }>('POST', `/api/dialer/campaigns/${encodeURIComponent(campaignId)}/contacts`, { body })).data;
  }

  async listCampaignContacts(campaignId: string, filter: { status?: string; limit?: number; offset?: number } = {}): Promise<Record<string, unknown>> {
    return (await this.request<{ data: Record<string, unknown> }>('GET', `/api/dialer/campaigns/${encodeURIComponent(campaignId)}/contacts`, { query: filter })).data;
  }

  /** start | pause | resume | cancel. */
  async transitionCampaign(campaignId: string, action: CampaignAction): Promise<Campaign> {
    return (await this.request<{ data: { campaign: Campaign } }>('POST', `/api/dialer/campaigns/${encodeURIComponent(campaignId)}/${action}`, { body: {} })).data.campaign;
  }

  // ---- speech catalog ----------------------------------------------------------------------

  async listCatalog(filter: Record<string, string | boolean | undefined> = {}): Promise<CatalogEntry[]> {
    return (await this.request<{ data: { entries: CatalogEntry[] } }>('GET', '/api/speech/catalog', { query: filter })).data.entries;
  }

  async getCatalogEntry(entryId: string): Promise<CatalogEntry | null> {
    return this.orNull(async () => (await this.request<{ data: { entry: CatalogEntry } }>('GET', `/api/speech/catalog/${encodeURIComponent(entryId)}`)).data.entry);
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

  private async orNull<T>(fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof VoiceClientError && err.status === 404) return null;
      throw err;
    }
  }

  private async request<T>(method: 'GET' | 'POST' | 'PATCH', path: string, init: { body?: unknown; query?: Query; headers?: Record<string, string> } = {}): Promise<T> {
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
