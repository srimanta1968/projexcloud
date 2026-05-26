/**
 * P9 / E4 — blueprint loader.
 *
 * Reads blueprint.yaml (preferred) or blueprint.json from a directory and
 * validates it. Returns BlueprintRecord with the absolute dir so the
 * installer can resolve template paths relative to it.
 *
 * `listBlueprints(rootDir)` walks one level deep — each blueprint lives
 * in its own subdirectory under rootDir. Subdirectories without a
 * blueprint manifest are skipped silently (allows mixing with READMEs,
 * docs/, etc.).
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { Blueprint, BlueprintRecord } from './types';
import { validateBlueprint } from './validator';

const MANIFEST_NAMES = ['blueprint.yaml', 'blueprint.yml', 'blueprint.json'];

export interface LoadOptions {
  /** Directory containing a single blueprint.{yaml,yml,json}. */
  dir: string;
}

export function loadBlueprint(opts: LoadOptions): BlueprintRecord {
  const dir = resolve(opts.dir);
  const manifestPath = findManifest(dir);
  if (!manifestPath) {
    throw new Error(`No blueprint manifest found in ${dir}; expected one of: ${MANIFEST_NAMES.join(', ')}`);
  }
  const raw = readFileSync(manifestPath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = manifestPath.endsWith('.json') ? JSON.parse(raw) : parseYaml(raw);
  } catch (err) {
    throw new Error(`Failed to parse ${manifestPath}: ${(err as Error).message}`);
  }
  const r = validateBlueprint(parsed);
  if (!r.ok) {
    throw new Error(`Blueprint ${manifestPath} failed validation:\n  - ${r.errors.join('\n  - ')}`);
  }
  return { dir, blueprint: r.value };
}

export function listBlueprints(rootDir: string): BlueprintRecord[] {
  const root = resolve(rootDir);
  if (!existsSync(root)) return [];
  const out: BlueprintRecord[] = [];
  for (const entry of readdirSync(root)) {
    const sub = join(root, entry);
    if (!statSync(sub).isDirectory()) continue;
    if (!findManifest(sub)) continue;
    try {
      out.push(loadBlueprint({ dir: sub }));
    } catch {
      // Validation errors at list time are non-fatal; surface only on
      // direct loadBlueprint call where the user can see the message.
      continue;
    }
  }
  return out.sort((a, b) => a.blueprint.id.localeCompare(b.blueprint.id));
}

function findManifest(dir: string): string | null {
  for (const name of MANIFEST_NAMES) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}
