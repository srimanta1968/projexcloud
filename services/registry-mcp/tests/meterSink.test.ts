import { describe, expect, it } from 'vitest';
import { buildMeterSink, composeAuditSinks, skuFor, TOOL_SKU_MAP } from '../src/meterSink';

describe('TOOL_SKU_MAP + skuFor', () => {
  it('every read tool has a registry.read.* SKU', () => {
    for (const tool of Object.keys(TOOL_SKU_MAP)) {
      expect(TOOL_SKU_MAP[tool]).toMatch(/^registry\.(read|write)\./);
    }
  });

  it('unknown tools fall back to registry.tool.other', () => {
    expect(skuFor('made_up_tool')).toBe('registry.tool.other');
  });

  it('known tools resolve via TOOL_SKU_MAP', () => {
    expect(skuFor('projex_registry_search_sdks')).toBe('registry.read.search');
    expect(skuFor('projex_registry_get_manifest')).toBe('registry.read.manifest');
    expect(skuFor('projex_registry_scaffold')).toBe('registry.read.scaffold');
  });
});

describe('buildMeterSink', () => {
  it('reports one unit per CallTool with the right dimensions', async () => {
    const calls: Array<{ sku: string; units: number; dimensions: Record<string, unknown> }> = [];
    const sink = buildMeterSink({
      report: async (input) => {
        calls.push({ sku: input.sku, units: input.units, dimensions: input.dimensions });
      },
      pool_index: 'global-catalog',
      region: 'us-east-1',
    });

    sink({
      tenant: { sub: 'user-1', tenant_id: 'tenant-acme', org_id: 'org-x', email: 'a@b.c' },
      tool: 'projex_registry_search_sdks',
      ok: true,
      duration_ms: 42,
    });

    // Sink is fire-and-forget; flush the microtask queue.
    await new Promise((resolve) => setImmediate(resolve));

    expect(calls.length).toBe(1);
    expect(calls[0].sku).toBe('registry.read.search');
    expect(calls[0].units).toBe(1);
    expect(calls[0].dimensions).toMatchObject({
      tenant_id: 'tenant-acme',
      org_id: 'org-x',
      pool_index: 'global-catalog',
      region: 'us-east-1',
      actor_kind: 'service',
      actor_id: 'user-1',
      latency_ms: 42,
    });
  });

  it('meter failure does NOT throw out of the audit sink', async () => {
    const sink = buildMeterSink({
      report: async () => { throw new Error('redis down'); },
      pool_index: 'p',
      region: 'r',
    });
    // If buildMeterSink let the promise reject up, this would crash the test runner.
    expect(() => sink({
      tenant: { sub: 'u', tenant_id: null, org_id: null },
      tool: 'projex_registry_search_sdks',
      ok: true,
      duration_ms: 1,
    })).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('unknown tool still meters under the fallback SKU', async () => {
    const calls: Array<{ sku: string }> = [];
    const sink = buildMeterSink({
      report: async (input) => { calls.push({ sku: input.sku }); },
      pool_index: 'p',
      region: 'r',
    });
    sink({
      tenant: { sub: 'u', tenant_id: 't', org_id: null },
      tool: 'projex_registry_mystery_tool',
      ok: true,
      duration_ms: 1,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls[0].sku).toBe('registry.tool.other');
  });
});

describe('composeAuditSinks', () => {
  it('fans the audit event into every sink', () => {
    const seenA: string[] = [];
    const seenB: string[] = [];
    const composite = composeAuditSinks(
      (e) => seenA.push(e.tool),
      (e) => seenB.push(e.tool),
    );
    composite({
      tenant: { sub: 'u', tenant_id: null, org_id: null },
      tool: 'projex_registry_search_sdks',
      ok: true,
      duration_ms: 1,
    });
    expect(seenA).toEqual(['projex_registry_search_sdks']);
    expect(seenB).toEqual(['projex_registry_search_sdks']);
  });

  it('a throwing sink does not skip remaining sinks', () => {
    const seenB: string[] = [];
    const composite = composeAuditSinks(
      () => { throw new Error('sink A boom'); },
      (e) => seenB.push(e.tool),
    );
    expect(() => composite({
      tenant: { sub: 'u', tenant_id: null, org_id: null },
      tool: 'projex_registry_search_sdks',
      ok: true,
      duration_ms: 1,
    })).not.toThrow();
    expect(seenB).toEqual(['projex_registry_search_sdks']);
  });
});
