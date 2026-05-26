/**
 * P9 / E5 Phase 1.5 — `projex install <sdk_name>`
 *
 * Reads the local app's package.json + adds the SDK as a dep + drops a
 * starter integration file at src/integrations/<sdk-bare>.ts derived from
 * the manifest's first scenario + updates src/index.ts to re-export it.
 *
 * Idempotent: re-running with the same SDK is a no-op (existing
 * integration file preserved unless --force; package.json dep version
 * bumped if newer in the catalog).
 *
 * Resolution rules for the dep version string:
 *   - PROJEX_DEV_ROOT set → "workspace:*"  (monorepo dev)
 *   - else                → "^<manifest.version>"
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadRegistry, type Registry } from '@projexlight/sdk-registry';
import { userCatalogPath } from '../paths';

export interface InstallFlags {
  sdk_name: string;
  /** Override target app dir; default cwd. */
  targetDir?: string;
  /** Override catalog path (testing). */
  catalogPath?: string;
  /** Overwrite existing integration file. */
  force?: boolean;
  /** Skip the package.json edit (just drop the integration file). */
  noPackageEdit?: boolean;
}

export type InstallAction = 'added' | 'updated' | 'unchanged' | 'integration-skipped-exists';

export interface InstallResult {
  sdk_name: string;
  targetDir: string;
  packageJsonAction: InstallAction;
  integrationAction: InstallAction;
  integrationPath: string;
  depVersion: string;
  indexUpdated: boolean;
  warnings: string[];
}

export function runInstall(flags: InstallFlags): InstallResult {
  if (!flags.sdk_name) throw new Error('sdk_name is required');
  if (!flags.sdk_name.startsWith('@projexlight/')) {
    throw new Error(
      `sdk_name must start with "@projexlight/" (got "${flags.sdk_name}"). Use search_sdks via your MCP to discover canonical names.`,
    );
  }

  const targetDir = resolve(flags.targetDir ?? process.cwd());
  const pkgPath = join(targetDir, 'package.json');
  if (!existsSync(pkgPath)) {
    throw new Error(
      `No package.json found at ${pkgPath}. Run 'projex init <app_name>' first, or cd into your app dir.`,
    );
  }

  // ── Resolve manifest from the catalog ─────────────────────────────────
  const catalogPath = resolve(flags.catalogPath ?? userCatalogPath());
  if (!existsSync(catalogPath)) {
    throw new Error(
      `No registry catalog at ${catalogPath}. Run 'projex registry refresh' first.`,
    );
  }
  let registry: Registry;
  try {
    registry = loadRegistry(catalogPath);
  } catch (err) {
    throw new Error(`Catalog at ${catalogPath} failed to load: ${(err as Error).message}`);
  }
  const entry = registry.get(flags.sdk_name);
  if (!entry) {
    const closest = registry
      .list()
      .map((e) => e.manifest.name)
      .filter((n) => n.includes(flags.sdk_name.replace('@projexlight/', '').slice(0, 6)))
      .slice(0, 5);
    const hint = closest.length > 0 ? `\n  Did you mean: ${closest.join(', ')}?` : '';
    throw new Error(
      `Unknown SDK "${flags.sdk_name}". It is not in the local catalog.${hint}\n  Run 'projex registry refresh' to pull the latest catalog.`,
    );
  }

  const manifest = entry.manifest;
  const depVersion = process.env.PROJEX_DEV_ROOT ? 'workspace:*' : `^${manifest.version}`;
  const warnings: string[] = [];

  // ── package.json edit ──────────────────────────────────────────────────
  let packageJsonAction: InstallAction = 'unchanged';
  if (!flags.noPackageEdit) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    pkg.dependencies = pkg.dependencies ?? {};
    if (pkg.dependencies[flags.sdk_name] === undefined) {
      pkg.dependencies[flags.sdk_name] = depVersion;
      packageJsonAction = 'added';
    } else if (pkg.dependencies[flags.sdk_name] !== depVersion) {
      pkg.dependencies[flags.sdk_name] = depVersion;
      packageJsonAction = 'updated';
    }
    if (packageJsonAction !== 'unchanged') {
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    }
  }

  // ── integration file ───────────────────────────────────────────────────
  const bare = manifest.name.split('/').pop() || manifest.name;
  const camel = bare
    .split('-')
    .map((part, i) => (i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('');
  const integrationDir = join(targetDir, 'src', 'integrations');
  const integrationPath = join(integrationDir, `${bare}.ts`);

  let integrationAction: InstallAction = 'unchanged';
  if (existsSync(integrationPath) && !flags.force) {
    integrationAction = 'integration-skipped-exists';
    warnings.push(`Integration ${integrationPath} already exists; pass --force to overwrite.`);
  } else {
    mkdirSync(integrationDir, { recursive: true });
    writeFileSync(integrationPath, renderIntegration(manifest));
    integrationAction = existsSync(integrationPath) && flags.force ? 'updated' : 'added';
  }

  // ── update src/index.ts re-export ──────────────────────────────────────
  let indexUpdated = false;
  const indexPath = join(targetDir, 'src', 'index.ts');
  if (existsSync(indexPath)) {
    const current = readFileSync(indexPath, 'utf-8');
    const exportLine = `export * as ${camel} from './integrations/${bare}';`;
    if (!current.includes(exportLine)) {
      const updated = current.trimEnd() + '\n' + exportLine + '\n';
      writeFileSync(indexPath, updated);
      indexUpdated = true;
    }
  } else {
    warnings.push(`No src/index.ts found; skipped re-export wiring.`);
  }

  return {
    sdk_name: flags.sdk_name,
    targetDir,
    packageJsonAction,
    integrationAction,
    integrationPath,
    depVersion,
    indexUpdated,
    warnings,
  };
}

/* ---------------------------------------------------- file template helper */

function renderIntegration(
  m: import('@projexlight/sdk-capability').SdkCapabilityManifest,
): string {
  const bare = (m.name.split('/').pop() || m.name).replace(/-/g, '_');
  const firstScenario = m.scenarios[0];
  const consumes = m.consumes.events.map((e) => e.name).join(', ') || '(none)';

  return `/**
 * Integration with ${m.name} v${m.version}
 *
 * Pool placement: ${m.pool_placement}
 * Compliance:     ${m.compliance_posture.regimes.join(', ')}
 * Tags:           ${m.tags.join(', ') || '(none)'}
 * Consumes:       ${consumes}
 *
 * ${m.summary}
 */

// import * as ${bare} from '${m.name}';

/**
 * Entry point. Replace with real wiring.
 *
 * Example scenario from the SDK's capability manifest:
 *   ${firstScenario?.title ?? '(no scenarios authored)'}
 *
 * When to use:
 *   ${firstScenario?.when_to_use ?? '(none documented)'}
 *
 * Expected outcome:
 *   ${firstScenario?.expected_outcome ?? '(none documented)'}
 */
export async function init(): Promise<void> {
${
  firstScenario
    ? `  // Auto-generated from scenario id "${firstScenario.id}":\n${firstScenario.example_code
        .split('\n')
        .map((l) => '  // ' + l)
        .join('\n')}`
    : '  // No scenarios in the manifest — write your own initialization here.'
}
}
`;
}
