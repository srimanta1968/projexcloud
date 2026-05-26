#!/usr/bin/env node
/**
 * P9 / E5 — `projex` CLI entry point.
 *
 * Subcommand routing. Each command lives in its own module so it can be
 * unit-tested independently of argv parsing.
 *
 * Per Q-6: npx-only distribution for v1; native binaries deferred to P10.
 * Most users will invoke this via:
 *   npx -y @projexlight/cli init my-app
 *
 * Inside this monorepo, use `pnpm --filter @projexlight/cli build` then
 * `node packages/cli/dist/cli.js ...`.
 */

import { runInit } from './commands/init';
import { runRegistryRefresh } from './commands/registry';
import { loginStub, deployStub, installStub, blueprintStub, type StubOutput } from './commands/stubs';

interface ParsedArgs {
  subcommand: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [, , subcommand = 'help', ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      const next = rest[i + 1];
      if (next && !next.startsWith('--')) {
        flags[name] = next;
        i++;
      } else {
        flags[name] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { subcommand, positional, flags };
}

function printHelp(): void {
  process.stdout.write(`projex — ProjexCloud CLI (P9 / E5)

Usage:
  projex <subcommand> [args] [flags]

Subcommands:
  init <app_name> [--blueprint <id>] [--no-mcp] [--all-tools] [--json]
                              Create a new app directory + auto-write MCP
                              config for detected AI tools.
  registry refresh [--source <path>]
                              Pull the SDK catalog into ~/.projex/cache/
                              (from PROJEX_CATALOG_SOURCE / PROJEX_DEV_ROOT
                              by default).
  install <sdk_name>          [Phase 1.5 stub] Add an SDK to the local app.
  blueprint list|apply [id]   [E4 stub] Vertical blueprint library.
  login                       [E3 Phase 2 stub] OAuth device flow.
  deploy [--env <env>]        [E3 Phase 2 stub] Ship to tenant pool.
  version                     Print CLI version.
  help                        This help.

Common flags:
  --json                      Emit results as JSON (for scripting).

Env vars:
  PROJEX_HOME                 Override ~/.projex (default: $HOME/.projex).
  PROJEX_DEV_ROOT             Monorepo root for dev-mode catalog + MCP.
  PROJEX_CATALOG_SOURCE       Override catalog source for registry refresh.

Exit codes:
  0  Success.
  1  Command failed (validation, IO, etc.).
  2  Bad arguments.
`);
}

function emit(result: unknown, jsonMode: boolean): void {
  if (jsonMode) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  // Pretty print common shapes; fall back to JSON for unknown.
  if (typeof result === 'object' && result !== null && 'targetDir' in result) {
    const r = result as { appName: string; targetDir: string; files: string[]; mcpWrites: Array<{ tool: string; action: string; configPath: string }>; warnings: string[] };
    process.stdout.write(`Created ${r.appName} at ${r.targetDir}\n`);
    process.stdout.write(`  Files: ${r.files.length}\n`);
    if (r.mcpWrites.length > 0) {
      process.stdout.write(`  MCP configs:\n`);
      for (const w of r.mcpWrites) {
        process.stdout.write(`    ${w.tool.padEnd(12)} ${w.action.padEnd(20)} ${w.configPath}\n`);
      }
    }
    if (r.warnings.length > 0) {
      process.stdout.write(`  Warnings:\n`);
      for (const w of r.warnings) process.stdout.write(`    - ${w}\n`);
    }
    return;
  }
  if (typeof result === 'object' && result !== null && 'command' in result) {
    const s = result as StubOutput;
    process.stdout.write(`${s.command} — ${s.phase}\n  ${s.description}\n  → ${s.next_step}\n`);
    return;
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const jsonMode = args.flags.json === true;

  try {
    switch (args.subcommand) {
      case 'init': {
        const app_name = args.positional[0];
        const result = await runInit({
          app_name,
          blueprint: typeof args.flags.blueprint === 'string' ? args.flags.blueprint : undefined,
          noMcp: args.flags['no-mcp'] === true,
          allTools: args.flags['all-tools'] === true,
        });
        emit(result, jsonMode);
        return;
      }

      case 'registry': {
        const sub = args.positional[0];
        if (sub !== 'refresh') {
          process.stderr.write(`unknown subcommand: registry ${sub}. Try: projex registry refresh\n`);
          process.exit(2);
        }
        const result = runRegistryRefresh({
          source: typeof args.flags.source === 'string' ? args.flags.source : undefined,
        });
        emit(result, jsonMode);
        return;
      }

      case 'install': {
        const sdk_name = args.positional[0] || '<sdk-name>';
        emit(installStub(sdk_name), jsonMode);
        return;
      }

      case 'blueprint': {
        const action = args.positional[0] || 'list';
        const id = args.positional[1];
        emit(blueprintStub(action, id), jsonMode);
        return;
      }

      case 'login':
        emit(loginStub(), jsonMode);
        return;

      case 'deploy':
        emit(deployStub(), jsonMode);
        return;

      case 'version':
        emit({ name: '@projexlight/cli', version: '0.1.0' }, jsonMode);
        return;

      case 'help':
      case '--help':
      case '-h':
      case undefined:
        printHelp();
        return;

      default:
        process.stderr.write(`unknown subcommand: ${args.subcommand}\n`);
        printHelp();
        process.exit(2);
    }
  } catch (err) {
    process.stderr.write(`projex: ${(err as Error).message}\n`);
    process.exit(1);
  }
}

main();
