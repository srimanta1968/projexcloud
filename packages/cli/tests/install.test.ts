import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInstall } from '../src/commands/install';
import {
  buildCatalog,
  serializeCatalog,
  type ScanResult,
  type SdkCapabilityManifest,
} from '@projexlight/sdk-registry';

const SAVED_ENV = { ...process.env };

function fixtureManifest(id: string): SdkCapabilityManifest {
  return {
    name: `@projexlight/sdk-${id}`,
    version: '1.2.3',
    schema_version: '1.0',
    summary: `Fixture manifest for sdk-${id}. Long enough to clear the 50-char lint minimum, used by install tests.`,
    tags: [id],
    provides: {
      endpoints: [{ method: 'POST', path: `/api/${id}` }],
      events: [{ name: `${id}.created.v1`, retention_class: 'operational', conflict_policy: 'lww' }],
      models: [{ schema: id, table: 'record' }],
      hooks: [],
      ui_components: [],
    },
    consumes: { events: [], infra: ['postgres'], config_keys: [] },
    scenarios: [
      { id: 's1', title: `Create a ${id}`, when_to_use: `When creating a ${id}.`, example_code: `await api.create${id}({ name: 'x' });`, expected_outcome: `A ${id} record exists.` },
      { id: 's2', title: `Read a ${id}`, when_to_use: `When reading.`, example_code: `await api.get${id}(id);`, expected_outcome: `Returns the row.` },
      { id: 's3', title: `Delete a ${id}`, when_to_use: `On cleanup.`, example_code: `await api.delete${id}(id);`, expected_outcome: `Row removed.` },
    ],
    compliance_posture: { regimes: ['SOC2'] },
    pool_placement: 'app',
    pricing_skus: [],
    links: {},
  };
}

function scanOK(id: string): ScanResult {
  return { path: `packages/sdk-${id}`, name: `@projexlight/sdk-${id}`, status: 'OK', manifest: fixtureManifest(id), errors: [] };
}

function setupAppDir(): { appDir: string; catalogPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'projex-install-'));
  const appDir = join(root, 'app');
  mkdirSync(join(appDir, 'src'), { recursive: true });
  writeFileSync(
    join(appDir, 'package.json'),
    JSON.stringify({ name: 'app', version: '0.1.0', dependencies: {} }, null, 2),
  );
  writeFileSync(join(appDir, 'src', 'index.ts'), '// app entry\n');

  // catalog with two SDKs
  const catalog = buildCatalog({
    scan: [scanOK('vault'), scanOK('billing')],
    built_at: '2026-05-25T00:00:00.000Z',
  });
  const catalogPath = join(root, 'registry.catalog.json');
  writeFileSync(catalogPath, serializeCatalog(catalog));

  return { appDir, catalogPath };
}

afterEach(() => {
  if (SAVED_ENV.PROJEX_DEV_ROOT === undefined) delete process.env.PROJEX_DEV_ROOT;
  else process.env.PROJEX_DEV_ROOT = SAVED_ENV.PROJEX_DEV_ROOT;
});

describe('runInstall — argument validation', () => {
  it('rejects an empty sdk_name', () => {
    expect(() => runInstall({ sdk_name: '' })).toThrow(/sdk_name is required/);
  });

  it('rejects an sdk_name without the @projexlight/ scope', () => {
    expect(() => runInstall({ sdk_name: 'sdk-vault' })).toThrow(/must start with "@projexlight\//);
  });

  it('errors when target dir has no package.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'projex-install-no-pkg-'));
    expect(() => runInstall({ sdk_name: '@projexlight/sdk-vault', targetDir: dir, catalogPath: '/nope' }))
      .toThrow(/No package.json found/);
  });

  it('errors when catalog missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'projex-install-no-cat-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{"name":"x"}');
    expect(() => runInstall({ sdk_name: '@projexlight/sdk-vault', targetDir: dir, catalogPath: '/nope/catalog.json' }))
      .toThrow(/No registry catalog/);
  });

  it('errors on unknown SDK with did-you-mean hint when possible', () => {
    const { appDir, catalogPath } = setupAppDir();
    expect(() => runInstall({ sdk_name: '@projexlight/sdk-vaul', targetDir: appDir, catalogPath }))
      .toThrow(/Unknown SDK[\s\S]*Did you mean/);
  });
});

describe('runInstall — package.json edit', () => {
  it('adds the SDK as a dependency with the catalog version', () => {
    const { appDir, catalogPath } = setupAppDir();
    const r = runInstall({ sdk_name: '@projexlight/sdk-vault', targetDir: appDir, catalogPath });
    expect(r.packageJsonAction).toBe('added');
    expect(r.depVersion).toBe('^1.2.3');
    const pkg = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf-8'));
    expect(pkg.dependencies['@projexlight/sdk-vault']).toBe('^1.2.3');
  });

  it('uses workspace:* when PROJEX_DEV_ROOT is set', () => {
    process.env.PROJEX_DEV_ROOT = '/dev/root';
    const { appDir, catalogPath } = setupAppDir();
    const r = runInstall({ sdk_name: '@projexlight/sdk-vault', targetDir: appDir, catalogPath });
    expect(r.depVersion).toBe('workspace:*');
  });

  it('is idempotent — re-running with same SDK + same version is unchanged', () => {
    const { appDir, catalogPath } = setupAppDir();
    runInstall({ sdk_name: '@projexlight/sdk-vault', targetDir: appDir, catalogPath });
    const r2 = runInstall({ sdk_name: '@projexlight/sdk-vault', targetDir: appDir, catalogPath, force: true });
    expect(r2.packageJsonAction).toBe('unchanged');
  });

  it('updates the version when catalog has a newer manifest', () => {
    const { appDir, catalogPath } = setupAppDir();
    runInstall({ sdk_name: '@projexlight/sdk-vault', targetDir: appDir, catalogPath });
    // Manually downgrade in package.json to simulate stale dep
    const pkgPath = join(appDir, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    pkg.dependencies['@projexlight/sdk-vault'] = '^0.0.1';
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    const r = runInstall({ sdk_name: '@projexlight/sdk-vault', targetDir: appDir, catalogPath, force: true });
    expect(r.packageJsonAction).toBe('updated');
  });
});

describe('runInstall — integration file', () => {
  it('drops src/integrations/<bare>.ts with manifest summary + first scenario', () => {
    const { appDir, catalogPath } = setupAppDir();
    const r = runInstall({ sdk_name: '@projexlight/sdk-vault', targetDir: appDir, catalogPath });
    expect(existsSync(r.integrationPath)).toBe(true);
    expect(r.integrationPath.endsWith('sdk-vault.ts')).toBe(true);
    const code = readFileSync(r.integrationPath, 'utf-8');
    expect(code).toContain('Integration with @projexlight/sdk-vault v1.2.3');
    expect(code).toContain('Pool placement: app');
    expect(code).toContain('Compliance:');
    expect(code).toContain('export async function init');
    expect(code).toContain('Create a vault'); // first scenario title
  });

  it('skips existing integration without --force', () => {
    const { appDir, catalogPath } = setupAppDir();
    runInstall({ sdk_name: '@projexlight/sdk-vault', targetDir: appDir, catalogPath });
    const r2 = runInstall({ sdk_name: '@projexlight/sdk-vault', targetDir: appDir, catalogPath });
    expect(r2.integrationAction).toBe('integration-skipped-exists');
  });

  it('overwrites with --force', () => {
    const { appDir, catalogPath } = setupAppDir();
    runInstall({ sdk_name: '@projexlight/sdk-vault', targetDir: appDir, catalogPath });
    writeFileSync(
      join(appDir, 'src', 'integrations', 'sdk-vault.ts'),
      '// manually edited\n',
    );
    const r = runInstall({ sdk_name: '@projexlight/sdk-vault', targetDir: appDir, catalogPath, force: true });
    expect(r.integrationAction).toMatch(/added|updated/);
    expect(readFileSync(r.integrationPath, 'utf-8')).toContain('Integration with @projexlight/sdk-vault');
  });
});

describe('runInstall — src/index.ts re-export', () => {
  it('appends a camelCased namespace re-export', () => {
    const { appDir, catalogPath } = setupAppDir();
    const r = runInstall({ sdk_name: '@projexlight/sdk-vault', targetDir: appDir, catalogPath });
    expect(r.indexUpdated).toBe(true);
    const idx = readFileSync(join(appDir, 'src', 'index.ts'), 'utf-8');
    expect(idx).toContain("export * as sdkVault from './integrations/sdk-vault'");
  });

  it('does not duplicate the re-export on re-run', () => {
    const { appDir, catalogPath } = setupAppDir();
    runInstall({ sdk_name: '@projexlight/sdk-vault', targetDir: appDir, catalogPath });
    const r2 = runInstall({ sdk_name: '@projexlight/sdk-vault', targetDir: appDir, catalogPath, force: true });
    expect(r2.indexUpdated).toBe(false);
    const idx = readFileSync(join(appDir, 'src', 'index.ts'), 'utf-8');
    expect((idx.match(/sdk-vault/g) ?? []).length).toBe(1);
  });

  it('warns when no src/index.ts exists', () => {
    const { appDir, catalogPath } = setupAppDir();
    // remove src/index.ts
    require('node:fs').rmSync(join(appDir, 'src', 'index.ts'));
    const r = runInstall({ sdk_name: '@projexlight/sdk-vault', targetDir: appDir, catalogPath });
    expect(r.indexUpdated).toBe(false);
    expect(r.warnings.some((w) => w.includes('No src/index.ts'))).toBe(true);
  });
});

describe('runInstall — composability with multiple SDKs', () => {
  it('installs two SDKs cleanly with both re-exports + both integrations', () => {
    const { appDir, catalogPath } = setupAppDir();
    runInstall({ sdk_name: '@projexlight/sdk-vault', targetDir: appDir, catalogPath });
    runInstall({ sdk_name: '@projexlight/sdk-billing', targetDir: appDir, catalogPath });

    const pkg = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf-8'));
    expect(pkg.dependencies['@projexlight/sdk-vault']).toBe('^1.2.3');
    expect(pkg.dependencies['@projexlight/sdk-billing']).toBe('^1.2.3');

    expect(existsSync(join(appDir, 'src', 'integrations', 'sdk-vault.ts'))).toBe(true);
    expect(existsSync(join(appDir, 'src', 'integrations', 'sdk-billing.ts'))).toBe(true);

    const idx = readFileSync(join(appDir, 'src', 'index.ts'), 'utf-8');
    expect(idx).toContain('sdkVault');
    expect(idx).toContain('sdkBilling');
  });
});
