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
