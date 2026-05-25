import { SdkCapabilityManifest } from '@projexlight/sdk-capability';
import { CatalogEntry, ScanResult } from '../src/types';

/**
 * Lint-clean manifest factory for tests. Returns a manifest under name
 * @projexlight/sdk-<id> with one event produced and optional consumes.
 */
export function fixtureManifest(
  id: string,
  opts: { produces?: string[]; consumes?: Array<{ name: string; from: string }> } = {},
): SdkCapabilityManifest {
  return {
    name: `@projexlight/sdk-${id}`,
    version: '0.1.0',
    schema_version: '1.0',
    summary:
      `Fixture manifest for sdk-${id}. Long enough to clear the 50-char lint minimum, used only by sdk-registry tests.`,
    tags: [id, 'fixture'],
    provides: {
      endpoints: [{ method: 'POST', path: `/api/${id}`, description: `Create ${id}` }],
      events: (opts.produces ?? [`${id}.created.v1`]).map((name) => ({
        name,
        retention_class: 'operational' as const,
        conflict_policy: 'lww' as const,
      })),
      models: [{ schema: id, table: 'record' }],
      hooks: [],
      ui_components: [],
    },
    consumes: {
      events: opts.consumes ?? [],
      infra: ['postgres'],
      config_keys: [],
    },
    scenarios: [
      {
        id: 's1',
        title: `Create a ${id}`,
        when_to_use: `When the caller needs to register a new ${id} record.`,
        example_code: `await fetch('/api/${id}', { method: 'POST', body: JSON.stringify({}) });`,
        expected_outcome: `A new ${id} row is persisted and ${id}.created.v1 fires.`,
      },
      {
        id: 's2',
        title: `Subscribe to ${id}.created.v1`,
        when_to_use: `When a downstream needs to react to new ${id}s.`,
        example_code: `subscribe('${id}.created.v1', async (e) => console.log(e));`,
        expected_outcome: `Handler fires once per event.`,
      },
      {
        id: 's3',
        title: `Recovery / replay`,
        when_to_use: `Replay missed events from the audit chain.`,
        example_code: `await replay('${id}.created.v1', { since: '2026-01-01' });`,
        expected_outcome: `Each event is re-emitted to subscribers idempotently.`,
      },
    ],
    compliance_posture: { regimes: ['SOC2'] },
    pool_placement: 'app',
    pricing_skus: [],
    links: {},
  };
}

export function scanResultOK(id: string, opts: Parameters<typeof fixtureManifest>[1] = {}): ScanResult {
  return {
    path: `packages/sdk-${id}`,
    name: `@projexlight/sdk-${id}`,
    status: 'OK',
    manifest: fixtureManifest(id, opts),
    errors: [],
  };
}

export function catalogEntryFrom(scan: ScanResult): CatalogEntry {
  if (scan.status !== 'OK' || !scan.manifest) throw new Error('not OK');
  return { path: scan.path, manifest: scan.manifest };
}
