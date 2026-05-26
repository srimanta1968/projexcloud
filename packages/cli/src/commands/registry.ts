/**
 * P9 / E5 — `projex registry refresh`
 *
 * Phase 1 behavior:
 *   - If PROJEX_CATALOG_SOURCE points at a local path, copy it (+ optional
 *     embeddings bin + meta if present beside) to ~/.projex/cache/.
 *   - If PROJEX_DEV_ROOT is set, default the source to the in-monorepo
 *     build at <root>/packages/sdk-registry/dist/registry.catalog.json.
 *
 * Phase 2 (after hosted MCP exists) extends this to:
 *   - HTTP fetch with ETag-conditional GET against the hosted catalog
 *     endpoint, using the tenant API key from ~/.projex/config.json.
 */

import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadRegistry } from '@projexlight/sdk-registry';
import {
  projexCacheDir,
  userCatalogPath,
  userEmbeddingsBinPath,
  userEmbeddingsMetaPath,
} from '../paths';

export interface RefreshFlags {
  /** Override the source path / URL. */
  source?: string;
}

export interface RefreshResult {
  source: string;
  catalogTarget: string;
  embeddingsCopied: boolean;
  bytes: number;
}

export function runRegistryRefresh(flags: RefreshFlags): RefreshResult {
  const rawSource =
    flags.source ??
    process.env.PROJEX_CATALOG_SOURCE ??
    (process.env.PROJEX_DEV_ROOT
      ? join(process.env.PROJEX_DEV_ROOT, 'packages', 'sdk-registry', 'dist', 'registry.catalog.json')
      : '');

  if (!rawSource) {
    throw new Error(
      `No catalog source. Set PROJEX_CATALOG_SOURCE to a local path, or PROJEX_DEV_ROOT for the in-monorepo build, or pass --source <path>. (Phase 2 will add HTTP fetch from the hosted registry.)`,
    );
  }

  const source = resolve(rawSource);
  if (!existsSync(source) || statSync(source).isDirectory()) {
    throw new Error(
      `Catalog source ${source} not found or is a directory. Expected a file path.`,
    );
  }

  mkdirSync(projexCacheDir(), { recursive: true });
  const catalogTarget = userCatalogPath();
  copyFileSync(source, catalogTarget);

  // Look for embeddings sidecar beside the source catalog.
  const sourceDir = dirname(source);
  const sourceBin = join(sourceDir, 'registry.embeddings.bin');
  const sourceMeta = join(sourceDir, 'registry.embeddings.meta.json');
  let embeddingsCopied = false;
  if (existsSync(sourceBin) && existsSync(sourceMeta)) {
    copyFileSync(sourceBin, userEmbeddingsBinPath());
    copyFileSync(sourceMeta, userEmbeddingsMetaPath());
    embeddingsCopied = true;
  }

  return {
    source,
    catalogTarget,
    embeddingsCopied,
    bytes: statSync(catalogTarget).size,
  };
}

/* --------------------------------------------------------------- list */

export interface ListFlags {
  /** Filter by tag substring (case-insensitive). */
  tag?: string;
  /** Substring filter against name + summary (case-insensitive). */
  search?: string;
  /** Override catalog path (testing). */
  catalogPath?: string;
}

export interface ListEntry {
  name: string;
  version: string;
  summary: string;
  pool_placement: string;
  tags: string[];
  scenarios: number;
  endpoints: number;
}

export interface ListResult {
  catalogPath: string;
  total: number;
  filtered: number;
  entries: ListEntry[];
}

/**
 * Reads the cached catalog and returns a pretty-printable summary of
 * every SDK in it. Supports --tag + --search filters for quick lookup
 * from the CLI without going through the MCP.
 */
export function runRegistryList(flags: ListFlags): ListResult {
  const catalogPath = resolve(flags.catalogPath ?? userCatalogPath());
  if (!existsSync(catalogPath)) {
    throw new Error(
      `No registry catalog at ${catalogPath}. Run 'projex registry refresh' first.`,
    );
  }
  const registry = loadRegistry(catalogPath);
  const all = registry.list();

  const tagLower = flags.tag?.toLowerCase();
  const searchLower = flags.search?.toLowerCase();

  const entries: ListEntry[] = all
    .filter((e) => {
      if (tagLower && !e.manifest.tags.some((t) => t.toLowerCase().includes(tagLower))) {
        return false;
      }
      if (searchLower) {
        const hay = (e.manifest.name + ' ' + e.manifest.summary).toLowerCase();
        if (!hay.includes(searchLower)) return false;
      }
      return true;
    })
    .map((e) => ({
      name: e.manifest.name,
      version: e.manifest.version,
      summary: e.manifest.summary,
      pool_placement: e.manifest.pool_placement,
      tags: e.manifest.tags,
      scenarios: e.manifest.scenarios.length,
      endpoints: e.manifest.provides.endpoints.length,
    }));

  return {
    catalogPath,
    total: all.length,
    filtered: entries.length,
    entries,
  };
}
