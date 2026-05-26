import { existsSync, statSync } from 'node:fs';
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

/**
 * Indirection so MCP sessions can pick up a fresh Registry without
 * losing their open SSE connection. The handler calls ref.current
 * on every CallTool; the watcher atomically swaps the pointer when
 * the on-disk catalog changes.
 */
export interface RegistryRef {
  current: Registry;
  embeddingsLoaded: boolean;
  lastLoadedAt: number;
  lastSourceMtimeMs: number;
  reloadCount: number;
}

function loadOnce(cfg: RegistryMcpConfig): { registry: Registry; embeddingsLoaded: boolean } {
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

export async function bootRegistry(cfg: RegistryMcpConfig): Promise<BootedRegistry> {
  return loadOnce(cfg);
}

export function createRegistryRef(cfg: RegistryMcpConfig): RegistryRef {
  const { registry, embeddingsLoaded } = loadOnce(cfg);
  return {
    current: registry,
    embeddingsLoaded,
    lastLoadedAt: Date.now(),
    lastSourceMtimeMs: statSync(cfg.catalogPath).mtimeMs,
    reloadCount: 0,
  };
}

export interface WatcherHandle {
  stop(): void;
  /** Force an immediate reload check (test entrypoint). */
  tick(): { reloaded: boolean; reason: string };
}

/**
 * Polls the catalog file's mtime + atomically swaps RegistryRef.current
 * when it changes. Polling beats fs.watch on Windows + container
 * volumes (fs.watch silently no-ops on mounted filesystems).
 *
 * intervalMs ≤ 0 disables the timer; tick() still works for tests.
 */
export function startCatalogWatcher(
  cfg: RegistryMcpConfig,
  ref: RegistryRef,
  opts: { intervalMs?: number; onReload?: (info: { from: number; to: number }) => void } = {},
): WatcherHandle {
  const intervalMs = opts.intervalMs ?? 30_000;

  const tick = (): { reloaded: boolean; reason: string } => {
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(cfg.catalogPath);
    } catch (e) {
      return { reloaded: false, reason: `stat-failed: ${(e as Error).message}` };
    }
    if (stat.mtimeMs <= ref.lastSourceMtimeMs) {
      return { reloaded: false, reason: 'unchanged' };
    }
    try {
      const { registry, embeddingsLoaded } = loadOnce(cfg);
      const from = ref.lastSourceMtimeMs;
      ref.current = registry;
      ref.embeddingsLoaded = embeddingsLoaded;
      ref.lastLoadedAt = Date.now();
      ref.lastSourceMtimeMs = stat.mtimeMs;
      ref.reloadCount += 1;
      opts.onReload?.({ from, to: stat.mtimeMs });
      return { reloaded: true, reason: 'mtime-advanced' };
    } catch (e) {
      // Failed reload — keep the previous Registry serving traffic.
      return { reloaded: false, reason: `reload-failed: ${(e as Error).message}` };
    }
  };

  let timer: NodeJS.Timeout | null = null;
  if (intervalMs > 0) {
    timer = setInterval(tick, intervalMs);
    timer.unref();
  }

  return {
    stop: () => { if (timer) clearInterval(timer); },
    tick,
  };
}
