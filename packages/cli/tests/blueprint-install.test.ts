import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBlueprintApply } from '../src/commands/blueprint';
import {
  buildCatalog,
  serializeCatalog,
  type ScanResult,
  type SdkCapabilityManifest,
} from '@projexlight/sdk-registry';

const SAVED_ENV = { ...process.env };
const REPO_ROOT = join(__dirname, '..', '..', '..');
const REAL_BLUEPRINTS_ROOT = join(REPO_ROOT, 'blueprints');

afterEach(() => {
  if (SAVED_ENV.PROJEX_DEV_ROOT === undefined) delete process.env.PROJEX_DEV_ROOT;
  else process.env.PROJEX_DEV_ROOT = SAVED_ENV.PROJEX_DEV_ROOT;
});

beforeEach(() => {
  // dev-root influences install's dep-version pinning (workspace:* vs ^x.y.z).
  delete process.env.PROJEX_DEV_ROOT;
});

function fixtureManifest(id: string, version = '1.2.3'): SdkCapabilityManifest {
  return {
    name: `@projexlight/${id}`,
    version,
    schema_version: '1.0',
    summary: `Fixture manifest for ${id}. Long enough to clear the 50-char lint minimum.`,
    tags: [id],
    provides: {
      endpoints: [{ method: 'POST', path: `/api/${id}` }],
      events: [{ name: `${id}.created.v1`, retention_class: 'operational', conflict_policy: 'lww' }],
      models: [{ schema: id.replace('-', '_'), table: 'record' }],
      hooks: [],
      ui_components: [],
    },
    consumes: { events: [], infra: [], config_keys: [] },
    scenarios: [
      { id: 's1', title: 'A', when_to_use: 'When', example_code: `await create${id}();`, expected_outcome: 'ok' },
      { id: 's2', title: 'B', when_to_use: 'When', example_code: `await read${id}();`, expected_outcome: 'ok' },
      { id: 's3', title: 'C', when_to_use: 'When', example_code: `await delete${id}();`, expected_outcome: 'ok' },
    ],
    compliance_posture: { regimes: ['SOC2'] },
    pool_placement: 'app',
    pricing_skus: [],
    links: {},
  };
}

function scanOK(id: string, version?: string): ScanResult {
  return {
    path: `packages/${id}`,
    name: `@projexlight/${id}`,
    status: 'OK',
    manifest: fixtureManifest(id, version),
    errors: [],
  };
}

function setupAppAndCatalog() {
  const root = mkdtempSync(join(tmpdir(), 'projex-bp-inst-'));
  const app = join(root, 'app');
  mkdirSync(join(app, 'src'), { recursive: true });
  writeFileSync(
    join(app, 'package.json'),
    JSON.stringify({ name: 'app', version: '0.1.0', dependencies: {} }, null, 2),
  );
  writeFileSync(join(app, 'src', 'index.ts'), '// app entry\n');

  // Catalog must include every SDK revops-crm references.
  const cat = buildCatalog({
    scan: [
      scanOK('sdk-tenant'),
      scanOK('sdk-identity'),
      scanOK('sdk-audit'),
      scanOK('sdk-billing'),
      scanOK('sdk-meter'),
    ],
    built_at: '2026-05-25T00:00:00.000Z',
  });
  const catalogPath = join(root, 'registry.catalog.json');
  writeFileSync(catalogPath, serializeCatalog(cat));

  return { app, catalogPath };
}

describe('runBlueprintApply — --install-sdks integration', () => {
  it('skips installs by default (back-compat)', () => {
    const { app, catalogPath } = setupAppAndCatalog();
    const r = runBlueprintApply({
      blueprint_id: 'revops-crm',
      root: REAL_BLUEPRINTS_ROOT,
      targetDir: app,
      catalogPath,
    });
    expect(r.installs).toBeUndefined();
  });

  it('runs install for every blueprint SDK when --installSdks is set', () => {
    const { app, catalogPath } = setupAppAndCatalog();
    const r = runBlueprintApply({
      blueprint_id: 'revops-crm',
      root: REAL_BLUEPRINTS_ROOT,
      targetDir: app,
      catalogPath,
      installSdks: true,
    });

    expect(r.installs).toBeDefined();
    expect(r.installs!.length).toBe(5);
    expect(r.installs!.every((i) => i.ok)).toBe(true);

    const pkg = JSON.parse(readFileSync(join(app, 'package.json'), 'utf-8'));
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      '@projexlight/sdk-audit',
      '@projexlight/sdk-billing',
      '@projexlight/sdk-identity',
      '@projexlight/sdk-meter',
      '@projexlight/sdk-tenant',
    ]);
    // Every dep pinned at ^1.2.3 (the fixture version).
    expect(pkg.dependencies['@projexlight/sdk-vault'] ?? '^1.2.3');
    for (const dep of Object.values<string>(pkg.dependencies)) expect(dep).toBe('^1.2.3');

    // src/index.ts re-exports every camelCased SDK.
    const idx = readFileSync(join(app, 'src', 'index.ts'), 'utf-8');
    expect(idx).toContain('sdkAudit');
    expect(idx).toContain('sdkBilling');
    expect(idx).toContain('sdkIdentity');
    expect(idx).toContain('sdkMeter');
    expect(idx).toContain('sdkTenant');

    // Every integration file exists.
    for (const sdk of ['sdk-audit', 'sdk-billing', 'sdk-identity', 'sdk-meter', 'sdk-tenant']) {
      expect(existsSync(join(app, 'src', 'integrations', `${sdk}.ts`))).toBe(true);
    }
  });

  it('surfaces install failures in the installs array + warnings', () => {
    // Catalog without sdk-tenant present — first install will fail.
    const root = mkdtempSync(join(tmpdir(), 'projex-bp-inst-fail-'));
    const app = join(root, 'app');
    mkdirSync(join(app, 'src'), { recursive: true });
    writeFileSync(
      join(app, 'package.json'),
      JSON.stringify({ name: 'app', version: '0.1.0', dependencies: {} }, null, 2),
    );
    writeFileSync(join(app, 'src', 'index.ts'), '// app entry\n');
    // catalog missing sdk-tenant
    const cat = buildCatalog({
      scan: [scanOK('sdk-identity'), scanOK('sdk-audit'), scanOK('sdk-billing'), scanOK('sdk-meter')],
      built_at: '2026-05-25T00:00:00.000Z',
    });
    const catalogPath = join(root, 'registry.catalog.json');
    writeFileSync(catalogPath, serializeCatalog(cat));

    const r = runBlueprintApply({
      blueprint_id: 'revops-crm',
      root: REAL_BLUEPRINTS_ROOT,
      targetDir: app,
      catalogPath,
      installSdks: true,
    });

    const sdkTenantResult = r.installs!.find((i) => i.sdk_name === '@projexlight/sdk-tenant');
    expect(sdkTenantResult?.ok).toBe(false);
    expect(sdkTenantResult?.error).toMatch(/Unknown SDK/);
    // The rest still installed.
    const others = r.installs!.filter((i) => i.sdk_name !== '@projexlight/sdk-tenant');
    expect(others.every((i) => i.ok)).toBe(true);
    // Warning surfaced for the failure.
    expect(r.warnings.some((w) => w.includes('Auto-install of @projexlight/sdk-tenant failed'))).toBe(true);
  });
});
