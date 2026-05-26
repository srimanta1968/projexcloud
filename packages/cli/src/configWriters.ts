/**
 * P9 / E5.F2 — MCP config writers for AI coding tools.
 *
 * `projex init` detects which AI tools the developer has installed and
 * writes the matching mcp.json so the registry MCP is immediately
 * available without any manual config copy-paste.
 *
 * Detection strategy: filesystem checks for each tool's known config
 * directory + binary location. Generous; misses are silent (we don't
 * want to break init for a missing tool).
 *
 * Merge semantics: we NEVER overwrite an existing mcpServers map. We
 * read, splice in our `projex-registry` entry, and write the merged
 * result. Other servers stay intact.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';

export type AiTool = 'claude-code' | 'cursor' | 'windsurf' | 'cline';

export interface ToolDetection {
  tool: AiTool;
  configPath: string;
  /** True when the tool's config dir already exists (good evidence the tool is installed). */
  detected: boolean;
}

export interface McpServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

const REGISTRY_SERVER_KEY = 'projex-registry';

/**
 * Where each AI tool reads its mcp.json. Paths normalized for the host OS.
 *
 * homeDir defaults to os.homedir(); tests override it. (os.homedir() doesn't
 * always honor HOME/USERPROFILE env mutations on every platform — explicit
 * param keeps tests deterministic.)
 */
export function knownConfigPaths(homeDir?: string): ToolDetection[] {
  const home = homeDir ?? homedir();
  const plat = platform();

  const claudeConfig = join(home, '.claude', 'mcp.json');
  const cursorConfig = join(home, '.cursor', 'mcp.json');
  const windsurfConfig =
    plat === 'win32'
      ? join(home, 'AppData', 'Roaming', 'Codeium', 'windsurf', 'mcp_config.json')
      : join(home, '.codeium', 'windsurf', 'mcp_config.json');
  const clineConfig =
    plat === 'darwin'
      ? join(home, 'Library', 'Application Support', 'Cline', 'cline_mcp_settings.json')
      : plat === 'win32'
        ? join(home, 'AppData', 'Roaming', 'Cline', 'cline_mcp_settings.json')
        : join(home, '.config', 'Cline', 'cline_mcp_settings.json');

  const dirExists = (p: string) => {
    try { return statSync(dirname(p)).isDirectory(); } catch { return false; }
  };

  return [
    { tool: 'claude-code', configPath: claudeConfig,   detected: dirExists(claudeConfig) },
    { tool: 'cursor',      configPath: cursorConfig,   detected: dirExists(cursorConfig) },
    { tool: 'windsurf',    configPath: windsurfConfig, detected: dirExists(windsurfConfig) },
    { tool: 'cline',       configPath: clineConfig,    detected: dirExists(clineConfig) },
  ];
}

export interface WriteOptions {
  /** McpServerEntry to splice in under "projex-registry" key. */
  server: McpServerEntry;
  /** When true, write to every config path even if undetected (used by projex init --all-tools). */
  force?: boolean;
  /** Override homedir() (testing). */
  homeDir?: string;
}

export interface WriteResult {
  tool: AiTool;
  configPath: string;
  action: 'created' | 'merged' | 'skipped-undetected' | 'unchanged';
}

/**
 * Write the projex-registry MCP entry into every detected (or all, with
 * --force) AI tool's config file. Preserves any existing mcpServers
 * entries; only the projex-registry key is touched.
 */
export function writeMcpConfigs(opts: WriteOptions): WriteResult[] {
  const targets = knownConfigPaths(opts.homeDir);
  const results: WriteResult[] = [];

  for (const t of targets) {
    if (!t.detected && !opts.force) {
      results.push({ tool: t.tool, configPath: t.configPath, action: 'skipped-undetected' });
      continue;
    }

    let existing: { mcpServers?: Record<string, McpServerEntry> } = {};
    let created = !existsSync(t.configPath);
    if (!created) {
      try {
        existing = JSON.parse(readFileSync(t.configPath, 'utf-8'));
      } catch {
        // Corrupt or non-JSON; treat as create.
        existing = {};
        created = true;
      }
    }

    const mcpServers = { ...(existing.mcpServers ?? {}) };
    const before = JSON.stringify(mcpServers[REGISTRY_SERVER_KEY] ?? null);
    mcpServers[REGISTRY_SERVER_KEY] = opts.server;
    const after = JSON.stringify(mcpServers[REGISTRY_SERVER_KEY]);

    if (!created && before === after) {
      results.push({ tool: t.tool, configPath: t.configPath, action: 'unchanged' });
      continue;
    }

    const merged = { ...existing, mcpServers };
    mkdirSync(dirname(t.configPath), { recursive: true });
    writeFileSync(t.configPath, JSON.stringify(merged, null, 2) + '\n');
    results.push({
      tool: t.tool,
      configPath: t.configPath,
      action: created ? 'created' : 'merged',
    });
  }

  return results;
}

export const PROJEX_REGISTRY_KEY = REGISTRY_SERVER_KEY;
