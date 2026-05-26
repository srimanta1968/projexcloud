import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../src/commands/init';
import { buildCatalog, scanWorkspace, serializeCatalog } from '@projexlight/sdk-registry';

const SAVED_ENV = { ...process.env };

function setupTempHome() {
  const root = mkdtempSync(join(tmpdir(), 'projex-cli-test-'));
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

describe('runInit — argument validation', () => {
  beforeEach(() => setupTempHome());
  afterEach(() => cleanupEnv());

  it('rejects an invalid app_name', async () => {
    await expect(runInit({ app_name: 'BadName!' })).rejects.toThrow(/Invalid app_name/);
  });

  it('rejects an empty app_name', async () => {
    await expect(runInit({ app_name: '' })).rejects.toThrow(/Invalid app_name/);
  });

  it('rejects when target dir exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'projex-init-existing-'));
    await expect(runInit({ app_name: 'foo', targetDir: dir })).rejects.toThrow(/already exists/);
  });
});

describe('runInit — blank-skeleton fallback', () => {
  beforeEach(() => setupTempHome());
  afterEach(() => cleanupEnv());

  it('emits a blank skeleton when no catalog + no blueprint', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'projex-init-')), 'my-app');
    const r = await runInit({ app_name: 'my-app', targetDir: dir, noMcp: true });
    expect(r.files).toContain('package.json');
    expect(r.files).toContain('tsconfig.json');
    expect(r.files).toContain('src/index.ts');
    expect(r.files).toContain('README.md');
    expect(r.files).toContain('CLAUDE.md');
    expect(r.files).toContain('.gitignore');
    expect(r.sdksResolved).toEqual([]);
    expect(r.warnings.some((w) => w.includes('No registry catalog found'))).toBe(true);
  });

  it('writes a package.json with the correct app_name', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'projex-init-')), 'pkg-name-test');
    const r = await runInit({ app_name: 'pkg-name-test', targetDir: dir, noMcp: true });
    const pkg = JSON.parse(readFileSync(join(r.targetDir, 'package.json'), 'utf-8'));
    expect(pkg.name).toBe('pkg-name-test');
  });

  it('CLAUDE.md instructs AI tools to use projex_registry_* tools first', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'projex-init-')), 'claude-md-test');
    const r = await runInit({ app_name: 'claude-md-test', targetDir: dir, noMcp: true });
    const md = readFileSync(join(r.targetDir, 'CLAUDE.md'), 'utf-8');
    expect(md).toMatch(/projex_registry_/);
    expect(md).toMatch(/Search before creating/);
  });
});

describe('runInit — with catalog (uses getScaffold)', () => {
  beforeEach(() => setupTempHome());
  afterEach(() => cleanupEnv());

  it('uses the registry catalog to scaffold + records blueprint warning', async () => {
    // Build a tiny catalog at a temp location.
    const dir = mkdtempSync(join(tmpdir(), 'projex-init-cat-'));
    const catalog = buildCatalog({ scan: [], built_at: '2026-05-25T00:00:00.000Z' });
    const catalogPath = join(dir, 'registry.catalog.json');
    writeFileSync(catalogPath, serializeCatalog(catalog));

    const r = await runInit({
      app_name: 'cat-app',
      targetDir: join(dir, 'app'),
      noMcp: true,
      catalogPath,
      blueprint: 'revops-crm',
    });
    expect(r.blueprint).toBe('revops-crm');
    expect(r.warnings.some((w) => w.includes('blueprint library'))).toBe(true);
    // Empty SDK list → still produces a starter skeleton via getScaffold
    // (since tree.files is non-empty for app-level files).
    expect(r.files.length).toBeGreaterThan(0);
  });
});

describe('runInit — MCP config writes', () => {
  beforeEach(() => setupTempHome());
  afterEach(() => cleanupEnv());

  it('skips MCP writes when --no-mcp', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'projex-init-')), 'no-mcp-app');
    const r = await runInit({ app_name: 'no-mcp-app', targetDir: dir, noMcp: true });
    expect(r.mcpWrites).toEqual([]);
  });

  it('--all-tools forces a write to every config path', async () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'projex-home-'));
    const dir = join(mkdtempSync(join(tmpdir(), 'projex-init-')), 'all-tools-app');
    const r = await runInit({ app_name: 'all-tools-app', targetDir: dir, allTools: true, homeDir: tempHome });
    expect(r.mcpWrites.length).toBe(4);
    expect(r.mcpWrites.every((w) => w.action === 'created' || w.action === 'merged')).toBe(true);
  });

  it('PROJEX_DEV_ROOT switches the mcp.json entry to point at the in-repo build', async () => {
    process.env.PROJEX_DEV_ROOT = '/dev/root';
    const tempHome = mkdtempSync(join(tmpdir(), 'projex-home-'));
    const dir = join(mkdtempSync(join(tmpdir(), 'projex-init-')), 'dev-root-app');
    const r = await runInit({ app_name: 'dev-root-app', targetDir: dir, allTools: true, homeDir: tempHome });
    const written = readFileSync(r.mcpWrites[0].configPath, 'utf-8');
    expect(written).toContain('PROJEX_DEV_ROOT');
    // path may use forward or back slashes depending on platform; just verify the segment
    expect(written.includes('packages') && written.includes('registry-mcp-local')).toBe(true);
  });
});
