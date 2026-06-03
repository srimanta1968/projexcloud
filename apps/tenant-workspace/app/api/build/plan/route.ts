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
import { loadCatalogWithMeta } from '../../../../lib/build/sdkCatalog';
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
  let packagesDir = '';
  try {
    const res = loadCatalogWithMeta();
    catalog = res.catalog;
    packagesDir = res.packagesDir;
  } catch (err) {
    return NextResponse.json(
      { error: 'failed to load SDK catalog: ' + (err as Error).message },
      { status: 500 },
    );
  }
  if (catalog.length === 0) {
    return NextResponse.json(
      {
        error: `no SDK manifests found at ${packagesDir} (tried PROJEXCLOUD_PACKAGES_DIR env, cwd/packages, cwd/../../packages). cwd=${process.cwd()}`,
      },
      { status: 500 },
    );
  }

  let plan: BuildPlan;
  let provider: string;
  try {
    const result = await generateBuildPlan({ intent, catalog });
    plan = result.plan;
    provider = result.provider;
  } catch (err) {
    const msg = (err as Error).message;
    const status = msg.includes('No LLM provider') || msg.includes('API_KEY is not set') ? 503 : 502;
    return NextResponse.json({ error: msg }, { status });
  }

  return NextResponse.json({
    plan,
    meta: {
      catalog_size: catalog.length,
      provider,
      audit_status: 'deferred-v2',
    },
  });
}
