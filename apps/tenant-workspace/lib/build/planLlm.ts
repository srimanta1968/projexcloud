import type { CatalogSdk } from './sdkCatalog';
import { renderCatalogForPrompt } from './sdkCatalog';

/**
 * Calls Anthropic Claude directly with a structured-output prompt that asks
 * the model to compose an SDK recommendation plan from the tenant's intent
 * and the full SDK catalog.
 *
 * v1 design choice: bypass sdk-ai-gateway. The gateway adds metering, audit,
 * and PII redaction — all valuable, but it requires the api-gateway to be
 * running and a full AgentContext (agent_id, run_id, trace_id). For a
 * tenant-side helper that should work even when the platform half is down,
 * a direct call is the right shape. Migration to sdk-ai-gateway is a one-
 * function swap when we add the gateway-side AgentContext minting.
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

Respond with STRICT JSON only. No prose, no markdown fences, no preamble. Schema:
{
  "summary": "string",
  "recommended_sdks": [{"name": "@projexlight/sdk-x", "why": "string"}],
  "custom_work": ["string", ...],
  "clarifying_questions": ["string", ...],
  "vertical_pack": "general" | "healthcare" | "finserv" | "publicSector" | "fieldService" | "revops",
  "complexity": "small" | "medium" | "large"
}`;

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = process.env.BUILD_PLAN_MODEL ?? 'claude-sonnet-4-6';

interface AnthropicMessageResponse {
  content?: Array<{ type: string; text?: string }>;
  stop_reason?: string;
}

function buildUserPrompt(intent: string, catalog: CatalogSdk[]): string {
  return `The tenant wants to build:\n\n"${intent}"\n\nAvailable SDKs (${catalog.length} total):\n\n${renderCatalogForPrompt(catalog)}\n\nReturn the JSON plan now. No prose.`;
}

function tryParseJson(raw: string): BuildPlan | null {
  // Anthropic sometimes wraps in ```json fences despite the strict instruction.
  const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
  try {
    return JSON.parse(cleaned) as BuildPlan;
  } catch {
    // Last-chance: extract first { ... } block.
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]) as BuildPlan;
    } catch {
      return null;
    }
  }
}

export async function generateBuildPlan(input: {
  intent: string;
  catalog: CatalogSdk[];
}): Promise<BuildPlan> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set; cannot generate build plan');
  }

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: buildUserPrompt(input.intent, input.catalog) },
      ],
    }),
    signal: AbortSignal.timeout(45_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`anthropic call failed: ${res.status} ${errText.slice(0, 200)}`);
  }

  const body = (await res.json()) as AnthropicMessageResponse;
  const text = body.content?.find((c) => c.type === 'text')?.text;
  if (!text) {
    throw new Error('anthropic returned no text content');
  }

  const plan = tryParseJson(text);
  if (!plan) {
    throw new Error('anthropic response was not valid JSON: ' + text.slice(0, 200));
  }
  return plan;
}
