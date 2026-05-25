import { describe, expect, it } from 'vitest';
import { buildCatalog } from '../src/catalog';
import { registryFromCatalog } from '../src/registry';
import { scanResultOK } from './fixtures';

const REF_DATE = '2026-05-25T00:00:00.000Z';

function buildTestCatalog() {
  const scan = [
    scanResultOK('vault', { produces: ['vault.key.created.v1'] }),
    scanResultOK('identity', {
      consumes: [{ name: 'vault.key.created.v1', from: '@projexlight/sdk-vault' }],
    }),
    scanResultOK('billing', { produces: ['billing.invoice.finalized.v1'] }),
  ];
  return buildCatalog({ scan, built_at: REF_DATE });
}

describe('Registry — list + get', () => {
  it('list returns all entries in deterministic order', () => {
    const r = registryFromCatalog(buildTestCatalog());
    expect(r.list().map((e) => e.manifest.name)).toEqual([
      '@projexlight/sdk-billing',
      '@projexlight/sdk-identity',
      '@projexlight/sdk-vault',
    ]);
  });

  it('get returns the entry by name', () => {
    const r = registryFromCatalog(buildTestCatalog());
    expect(r.get('@projexlight/sdk-vault')?.manifest.name).toBe('@projexlight/sdk-vault');
  });

  it('get returns null for missing name', () => {
    const r = registryFromCatalog(buildTestCatalog());
    expect(r.get('@projexlight/sdk-nope')).toBeNull();
  });
});

describe('Registry — findCompatibleSdks', () => {
  it('returns SDKs that consume an event we produce', () => {
    const r = registryFromCatalog(buildTestCatalog());
    expect(r.findCompatibleSdks('@projexlight/sdk-vault')).toEqual([
      '@projexlight/sdk-identity',
    ]);
  });

  it('returns SDKs that produce an event we consume', () => {
    const r = registryFromCatalog(buildTestCatalog());
    expect(r.findCompatibleSdks('@projexlight/sdk-identity')).toEqual([
      '@projexlight/sdk-vault',
    ]);
  });

  it('returns empty for an SDK with no shared events', () => {
    const r = registryFromCatalog(buildTestCatalog());
    expect(r.findCompatibleSdks('@projexlight/sdk-billing')).toEqual([]);
  });

  it('returns empty for an unknown SDK', () => {
    const r = registryFromCatalog(buildTestCatalog());
    expect(r.findCompatibleSdks('@projexlight/sdk-ghost')).toEqual([]);
  });
});

describe('Registry — searchByIntent (substring fallback; bge-small lands in E2.F3)', () => {
  it('ranks substring matches', async () => {
    const r = registryFromCatalog(buildTestCatalog());
    const hits = await r.searchByIntent('billing invoice');
    expect(hits[0]?.name).toBe('@projexlight/sdk-billing');
  });

  it('drops non-matching entries', async () => {
    const r = registryFromCatalog(buildTestCatalog());
    const hits = await r.searchByIntent('billing invoice');
    expect(hits.every((h) => h.score > 0)).toBe(true);
  });

  it('honors top_k', async () => {
    const r = registryFromCatalog(buildTestCatalog());
    const hits = await r.searchByIntent('fixture', 2);
    expect(hits.length).toBeLessThanOrEqual(2);
  });

  it('returns [] for empty query', async () => {
    const r = registryFromCatalog(buildTestCatalog());
    expect(await r.searchByIntent('  ')).toEqual([]);
  });
});
