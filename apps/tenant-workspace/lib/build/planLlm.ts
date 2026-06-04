import type { Candidate } from './resolve';

/**
 * Compose stage of Planner v2.
 *
 * v1 pasted the entire ~90-SDK catalog into one prompt and let the model pick
 * (it returned ~3, dropped auth, and cost ~18k tokens). v2 receives only the
 * RESOLVED CANDIDATE SET (retrieval hits + injected foundation tier +
 * dependency closure) and asks the model to compose a plan that includes every
 * contributing candidate and splits SDK reuse from custom UI work.
 *
 * The generation provider is swappable behind selectProvider()/callOpenAi/
 * callAnthropic. Retrieval (which SDKs are candidates) is decided upstream by
 * the local retriever + resolvers, so swapping the generation provider never
 * changes which SDKs surface — only the prose.
 *
 * Provider selection (in order):
 *   1. BUILD_PLAN_PROVIDER env var (explicit 'openai' | 'anthropic')
 *   2. OPENAI_API_KEY if set (OpenAI JSON mode is the more reliable default)
 *   3. ANTHROPIC_API_KEY if set
 *   4. throws — caller surfaces the error to the user
 */

export type VerticalPack = 'general' | 'healthcare' | 'finserv' | 'publicSector' | 'fieldService' | 'revops';
export type Complexity = 'small' | 'medium' | 'large';

export interface RecommendedSdk {
  name: string;
  why: string;
}

export interface BuildPlan {
  summary: string;
  recommended_sdks: RecommendedSdk[];
  custom_work: string[];
  clarifying_questions: string[];
  vertical_pack: VerticalPack;
  complexity: Complexity;
}

const SYSTEM_PROMPT = `You are an SDK composition advisor for ProjexCloud, a multi-tenant SaaS platform with ~90 production SDKs covering identity, billing, audit, AI, dispatch, encryption, vertical packs, and more.

You are given a tenant's natural-language app description plus a PRE-SELECTED CANDIDATE SET of SDKs. The candidates were chosen by semantic retrieval, then augmented with the platform's foundation identity/AIM tier and with dependency prerequisites. Each candidate is labelled with WHY it is present (retrieval | foundation | dependency).

Return a structured plan that:
1. Recommends the candidate SDKs that genuinely contribute to this app, with a one-line rationale per SDK. INCLUDE EVERY foundation and dependency candidate that the app needs — a multi-user app must use the identity/AIM SDKs (login, personas, tenancy, permissions) rather than rebuilding auth. Only drop a candidate if it is clearly irrelevant, and do not invent SDKs outside the candidate set.
2. Lists the custom work the tenant must still implement themselves. IMPORTANT: ProjexCloud ships the auth SDKs but NOT prebuilt login/admin UI — so when the app needs sign-in or administration, list the "login page UI (wired to the identity SDK's login endpoint)" and "admin page UI (calling the persona/rebac permission endpoints)" here as custom work, distinct from the auth SDKs you recommend.
3. Offers 0-3 clarifying questions ONLY when the description is ambiguous; leave empty otherwise.
4. Classifies the vertical pack and overall complexity.
5. Provides a one-paragraph executive summary.

Use exact SDK names with the @projexlight/ prefix.

Respond with STRICT JSON matching this schema:
{
  "summary": "string",
  "recommended_sdks": [{"name": "@projexlight/sdk-x", "why": "string"}],
  "custom_work": ["string", ...],
  "clarifying_questions": ["string", ...],
  "vertical_pack": "general" | "healthcare" | "finserv" | "publicSector" | "fieldService" | "revops",
  "complexity": "small" | "medium" | "large"
}`;

/** Render one candidate (with provenance + endpoints) for the compose prompt. */
function renderCandidate(c: Candidate): string {
  const tier = c.sdk.tier === 'foundation' ? ' (FOUNDATION)' : '';
  const why = c.reason ? `\n    included_because: ${c.reason}` : '';
  const eps = c.sdk.endpoints.length
    ? `\n    endpoints: ${c.sdk.endpoints.slice(0, 6).map((e) => `${e.method} ${e.path}${e.kind !== 'query' ? ` [${e.kind}]` : ''}`).join(', ')}`
    : '';
  return `- name: ${c.sdk.name}${tier} [source=${c.source}]\n    summary: ${c.sdk.summary}${why}${eps}`;
}

function buildUserPrompt(intent: string, candidates: Candidate[]): string {
  return `The tenant wants to build:\n\n"${intent}"\n\nCandidate SDKs (${candidates.length}) — recommend from these:\n\n${candidates
    .map(renderCandidate)
    .join('\n')}\n\nReturn the JSON plan now.`;
}

function tryParseJson(raw: string): BuildPlan | null {
  // Some providers wrap in ```json fences despite the instruction.
  const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
  try {
    return JSON.parse(cleaned) as BuildPlan;
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]) as BuildPlan;
    } catch {
      return null;
    }
  }
}

type Provider = 'openai' | 'anthropic';

/**
 * Generation adapter (TK-3474). The compose-step LLM is hidden behind this
 * interface so the provider is swappable (config / new vendor / local model)
 * without touching the planner. Retrieval stays on the local bge-small model,
 * so swapping the generation provider never changes which SDKs are discovered —
 * only the prose. `complete()` returns raw text; the planner parses it.
 */
export interface GenerationProvider {
  readonly name: Provider;
  complete(system: string, user: string): Promise<string>;
}

class OpenAiProvider implements GenerationProvider {
  readonly name = 'openai' as const;
  private url = 'https://api.openai.com/v1/chat/completions';
  private model = process.env.BUILD_PLAN_OPENAI_MODEL ?? 'gpt-4o-mini';

  async complete(system: string, user: string): Promise<string> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: this.model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.4,
        max_tokens: 2048,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`openai call failed: ${res.status} ${errText.slice(0, 400)}`);
    }
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = body.choices?.[0]?.message?.content;
    if (!text) throw new Error('openai returned no message content');
    return text;
  }
}

class AnthropicProvider implements GenerationProvider {
  readonly name = 'anthropic' as const;
  private url = 'https://api.anthropic.com/v1/messages';
  private model = process.env.BUILD_PLAN_ANTHROPIC_MODEL ?? 'claude-sonnet-4-6';

  async complete(system: string, user: string): Promise<string> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 2048,
        system,
        messages: [{ role: 'user', content: user }],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`anthropic call failed: ${res.status} ${errText.slice(0, 400)}`);
    }
    const body = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = body.content?.find((c) => c.type === 'text')?.text;
    if (!text) throw new Error('anthropic returned no text content');
    return text;
  }
}

/**
 * Provider selection (in order):
 *   1. BUILD_PLAN_PROVIDER (explicit 'openai' | 'anthropic')
 *   2. OPENAI_API_KEY if set (OpenAI JSON mode is the more reliable default)
 *   3. ANTHROPIC_API_KEY if set
 *   4. throws
 */
export function selectGenerationProvider(): GenerationProvider {
  const explicit = (process.env.BUILD_PLAN_PROVIDER ?? '').toLowerCase();
  if (explicit === 'openai') return new OpenAiProvider();
  if (explicit === 'anthropic') return new AnthropicProvider();
  if (process.env.OPENAI_API_KEY) return new OpenAiProvider();
  if (process.env.ANTHROPIC_API_KEY) return new AnthropicProvider();
  throw new Error('No LLM provider configured: set OPENAI_API_KEY or ANTHROPIC_API_KEY');
}

// ─── Public entrypoint ─────────────────────────────────────────────────
export async function generateBuildPlan(input: {
  intent: string;
  candidates: Candidate[];
  provider?: GenerationProvider;
}): Promise<{ plan: BuildPlan; provider: Provider }> {
  const provider = input.provider ?? selectGenerationProvider();
  const text = await provider.complete(SYSTEM_PROMPT, buildUserPrompt(input.intent, input.candidates));
  const plan = tryParseJson(text);
  if (!plan) throw new Error(`${provider.name} response was not valid JSON: ` + text.slice(0, 200));
  return { plan, provider: provider.name };
}
