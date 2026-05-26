#!/usr/bin/env node
/**
 * AC-13 — MCP cohabitation test (FR-COHAB-2).
 *
 * Validates no tool-name collision between Projexlight MCPs (`projexlight_*`)
 * and the new ProjexCloud registry MCP (`projex_registry_*`). Boots the
 * local registry MCP via stdio, calls ListTools, and asserts:
 *   1. Every tool name is `projex_registry_*` prefixed.
 *   2. No tool name starts with `projexlight_`.
 *   3. The expected core tools are present (search/get_manifest/scaffold/deploy).
 *
 * For the integration test in CI, we don't actually boot projex_dev_mcp
 * (Docker dep); we assert the *prefix policy* which is the contract that
 * makes cohabitation safe.
 */

import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..');
const LOCAL_MCP = join(ROOT, 'packages', 'registry-mcp-local', 'dist', 'cli.js');

const EXPECTED_TOOLS = [
  'projex_registry_search_sdks',
  'projex_registry_get_manifest',
  'projex_registry_get_example',
  'projex_registry_list_compatible_sdks',
  'projex_registry_list_blueprints',
  'projex_registry_get_blueprint',
  'projex_registry_scaffold',
  'projex_registry_deploy',
  'projex_registry_list_my_sdks',
  'projex_registry_list_my_blueprints',
  'projex_registry_request_pack_upgrade',
];

async function listTools() {
  return new Promise((resolveP, rejectP) => {
    const proc = spawn('node', [LOCAL_MCP], {
      env: { ...process.env, PROJEX_DEV_ROOT: ROOT, PROJEX_SKIP_REFRESH: '1' },
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    let buf = '';
    proc.stdout.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 1 && msg.result?.tools) {
            proc.kill('SIGTERM');
            resolveP(msg.result.tools);
          }
        } catch {
          // skip non-JSON
        }
      }
    });

    proc.on('error', rejectP);
    proc.on('exit', (code) => {
      if (code !== 0 && code !== null) rejectP(new Error(`MCP exited ${code}`));
    });

    // Send MCP initialize then list_tools (minimal JSON-RPC wire dance).
    const initialize = {
      jsonrpc: '2.0', id: 0, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'cohab-test', version: '0.1' } },
    };
    const listToolsReq = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
    proc.stdin.write(JSON.stringify(initialize) + '\n');
    setTimeout(() => proc.stdin.write(JSON.stringify(listToolsReq) + '\n'), 200);
    setTimeout(() => { proc.kill('SIGTERM'); rejectP(new Error('timeout waiting for tools/list')); }, 15000);
  });
}

try {
  const tools = await listTools();
  const names = tools.map((t) => t.name);

  const errors = [];
  for (const n of names) {
    if (!n.startsWith('projex_registry_')) {
      errors.push(`tool "${n}" lacks the projex_registry_ prefix (FR-COHAB-2 violation)`);
    }
    if (n.startsWith('projexlight_')) {
      errors.push(`tool "${n}" uses the projexlight_ prefix reserved for the dev MCP`);
    }
  }
  for (const expected of EXPECTED_TOOLS) {
    if (!names.includes(expected)) {
      errors.push(`expected tool "${expected}" missing from local MCP`);
    }
  }

  const report = {
    tool_count: names.length,
    tools: names,
    errors,
  };
  console.log(JSON.stringify(report, null, 2));

  if (errors.length > 0) {
    console.error(`\nAC-13 FAIL: ${errors.length} violation(s)`);
    process.exit(1);
  }
  console.log('\nAC-13 PASS: cohabitation safe');
} catch (e) {
  console.error(`AC-13 ERROR: ${e.message}`);
  process.exit(2);
}
