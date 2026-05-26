/**
 * Tests the tool-dispatch surface without going through the MCP stdio
 * transport. The dispatcher signature is the same one used by both
 * stdio (Phase 1) and SSE (Phase 2 hosted), so unit-testing here covers
 * the contract independently of transport choice.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { join } from 'node:path';
import {
  buildCatalog,
  registryFromCatalog,
  type SdkCapabilityManifest,
} from '@projexlight/sdk-registry';
import type { ScanResult } from '@projexlight/sdk-registry';
import { READ_TOOLS, dispatchTool } from '../src/tools';

/* fixtures -------------------------------------------------------------- */

function fixtureManifest(id: string, extra: Partial<SdkCapabilityManifest> = {}): SdkCapabilityManifest {
  return {
    name: `@projexlight/sdk-${id}`,
    version: '0.1.0',
    schema_version: '1.0',
    summary:
      `Fixture manifest for sdk-${id}. Long enough to clear the 50-char lint minimum, used by registry-mcp-local tests.`,
    tags: [id],
    provides: {
      endpoints: [{ method: 'POST', path: `/api/${id}` }],
      events: [{ name: `${id}.created.v1`, retention_class: 'operational', conflict_policy: 'lww' }],
      models: [{ schema: id, table: 'record' }],
      hooks: [],
      ui_components: [],
    },
    consumes: { events: [], infra: [], config_keys: [] },
    scenarios: [
      {
        id: 'demo',
        title: `Demo scenario for ${id}`,
        when_to_use: `Use ${id} when you need ${id}-ish stuff.`,
        example_code: `await fetch('/api/${id}', { method: 'POST' });`,
        expected_outcome: `A new ${id} record is created.`,
      },
      {
        id: 's2',
        title: `Second scenario for ${id}`,
        when_to_use: `Use ${id} for the secondary flow.`,
        example_code: `console.log('${id} secondary');`,
        expected_outcome: `Secondary flow completes.`,
      },
      {
        id: 's3',
        title: `Third scenario for ${id}`,
        when_to_use: `Edge / recovery for ${id}.`,
        example_code: `await replay('${id}.created.v1', { since: '2026-01-01' });`,
        expected_outcome: `Each event re-emits idempotently.`,
      },
    ],
    compliance_posture: { regimes: ['SOC2'] },
    pool_placement: 'app',
    pricing_skus: [],
    links: {},
    ...extra,
  };
}

function scanOK(id: string, extra: Partial<SdkCapabilityManifest> = {}): ScanResult {
  return {
    path: `packages/sdk-${id}`,
    name: `@projexlight/sdk-${id}`,
    status: 'OK',
    manifest: fixtureManifest(id, extra),
    errors: [],
  };
}

function makeRegistry() {
  const cat = buildCatalog({
    scan: [
      scanOK('vault'),
      scanOK('billing', {
        consumes: { events: [{ name: 'vault.created.v1', from: '@projexlight/sdk-vault' }], infra: [], config_keys: [] },
      }),
    ],
    built_at: '2026-05-25T00:00:00.000Z',
  });
  return registryFromCatalog(cat);
}

/* tool listing ---------------------------------------------------------- */

describe('READ_TOOLS — schema shape', () => {
  it('every tool uses the projex_registry_* prefix per FR-COHAB-2', () => {
    for (const t of READ_TOOLS) {
      expect(t.name.startsWith('projex_registry_')).toBe(true);
    }
  });

  it('every tool has a non-empty description (AI clients render this)', () => {
    for (const t of READ_TOOLS) {
      expect(t.description.length).toBeGreaterThan(20);
    }
  });

  it('every tool inputSchema is a JSON-Schema object', () => {
    for (const t of READ_TOOLS) {
      expect(t.inputSchema.type).toBe('object');
      expect(t.inputSchema.properties).toBeDefined();
    }
  });
});

/* search_sdks ----------------------------------------------------------- */

describe('projex_registry_search_sdks', () => {
  it('returns hits and includes the query echo for debuggability', async () => {
    const r = await dispatchTool('projex_registry_search_sdks', { intent: 'vault' }, makeRegistry());
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.query).toBe('vault');
    expect(body.top_k).toBe(5);
    expect(body.hits[0].name).toBe('@projexlight/sdk-vault');
  });

  it('honors a custom top_k', async () => {
    const r = await dispatchTool(
      'projex_registry_search_sdks',
      { intent: 'fixture', top_k: 1 },
      makeRegistry(),
    );
    const body = JSON.parse(r.content[0].text);
    expect(body.hits.length).toBeLessThanOrEqual(1);
  });

  it('returns an error when intent is missing', async () => {
    const r = await dispatchTool('projex_registry_search_sdks', {}, makeRegistry());
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/intent is required/);
  });
});

/* get_manifest ---------------------------------------------------------- */

describe('projex_registry_get_manifest', () => {
  it('returns the full manifest', async () => {
    const r = await dispatchTool(
      'projex_registry_get_manifest',
      { sdk_name: '@projexlight/sdk-vault' },
      makeRegistry(),
    );
    expect(r.isError).toBeFalsy();
    const m = JSON.parse(r.content[0].text);
    expect(m.name).toBe('@projexlight/sdk-vault');
    expect(m.scenarios.length).toBe(3);
  });

  it('errors on unknown SDK', async () => {
    const r = await dispatchTool(
      'projex_registry_get_manifest',
      { sdk_name: '@projexlight/sdk-nope' },
      makeRegistry(),
    );
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/unknown sdk/);
  });

  it('errors when sdk_name is missing', async () => {
    const r = await dispatchTool('projex_registry_get_manifest', {}, makeRegistry());
    expect(r.isError).toBe(true);
  });
});

/* get_example ----------------------------------------------------------- */

describe('projex_registry_get_example', () => {
  it('returns a single scenario by id', async () => {
    const r = await dispatchTool(
      'projex_registry_get_example',
      { sdk_name: '@projexlight/sdk-vault', scenario_id: 'demo' },
      makeRegistry(),
    );
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.scenario_id).toBe('demo');
    expect(body.title).toBe('Demo scenario for vault');
    expect(body.example_code).toContain('/api/vault');
  });

  it('errors on unknown scenario', async () => {
    const r = await dispatchTool(
      'projex_registry_get_example',
      { sdk_name: '@projexlight/sdk-vault', scenario_id: 'nope' },
      makeRegistry(),
    );
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/unknown scenario/);
  });

  it('errors on missing args', async () => {
    const r = await dispatchTool(
      'projex_registry_get_example',
      { sdk_name: '@projexlight/sdk-vault' },
      makeRegistry(),
    );
    expect(r.isError).toBe(true);
  });
});

/* list_compatible_sdks -------------------------------------------------- */

describe('projex_registry_list_compatible_sdks', () => {
  it('returns the SDK that consumes our event', async () => {
    const r = await dispatchTool(
      'projex_registry_list_compatible_sdks',
      { sdk_name: '@projexlight/sdk-vault' },
      makeRegistry(),
    );
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.compatible).toEqual(['@projexlight/sdk-billing']);
  });

  it('returns the SDK whose event we consume', async () => {
    const r = await dispatchTool(
      'projex_registry_list_compatible_sdks',
      { sdk_name: '@projexlight/sdk-billing' },
      makeRegistry(),
    );
    const body = JSON.parse(r.content[0].text);
    expect(body.compatible).toEqual(['@projexlight/sdk-vault']);
  });

  it('errors on unknown SDK', async () => {
    const r = await dispatchTool(
      'projex_registry_list_compatible_sdks',
      { sdk_name: '@projexlight/sdk-nope' },
      makeRegistry(),
    );
    expect(r.isError).toBe(true);
  });
});

/* blueprint stubs ------------------------------------------------------- */

describe('projex_registry_list_blueprints', () => {
  const SAVED_ROOT = process.env.PROJEX_BLUEPRINTS_ROOT;
  const SAVED_DEV = process.env.PROJEX_DEV_ROOT;
  afterEach(() => {
    if (SAVED_ROOT === undefined) delete process.env.PROJEX_BLUEPRINTS_ROOT;
    else process.env.PROJEX_BLUEPRINTS_ROOT = SAVED_ROOT;
    if (SAVED_DEV === undefined) delete process.env.PROJEX_DEV_ROOT;
    else process.env.PROJEX_DEV_ROOT = SAVED_DEV;
  });

  it('returns empty + note when no root configured', async () => {
    delete process.env.PROJEX_BLUEPRINTS_ROOT;
    delete process.env.PROJEX_DEV_ROOT;
    const r = await dispatchTool('projex_registry_list_blueprints', {}, makeRegistry());
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.blueprints).toEqual([]);
    expect(body.note).toMatch(/No blueprints root configured/);
  });

  it('lists real blueprints from PROJEX_BLUEPRINTS_ROOT', async () => {
    process.env.PROJEX_BLUEPRINTS_ROOT = join(__dirname, '..', '..', '..', 'blueprints');
    const r = await dispatchTool('projex_registry_list_blueprints', {}, makeRegistry());
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.count).toBeGreaterThanOrEqual(1);
    expect(body.blueprints.find((b: { id: string }) => b.id === 'revops-crm')).toBeDefined();
  });

  it('respects tag filter', async () => {
    process.env.PROJEX_BLUEPRINTS_ROOT = join(__dirname, '..', '..', '..', 'blueprints');
    const r = await dispatchTool('projex_registry_list_blueprints', { tag: 'pilot' }, makeRegistry());
    const body = JSON.parse(r.content[0].text);
    expect(body.blueprints.every((b: { tags: string[] }) => b.tags.includes('pilot'))).toBe(true);
  });
});

describe('projex_registry_get_blueprint', () => {
  const SAVED_ROOT = process.env.PROJEX_BLUEPRINTS_ROOT;
  const SAVED_DEV = process.env.PROJEX_DEV_ROOT;
  afterEach(() => {
    if (SAVED_ROOT === undefined) delete process.env.PROJEX_BLUEPRINTS_ROOT;
    else process.env.PROJEX_BLUEPRINTS_ROOT = SAVED_ROOT;
    if (SAVED_DEV === undefined) delete process.env.PROJEX_DEV_ROOT;
    else process.env.PROJEX_DEV_ROOT = SAVED_DEV;
  });

  it('errors when no root configured', async () => {
    delete process.env.PROJEX_BLUEPRINTS_ROOT;
    delete process.env.PROJEX_DEV_ROOT;
    const r = await dispatchTool('projex_registry_get_blueprint', { blueprint_id: 'revops-crm' }, makeRegistry());
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/No blueprints root configured/);
  });

  it('errors on unknown blueprint id', async () => {
    process.env.PROJEX_BLUEPRINTS_ROOT = join(__dirname, '..', '..', '..', 'blueprints');
    const r = await dispatchTool('projex_registry_get_blueprint', { blueprint_id: 'no-such-bp' }, makeRegistry());
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/not found/);
  });

  it('returns the full blueprint when loaded', async () => {
    process.env.PROJEX_BLUEPRINTS_ROOT = join(__dirname, '..', '..', '..', 'blueprints');
    const r = await dispatchTool('projex_registry_get_blueprint', { blueprint_id: 'revops-crm' }, makeRegistry());
    expect(r.isError).toBeFalsy();
    const bp = JSON.parse(r.content[0].text);
    expect(bp.id).toBe('revops-crm');
    expect(bp.pack).toBe('general');
    expect(bp.sdks.length).toBe(5);
  });
});

/* unknown tool ---------------------------------------------------------- */

describe('unknown tool routing', () => {
  it('rejects calls to non-existent tool names', async () => {
    const r = await dispatchTool('projex_unknown_thing', {}, makeRegistry());
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/unknown tool/);
  });
});
