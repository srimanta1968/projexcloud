/**
 * Canonical paths the CLI reads/writes. Centralized so tests can override
 * via environment variables.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

export function projexHome(): string {
  return process.env.PROJEX_HOME || join(homedir(), '.projex');
}

export function projexCacheDir(): string {
  return join(projexHome(), 'cache');
}

export function projexConfigPath(): string {
  return join(projexHome(), 'config.json');
}

export function userCatalogPath(): string {
  return join(projexCacheDir(), 'registry.catalog.json');
}

export function userEmbeddingsBinPath(): string {
  return join(projexCacheDir(), 'registry.embeddings.bin');
}

export function userEmbeddingsMetaPath(): string {
  return join(projexCacheDir(), 'registry.embeddings.meta.json');
}
