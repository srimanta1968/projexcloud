import { describe, expect, it } from 'vitest';
import { buildCatalog } from '../src/catalog';
import { registryFromCatalog } from '../src/registry';
import { getScaffold } from '../src/scaffold';
import { scanResultOK } from './fixtures';

const REF_DATE = '2026-05-25T00:00:00.000Z';

function buildTestRegistry() {
  const scan = [
    scanResultOK('vault'),
    scanResultOK('billing'),
  ];
  return registryFromCatalog(buildCatalog({ scan, built_at: REF_DATE }));
}

describe('getScaffold — file set', () => {
  it('produces the canonical file set for two SDKs', () => {
    const r = getScaffold(buildTestRegistry(), [
      '@projexlight/sdk-vault',
      '@projexlight/sdk-billing',
    ], 'my-app');

    const paths = r.files.map((f) => f.path).sort();
    expect(paths).toContain('package.json');
    expect(paths).toContain('tsconfig.json');
    expect(paths).toContain('src/index.ts');
    expect(paths).toContain('src/integrations/sdk-vault.ts');
    expect(paths).toContain('src/integrations/sdk-billing.ts');
    expect(paths).toContain('db/migrations/.gitkeep');
    expect(paths).toContain('tests/smoke.test.ts');
    expect(paths).toContain('tests/vitest.config.ts');
    expect(paths).toContain('README.md');
    expect(paths).toContain('CLAUDE.md');
    expect(paths).toContain('.gitignore');
  });

  it('skips unknown SDKs and emits a warning per skip', () => {
    const r = getScaffold(buildTestRegistry(), [
      '@projexlight/sdk-vault',
      '@projexlight/sdk-not-real',
      '@projexlight/sdk-also-fake',
    ], 'my-app');
    expect(r.resolved_sdks).toEqual(['@projexlight/sdk-vault']);
    expect(r.warnings.length).toBe(2);
    expect(r.warnings[0]).toMatch(/sdk-not-real/);
    expect(r.warnings[1]).toMatch(/sdk-also-fake/);
  });

  it('returns an empty resolved list (but still scaffolds files) when every SDK is unknown', () => {
    const r = getScaffold(buildTestRegistry(), ['@projexlight/sdk-ghost'], 'my-app');
    expect(r.resolved_sdks).toEqual([]);
    expect(r.warnings.length).toBe(1);
    // No integration files for unknown SDKs.
    const integ = r.files.filter((f) => f.path.startsWith('src/integrations/'));
    expect(integ.length).toBe(0);
    // But the rest of the skeleton is still there.
    expect(r.files.find((f) => f.path === 'package.json')).toBeDefined();
  });
});

describe('getScaffold — file content', () => {
  it('package.json includes the picked SDKs as deps with caret-pinned versions', () => {
    const r = getScaffold(buildTestRegistry(), [
      '@projexlight/sdk-vault',
      '@projexlight/sdk-billing',
    ], 'my-app');
    const pkg = JSON.parse(r.files.find((f) => f.path === 'package.json')!.contents);
    expect(pkg.name).toBe('my-app');
    expect(pkg.dependencies['@projexlight/sdk-vault']).toBe('^0.1.0');
    expect(pkg.dependencies['@projexlight/sdk-billing']).toBe('^0.1.0');
    expect(pkg.devDependencies.typescript).toBeDefined();
    expect(pkg.scripts.test).toContain('vitest');
  });

  it('src/index.ts re-exports each integration as a camelCased namespace', () => {
    const r = getScaffold(buildTestRegistry(), [
      '@projexlight/sdk-vault',
      '@projexlight/sdk-billing',
    ], 'my-app');
    const idx = r.files.find((f) => f.path === 'src/index.ts')!.contents;
    expect(idx).toMatch(/export \* as sdkVault from '\.\/integrations\/sdk-vault'/);
    expect(idx).toMatch(/export \* as sdkBilling from '\.\/integrations\/sdk-billing'/);
  });

  it('integration file includes the manifest summary + first scenario as a stub', () => {
    const r = getScaffold(buildTestRegistry(), ['@projexlight/sdk-vault'], 'my-app');
    const integ = r.files.find((f) => f.path === 'src/integrations/sdk-vault.ts')!.contents;
    expect(integ).toMatch(/Integration with @projexlight\/sdk-vault/);
    expect(integ).toMatch(/Pool placement:/);
    expect(integ).toMatch(/Compliance:/);
    expect(integ).toMatch(/export async function init/);
  });

  it('CLAUDE.md ports the ai-appgen-style mandatory-search rule', () => {
    const r = getScaffold(buildTestRegistry(), ['@projexlight/sdk-vault'], 'my-app');
    const md = r.files.find((f) => f.path === 'CLAUDE.md')!.contents;
    expect(md).toMatch(/Search before creating/);
    expect(md).toMatch(/projex_registry_/);
    expect(md).toMatch(/No upward dependencies/);
  });

  it('README documents the picked SDKs in a table', () => {
    const r = getScaffold(buildTestRegistry(), [
      '@projexlight/sdk-vault',
      '@projexlight/sdk-billing',
    ], 'my-app');
    const readme = r.files.find((f) => f.path === 'README.md')!.contents;
    expect(readme).toContain('# my-app');
    expect(readme).toContain('@projexlight/sdk-vault');
    expect(readme).toContain('@projexlight/sdk-billing');
  });

  it('smoke test imports each integration and asserts init exists', () => {
    const r = getScaffold(buildTestRegistry(), [
      '@projexlight/sdk-vault',
      '@projexlight/sdk-billing',
    ], 'my-app');
    const test = r.files.find((f) => f.path === 'tests/smoke.test.ts')!.contents;
    expect(test).toMatch(/integrations\/sdk-vault/);
    expect(test).toMatch(/integrations\/sdk-billing/);
    expect(test).toMatch(/expect\(typeof mod\.init\)\.toBe\('function'\)/);
  });
});
