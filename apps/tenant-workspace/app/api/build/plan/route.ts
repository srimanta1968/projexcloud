/**
 * /api/build/plan — SDK composition planner.
 *
 * Replaces the brittle blueprint-matcher in /api/build/match. Reads every
 * sdk-capability.json from packages/*, sends the catalog + the tenant's
 * intent to Claude, and returns a structured plan:
 *   - recommended_sdks: which SDKs from the catalog to use, with reasons
 *   - custom_work: what the tenant must implement themselves
 *   - clarifying_questions: 0-3 follow-ups when the prompt is ambiguous
 *   - vertical_pack + complexity classification
 *
 * v1 calls Anthropic directly (using the ANTHROPIC_API_KEY in root .env).
 * That intentionally bypasses sdk-ai-gateway's metering / audit / redaction
 * — the right tradeoff for a tenant-side helper that must work even when
 * the platform half is down. Migration to sdk-ai-gateway is a one-function
 * swap inside planLlm.ts.
 */

import { NextRequest, NextResponse } from 'next/server';
import { loadCatalog } from '../../../../lib/build/sdkCatalog';
import { generateBuildPlan, type BuildPlan } from '../../../../lib/build/planLlm';

// Force node runtime — we read files from disk and need the ANTHROPIC_API_KEY env.
export const runtime = 'nodejs';

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
  if (intent.length > 2000) {
    return NextResponse.json({ error: 'intent exceeds 2000 characters' }, { status: 400 });
  }

  let catalog;
  try {
    catalog = loadCatalog();
  } catch (err) {
    return NextResponse.json(
      { error: 'failed to load SDK catalog: ' + (err as Error).message },
      { status: 500 },
    );
  }
  if (catalog.length === 0) {
    return NextResponse.json(
      { error: 'no SDK manifests found under packages/*; cannot plan' },
      { status: 500 },
    );
  }

  let plan: BuildPlan;
  try {
    plan = await generateBuildPlan({ intent, catalog });
  } catch (err) {
    const msg = (err as Error).message;
    const status = msg.includes('ANTHROPIC_API_KEY') ? 503 : 502;
    return NextResponse.json({ error: msg }, { status });
  }

  return NextResponse.json({
    plan,
    meta: {
      catalog_size: catalog.length,
      audit_status: 'deferred-v2',
    },
  });
}
