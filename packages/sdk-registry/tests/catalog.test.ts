import { describe, expect, it } from 'vitest';
import {
  buildCatalog,
  catalogContentHash,
  serializeCatalog,
} from '../src/catalog';
import { scanResultOK } from './fixtures';

describe('buildCatalog — entry ordering + counts', () => {
  it('sorts entries by manifest.name regardless of scan order', () => {
    const scan = [scanResultOK('zebra'), scanResultOK('alpha'), scanResultOK('mango')];
    const cat = buildCatalog({ scan, built_at: '2026-05-25T00:00:00.000Z' });
    expect(cat.entries.map((e) => e.manifest.name)).toEqual([
      '@projexlight/sdk-alpha',
      '@projexlight/sdk-mango',
      '@projexlight/sdk-zebra',
    ]);
  });

  it('counts endpoints, events_produced, scenarios correctly', () => {
    const scan = [scanResultOK('alpha'), scanResultOK('mango')];
    const cat = buildCatalog({ scan, built_at: '2026-05-25T00:00:00.000Z' });
    expect(cat.counts.sdks).toBe(2);
    expect(cat.counts.endpoints).toBe(2); // 1 each
    expect(cat.counts.events_produced).toBe(2); // alpha.created.v1, mango.created.v1
    expect(cat.counts.scenarios).toBe(6); // 3 each
    expect(cat.counts.events_consumed_unmatched).toBe(0);
  });

  it('flags consumed-but-unproduced events as unmatched', () => {
    const scan = [
      scanResultOK('alpha', { consumes: [{ name: 'orphan.event.v1', from: 'external' }] }),
    ];
    const cat = buildCatalog({ scan, built_at: '2026-05-25T00:00:00.000Z' });
    expect(cat.counts.events_consumed_unmatched).toBe(1);
  });

  it('drops non-OK scan entries silently (caller decides strictness)', () => {
    const scan = [
      scanResultOK('alpha'),
      {
        path: 'packages/sdk-broken',
        name: '@projexlight/sdk-broken',
        status: 'MISSING' as const,
        errors: ['no manifest'],
      },
    ];
    const cat = buildCatalog({ scan, built_at: '2026-05-25T00:00:00.000Z' });
    expect(cat.counts.sdks).toBe(1);
  });
});

describe('buildCatalog — dependency graph', () => {
  it('builds consumer → producer edges from event overlap', () => {
    const scan = [
      scanResultOK('producer', { produces: ['shared.event.v1'] }),
      scanResultOK('consumer', { consumes: [{ name: 'shared.event.v1', from: '@projexlight/sdk-producer' }] }),
    ];
    const cat = buildCatalog({ scan, built_at: '2026-05-25T00:00:00.000Z' });

    expect(cat.graph.producers['shared.event.v1']).toEqual(['@projexlight/sdk-producer']);
    expect(cat.graph.consumers['shared.event.v1']).toEqual(['@projexlight/sdk-consumer']);
    expect(cat.graph.edges).toEqual([
      {
        consumer_sdk: '@projexlight/sdk-consumer',
        producer_sdk: '@projexlight/sdk-producer',
        event: 'shared.event.v1',
      },
    ]);
  });

  it('sorts adjacency lists alphabetically', () => {
    const scan = [
      scanResultOK('beta', { produces: ['shared.v1'] }),
      scanResultOK('alpha', { produces: ['shared.v1'] }),
    ];
    const cat = buildCatalog({ scan, built_at: '2026-05-25T00:00:00.000Z' });
    expect(cat.graph.producers['shared.v1']).toEqual([
      '@projexlight/sdk-alpha',
      '@projexlight/sdk-beta',
    ]);
  });
});

describe('serializeCatalog — determinism (AC-2)', () => {
  it('produces byte-identical output for identical inputs and built_at', () => {
    const scan = [scanResultOK('a'), scanResultOK('b'), scanResultOK('c')];
    const c1 = buildCatalog({ scan, built_at: '2026-05-25T00:00:00.000Z' });
    const c2 = buildCatalog({ scan, built_at: '2026-05-25T00:00:00.000Z' });
    expect(serializeCatalog(c1)).toBe(serializeCatalog(c2));
    expect(catalogContentHash(c1)).toBe(catalogContentHash(c2));
  });

  it('top-level object keys are sorted alphabetically', () => {
    const cat = buildCatalog({ scan: [scanResultOK('z')], built_at: '2026-05-25T00:00:00.000Z' });
    const out = serializeCatalog(cat);
    // Alphabetical order: built_at < catalog_version < counts < entries < graph.
    const iBuiltAt = out.indexOf('"built_at"');
    const iCatVer = out.indexOf('"catalog_version"');
    const iCounts = out.indexOf('"counts"');
    const iEntries = out.indexOf('"entries"');
    const iGraph = out.indexOf('"graph"');
    expect(iBuiltAt).toBeGreaterThan(-1);
    expect(iBuiltAt).toBeLessThan(iCatVer);
    expect(iCatVer).toBeLessThan(iCounts);
    expect(iCounts).toBeLessThan(iEntries);
    expect(iEntries).toBeLessThan(iGraph);
  });

  it('content hash differs when content differs', () => {
    const c1 = buildCatalog({ scan: [scanResultOK('a')], built_at: '2026-05-25T00:00:00.000Z' });
    const c2 = buildCatalog({ scan: [scanResultOK('a'), scanResultOK('b')], built_at: '2026-05-25T00:00:00.000Z' });
    expect(catalogContentHash(c1)).not.toBe(catalogContentHash(c2));
  });
});
