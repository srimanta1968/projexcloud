/**
 * P9 / E4 Phase 2 — `projex blueprint list | apply <id>`
 *
 * list: walks the configured blueprint root + prints title + pack + SDKs.
 * apply <id>: loads the blueprint, resolves clarifying-question answers
 *   from --answers '{"q":"v",...}' JSON or defaults (non-interactive for
 *   Phase 2; interactive prompts land later), renders {{var}}-substituted
 *   templates, writes files into --targetDir (or cwd).
 *
 * Template syntax: simple {{var_name}} substitution. Full Handlebars
 * (conditionals, loops, helpers) lands in Phase 3 if templates demand it.
 *
 * Phase 2 does NOT yet:
 *   - run smoke tests (just writes files)
 *   - install SDK deps (developer runs `projex install <sdk>` after)
 *   - emit blueprint.installed.v1 events (no audit chain locally)
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { listBlueprints, loadBlueprint, type Blueprint } from '@projexlight/blueprints';
import { runInstall, type InstallResult } from './install';

/* --------------------------------------------------------------- shared */

function resolveBlueprintsRoot(override?: string): string {
  if (override) return resolve(override);
  if (process.env.PROJEX_BLUEPRINTS_ROOT) return resolve(process.env.PROJEX_BLUEPRINTS_ROOT);
  if (process.env.PROJEX_DEV_ROOT) {
    const dev = join(process.env.PROJEX_DEV_ROOT, 'blueprints');
    if (existsSync(dev)) return dev;
  }
  throw new Error(
    `No blueprints root configured. Set PROJEX_BLUEPRINTS_ROOT, or PROJEX_DEV_ROOT (with a blueprints/ subdir), or pass --root.`,
  );
}

/* ------------------------------------------------------------------ list */

export interface BlueprintListFlags {
  /** Override the blueprints root (testing). */
  root?: string;
  /** Filter by tag substring (case-insensitive). */
  tag?: string;
}

export interface BlueprintListEntry {
  id: string;
  title: string;
  summary: string;
  pack: string;
  sdk_count: number;
  estimated_minutes: number;
  tags: string[];
  dir: string;
}

export interface BlueprintListResult {
  root: string;
  total: number;
  filtered: number;
  blueprints: BlueprintListEntry[];
}

export function runBlueprintList(flags: BlueprintListFlags): BlueprintListResult {
  const root = resolveBlueprintsRoot(flags.root);
  const all = listBlueprints(root);
  const tagLower = flags.tag?.toLowerCase();

  const blueprints: BlueprintListEntry[] = all
    .filter((r) => !tagLower || (r.blueprint.tags ?? []).some((t) => t.toLowerCase().includes(tagLower)))
    .map((r) => ({
      id: r.blueprint.id,
      title: r.blueprint.title,
      summary: r.blueprint.summary,
      pack: r.blueprint.pack,
      sdk_count: r.blueprint.sdks.length,
      estimated_minutes: r.blueprint.estimated_minutes,
      tags: r.blueprint.tags ?? [],
      dir: r.dir,
    }));

  return { root, total: all.length, filtered: blueprints.length, blueprints };
}

/* ----------------------------------------------------------------- apply */

export interface BlueprintApplyFlags {
  blueprint_id: string;
  /** Override target app dir; default cwd. */
  targetDir?: string;
  /** Override blueprints root (testing). */
  root?: string;
  /** JSON string with per-question id → answer. Missing answers use defaults. */
  answersJson?: string;
  /** Overwrite existing output files. */
  force?: boolean;
  /**
   * After templates are written, iterate through blueprint.sdks and call
   * runInstall for each. Closes the manual "next: install these" loop.
   * Requires the catalog to be present (projex registry refresh).
   */
  installSdks?: boolean;
  /** Override catalog path passed through to runInstall (testing). */
  catalogPath?: string;
}

export type ApplyAction = 'written' | 'skipped-exists' | 'template-missing';

export interface ApplyFileResult {
  path: string;
  action: ApplyAction;
  template: string;
}

export interface BlueprintApplyResult {
  blueprint_id: string;
  blueprint_title: string;
  targetDir: string;
  answers: Record<string, unknown>;
  files: ApplyFileResult[];
  warnings: string[];
  sdks_to_install: string[];
  /** Populated when --install-sdks was passed. One entry per SDK. */
  installs?: Array<{ sdk_name: string; ok: boolean; result?: InstallResult; error?: string }>;
}

export function runBlueprintApply(flags: BlueprintApplyFlags): BlueprintApplyResult {
  if (!flags.blueprint_id) throw new Error('blueprint_id is required');
  const root = resolveBlueprintsRoot(flags.root);
  const dir = join(root, flags.blueprint_id);
  if (!existsSync(dir)) throw new Error(`Blueprint "${flags.blueprint_id}" not found under ${root}`);

  const { blueprint } = loadBlueprint({ dir });
  const targetDir = resolve(flags.targetDir ?? process.cwd());
  if (!existsSync(join(targetDir, 'package.json'))) {
    throw new Error(
      `Target dir ${targetDir} doesn't look like an app (no package.json). Run 'projex init <name>' first.`,
    );
  }

  // ── resolve answers (Phase 2: non-interactive only) ───────────────────
  const userAnswers = flags.answersJson ? JSON.parse(flags.answersJson) : {};
  const answers: Record<string, unknown> = {};
  const warnings: string[] = [];
  for (const q of blueprint.clarifying_questions) {
    if (Object.prototype.hasOwnProperty.call(userAnswers, q.id)) {
      answers[q.id] = userAnswers[q.id];
    } else if (q.default !== undefined) {
      answers[q.id] = q.default;
    } else {
      warnings.push(`No answer provided for clarifying question "${q.id}" and no default; using empty string.`);
      answers[q.id] = '';
    }
  }

  // ── render every output ───────────────────────────────────────────────
  const files: ApplyFileResult[] = [];
  const context: Record<string, string> = {
    app_name: targetDirBaseName(targetDir),
    blueprint_id: blueprint.id,
    blueprint_title: blueprint.title,
    ...Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, String(v)])),
  };

  for (const out of blueprint.outputs) {
    const templatePath = join(dir, out.template);
    const outPath = join(targetDir, out.path);

    if (!existsSync(templatePath)) {
      files.push({ path: out.path, template: out.template, action: 'template-missing' });
      warnings.push(`Template ${out.template} not found at ${templatePath}; skipped output ${out.path}.`);
      continue;
    }

    if (existsSync(outPath) && !flags.force) {
      files.push({ path: out.path, template: out.template, action: 'skipped-exists' });
      warnings.push(`Output ${out.path} already exists; pass --force to overwrite.`);
      continue;
    }

    const raw = readFileSync(templatePath, 'utf-8');
    const rendered = render(raw, context);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, rendered);
    files.push({ path: out.path, template: out.template, action: 'written' });
  }

  // ── optionally install every SDK the blueprint composes ───────────────
  let installs: BlueprintApplyResult['installs'];
  if (flags.installSdks) {
    installs = [];
    for (const ref of blueprint.sdks) {
      try {
        const result = runInstall({
          sdk_name: ref.name,
          targetDir,
          catalogPath: flags.catalogPath,
          force: flags.force,
        });
        installs.push({ sdk_name: ref.name, ok: true, result });
      } catch (err) {
        installs.push({ sdk_name: ref.name, ok: false, error: (err as Error).message });
        warnings.push(`Auto-install of ${ref.name} failed: ${(err as Error).message}`);
      }
    }
  }

  return {
    blueprint_id: blueprint.id,
    blueprint_title: blueprint.title,
    targetDir,
    answers,
    files,
    warnings,
    sdks_to_install: blueprint.sdks.map((s) => s.name),
    installs,
  };
}

/* ----------------------------------------------------------------- util */

/**
 * Tiny {{var}} renderer. Replaces every `{{name}}` with context[name].
 * Unknown vars left as-is (intentional — surfaces gaps loudly).
 * Whitespace inside braces is tolerated: `{{ name }}` works too.
 */
function render(src: string, context: Record<string, string>): string {
  return src.replace(/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/gi, (_, key: string) => {
    if (Object.prototype.hasOwnProperty.call(context, key)) return context[key];
    return `{{${key}}}`;
  });
}

function targetDirBaseName(targetDir: string): string {
  const parts = targetDir.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || 'app';
}

/** Re-export for use by listBlueprints consumers. */
export type { Blueprint };
