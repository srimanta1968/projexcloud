/**
 * Path-resolution tests for the catalog loader. Doesn't actually boot
 * the registry — that exercises the embedder pipeline which is covered
 * by the sdk-registry integration suite.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCatalogPaths } from '../src/catalogLoader';

const SAVED_ENV = { ...process.env };

describe('resolveCatalogPaths', () => {
  beforeEach(() => {
    delete process.env.PROJEX_CATALOG_PATH;
  });
  afterEach(() => {
    process.env.PROJEX_CATALOG_PATH = SAVED_ENV.PROJEX_CATALOG_PATH;
  });

  it('honors PROJEX_CATALOG_PATH env when set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-local-test-'));
    const file = join(dir, 'my-catalog.json');
    writeFileSync(file, '{}');
    process.env.PROJEX_CATALOG_PATH = file;

    const r = resolveCatalogPaths();
    expect(r.source).toBe('env');
    expect(r.catalogPath).toBe(file);
    expect(r.embeddingPaths).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it('finds embeddings sidecar beside the catalog', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-local-test-'));
    const cat = join(dir, 'registry.catalog.json');
    const bin = join(dir, 'registry.embeddings.bin');
    const meta = join(dir, 'registry.embeddings.meta.json');
    writeFileSync(cat, '{}');
    writeFileSync(bin, '');
    writeFileSync(meta, '{}');
    process.env.PROJEX_CATALOG_PATH = cat;

    const r = resolveCatalogPaths();
    expect(r.embeddingPaths?.bin).toBe(bin);
    expect(r.embeddingPaths?.meta).toBe(meta);
    rmSync(dir, { recursive: true, force: true });
  });

  it('falls back to dev-fallback when env + user-cache are absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-local-test-'));
    const devCatalog = join(dir, 'packages', 'sdk-registry', 'dist', 'registry.catalog.json');
    mkdirSync(join(dir, 'packages', 'sdk-registry', 'dist'), { recursive: true });
    writeFileSync(devCatalog, '{}');

    // user-cache is at ~/.projex/cache; setting HOME to dir isolates it.
    const savedHome = process.env.HOME;
    const savedUserProfile = process.env.USERPROFILE;
    process.env.HOME = join(dir, 'no-such-home');
    process.env.USERPROFILE = join(dir, 'no-such-home');

    try {
      const r = resolveCatalogPaths(dir);
      expect(r.source).toBe('dev-fallback');
      expect(r.catalogPath).toBe(devCatalog);
    } finally {
      process.env.HOME = savedHome;
      process.env.USERPROFILE = savedUserProfile;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws a helpful error when nothing is found', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-local-test-'));
    const savedHome = process.env.HOME;
    const savedUserProfile = process.env.USERPROFILE;
    process.env.HOME = join(dir, 'no-such-home');
    process.env.USERPROFILE = join(dir, 'no-such-home');

    try {
      expect(() => resolveCatalogPaths(dir)).toThrow(/No registry catalog found/);
    } finally {
      process.env.HOME = savedHome;
      process.env.USERPROFILE = savedUserProfile;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
