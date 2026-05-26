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

/** Stdio MCP server — child process spawned by the AI client over stdio. */
export interface McpStdioEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** SSE MCP server — AI client connects to a hosted HTTP endpoint. */
export interface McpSseEntry {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
}

export type McpServerEntry = McpStdioEntry | McpSseEntry;

/**
 * Build the SSE entry for the hosted registry-mcp service. Bearer token
 * is embedded as an Authorization header — the AI client passes it on
 * every request the server makes for tenant scoping + metering.
 */
export function hostedMcpServerEntry(url: string, apiToken?: string): McpSseEntry {
  const entry: McpSseEntry = { type: 'sse', url };
  if (apiToken) entry.headers = { Authorization: `Bearer ${apiToken}` };
  return entry;
}

const REGISTRY_SERVER_KEY = 'projex-registry';
const PROJEXLIGHT_DEV_KEY = 'projexlight-dev';
const PROJEXLIGHT_TEST_KEY = 'projexlight-test';

/**
 * FR-COHAB-1 — detect Projexlight on the dev's machine. We look for the
 * canonical config at ~/.projexlight/config.json which both projex_dev_mcp
 * and projex_test_mcp write on first install. When detected, projex init
 * splices both into the AI tool's mcp.json so an AI client sees ONE tool
 * list with all four servers (projex-registry + projexlight-dev +
 * projexlight-test + any others), routed by prefix per FR-COHAB-2.
 */
export interface ProjexlightDetection {
  detected: boolean;
  config_path: string;
  dev_mcp_command?: string;
  test_mcp_command?: string;
}

export function detectProjexlight(homeDir?: string): ProjexlightDetection {
  const home = homeDir ?? homedir();
  const config_path = join(home, '.projexlight', 'config.json');
  if (!existsSync(config_path)) {
    return { detected: false, config_path };
  }
  try {
    const cfg = JSON.parse(readFileSync(config_path, 'utf-8')) as {
      mcps?: { dev?: { command?: string }; test?: { command?: string } };
    };
    return {
      detected: true,
      config_path,
      dev_mcp_command: cfg.mcps?.dev?.command ?? 'projex_dev_mcp',
      test_mcp_command: cfg.mcps?.test?.command ?? 'projex_test_mcp',
    };
  } catch {
    // Config exists but is malformed; assume defaults.
    return {
      detected: true,
      config_path,
      dev_mcp_command: 'projex_dev_mcp',
      test_mcp_command: 'projex_test_mcp',
    };
  }
}

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
  const projexlight = detectProjexlight(opts.homeDir);
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
    const before = JSON.stringify({
      r: mcpServers[REGISTRY_SERVER_KEY] ?? null,
      d: mcpServers[PROJEXLIGHT_DEV_KEY] ?? null,
      tst: mcpServers[PROJEXLIGHT_TEST_KEY] ?? null,
    });

    mcpServers[REGISTRY_SERVER_KEY] = opts.server;

    // FR-COHAB-1 — when Projexlight is detected on this machine, splice
    // its MCPs into the same config. Existing entries take precedence so
    // we don't clobber a user's customizations.
    if (projexlight.detected) {
      if (!mcpServers[PROJEXLIGHT_DEV_KEY] && projexlight.dev_mcp_command) {
        mcpServers[PROJEXLIGHT_DEV_KEY] = { command: projexlight.dev_mcp_command } satisfies McpStdioEntry;
      }
      if (!mcpServers[PROJEXLIGHT_TEST_KEY] && projexlight.test_mcp_command) {
        mcpServers[PROJEXLIGHT_TEST_KEY] = { command: projexlight.test_mcp_command } satisfies McpStdioEntry;
      }
    }

    const after = JSON.stringify({
      r: mcpServers[REGISTRY_SERVER_KEY] ?? null,
      d: mcpServers[PROJEXLIGHT_DEV_KEY] ?? null,
      tst: mcpServers[PROJEXLIGHT_TEST_KEY] ?? null,
    });

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
