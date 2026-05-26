import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRegistryRefresh } from '../src/commands/registry';

const SAVED_ENV = { ...process.env };

function setupTempHome() {
  const root = mkdtempSync(join(tmpdir(), 'projex-cli-reg-'));
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  process.env.PROJEX_HOME = join(root, '.projex');
  return root;
}

function cleanupEnv() {
  process.env.HOME = SAVED_ENV.HOME;
  process.env.USERPROFILE = SAVED_ENV.USERPROFILE;
  delete process.env.PROJEX_HOME;
  delete process.env.PROJEX_CATALOG_SOURCE;
  delete process.env.PROJEX_DEV_ROOT;
}

describe('runRegistryRefresh', () => {
  beforeEach(() => setupTempHome());
  afterEach(() => cleanupEnv());

  it('errors when no source is configured', () => {
    expect(() => runRegistryRefresh({})).toThrow(/No catalog source/);
  });

  it('copies a catalog from --source into ~/.projex/cache/', () => {
    const dir = mkdtempSync(join(tmpdir(), 'projex-source-'));
    const src = join(dir, 'registry.catalog.json');
    writeFileSync(src, '{"catalog_version":"1.0"}');
    const r = runRegistryRefresh({ source: src });
    expect(existsSync(r.catalogTarget)).toBe(true);
    expect(readFileSync(r.catalogTarget, 'utf-8')).toContain('catalog_version');
    expect(r.embeddingsCopied).toBe(false);
  });

  it('also copies embeddings sidecar when present beside the source', () => {
    const dir = mkdtempSync(join(tmpdir(), 'projex-source-emb-'));
    const src = join(dir, 'registry.catalog.json');
    const bin = join(dir, 'registry.embeddings.bin');
    const meta = join(dir, 'registry.embeddings.meta.json');
    writeFileSync(src, '{}');
    writeFileSync(bin, '\x00\x01\x02');
    writeFileSync(meta, '{}');
    const r = runRegistryRefresh({ source: src });
    expect(r.embeddingsCopied).toBe(true);
  });

  it('honors PROJEX_CATALOG_SOURCE env when --source not given', () => {
    const dir = mkdtempSync(join(tmpdir(), 'projex-env-source-'));
    const src = join(dir, 'registry.catalog.json');
    writeFileSync(src, '{}');
    process.env.PROJEX_CATALOG_SOURCE = src;
    const r = runRegistryRefresh({});
    expect(r.source).toBe(src);
  });

  it('honors PROJEX_DEV_ROOT as the dev-mode fallback', () => {
    const dir = mkdtempSync(join(tmpdir(), 'projex-dev-root-'));
    const devCatalog = join(dir, 'packages', 'sdk-registry', 'dist', 'registry.catalog.json');
    mkdirSync(join(dir, 'packages', 'sdk-registry', 'dist'), { recursive: true });
    writeFileSync(devCatalog, '{}');
    process.env.PROJEX_DEV_ROOT = dir;
    const r = runRegistryRefresh({});
    expect(r.source).toBe(devCatalog);
  });
});
