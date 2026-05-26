import { SdkCapabilityManifest } from '../src/types';

/**
 * Canonical "known-good" manifest fixture used across tests. Mirrors what an
 * authored sdk-capability.json for a hypothetical SDK looks like.
 */
export function validManifest(overrides: Partial<SdkCapabilityManifest> = {}): SdkCapabilityManifest {
  const base: SdkCapabilityManifest = {
    name: '@projexlight/sdk-example',
    version: '1.0.0',
    schema_version: '1.0',
    summary:
      'Example SDK that demonstrates a complete, lint-clean manifest. Provides a single REST endpoint and emits one event for downstream consumers to subscribe to.',
    tags: ['example', 'demo'],
    provides: {
      endpoints: [
        { method: 'POST', path: '/api/example', description: 'Create an example' },
      ],
      events: [
        {
          name: 'example.created.v1',
          retention_class: 'operational',
          conflict_policy: 'lww',
        },
      ],
      models: [{ schema: 'example', table: 'example_record' }],
      hooks: [],
      ui_components: [],
    },
    consumes: {
      events: [],
      infra: ['postgres'],
      config_keys: ['EXAMPLE_FEATURE_FLAG'],
    },
    scenarios: [
      {
        id: 's1',
        title: 'Create an example record',
        when_to_use: 'When a tenant wants to register a new example for later retrieval.',
        example_code: "await fetch('/api/example', { method: 'POST', body: JSON.stringify({ name: 'demo' }) });",
        expected_outcome: 'A new example_record row appears in the example schema with a generated id.',
      },
      {
        id: 's2',
        title: 'Subscribe to example.created.v1',
        when_to_use: 'When a downstream SDK needs to react to new examples being created.',
        example_code: "subscribeEvents('example.created.v1', async (e) => { console.log(e); });",
        expected_outcome: 'The handler fires once per example.created.v1 event published.',
      },
      {
        id: 's3',
        title: 'Query existing examples by tenant',
        when_to_use: 'When the workspace UI needs to render the tenant\'s example list.',
        example_code: "const rows = await db.query('SELECT * FROM example.example_record WHERE tenant_id = $1', [tid]);",
        expected_outcome: 'Returns 0..n rows scoped to the calling tenant via RLS.',
      },
    ],
    compliance_posture: {
      regimes: ['SOC2'],
      notes: 'No PII handled; no special compliance considerations.',
    },
    pool_placement: 'app',
    pricing_skus: [
      { sku: 'example.create', mode: 'metered', unit_description: 'per example record created' },
    ],
    links: {
      readme: 'packages/sdk-example/README.md',
      source: 'packages/sdk-example/src/',
      prd_section: 'P-Example §5.1',
    },
  };
  return { ...base, ...overrides };
}
