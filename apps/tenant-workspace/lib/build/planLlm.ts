import type { CatalogSdk } from './sdkCatalog';
import { renderCatalogForPrompt } from './sdkCatalog';

/**
 * Calls an LLM with a structured-output prompt that asks for an SDK
 * composition plan given the tenant's intent + the full SDK catalog.
 *
 * Provider selection (in order):
 *   1. BUILD_PLAN_PROVIDER env var (explicit override: 'openai' | 'anthropic')
 *   2. OPENAI_API_KEY if set (default — OpenAI's JSON mode is more reliable
 *      than asking Claude nicely to return JSON)
 *   3. ANTHROPIC_API_KEY if set
 *   4. throws — caller surfaces the error to the user
 *
 * v1 design choice: bypass sdk-ai-gateway. The gateway adds metering, audit,
 * and PII redaction — all valuable, but it requires the api-gateway to be
 * running and a full AgentContext. For a tenant-side helper that should
 * work even when the platform half is down, a direct call is the right
 * shape. Migration to sdk-ai-gateway is a one-function swap here.
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

const SYSTEM_PROMPT = `You are an SDK composition advisor for ProjexCloud, a multi-tenant SaaS platform with ~88 production SDKs covering identity, billing, audit, AI, dispatch, encryption, vertical packs, and more.

Given a tenant's natural-language app description plus the full SDK catalog, return a structured plan that:
1. Recommends specific SDKs from the catalog that solve part of the problem (with a one-line rationale per SDK).
2. Lists the custom work the tenant must still implement themselves (concise bullet points — what the SDKs DON'T cover).
3. Offers 0-3 clarifying questions ONLY when the description is ambiguous; leave empty otherwise.
4. Classifies the vertical pack and overall complexity.
5. Provides a one-paragraph executive summary.

CRITICAL: Only recommend SDKs that appear in the provided catalog. Use exact names with the @projexlight/ prefix. Do not invent SDKs.

Respond with STRICT JSON matching this schema:
{
  "summary": "string",
  "recommended_sdks": [{"name": "@projexlight/sdk-x", "why": "string"}],
  "custom_work": ["string", ...],
  "clarifying_questions": ["string", ...],
  "vertical_pack": "general" | "healthcare" | "finserv" | "publicSector" | "fieldService" | "revops",
  "complexity": "small" | "medium" | "large"
}`;

function buildUserPrompt(intent: string, catalog: CatalogSdk[]): string {
  return `The tenant wants to build:\n\n"${intent}"\n\nAvailable SDKs (${catalog.length} total):\n\n${renderCatalogForPrompt(catalog)}\n\nReturn the JSON plan now.`;
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

function selectProvider(): Provider {
  const explicit = (process.env.BUILD_PLAN_PROVIDER ?? '').toLowerCase();
  if (explicit === 'openai' || explicit === 'anthropic') return explicit;
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  throw new Error('No LLM provider configured: set OPENAI_API_KEY or ANTHROPIC_API_KEY');
}

// ─── OpenAI ────────────────────────────────────────────────────────────
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_DEFAULT_MODEL = process.env.BUILD_PLAN_OPENAI_MODEL ?? 'gpt-4o-mini';

interface OpenAiResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

async function callOpenAi(intent: string, catalog: CatalogSdk[]): Promise<BuildPlan> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');

  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_DEFAULT_MODEL,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: buildUserPrompt(intent, catalog) },
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

  const body = (await res.json()) as OpenAiResponse;
  const text = body.choices?.[0]?.message?.content;
  if (!text) throw new Error('openai returned no message content');
  const plan = tryParseJson(text);
  if (!plan) throw new Error('openai response was not valid JSON: ' + text.slice(0, 200));
  return plan;
}

// ─── Anthropic ─────────────────────────────────────────────────────────
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_DEFAULT_MODEL = process.env.BUILD_PLAN_ANTHROPIC_MODEL ?? 'claude-sonnet-4-6';

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>;
}

async function callAnthropic(intent: string, catalog: CatalogSdk[]): Promise<BuildPlan> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_DEFAULT_MODEL,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserPrompt(intent, catalog) }],
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`anthropic call failed: ${res.status} ${errText.slice(0, 400)}`);
  }

  const body = (await res.json()) as AnthropicResponse;
  const text = body.content?.find((c) => c.type === 'text')?.text;
  if (!text) throw new Error('anthropic returned no text content');
  const plan = tryParseJson(text);
  if (!plan) throw new Error('anthropic response was not valid JSON: ' + text.slice(0, 200));
  return plan;
}

// ─── Public entrypoint ─────────────────────────────────────────────────
export async function generateBuildPlan(input: {
  intent: string;
  catalog: CatalogSdk[];
}): Promise<{ plan: BuildPlan; provider: Provider }> {
  const provider = selectProvider();
  const plan = provider === 'openai'
    ? await callOpenAi(input.intent, input.catalog)
    : await callAnthropic(input.intent, input.catalog);
  return { plan, provider };
}
