/**
 * P9 / E1.F3 — auto-scaffold the boilerplate of an sdk-capability.json
 * from a package's source. Hand-rolled (no ts-morph dep) — uses regex
 * scans because we only need name-level detection, not full AST analysis.
 *
 * Output is intentionally TBD-placeholder-rich for the prose sections
 * (summary, scenarios, compliance_posture.notes). The lint layer (E1.F5)
 * will refuse to validate until the SDK owner fills those in — that's
 * the forcing function for quality.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { PoolPlacement, RetentionClass, SdkCapabilityManifest } from './types';

export interface ScaffoldOptions {
  /** Absolute path to the package directory (contains package.json). */
  packageDir: string;
  /** Override pool_placement; default 'app'. SDK owner usually picks. */
  pool_placement?: PoolPlacement;
}

interface PackageJson {
  name: string;
  version: string;
  description?: string;
}

/**
 * Reads a package's source tree and emits a starter manifest with:
 *   - name/version from package.json
 *   - summary stub TBD'd from package.json description
 *   - endpoints auto-detected from src/server/ via regex scan for
 *     app.{get,post,put,patch,delete}('...')
 *   - events auto-detected from src/events.ts via regex for exported
 *     event-name constants matching `{ns}.{action}.v{n}`
 *   - models auto-detected from db/migrations/*.sql CREATE TABLE statements
 *   - scenarios/compliance_posture left as TBD placeholders to force the
 *     SDK owner to author them (lint will reject these placeholders)
 */
export function scaffoldManifest(opts: ScaffoldOptions): SdkCapabilityManifest {
  const pkg = readPackageJson(opts.packageDir);
  const endpoints = scanEndpoints(opts.packageDir);
  const events = scanEvents(opts.packageDir);
  const models = scanModels(opts.packageDir);

  return {
    name: pkg.name,
    version: pkg.version,
    schema_version: '1.0',
    summary:
      pkg.description ??
      `TBD: write a 1-paragraph summary of what ${pkg.name} does (50-500 chars).`,
    tags: [],
    provides: {
      endpoints: endpoints.map((ep) => ({
        method: ep.method,
        path: ep.path,
        description: 'TBD: one-line description of what this endpoint does.',
      })),
      events: events.map((name) => ({
        name,
        retention_class: 'operational' as RetentionClass,
        conflict_policy: 'lww',
        description: 'TBD: one-line description of when this event fires.',
      })),
      models,
      hooks: [],
      ui_components: [],
    },
    consumes: {
      events: [],
      infra: [],
      config_keys: [],
    },
    scenarios: [
      placeholderScenario('s1', 'Primary use case'),
      placeholderScenario('s2', 'Secondary use case'),
      placeholderScenario('s3', 'Edge case or recovery flow'),
    ],
    compliance_posture: {
      regimes: ['SOC2'],
      notes: 'TBD: describe any HIPAA / GDPR / PCI / FedRAMP considerations.',
    },
    pool_placement: opts.pool_placement ?? 'app',
    pricing_skus: [],
    links: {
      readme: `packages/${basename(opts.packageDir)}/README.md`,
      source: `packages/${basename(opts.packageDir)}/src/`,
    },
    no_endpoints: endpoints.length === 0 ? true : undefined,
  };
}

function placeholderScenario(id: string, title: string) {
  return {
    id,
    title,
    when_to_use: 'TBD: when should a developer reach for this SDK?',
    example_code: 'TBD: paste a real, runnable code snippet here.',
    expected_outcome: 'TBD: what should happen when the snippet runs?',
  };
}

function readPackageJson(packageDir: string): PackageJson {
  const path = join(packageDir, 'package.json');
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw) as PackageJson;
}

interface DetectedEndpoint {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
}

function scanEndpoints(packageDir: string): DetectedEndpoint[] {
  const serverDir = join(packageDir, 'src', 'server');
  const found: DetectedEndpoint[] = [];
  for (const file of walkTs(serverDir)) {
    const src = readFileSync(file, 'utf-8');
    // Match: app.get('/api/x', ...)   or   instance.post<...>('/api/x', ...)
    const re =
      /\b(?:app|instance|fastify|server)\s*\.\s*(get|post|put|patch|delete)\s*(?:<[^>]+>)?\s*\(\s*['"`]([^'"`]+)['"`]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      found.push({
        method: m[1].toUpperCase() as DetectedEndpoint['method'],
        path: m[2],
      });
    }
  }
  // de-dup
  const seen = new Set<string>();
  return found.filter((e) => {
    const key = `${e.method} ${e.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scanEvents(packageDir: string): string[] {
  const candidates = [
    join(packageDir, 'src', 'events.ts'),
    join(packageDir, 'src', 'events', 'index.ts'),
  ];
  const found = new Set<string>();
  for (const path of candidates) {
    if (!safeExists(path)) continue;
    const src = readFileSync(path, 'utf-8');
    // Match either: export const X = 'ns.action.v1'   or just any string literal
    // matching the event-name pattern in the file
    const re = /['"`]([a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)+\.v\d+)['"`]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      found.add(m[1]);
    }
  }
  return Array.from(found);
}

function scanModels(packageDir: string): Array<{ schema: string; table: string }> {
  const migDir = join(packageDir, 'src', 'db', 'migrations');
  const alt = join(packageDir, 'db', 'migrations');
  const dir = safeExists(migDir) ? migDir : safeExists(alt) ? alt : null;
  if (!dir) return [];
  const found: Array<{ schema: string; table: string }> = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.sql')) continue;
    const src = readFileSync(join(dir, file), 'utf-8');
    // CREATE TABLE [IF NOT EXISTS] schema.table (
    const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      found.push({ schema: m[1], table: m[2] });
    }
  }
  return found;
}

function* walkTs(dir: string): Generator<string> {
  if (!safeExists(dir)) return;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const s = statSync(path);
    if (s.isDirectory()) yield* walkTs(path);
    else if (path.endsWith('.ts')) yield path;
  }
}

function safeExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}
