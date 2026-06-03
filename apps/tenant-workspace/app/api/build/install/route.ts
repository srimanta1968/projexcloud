/**
 * /api/build/install — cloud-builder deploy (FR-CB-2/3/4/5/6, AC-5, AC-8).
 *
 * Calls hosted MCP projex_registry_deploy with the chosen blueprint's
 * SDKs. Pack guardrails enforced server-side: a PACK_GATED error is
 * surfaced back to the UI as a 403 with the offending SDK + required pack.
 * Audit chain (FR-CB-3) is the hosted MCP's registry.tool.invoked.v1 stream.
 */

import { NextRequest, NextResponse } from 'next/server';

const HOSTED_MCP = process.env.NEXT_PUBLIC_HOSTED_MCP ?? process.env.HOSTED_MCP_URL ?? 'http://localhost:3600';

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = req.headers.get('authorization');
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = (await req.json()) as { blueprint_id?: string; answers?: Record<string, string> };
  if (!body.blueprint_id) return NextResponse.json({ error: 'blueprint_id is required' }, { status: 400 });

  try {
    // Fetch blueprint to derive SDK list. We don't pass answers to deploy
    // directly in v1 (the blueprint installer in P9.1 will consume them);
    // for v1 the chosen blueprint composes a fixed SDK set.
    const detailRes = await fetch(`${HOSTED_MCP}/mcp/v1/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: auth },
      body: JSON.stringify({ name: 'projex_registry_get_blueprint', arguments: { blueprint_id: body.blueprint_id } }),
      signal: AbortSignal.timeout(8000),
    });
    if (!detailRes.ok) {
      return NextResponse.json({ error: `blueprint fetch failed: ${detailRes.status}` }, { status: 502 });
    }
    const detailResult = (await detailRes.json()) as { content: Array<{ text: string }>; isError?: boolean };
    if (detailResult.isError) {
      return NextResponse.json({ error: 'blueprint not found' }, { status: 404 });
    }
    const blueprint = JSON.parse(detailResult.content[0].text) as {
      id: string;
      sdks: Array<{ name: string; version?: string }>;
    };

    const sdkNames = blueprint.sdks.map((s) => s.name);
    const appName = `${blueprint.id}-${Date.now().toString(36)}`;

    const deployRes = await fetch(`${HOSTED_MCP}/mcp/v1/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: auth },
      body: JSON.stringify({
        name: 'projex_registry_deploy',
        arguments: {
          app_name: appName,
          sdk_names: sdkNames,
          env: 'trial',
          // v1 doesn't thread answers into the deploy; recorded in audit only.
          answers: body.answers ?? {},
        },
      }),
      signal: AbortSignal.timeout(30000),
    });
    const deployResult = (await deployRes.json()) as { content: Array<{ text: string }>; isError?: boolean };
    const parsed = JSON.parse(deployResult.content[0].text) as {
      deploy_id?: string;
      status?: string;
      url?: string;
      error?: string;
      code?: string;
    };

    if (deployResult.isError) {
      // Pack-gated → 403 with policy citation
      if (parsed.code === 'PACK_GATED') {
        return NextResponse.json({ status: 'failed', error: parsed.error }, { status: 403 });
      }
      return NextResponse.json({ status: 'failed', error: parsed.error ?? 'deploy failed' }, { status: 502 });
    }

    return NextResponse.json({
      status: (parsed.status as 'queued' | 'started' | 'success') ?? 'queued',
      url: parsed.url,
      deploy_id: parsed.deploy_id,
    });
  } catch (e) {
    return NextResponse.json({ status: 'failed', error: (e as Error).message }, { status: 502 });
  }
}
