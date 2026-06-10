/**
 * /api/build/plan — SDK composition planner (Planner v2, P9.2).
 *
 * Pipeline (replaces the v1 "paste all ~90 SDKs into one prompt" call):
 *   1. load catalog   — every sdk-capability.json from packages/* (tier,
 *                       endpoints, event graph captured).
 *   2. retrieve       — top-K candidates by relevance (pluggable Retriever;
 *                       lexical today, pgvector/bge-small in Epic A).
 *   3. inject         — always add the foundation identity/AIM tier for
 *                       multi-user apps (so login/personas/tenancy/permissions
 *                       never silently drop).
 *   4. expand         — pull dependency prerequisites via the consumes→provides
 *                       event graph.
 *   5. compose        — the generation LLM writes the plan from candidates
 *                       ONLY, splitting recommended SDKs from custom UI work.
 *
 * The generation LLM (planLlm.ts) is swappable and bypasses sdk-ai-gateway by
 * design — a tenant-side helper must work even when the platform half is down.
 */

import { NextRequest, NextResponse } from 'next/server';
import { loadCatalogWithMeta } from '../../../../lib/build/sdkCatalog';
import { getRetriever, getLastRetrievalMode } from '../../../../lib/build/retriever';
import { resolveCandidates } from '../../../../lib/build/resolve';
import { generateBuildPlan, type BuildPlan } from '../../../../lib/build/planLlm';

// Force node runtime — we read files from disk and need the LLM API key env.
export const runtime = 'nodejs';

// How many semantic hits to seed the candidate set with before foundation +
// dependency augmentation. Kept small so the compose prompt stays cheap.
const RETRIEVE_TOP_K = 20;

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

  // 2-4: retrieve → inject foundation → expand dependencies.
  const retrieved = await getRetriever().retrieve(intent, catalog, RETRIEVE_TOP_K);
  const candidates = resolveCandidates(intent, retrieved, catalog);

  if (candidates.length === 0) {
    return NextResponse.json(
      { error: 'no candidate SDKs matched the intent; try describing the app differently' },
      { status: 422 },
    );
  }

  // 5: compose the plan from candidates only.
  let plan: BuildPlan;
  let provider: string;
  try {
    const result = await generateBuildPlan({ intent, candidates });
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
      retrieval: {
        // The backend that ACTUALLY produced these hits — not the configured
        // BUILD_RETRIEVER, which would mislabel the result whenever a backend
        // failed init and the chain fell back (e.g. embedding → lexical).
        retriever: getLastRetrievalMode(),
        configured: (process.env.BUILD_RETRIEVER ?? 'embedding').toLowerCase(),
        retrieved: retrieved.length,
        candidates: candidates.length,
        foundation_injected: candidates.filter((c) => c.source === 'foundation').map((c) => c.sdk.name),
        dependency_added: candidates.filter((c) => c.source === 'dependency').map((c) => c.sdk.name),
      },
    },
  });
}
