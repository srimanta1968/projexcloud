/**
 * P9 / E5.F2 — `projex init <app_name> [--blueprint <id>]`
 *
 * 1. Creates a new directory at ./<app_name>
 * 2. If --blueprint is given (and resolves), uses sdk-registry's getScaffold
 *    against the named blueprint's SDK set to write a starter file tree.
 *    Otherwise writes a minimal blank-app skeleton with the same shape so
 *    `projex install <sdk>` can extend it later.
 * 3. Writes mcp.json into every detected AI tool's config dir so the
 *    registry MCP is immediately reachable (per FR-COHAB-1).
 * 4. Drops a README + CLAUDE.md that name the project + reference the
 *    same getScaffold output format used by --blueprint.
 *
 * Phase 1 limitations:
 *   - --blueprint resolution returns "blueprint library not yet wired
 *     (E4 pending)" — we still scaffold a blank starter so init isn't
 *     blocked.
 *   - registry-mcp-local is referenced via `npx -y @projexlight/registry-mcp-local`
 *     (works once that package is published). In dev mode (env
 *     PROJEX_DEV_ROOT set) we use the in-monorepo path instead.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getScaffold, loadRegistry, type Registry } from '@projexlight/sdk-registry';
import { writeMcpConfigs, hostedMcpServerEntry, type McpServerEntry, type WriteResult } from '../configWriters';
import { userCatalogPath, userEmbeddingsBinPath, userEmbeddingsMetaPath } from '../paths';

export interface InitFlags {
  app_name: string;
  blueprint?: string;
  /** Skip writing AI-tool mcp.json files. */
  noMcp?: boolean;
  /** Write configs for every known AI tool, even undetected ones. */
  allTools?: boolean;
  /** Override target directory; default ./<app_name>. */
  targetDir?: string;
  /** Override the catalog used for SDK resolution (testing). */
  catalogPath?: string;
  /** Override homedir() for mcp.json path resolution (testing). */
  homeDir?: string;
  /** Hosted registry-mcp SSE URL — when set, mcp.json points at the hosted service instead of spawning a stdio child. */
  hostedUrl?: string;
  /** Bearer token sent with hosted-MCP requests (six-layer JWT). */
  apiToken?: string;
}

export interface InitResult {
  appName: string;
  targetDir: string;
  files: string[];
  mcpWrites: WriteResult[];
  blueprint: string | null;
  sdksResolved: string[];
  warnings: string[];
}

export async function runInit(flags: InitFlags): Promise<InitResult> {
  if (!flags.app_name || !/^[a-z][a-z0-9_-]*$/.test(flags.app_name)) {
    throw new Error(
      `Invalid app_name "${flags.app_name}". Expected lowercase letters, digits, dashes, underscores; must start with a letter.`,
    );
  }
  const targetDir = resolve(flags.targetDir ?? join(process.cwd(), flags.app_name));
  if (existsSync(targetDir)) {
    throw new Error(`Target directory ${targetDir} already exists. Pick a different app_name or remove the directory.`);
  }

  const warnings: string[] = [];

  // ── Resolve catalog + registry (read-only) ─────────────────────────────
  const catalogPath = resolve(flags.catalogPath ?? userCatalogPath());
  let registry: Registry | null = null;
  if (existsSync(catalogPath)) {
    try {
      registry = loadRegistry(catalogPath);
    } catch (err) {
      warnings.push(`Catalog at ${catalogPath} failed to load: ${(err as Error).message}. Continuing with blank scaffold.`);
    }
  } else {
    warnings.push(`No registry catalog found at ${catalogPath}. Run 'projex registry refresh' to populate. Continuing with blank scaffold.`);
  }

  // ── Resolve blueprint → SDK list (Phase 1: stub until E4) ──────────────
  let blueprintId: string | null = null;
  let sdkNames: string[] = [];
  if (flags.blueprint) {
    blueprintId = flags.blueprint;
    warnings.push(
      `Blueprint "${flags.blueprint}" requested but the blueprint library (E4) is not yet wired. Scaffolding with no SDKs preselected.`,
    );
    // When E4 lands, this becomes: sdkNames = await loadBlueprint(blueprint).sdks
  }

  // ── Generate file tree via getScaffold (works with empty sdk list too) ──
  if (!registry && sdkNames.length === 0) {
    // No registry + no blueprint: emit a minimal skeleton.
    mkdirSync(targetDir, { recursive: true });
    const files = writeBlankSkeleton(targetDir, flags.app_name);
    const mcpWrites = flags.noMcp ? [] : writeMcpConfigs({
      server: resolveMcpServerEntry(flags),
      force: flags.allTools,
      homeDir: flags.homeDir,
    });
    return {
      appName: flags.app_name,
      targetDir,
      files,
      mcpWrites,
      blueprint: blueprintId,
      sdksResolved: [],
      warnings,
    };
  }

  const tree = registry
    ? getScaffold(registry, sdkNames, flags.app_name)
    : { app_name: flags.app_name, files: [], warnings: [], resolved_sdks: [] };

  mkdirSync(targetDir, { recursive: true });
  const writtenFiles: string[] = [];
  for (const f of tree.files) {
    const dest = join(targetDir, f.path);
    mkdirSync(dest.replace(/[\\/][^\\/]+$/, ''), { recursive: true });
    writeFileSync(dest, f.contents);
    writtenFiles.push(f.path);
  }
  if (tree.warnings.length > 0) warnings.push(...tree.warnings);

  // If the tree was empty (no blueprint + no SDKs), still produce a skeleton.
  if (writtenFiles.length === 0) {
    writtenFiles.push(...writeBlankSkeleton(targetDir, flags.app_name));
  }

  const mcpWrites = flags.noMcp ? [] : writeMcpConfigs({
    server: resolveMcpServerEntry(flags),
    force: flags.allTools,
    homeDir: flags.homeDir,
  });

  return {
    appName: flags.app_name,
    targetDir,
    files: writtenFiles,
    mcpWrites,
    blueprint: blueprintId,
    sdksResolved: tree.resolved_sdks,
    warnings,
  };
}

/* --------------------------------------------------------------- helpers */

function resolveMcpServerEntry(flags: InitFlags): McpServerEntry {
  // Hosted SSE wins when --hosted-url is set: the AI client connects
  // directly to services/registry-mcp without spawning a stdio child.
  if (flags.hostedUrl) {
    return hostedMcpServerEntry(flags.hostedUrl, flags.apiToken);
  }
  return defaultMcpServerEntry();
}

function defaultMcpServerEntry(): McpServerEntry {
  // In a checked-out monorepo we point straight at the local build. In
  // any other context, npx -y pulls the published package.
  const devRoot = process.env.PROJEX_DEV_ROOT;
  if (devRoot) {
    return {
      command: 'node',
      args: [join(devRoot, 'packages', 'registry-mcp-local', 'dist', 'cli.js')],
      env: { PROJEX_DEV_ROOT: devRoot },
    };
  }
  return {
    command: 'npx',
    args: ['-y', '@projexlight/registry-mcp-local'],
  };
}

function writeBlankSkeleton(targetDir: string, appName: string): string[] {
  const pkg = {
    name: appName,
    version: '0.1.0',
    private: true,
    type: 'module',
    scripts: { build: 'tsc', test: 'vitest run', start: 'node dist/index.js' },
    devDependencies: { typescript: '^5.3.0', '@types/node': '^20.10.0' },
  };
  const tsconfig = {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      esModuleInterop: true,
      outDir: 'dist',
      rootDir: 'src',
    },
    include: ['src/**/*'],
  };
  const indexTs = `// ${appName} — entry point.\n// Wire in ProjexCloud SDKs via \`projex install <sdk>\`.\n\nexport async function main(): Promise<void> {\n  console.log('Hello from ${appName}.');\n}\n`;
  const readme = `# ${appName}\n\nScaffolded by \`projex init\`. Next steps:\n\n\`\`\`sh\nprojex install @projexlight/sdk-vault\nprojex install @projexlight/sdk-billing\n\`\`\`\n\nThe MCP server config has been auto-written for any detected AI tool (Claude Code / Cursor / Windsurf / Cline).\n`;
  const claudeMd = `# CLAUDE.md\n\nThis project was scaffolded by \`projex init\`. Read \`projex-registry-mcp-local\` tools (prefix \`projex_registry_*\`) before writing any custom code.\n\n## Mandatory first steps before ANY code change\n\n1. **Search before creating.** Call \`projex_registry_search_sdks\` to check whether a ProjexCloud SDK already provides the capability.\n2. **Read the manifest.** Before calling an SDK, use \`projex_registry_get_manifest\` to verify endpoint/event shape.\n3. **Honor pool placement.** Don't write across pool boundaries — route through the SDK's API.\n`;
  const gitignore = `node_modules/\ndist/\n*.log\n.env\n.env.local\n`;

  const files: Array<[string, string]> = [
    ['package.json', JSON.stringify(pkg, null, 2) + '\n'],
    ['tsconfig.json', JSON.stringify(tsconfig, null, 2) + '\n'],
    ['src/index.ts', indexTs],
    ['README.md', readme],
    ['CLAUDE.md', claudeMd],
    ['.gitignore', gitignore],
  ];

  const written: string[] = [];
  for (const [rel, body] of files) {
    const dest = join(targetDir, rel);
    mkdirSync(dest.replace(/[\\/][^\\/]+$/, ''), { recursive: true });
    writeFileSync(dest, body);
    written.push(rel);
  }
  return written;
}

/** Catalog/embeddings sidecar paths kept so consumers (other commands) can read them. */
export const cacheArtifactPaths = {
  catalog: userCatalogPath,
  embeddingsBin: userEmbeddingsBinPath,
  embeddingsMeta: userEmbeddingsMetaPath,
};
