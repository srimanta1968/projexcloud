import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyFileSync, readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApp, createRegistryRef, startCatalogWatcher, loadConfig } from '../src';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const SOURCE_CATALOG = resolve(REPO_ROOT, 'packages/sdk-registry/dist/registry.catalog.json');

const SAVED: Record<string, string | undefined> = {};
function setEnv(k: string, v: string | undefined) {
  SAVED[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}
function restore() {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe('catalog hot-reload', () => {
  let tempDir: string;
  let tempCatalog: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'registry-mcp-watch-'));
    tempCatalog = join(tempDir, 'registry.catalog.json');
    copyFileSync(SOURCE_CATALOG, tempCatalog);
    setEnv('REGISTRY_MCP_CATALOG_PATH', tempCatalog);
    setEnv('REGISTRY_MCP_AUTH_MODE', 'disabled');
    setEnv('JWT_SECRET', 'test-secret-only');
  });
  afterEach(() => restore());

  it('createRegistryRef loads + records the source mtime', () => {
    const cfg = loadConfig();
    const ref = createRegistryRef(cfg);
    expect(ref.current.list().length).toBeGreaterThan(0);
    expect(ref.lastSourceMtimeMs).toBeGreaterThan(0);
    expect(ref.reloadCount).toBe(0);
  });

  it('watcher tick reports unchanged when mtime has not advanced', () => {
    const cfg = loadConfig();
    const ref = createRegistryRef(cfg);
    const watcher = startCatalogWatcher(cfg, ref, { intervalMs: -1 });
    try {
      const r = watcher.tick();
      expect(r).toEqual({ reloaded: false, reason: 'unchanged' });
      expect(ref.reloadCount).toBe(0);
    } finally {
      watcher.stop();
    }
  });

  it('watcher tick reloads when the catalog file is overwritten', () => {
    const cfg = loadConfig();
    const ref = createRegistryRef(cfg);
    const originalCount = ref.current.list().length;
    const originalReloadCount = ref.reloadCount;

    // Rewrite the catalog with one fewer entry to prove the in-memory swap.
    const cat = JSON.parse(readFileSync(tempCatalog, 'utf-8'));
    const trimmedEntries = cat.entries.slice(0, cat.entries.length - 1);
    const trimmed = { ...cat, entries: trimmedEntries, counts: { ...cat.counts, sdks: trimmedEntries.length } };
    writeFileSync(tempCatalog, JSON.stringify(trimmed));
    // Force mtime forward (filesystem mtime resolution can be 1s on some hosts).
    const future = new Date(Date.now() + 5_000);
    utimesSync(tempCatalog, future, future);

    const watcher = startCatalogWatcher(cfg, ref, { intervalMs: -1 });
    try {
      const r = watcher.tick();
      expect(r.reloaded).toBe(true);
      expect(ref.reloadCount).toBe(originalReloadCount + 1);
      expect(ref.current.list().length).toBe(originalCount - 1);
    } finally {
      watcher.stop();
    }
  });

  it('failed reload keeps the previous Registry serving traffic', () => {
    const cfg = loadConfig();
    const ref = createRegistryRef(cfg);
    const originalCount = ref.current.list().length;

    // Write garbage with a future mtime — load should fail; ref untouched.
    writeFileSync(tempCatalog, '{ not valid JSON');
    const future = new Date(Date.now() + 5_000);
    utimesSync(tempCatalog, future, future);

    const watcher = startCatalogWatcher(cfg, ref, { intervalMs: -1 });
    try {
      const r = watcher.tick();
      expect(r.reloaded).toBe(false);
      expect(r.reason).toMatch(/^reload-failed:/);
      // ref still serves the old Registry — no service disruption.
      expect(ref.current.list().length).toBe(originalCount);
    } finally {
      watcher.stop();
    }
  });

  it('healthz reports reload counters when wired with registryRef', async () => {
    const cfg = loadConfig();
    const ref = createRegistryRef(cfg);
    const app = buildApp({ config: cfg, registryRef: ref, embeddingsLoaded: ref.embeddingsLoaded });
    try {
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      const body = res.json() as Record<string, unknown>;
      expect(body.catalog_reload_count).toBe(0);
      expect(body.catalog_loaded_at).toBeTypeOf('number');
      expect(body.catalog_source_mtime_ms).toBeTypeOf('number');
      expect(body.catalog_entries).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it('onReload callback fires with mtime transition info', () => {
    const cfg = loadConfig();
    const ref = createRegistryRef(cfg);
    const reloads: Array<{ from: number; to: number }> = [];
    const watcher = startCatalogWatcher(cfg, ref, {
      intervalMs: -1,
      onReload: (i) => reloads.push(i),
    });
    try {
      // Touch the catalog forward.
      const future = new Date(Date.now() + 5_000);
      utimesSync(tempCatalog, future, future);
      watcher.tick();
      expect(reloads.length).toBe(1);
      expect(reloads[0].to).toBeGreaterThan(reloads[0].from);
    } finally {
      watcher.stop();
    }
  });

  it('buildApp throws when neither registry nor registryRef supplied', () => {
    const cfg = loadConfig();
    expect(() => buildApp({ config: cfg, embeddingsLoaded: false } as never)).toThrow(/registry/);
  });
});
