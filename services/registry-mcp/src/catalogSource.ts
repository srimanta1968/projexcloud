import { existsSync } from 'node:fs';
import {
  EmbedderHandle,
  Registry,
  createEmbedder,
  loadRegistry,
} from '@projexlight/sdk-registry';
import type { RegistryMcpConfig } from './config';

export interface BootedRegistry {
  registry: Registry;
  embeddingsLoaded: boolean;
}

export async function bootRegistry(cfg: RegistryMcpConfig): Promise<BootedRegistry> {
  if (!existsSync(cfg.catalogPath)) {
    throw new Error(`catalog file not found at ${cfg.catalogPath}`);
  }

  let embeddingPaths: { bin: string; meta: string } | undefined;
  if (
    cfg.embeddingsBinPath &&
    cfg.embeddingsMetaPath &&
    existsSync(cfg.embeddingsBinPath) &&
    existsSync(cfg.embeddingsMetaPath)
  ) {
    embeddingPaths = { bin: cfg.embeddingsBinPath, meta: cfg.embeddingsMetaPath };
  }

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

  const registry = loadRegistry(cfg.catalogPath, {
    embeddingPaths,
    embedder: embeddingPaths ? lazyEmbedder : undefined,
  });

  return { registry, embeddingsLoaded: !!embeddingPaths };
}
