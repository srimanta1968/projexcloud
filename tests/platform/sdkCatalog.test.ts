import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

/**
 * SDK catalog invariants (P16 · EP-387).
 *
 * The catalog is what an AI coding tool reads to decide reuse-vs-rebuild. An SDK missing
 * from it is, for that purpose, an SDK that does not exist — the tool cannot find it, so
 * it writes the capability again. Every assertion here protects that one outcome.
 */

const ROOT = path.resolve(__dirname, '..', '..');
const CATALOG = JSON.parse(fs.readFileSync(path.join(ROOT, 'mcp-server', 'data', 'sdk-catalog.json'), 'utf8'));
const INDEX_PATH = path.join(ROOT, 'mcp-server', 'data', 'sdk-catalog-index.json');
const INDEX = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));

const MAX_INDEX_BYTES = 64 * 1024;

const ALL_SDKS = CATALOG.groups.flatMap((g: { sdks: Array<Record<string, never>> }) => g.sdks);
const bySdk = new Map(ALL_SDKS.map((s: { sdk: string }) => [s.sdk, s]));

/** SDKs this sprint built or extended — the ones a future vertical must be able to find. */
const P16_SDKS = [
  'sdk-conversation', 'sdk-parsing', 'sdk-projection',
  'sdk-notification', 'sdk-rebac', 'sdk-connectors', 'sdk-lead-scoring',
];

describe('get_sdk_api resolves every new endpoint with a full spec (AC1)', () => {
  it.each(P16_SDKS)('%s is in the catalog with at least one endpoint', (sdk) => {
    const entry = bySdk.get(sdk) as { apis?: unknown[] } | undefined;
    expect(entry, `${sdk} is absent from the catalog — a capability nobody can find gets rebuilt`).toBeDefined();
    expect((entry!.apis ?? []).length).toBeGreaterThan(0);
  });

  it.each(P16_SDKS)('%s endpoints each carry method, path, auth, payload shape and dependsOn', (sdk) => {
    const entry = bySdk.get(sdk) as { apis: Array<Record<string, never>> };
    for (const api of entry.apis) {
      expect(api.method, `${sdk} endpoint missing method`).toBeTruthy();
      expect(api.endpoint).toMatch(/^\//);
      expect(typeof api.requiresAuth).toBe('boolean');
      // Shape, not values — enough to call the endpoint without fetching the definition.
      expect(Array.isArray(api.payload_shape)).toBe(true);
      expect(Array.isArray(api.dependsOn)).toBe(true);
      expect(api.fieldEnums).toBeDefined();
    }
  });

  it('specific P16 endpoints resolve with the auth contract intact', () => {
    const conv = bySdk.get('sdk-conversation') as { apis: Array<{ endpoint: string; requiresAuth: boolean }> };
    const guardrail = conv.apis.find((a) => a.endpoint === '/api/conversations/compose-guardrail');
    expect(guardrail).toBeDefined();
    expect(guardrail!.requiresAuth).toBe(true);

    // The signed-webhook exemption must survive into the catalog, or a consumer will send
    // a Bearer token to an endpoint that authenticates by HMAC and wonder why it 401s.
    const conn = bySdk.get('sdk-connectors') as { apis: Array<{ endpoint: string; requiresAuth: boolean }> };
    const leadForm = conn.apis.find((a) => a.endpoint.includes('/lead-forms/') && a.endpoint.includes(':platform'));
    expect(leadForm).toBeDefined();
    expect(leadForm!.requiresAuth).toBe(false);
  });

  it('no endpoint is listed twice within an SDK', () => {
    for (const s of ALL_SDKS as Array<{ sdk: string; apis?: Array<{ method: string; endpoint: string }> }>) {
      const keys = (s.apis ?? []).map((a) => `${a.method} ${a.endpoint}`);
      expect(new Set(keys).size, `${s.sdk} has duplicate endpoints`).toBe(keys.length);
    }
  });

  it('build tooling is NOT catalogued as a consumable SDK', () => {
    // scripts/release/* has api_definitions for traceability but is not something a
    // vertical installs; listing it would send a consumer looking for a package.
    expect(bySdk.has('platform')).toBe(false);
  });
});

describe('reuse_when keywords route discovery to the new SDKs (AC2)', () => {
  const EXPECTED_KEYWORDS: Record<string, string[]> = {
    'sdk-source-record': ['provenance', 'source record', 'origin', 'attestation'],
    'sdk-sla': ['sla', 'response time', 'escalation', 'business hours'],
    'sdk-coverage': ['coverage', 'availability', 'pto', 'on-call', 'capacity'],
    'sdk-data-credits': ['credits', 'capability', 'enrichment', 'provider', 'budget'],
    'sdk-import': ['import', 'mapping', 'csv', 'dry run', 'rollback'],
  };

  it.each(Object.keys(EXPECTED_KEYWORDS))('%s carries its briefed keyword set', (sdk) => {
    const entry = bySdk.get(sdk) as { reuse_when?: string[] } | undefined;
    if (!entry) return; // SDK not yet built in this repo — keywords land with it
    for (const kw of EXPECTED_KEYWORDS[sdk]) {
      expect(entry.reuse_when, `${sdk} missing keyword '${kw}'`).toContain(kw);
    }
  });

  it.each(P16_SDKS)('%s has discovery keywords', (sdk) => {
    const entry = bySdk.get(sdk) as { reuse_when?: string[] };
    expect(Array.isArray(entry.reuse_when)).toBe(true);
    expect(entry.reuse_when!.length).toBeGreaterThanOrEqual(3);
  });

  it('keywords are the words someone with the PROBLEM would use', () => {
    // Someone about to rebuild SLA tracking types "response time", not "sdk-sla" — if they
    // knew the SDK existed they would not be rebuilding it. So a keyword set that only
    // echoes the SDK's own name routes nobody.
    for (const sdk of P16_SDKS) {
      const entry = bySdk.get(sdk) as { reuse_when: string[] };
      const bare = sdk.replace(/^sdk-/, '');
      const nonEcho = entry.reuse_when.filter((k) => k !== bare && !k.startsWith('sdk-'));
      expect(nonEcho.length, `${sdk} keywords only echo its own name`).toBeGreaterThanOrEqual(3);
    }
  });

  const findByKeyword = (phrase: string) => (ALL_SDKS as Array<{ sdk: string; reuse_when?: string[] }>)
    .filter((s) => (s.reuse_when ?? []).some((k) => k === phrase))
    .map((s) => s.sdk);

  it('a distinctive discovery phrase resolves to exactly one SDK', () => {
    expect(findByKeyword('smart paste')).toEqual(['sdk-parsing']);
    expect(findByKeyword('survivorship')).toEqual(['sdk-projection']);
    expect(findByKeyword('frequency cap')).toEqual(['sdk-notification']);
    expect(findByKeyword('contextual role')).toEqual(['sdk-rebac']);
    expect(findByKeyword('lead form')).toEqual(['sdk-connectors']);
  });

  it.each(P16_SDKS)('%s owns at least one keyword no other SDK claims', (sdk) => {
    // This is the property that actually makes routing work. Some overlap is unavoidable
    // and already widespread ("escalation" is both sdk-handoff and sdk-sla, reasonably) —
    // what matters is that every SDK has SOME phrase that lands on it alone, or nothing
    // can ever route there unambiguously.
    const entry = bySdk.get(sdk) as { reuse_when: string[] };
    const unique = entry.reuse_when.filter((k) => findByKeyword(k).length === 1);
    expect(unique.length, `${sdk} has no keyword unique to it: ${entry.reuse_when.join(', ')}`).toBeGreaterThan(0);
  });

  it('does not claim a term another SDK already owns more precisely', () => {
    // 'golden record' belongs to sdk-identity-resolver, which does RECORD-level MDM
    // (match/dedupe/merge). sdk-projection is ATTRIBUTE-level survivorship, so it keeps
    // the phrases that distinguish it rather than competing for the same word.
    expect(findByKeyword('golden record')).toEqual(['sdk-identity-resolver']);
  });
});

describe('sdk_count and api_count are updated (AC3)', () => {
  it('counts reconcile to the tree rather than being asserted separately', () => {
    const sdkTotal = CATALOG.groups.reduce((n: number, g: { sdks: unknown[] }) => n + g.sdks.length, 0);
    const apiTotal = CATALOG.groups.reduce(
      (n: number, g: { sdks: Array<{ apis?: unknown[] }> }) => n + g.sdks.reduce((m, s) => m + (s.apis?.length ?? 0), 0),
      0,
    );
    // Recounted from the tree, so a hand-edited total cannot drift away from reality.
    expect(CATALOG.sdk_count).toBe(sdkTotal);
    expect(CATALOG.api_count).toBe(apiTotal);
  });

  it('per-group counts also reconcile', () => {
    for (const g of CATALOG.groups as Array<{ name: string; sdk_count: number; api_count: number; sdks: Array<{ apis?: unknown[] }> }>) {
      expect(g.sdk_count, `${g.name} sdk_count`).toBe(g.sdks.length);
      expect(g.api_count, `${g.name} api_count`).toBe(g.sdks.reduce((m, s) => m + (s.apis?.length ?? 0), 0));
    }
  });

  it('the index agrees with the catalog on both totals', () => {
    // Two artifacts that disagree about what exists are worse than one that is wrong.
    expect(INDEX.sdk_count).toBe(CATALOG.sdk_count);
    expect(INDEX.api_count).toBe(CATALOG.api_count);
    expect(INDEX.sdks.length).toBe(CATALOG.sdk_count);
  });

  it('the catalog grew to include this sprint', () => {
    // It stood at 67/469 before regeneration.
    expect(CATALOG.sdk_count).toBeGreaterThan(67);
    expect(CATALOG.api_count).toBeGreaterThan(469);
  });
});

describe('the index stays under the compact-map size budget (AC4)', () => {
  it(`is under ${MAX_INDEX_BYTES / 1024} KB`, () => {
    const bytes = fs.statSync(INDEX_PATH).size;
    // This file loads into a model's context on EVERY discovery call, so its size is a
    // running cost. An index that crowds out the answer defeats its own purpose.
    expect(bytes).toBeLessThan(MAX_INDEX_BYTES);
  });

  it('carries no payload shapes — that is the catalog\'s job', () => {
    for (const s of INDEX.sdks as Array<Record<string, unknown>>) {
      expect(s.apis).toBeUndefined();
      expect(s.payload_shape).toBeUndefined();
      expect(Object.keys(s).sort()).toEqual(['api_count', 'group', 'reuse_when', 'sdk', 'summary']);
    }
  });

  it('still carries what discovery actually needs', () => {
    for (const s of INDEX.sdks as Array<{ sdk: string; reuse_when: string[]; api_count: number }>) {
      expect(s.sdk).toBeTruthy();
      expect(Array.isArray(s.reuse_when)).toBe(true);
      expect(typeof s.api_count).toBe('number');
    }
  });
});

describe('regeneration is idempotent and CI-checkable', () => {
  it('re-running the generator changes nothing', () => {
    const out = execFileSync(
      process.execPath,
      [path.join(ROOT, 'scripts', 'catalog', 'regenerate-sdk-catalog.js'), '--check'],
      { encoding: 'utf8' },
    );
    // Drift means an endpoint exists that the catalog does not list — and an uncatalogued
    // capability is one the next vertical rebuilds.
    expect(out).toMatch(/catalog OK/);
  });
});
