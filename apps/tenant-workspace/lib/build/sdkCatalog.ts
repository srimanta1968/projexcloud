import fs from 'node:fs';
import path from 'node:path';

/**
 * Loads + trims every sdk-capability.json manifest in the monorepo into a
 * catalog the planner reasons about.
 *
 * Planner v2 (P9.2): the catalog is no longer streamed wholesale into one LLM
 * prompt. Instead it feeds a retrieve-then-compose pipeline (see retriever.ts
 * + resolve.ts), so we capture the extra structure those stages need:
 *   - tier            — 'foundation' when the manifest carries the
 *                       `foundation` tag (identity/persona/tenant/rebac/…),
 *                       which the foundation-tier resolver always injects.
 *   - endpoints[]     — method/path/kind, so a plan can cite concrete APIs and
 *                       so ingest endpoints stay discoverable.
 *   - providesEvents  — event names this SDK emits.
 *   - consumesEvents  — event names this SDK consumes; the dependency-closure
 *                       resolver walks consumes→provides to pull prerequisites.
 *
 * Loaded ONCE at module init — manifests change when the dev rebuilds, not
 * per-request.
 */

export interface CatalogEndpoint {
  method: string;
  path: string;
  /** ingest | bulk | query | mutation | webhook (defaults to 'query'). */
  kind: string;
}

export interface CatalogSdk {
  name: string;
  summary: string;
  tags: string[];
  tier: 'foundation' | 'domain';
  capabilities: string[];
  endpoints: CatalogEndpoint[];
  providesEvents: string[];
  consumesEvents: string[];
}

/**
 * Resolve the monorepo `packages/` directory regardless of where Next was
 * launched from. We can't trust __dirname — at runtime in Next dev, route
 * handlers live in .next/server/... not in apps/tenant-workspace/lib/build/.
 * Try a few candidates in order (repo root, parent of apps/, etc.) and pick
 * the first one that actually contains sdk-capability.json files.
 */
function resolvePackagesDir(): string {
  const cwd = process.cwd();
  const candidates = [
    path.resolve(cwd, 'packages'),                    // started from repo root
    path.resolve(cwd, '..', '..', 'packages'),        // started from apps/tenant-workspace
    path.resolve(cwd, '..', 'packages'),              // started from apps/ (rare)
    process.env.PROJEXCLOUD_PACKAGES_DIR ?? '',       // explicit override
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const entries = fs.readdirSync(candidate, { withFileTypes: true });
      const hasManifest = entries.some(
        (d) => d.isDirectory() && fs.existsSync(path.join(candidate, d.name, 'sdk-capability.json')),
      );
      if (hasManifest) return candidate;
    } catch {
      // fallthrough
    }
  }
  return candidates[0]; // best-effort even if empty, so the error message names a real path
}

const PACKAGES_DIR = resolvePackagesDir();

/** Absolute path to the resolved monorepo packages/ dir (used by the embedding retriever). */
export function getPackagesDir(): string {
  return PACKAGES_DIR;
}

interface RawManifest {
  name?: string;
  summary?: string;
  tags?: string[];
  provides?: {
    endpoints?: Array<{ method?: string; path?: string; description?: string; kind?: string }>;
    hooks?: Array<{ name?: string; description?: string }>;
    ui_components?: Array<{ name?: string; description?: string }>;
    events?: Array<{ name?: string }>;
  };
  consumes?: {
    events?: Array<{ name?: string }>;
  };
}

function trim(manifest: RawManifest): CatalogSdk | null {
  if (!manifest.name || !manifest.summary) return null;
  const tags = manifest.tags ?? [];

  const endpoints: CatalogEndpoint[] = [];
  const capabilities: string[] = [];

  for (const hook of manifest.provides?.hooks ?? []) {
    if (hook.name) capabilities.push(`hook:${hook.name}`);
  }
  for (const endpoint of manifest.provides?.endpoints ?? []) {
    if (endpoint.method && endpoint.path) {
      endpoints.push({
        method: endpoint.method,
        path: endpoint.path,
        kind: endpoint.kind ?? 'query',
      });
      capabilities.push(`${endpoint.method} ${endpoint.path}`);
    }
  }
  for (const ui of manifest.provides?.ui_components ?? []) {
    if (ui.name) capabilities.push(`ui:${ui.name}`);
  }

  const providesEvents = (manifest.provides?.events ?? [])
    .map((e) => e.name)
    .filter((n): n is string => Boolean(n));
  const consumesEvents = (manifest.consumes?.events ?? [])
    .map((e) => e.name)
    .filter((n): n is string => Boolean(n));

  return {
    name: manifest.name,
    summary: manifest.summary,
    tags,
    tier: tags.includes('foundation') ? 'foundation' : 'domain',
    capabilities: capabilities.slice(0, 10), // cap to avoid runaway tokens
    endpoints: endpoints.slice(0, 20),
    providesEvents,
    consumesEvents,
  };
}

let _catalog: CatalogSdk[] | null = null;

export interface CatalogLoadResult {
  catalog: CatalogSdk[];
  packagesDir: string;
}

export function loadCatalog(): CatalogSdk[] {
  return loadCatalogWithMeta().catalog;
}

export function loadCatalogWithMeta(): CatalogLoadResult {
  if (_catalog) return { catalog: _catalog, packagesDir: PACKAGES_DIR };
  const out: CatalogSdk[] = [];
  try {
    if (!fs.existsSync(PACKAGES_DIR)) {
      console.error(`[sdkCatalog] packages dir not found: ${PACKAGES_DIR}`);
      _catalog = out;
      return { catalog: out, packagesDir: PACKAGES_DIR };
    }
    const pkgDirs = fs.readdirSync(PACKAGES_DIR, { withFileTypes: true });
    for (const dirent of pkgDirs) {
      if (!dirent.isDirectory()) continue;
      const manifestPath = path.join(PACKAGES_DIR, dirent.name, 'sdk-capability.json');
      if (!fs.existsSync(manifestPath)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as RawManifest;
        const trimmed = trim(raw);
        if (trimmed) out.push(trimmed);
      } catch (err) {
        console.warn(`[sdkCatalog] skipped ${dirent.name}: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    console.error('[sdkCatalog] failed to scan packages/:', (err as Error).message);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  _catalog = out;
  console.log(`[sdkCatalog] loaded ${out.length} manifests from ${PACKAGES_DIR}`);
  return { catalog: out, packagesDir: PACKAGES_DIR };
}

/** Render a single SDK as a compact YAML-ish prompt block (used by the compose step). */
export function renderSdkForPrompt(sdk: CatalogSdk): string {
  const tags = sdk.tags.length ? ` [${sdk.tags.join(', ')}]` : '';
  const caps = sdk.capabilities.length ? `\n    capabilities: ${sdk.capabilities.join(', ')}` : '';
  return `- name: ${sdk.name}${tags}\n    summary: ${sdk.summary}${caps}`;
}

/** Render a list of SDKs as a compact prompt block. */
export function renderCatalogForPrompt(catalog: CatalogSdk[]): string {
  return catalog.map(renderSdkForPrompt).join('\n');
}
