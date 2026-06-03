/**
 * /api/build/match — cloud-builder intent matcher (FR-CB-1, FR-CB-2).
 *
 * Reads the user's intent → calls the hosted MCP's projex_registry_search_sdks
 * (or the blueprint endpoint) → returns the top-1 blueprint with its
 * clarifying_questions extracted from blueprint.yaml. v1 keeps the LLM
 * orchestration server-side (no streaming) for simplicity; richer agent
 * loops land in P9.1.
 *
 * Auth: requires a tenant-scoped JWT in the Authorization header. The
 * server forwards it to the hosted MCP as x-projex-api-key (gateway-side
 * adapter) OR as Bearer when the gateway mints a service JWT for the agent.
 */

import { NextRequest, NextResponse } from 'next/server';

interface MatchedQuestion {
  id: string;
  prompt: string;
  type: 'enum' | 'string' | 'boolean';
  options?: string[];
}

interface MatchedBlueprint {
  id: string;
  title: string;
  summary: string;
  pack: string;
  sdk_count: number;
  estimated_minutes: number;
  questions: MatchedQuestion[];
}

const HOSTED_MCP = process.env.NEXT_PUBLIC_HOSTED_MCP ?? process.env.HOSTED_MCP_URL ?? 'http://localhost:3600';

/**
 * Naive keyword match over blueprint titles + summaries. v1 fallback when
 * the hosted MCP is not reachable. Acceptable for the GA-gate AC-5 demo
 * (3 blueprints to disambiguate); P9.1 replaces with a real LLM intent
 * matcher backed by sdk-ai-gateway.
 */
function pickBlueprint(intent: string, blueprints: Array<{ id: string; title: string; summary: string; pack: string; sdk_count: number; estimated_minutes: number }>): typeof blueprints[number] | null {
  const intentLower = intent.toLowerCase();
  let best: { score: number; bp: typeof blueprints[number] } | null = null;
  for (const bp of blueprints) {
    const hay = (bp.id + ' ' + bp.title + ' ' + bp.summary).toLowerCase();
    let score = 0;
    for (const word of intentLower.split(/\s+/).filter((w) => w.length >= 3)) {
      if (hay.includes(word)) score++;
    }
    if (!best || score > best.score) best = { score, bp };
  }
  return best && best.score > 0 ? best.bp : null;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = req.headers.get('authorization');
  if (!auth) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const body = (await req.json()) as { intent?: string };
  const intent = body.intent?.trim() ?? '';
  if (!intent) {
    return NextResponse.json({ error: 'intent is required' }, { status: 400 });
  }

  try {
    // Hit hosted MCP read-tool list (no auth required for read; uses tenant
    // JWT when present for pack filtering).
    const res = await fetch(`${HOSTED_MCP}/mcp/v1/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: auth },
      body: JSON.stringify({ name: 'projex_registry_list_blueprints', arguments: {} }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      return NextResponse.json({ error: `hosted MCP returned ${res.status}` }, { status: 502 });
    }
    const toolResult = (await res.json()) as { content: Array<{ text: string }>; isError?: boolean };
    if (toolResult.isError) {
      return NextResponse.json({ error: 'blueprint listing failed' }, { status: 502 });
    }
    const parsed = JSON.parse(toolResult.content[0].text) as {
      blueprints: Array<{ id: string; title: string; summary: string; pack: string; sdk_count: number; estimated_minutes: number }>;
    };

    const picked = pickBlueprint(intent, parsed.blueprints);
    if (!picked) {
      return NextResponse.json({ matched: null });
    }

    // Fetch the full blueprint so we can extract clarifying_questions.
    const detailRes = await fetch(`${HOSTED_MCP}/mcp/v1/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: auth },
      body: JSON.stringify({ name: 'projex_registry_get_blueprint', arguments: { blueprint_id: picked.id } }),
      signal: AbortSignal.timeout(8000),
    });
    const detailResult = (await detailRes.json()) as { content: Array<{ text: string }>; isError?: boolean };
    const detail = detailResult.isError ? null : (JSON.parse(detailResult.content[0].text) as { clarifying_questions?: MatchedQuestion[] });

    const matched: MatchedBlueprint = {
      id: picked.id,
      title: picked.title,
      summary: picked.summary,
      pack: picked.pack,
      sdk_count: picked.sdk_count,
      estimated_minutes: picked.estimated_minutes,
      questions: detail?.clarifying_questions ?? [],
    };

    return NextResponse.json({ matched });
  } catch (e) {
    return NextResponse.json({ error: `match failed: ${(e as Error).message}` }, { status: 502 });
  }
}
