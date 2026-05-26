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
import { runRegistryRefresh, runRegistryList, runRegistryDrain } from './commands/registry';
import { runBlueprintList, runBlueprintApply } from './commands/blueprint';
import { runLogin } from './commands/login';
import { runDeploy } from './commands/deploy';
import { runLogs } from './commands/logs';
import { runTelemetry } from './commands/telemetry';
import { maybeWarnNewerVersion } from './versionCheck';

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
  init <app_name> [--blueprint <id>] [--no-mcp] [--all-tools] [--hosted-url <url>] [--api-token <token>] [--json]
                              Create a new app directory + auto-write MCP
                              config for detected AI tools.
  login [--hosted-url <url>] [--api-key <key>] [--dry-run] [--json]
                              Enroll this machine against a hosted MCP. Stores
                              ~/.projex/auth.json (0o600). Used by deploy/logs/proxy.
  install <sdk_name> [--force]
                              Add a ProjexCloud SDK to the current app:
                              edits package.json, drops a starter integration
                              at src/integrations/, updates src/index.ts.
  blueprint list|apply [id]   Vertical blueprint library.
  deploy [--env trial|staging|prod] [--app-dir <path>] [--no-watch] [--dry-run] [--json]
                              Package the current app + ship to the tenant pool
                              via the hosted MCP. Polls until terminal status;
                              rollback enforced server-side.
  logs <app_name> [--tail] [--limit <n>] [--json]
                              Fetch last N log events or tail live (SSE).
  registry refresh|list|drain [--source <path>] [--tag <tag>] [--search <q>]
                              Catalog cache ops. drain replays queued offline writes.
  telemetry on|off|status     Opt-in local telemetry (anonymous tool counters).
  version                     Print CLI version.
  help                        This help.

Common flags:
  --json                      Emit results as JSON (for scripting).

Env vars:
  PROJEX_HOME                 Override ~/.projex (default: $HOME/.projex).
  PROJEX_DEV_ROOT             Monorepo root for dev-mode catalog + MCP.
  PROJEX_CATALOG_SOURCE       Override catalog source for registry refresh.
  PROJEX_HOSTED_MCP           Hosted MCP base URL (overrides ~/.projex/auth.json).
  PROJEX_API_KEY              Tenant API key (overrides ~/.projex/auth.json).
  PROJEX_SKIP_VERSION_CHECK   Disable the periodic newer-CLI-available check.

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
    const r = result as { blueprint_id: string; blueprint_title: string; targetDir: string; files: Array<{ path: string; action: string }>; sdks_to_install: string[]; warnings: string[]; installs?: Array<{ sdk_name: string; ok: boolean; result?: { packageJsonAction: string; integrationAction: string }; error?: string }> };
    process.stdout.write(`Applied ${r.blueprint_id} (${r.blueprint_title}) to ${r.targetDir}\n`);
    process.stdout.write(`  Files:\n`);
    for (const f of r.files) process.stdout.write(`    ${f.action.padEnd(20)} ${f.path}\n`);
    if (r.installs) {
      process.stdout.write(`\n  SDK installs:\n`);
      for (const inst of r.installs) {
        if (inst.ok && inst.result) {
          process.stdout.write(`    OK  ${inst.sdk_name}  (package=${inst.result.packageJsonAction}, integration=${inst.result.integrationAction})\n`);
        } else {
          process.stdout.write(`    ERR ${inst.sdk_name}  — ${inst.error}\n`);
        }
      }
    } else {
      process.stdout.write(`\n  Next: install the SDKs this blueprint composes (or re-run with --install-sdks):\n`);
      for (const s of r.sdks_to_install) process.stdout.write(`    projex install ${s}\n`);
    }
    if (r.warnings.length > 0) {
      process.stdout.write(`\n  Warnings:\n`);
      for (const w of r.warnings) process.stdout.write(`    - ${w}\n`);
    }
    return;
  }
  if (typeof result === 'object' && result !== null && 'command' in result && (result as { command: string }).command === 'projex login') {
    const r = result as unknown as { hosted_url: string; auth_path: string; status: string; api_key_prefix: string };
    process.stdout.write(`Logged in.\n  hosted: ${r.hosted_url}\n  key:    ${r.api_key_prefix}\n  path:   ${r.auth_path}\n  status: ${r.status}\n`);
    return;
  }
  if (typeof result === 'object' && result !== null && 'command' in result && (result as { command: string }).command === 'projex deploy') {
    const r = result as unknown as { app_name: string; env: string; status: string; deploy_id?: string; url?: string; duration_ms?: number; rollback?: boolean; error?: string; manifest_file_count: number; manifest_total_bytes: number };
    process.stdout.write(`Deploy: ${r.app_name} → ${r.env}\n`);
    process.stdout.write(`  status:        ${r.status}${r.rollback ? ' (rolled back)' : ''}\n`);
    if (r.deploy_id) process.stdout.write(`  deploy_id:     ${r.deploy_id}\n`);
    if (r.url) process.stdout.write(`  url:           ${r.url}\n`);
    process.stdout.write(`  files:         ${r.manifest_file_count} (${r.manifest_total_bytes} bytes)\n`);
    if (r.duration_ms != null) process.stdout.write(`  duration_ms:   ${r.duration_ms}\n`);
    if (r.error) process.stdout.write(`  error:         ${r.error}\n`);
    return;
  }
  if (typeof result === 'object' && result !== null && 'command' in result && (result as { command: string }).command === 'projex logs') {
    const r = result as unknown as { app_name: string; event_count: number; status: string; error?: string };
    process.stdout.write(`Logs: ${r.app_name}  ${r.event_count} event(s)  status=${r.status}${r.error ? '  err=' + r.error : ''}\n`);
    return;
  }
  if (typeof result === 'object' && result !== null && 'action' in result && 'remaining_count' in result) {
    const r = result as unknown as { drained: Array<{ queue_id: string; tool: string; ok: boolean; error?: string }>; remaining_count: number };
    process.stdout.write(`Drained ${r.drained.length} entry(ies); ${r.remaining_count} remaining\n`);
    for (const d of r.drained) {
      process.stdout.write(`  ${d.ok ? 'OK ' : 'ERR'}  ${d.queue_id}  ${d.tool}${d.error ? '  — ' + d.error : ''}\n`);
    }
    return;
  }
  if (typeof result === 'object' && result !== null && 'enabled' in result && 'path' in result) {
    const r = result as unknown as { enabled: boolean; device_id?: string; path: string };
    process.stdout.write(`Telemetry ${r.enabled ? 'ENABLED' : 'DISABLED'}\n  config: ${r.path}\n  device: ${r.device_id ?? '(none)'}\n`);
    return;
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const jsonMode = args.flags.json === true;

  // FR-CLI-8 — non-blocking newer-version warning. Cached 24h; opt-out via env.
  if (process.env.PROJEX_SKIP_VERSION_CHECK !== '1') {
    void maybeWarnNewerVersion();
  }

  try {
    switch (args.subcommand) {
      case 'init': {
        const app_name = args.positional[0];
        const result = await runInit({
          app_name,
          blueprint: typeof args.flags.blueprint === 'string' ? args.flags.blueprint : undefined,
          noMcp: args.flags['no-mcp'] === true,
          allTools: args.flags['all-tools'] === true,
          hostedUrl: typeof args.flags['hosted-url'] === 'string' ? args.flags['hosted-url'] : undefined,
          apiToken: typeof args.flags['api-token'] === 'string' ? args.flags['api-token'] : undefined,
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
        if (sub === 'drain') {
          const result = await runRegistryDrain();
          emit(result, jsonMode);
          return;
        }
        process.stderr.write(`unknown subcommand: registry ${sub}. Try: projex registry refresh | list | drain\n`);
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
            installSdks: args.flags['install-sdks'] === true,
          });
          emit(result, jsonMode);
          return;
        }
        process.stderr.write(`unknown subcommand: blueprint ${action}. Try: projex blueprint list | apply <id>\n`);
        process.exit(2);
      }

      case 'login': {
        const result = await runLogin({
          hostedUrl: typeof args.flags['hosted-url'] === 'string' ? args.flags['hosted-url'] : undefined,
          apiKey: typeof args.flags['api-key'] === 'string' ? args.flags['api-key'] : undefined,
          dryRun: args.flags['dry-run'] === true,
        });
        emit(result, jsonMode);
        return;
      }

      case 'deploy': {
        const result = await runDeploy({
          env: ((args.flags.env as string) ?? 'trial') as 'trial' | 'staging' | 'prod',
          appDir: (args.flags['app-dir'] as string) ?? process.cwd(),
          appName: typeof args.flags['app-name'] === 'string' ? args.flags['app-name'] : undefined,
          hostedUrl: typeof args.flags['hosted-url'] === 'string' ? args.flags['hosted-url'] : undefined,
          apiKey: typeof args.flags['api-key'] === 'string' ? args.flags['api-key'] : undefined,
          watch: args.flags['no-watch'] !== true,
          dryRun: args.flags['dry-run'] === true,
        });
        emit(result, jsonMode);
        if (result.status === 'failed') process.exit(1);
        return;
      }

      case 'logs': {
        const appName = args.positional[0];
        if (!appName) {
          process.stderr.write(`projex logs: missing <app_name>.\n`);
          process.exit(2);
        }
        const result = await runLogs({
          appName,
          tail: args.flags.tail === true,
          limit: typeof args.flags.limit === 'string' ? parseInt(args.flags.limit, 10) : undefined,
          hostedUrl: typeof args.flags['hosted-url'] === 'string' ? args.flags['hosted-url'] : undefined,
          apiKey: typeof args.flags['api-key'] === 'string' ? args.flags['api-key'] : undefined,
          json: jsonMode,
        });
        emit(result, jsonMode);
        if (result.status === 'failed') process.exit(1);
        return;
      }

      case 'telemetry': {
        const action = (args.positional[0] ?? 'status') as 'on' | 'off' | 'status';
        const result = runTelemetry(action);
        emit(result, jsonMode);
        return;
      }

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
