import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { knownConfigPaths, writeMcpConfigs, PROJEX_REGISTRY_KEY } from '../src/configWriters';

const SAVED_ENV = { ...process.env };

function makeTempHome() {
  const root = mkdtempSync(join(tmpdir(), 'projex-cli-test-'));
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  return root;
}

let TEMP_HOME = '';

describe('knownConfigPaths', () => {
  beforeEach(() => { TEMP_HOME = makeTempHome(); });
  afterEach(() => {
    process.env.HOME = SAVED_ENV.HOME;
    process.env.USERPROFILE = SAVED_ENV.USERPROFILE;
  });

  it('returns 4 entries (claude/cursor/windsurf/cline)', () => {
    const paths = knownConfigPaths(TEMP_HOME);
    expect(paths.map((p) => p.tool).sort()).toEqual(['claude-code', 'cline', 'cursor', 'windsurf']);
  });

  it('marks tools undetected when the config dir does not exist', () => {
    const paths = knownConfigPaths(TEMP_HOME);
    expect(paths.every((p) => p.detected === false)).toBe(true);
  });

  it('marks tools detected when the parent dir exists', () => {
    // simulate ~/.claude exists
    const claudeDir = knownConfigPaths(TEMP_HOME).find((p) => p.tool === 'claude-code')!.configPath;
    mkdirSync(dirname(claudeDir), { recursive: true });
    const paths = knownConfigPaths(TEMP_HOME);
    expect(paths.find((p) => p.tool === 'claude-code')?.detected).toBe(true);
  });
});

describe('writeMcpConfigs', () => {
  beforeEach(() => { TEMP_HOME = makeTempHome(); });
  afterEach(() => {
    process.env.HOME = SAVED_ENV.HOME;
    process.env.USERPROFILE = SAVED_ENV.USERPROFILE;
  });

  it('skips undetected tools by default', () => {
    const results = writeMcpConfigs({
      server: { command: 'npx', args: ['-y', '@projexlight/registry-mcp-local'] },
      homeDir: TEMP_HOME,
    });
    expect(results.every((r) => r.action === 'skipped-undetected')).toBe(true);
  });

  it('writes to all tools when force=true (creates config dir if missing)', () => {
    const results = writeMcpConfigs({
      server: { command: 'npx', args: ['-y', '@projexlight/registry-mcp-local'] },
      force: true,
      homeDir: TEMP_HOME,
    });
    expect(results.every((r) => r.action === 'created')).toBe(true);
    for (const r of results) expect(existsSync(r.configPath)).toBe(true);
  });

  it('preserves existing mcpServers entries when merging', () => {
    const claudePath = knownConfigPaths(TEMP_HOME).find((p) => p.tool === 'claude-code')!.configPath;
    mkdirSync(dirname(claudePath), { recursive: true });
    writeFileSync(
      claudePath,
      JSON.stringify({ mcpServers: { 'some-other-server': { command: 'echo' } } }, null, 2),
    );
    writeMcpConfigs({
      server: { command: 'npx', args: ['-y', '@projexlight/registry-mcp-local'] },
      homeDir: TEMP_HOME,
    });
    const merged = JSON.parse(readFileSync(claudePath, 'utf-8'));
    expect(merged.mcpServers['some-other-server']).toEqual({ command: 'echo' });
    expect(merged.mcpServers[PROJEX_REGISTRY_KEY].command).toBe('npx');
  });

  it('reports "unchanged" when the projex-registry entry already matches', () => {
    const claudePath = knownConfigPaths(TEMP_HOME).find((p) => p.tool === 'claude-code')!.configPath;
    mkdirSync(dirname(claudePath), { recursive: true });
    const server = { command: 'npx', args: ['-y', '@projexlight/registry-mcp-local'] };
    writeFileSync(claudePath, JSON.stringify({ mcpServers: { [PROJEX_REGISTRY_KEY]: server } }, null, 2));
    const results = writeMcpConfigs({ server, homeDir: TEMP_HOME });
    const claudeResult = results.find((r) => r.tool === 'claude-code')!;
    expect(claudeResult.action).toBe('unchanged');
  });

  it('handles corrupt existing config by treating as create', () => {
    const claudePath = knownConfigPaths(TEMP_HOME).find((p) => p.tool === 'claude-code')!.configPath;
    mkdirSync(dirname(claudePath), { recursive: true });
    writeFileSync(claudePath, 'not-json-at-all');
    const results = writeMcpConfigs({
      server: { command: 'npx', args: ['-y', '@projexlight/registry-mcp-local'] },
      homeDir: TEMP_HOME,
    });
    const claudeResult = results.find((r) => r.tool === 'claude-code')!;
    expect(claudeResult.action).toBe('created');
    const reparsed = JSON.parse(readFileSync(claudePath, 'utf-8'));
    expect(reparsed.mcpServers[PROJEX_REGISTRY_KEY]).toBeDefined();
  });
});
