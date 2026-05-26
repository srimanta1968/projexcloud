/**
 * Resolves the catalog + (optional) embedding-index paths for the local
 * MCP. Lookup order:
 *
 *   1. Explicit env: PROJEX_CATALOG_PATH (overrides everything)
 *   2. User cache:   ~/.projex/cache/registry.catalog.json
 *   3. Dev fallback: <monorepo>/packages/sdk-registry/dist/registry.catalog.json
 *
 * Embeddings (optional) follow the same lookup but for .bin + .meta.json.
 * If embeddings are missing, the Registry's searchByIntent falls back to
 * substring matching (FR-MCP-L2 + FR-MCP-L5 graceful degradation).
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  EmbedderHandle,
  Registry,
  createEmbedder,
  loadRegistry,
} from '@projexlight/sdk-registry';

export interface ResolvedPaths {
  catalogPath: string;
  embeddingPaths?: { bin: string; meta: string };
  source: 'env' | 'user-cache' | 'dev-fallback';
}

export function resolveCatalogPaths(devRoot?: string): ResolvedPaths {
  const fromEnv = process.env.PROJEX_CATALOG_PATH;
  if (fromEnv) {
    const catalogPath = resolve(fromEnv);
    return {
      catalogPath,
      embeddingPaths: maybeEmbeddingsBeside(catalogPath),
      source: 'env',
    };
  }

  const userCacheCatalog = join(homedir(), '.projex', 'cache', 'registry.catalog.json');
  if (existsSync(userCacheCatalog)) {
    return {
      catalogPath: userCacheCatalog,
      embeddingPaths: maybeEmbeddingsBeside(userCacheCatalog),
      source: 'user-cache',
    };
  }

  if (devRoot) {
    const devCatalog = join(devRoot, 'packages', 'sdk-registry', 'dist', 'registry.catalog.json');
    if (existsSync(devCatalog)) {
      return {
        catalogPath: devCatalog,
        embeddingPaths: maybeEmbeddingsBeside(devCatalog),
        source: 'dev-fallback',
      };
    }
  }

  throw new Error(
    `No registry catalog found. Set PROJEX_CATALOG_PATH or run 'projex registry refresh' to download the latest catalog into ~/.projex/cache/.`,
  );
}

function maybeEmbeddingsBeside(catalogPath: string): { bin: string; meta: string } | undefined {
  const dir = catalogPath.replace(/registry\.catalog\.json$/, '');
  const bin = `${dir}registry.embeddings.bin`;
  const meta = `${dir}registry.embeddings.meta.json`;
  return existsSync(bin) && existsSync(meta) ? { bin, meta } : undefined;
}

/**
 * Boots the Registry. The embedder is lazy — created on the first call
 * to searchByIntent. This keeps server startup fast and avoids paying
 * the model load cost for clients that only use get_manifest/list_*.
 */
export async function bootRegistry(devRoot?: string): Promise<{
  registry: Registry;
  paths: ResolvedPaths;
}> {
  const paths = resolveCatalogPaths(devRoot);

  // Lazy embedder factory wrapped as EmbedderHandle. Initializes on
  // first embed() call.
  let embedderPromise: Promise<EmbedderHandle> | null = null;
  const lazyEmbedder: EmbedderHandle = {
    embed: async (text) => {
      if (!embedderPromise) embedderPromise = createEmbedder();
      return (await embedderPromise).embed(text);
    },
    embedAll: async (texts) => {
      if (!embedderPromise) embedderPromise = createEmbedder();
      return (await embedderPromise).embedAll(texts);
    },
  };

  const registry = loadRegistry(paths.catalogPath, {
    embeddingPaths: paths.embeddingPaths,
    embedder: paths.embeddingPaths ? lazyEmbedder : undefined,
  });

  return { registry, paths };
}
