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
import { runInstall } from './commands/install';
import { runRegistryRefresh, runRegistryList } from './commands/registry';
import { loginStub, deployStub, type StubOutput } from './commands/stubs';
import { runBlueprintList, runBlueprintApply } from './commands/blueprint';

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
  registry list [--tag <tag>] [--search <q>]
                              Print SDK list from the cached catalog.
  install <sdk_name> [--force]
                              Add a ProjexCloud SDK to the current app:
                              edits package.json, drops a starter integration
                              at src/integrations/, updates src/index.ts.
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
  // Pretty print common shapes; check most-specific first so the
  // dispatch routes correctly (install result also has targetDir, so it
  // must be checked before the init shape).
  if (typeof result === 'object' && result !== null && 'integrationPath' in result) {
    const r = result as { sdk_name: string; depVersion: string; packageJsonAction: string; integrationAction: string; integrationPath: string; indexUpdated: boolean; warnings: string[] };
    process.stdout.write(`Installed ${r.sdk_name} @ ${r.depVersion}\n`);
    process.stdout.write(`  package.json:  ${r.packageJsonAction}\n`);
    process.stdout.write(`  integration:   ${r.integrationAction} (${r.integrationPath})\n`);
    process.stdout.write(`  src/index.ts:  ${r.indexUpdated ? 'updated' : 'unchanged'}\n`);
    if (r.warnings.length > 0) {
      process.stdout.write(`  Warnings:\n`);
      for (const w of r.warnings) process.stdout.write(`    - ${w}\n`);
    }
    return;
  }
  if (typeof result === 'object' && result !== null && 'appName' in result) {
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
  if (typeof result === 'object' && result !== null && 'entries' in result && 'filtered' in result) {
    const r = result as { catalogPath: string; total: number; filtered: number; entries: Array<{ name: string; version: string; summary: string; pool_placement: string; scenarios: number; endpoints: number }> };
    process.stdout.write(`Catalog: ${r.catalogPath}\n`);
    process.stdout.write(`  ${r.filtered}/${r.total} SDK(s)\n\n`);
    const maxName = Math.max(20, ...r.entries.map((e) => e.name.length));
    for (const e of r.entries) {
      const truncSummary = e.summary.length > 80 ? e.summary.slice(0, 77) + '...' : e.summary;
      process.stdout.write(`  ${e.name.padEnd(maxName)}  v${e.version.padEnd(8)}  [${e.pool_placement.padEnd(14)}]  ${e.endpoints}ep ${e.scenarios}sc\n`);
      process.stdout.write(`    ${truncSummary}\n`);
    }
    return;
  }
  if (typeof result === 'object' && result !== null && 'blueprints' in result && 'filtered' in result) {
    const r = result as { root: string; total: number; filtered: number; blueprints: Array<{ id: string; title: string; pack: string; sdk_count: number; estimated_minutes: number; summary: string }> };
    process.stdout.write(`Blueprints root: ${r.root}\n`);
    process.stdout.write(`  ${r.filtered}/${r.total} blueprint(s)\n\n`);
    for (const b of r.blueprints) {
      const sum = b.summary.length > 80 ? b.summary.slice(0, 77) + '...' : b.summary;
      process.stdout.write(`  ${b.id.padEnd(20)}  [${b.pack.padEnd(14)}]  ${b.sdk_count}sdk  ~${b.estimated_minutes}min   ${b.title}\n    ${sum}\n`);
    }
    return;
  }
  if (typeof result === 'object' && result !== null && 'blueprint_id' in result && 'files' in result) {
    const r = result as { blueprint_id: string; blueprint_title: string; targetDir: string; files: Array<{ path: string; action: string }>; sdks_to_install: string[]; warnings: string[] };
    process.stdout.write(`Applied ${r.blueprint_id} (${r.blueprint_title}) to ${r.targetDir}\n`);
    process.stdout.write(`  Files:\n`);
    for (const f of r.files) process.stdout.write(`    ${f.action.padEnd(20)} ${f.path}\n`);
    process.stdout.write(`\n  Next: install the SDKs this blueprint composes:\n`);
    for (const s of r.sdks_to_install) process.stdout.write(`    projex install ${s}\n`);
    if (r.warnings.length > 0) {
      process.stdout.write(`\n  Warnings:\n`);
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
        if (sub === 'refresh') {
          const result = runRegistryRefresh({
            source: typeof args.flags.source === 'string' ? args.flags.source : undefined,
          });
          emit(result, jsonMode);
          return;
        }
        if (sub === 'list') {
          const result = runRegistryList({
            tag: typeof args.flags.tag === 'string' ? args.flags.tag : undefined,
            search: typeof args.flags.search === 'string' ? args.flags.search : undefined,
          });
          emit(result, jsonMode);
          return;
        }
        process.stderr.write(`unknown subcommand: registry ${sub}. Try: projex registry refresh | list\n`);
        process.exit(2);
      }

      case 'install': {
        const sdk_name = args.positional[0];
        if (!sdk_name) {
          process.stderr.write(`projex install: missing <sdk_name>. Example: projex install @projexlight/sdk-vault\n`);
          process.exit(2);
        }
        const result = runInstall({
          sdk_name,
          force: args.flags.force === true,
          noPackageEdit: args.flags['no-package-edit'] === true,
        });
        emit(result, jsonMode);
        return;
      }

      case 'blueprint': {
        const action = args.positional[0] || 'list';
        if (action === 'list') {
          const result = runBlueprintList({
            tag: typeof args.flags.tag === 'string' ? args.flags.tag : undefined,
            root: typeof args.flags.root === 'string' ? args.flags.root : undefined,
          });
          emit(result, jsonMode);
          return;
        }
        if (action === 'apply') {
          const id = args.positional[1];
          if (!id) {
            process.stderr.write(`projex blueprint apply: missing <id>. Try 'projex blueprint list' to see available ids.\n`);
            process.exit(2);
          }
          const result = runBlueprintApply({
            blueprint_id: id,
            answersJson: typeof args.flags.answers === 'string' ? args.flags.answers : undefined,
            force: args.flags.force === true,
            root: typeof args.flags.root === 'string' ? args.flags.root : undefined,
          });
          emit(result, jsonMode);
          return;
        }
        process.stderr.write(`unknown subcommand: blueprint ${action}. Try: projex blueprint list | apply <id>\n`);
        process.exit(2);
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
