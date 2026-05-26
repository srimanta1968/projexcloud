/**
 * P9 / E2.F4 + F5 — runtime Registry API.
 *
 * Loads a previously-built catalog (dist/registry.catalog.json) and exposes
 * the read surface that the MCP servers (E3), CLI (E5), and cloud builder
 * (E6) all consume. searchByIntent is stubbed until the embedding work
 * (E2.F3) lands; it currently falls back to substring keyword search so
 * downstream consumers can be wired immediately.
 */

import { readFileSync } from 'node:fs';
import { Catalog, CatalogEntry, RegistryHit } from './types';
import { SdkCapabilityManifest } from '@projexlight/sdk-capability';
import {
  EmbedderHandle,
  EmbeddingIndex,
  loadEmbeddingIndex,
  searchEmbeddings,
} from './embeddings';

export interface Registry {
  /** All catalog entries in deterministic order. */
  list(): CatalogEntry[];
  /** Lookup by manifest name (e.g. "@projexlight/sdk-vault"). */
  get(name: string): CatalogEntry | null;
  /**
   * Intent-based search. Currently uses substring matching against the
   * summary + scenarios; will swap to bge-small embedding search in E2.F3
   * without changing the call surface.
   */
  searchByIntent(query: string, top_k?: number): Promise<RegistryHit[]>;
  /**
   * Returns SDK names whose consumes.events overlap with the target SDK's
   * provides.events (i.e. SDKs that would naturally compose with it).
   * Bidirectional: also returns SDKs whose provides.events the target
   * consumes.
   */
  findCompatibleSdks(name: string): string[];
}

export interface RegistryOptions {
  /** Optional embedding index for ANN-based searchByIntent (E2.F3). */
  embeddingIndex?: EmbeddingIndex;
  /** Optional embedder for query-time embedding. Required when embeddingIndex is set. */
  embedder?: EmbedderHandle;
}

export interface LoadRegistryOptions {
  /** Paths to a pre-built embedding index produced by sdk-registry-build. */
  embeddingPaths?: { bin: string; meta: string };
  /** Optional embedder for query-time embedding. */
  embedder?: EmbedderHandle;
}

/** Load a catalog (+ optional embedding index) and return a Registry. */
export function loadRegistry(catalogPath: string, opts: LoadRegistryOptions = {}): Registry {
  const raw = readFileSync(catalogPath, 'utf-8');
  const catalog = JSON.parse(raw) as Catalog;
  const embeddingIndex = opts.embeddingPaths
    ? loadEmbeddingIndex(opts.embeddingPaths.bin, opts.embeddingPaths.meta)
    : undefined;
  return registryFromCatalog(catalog, { embeddingIndex, embedder: opts.embedder });
}

/** Construct a Registry over an in-memory catalog (useful for tests). */
export function registryFromCatalog(catalog: Catalog, opts: RegistryOptions = {}): Registry {
  const byName = new Map<string, CatalogEntry>();
  for (const e of catalog.entries) byName.set(e.manifest.name, e);

  return {
    list: () => catalog.entries,

    get: (name) => byName.get(name) ?? null,

    async searchByIntent(query, top_k = 5): Promise<RegistryHit[]> {
      // Embedding path: ANN cosine over bge-small vectors when both
      // embedder + index are available. Aggregates per-SDK by taking the
      // best-scoring record (summary or scenario) per SDK.
      if (opts.embeddingIndex && opts.embedder) {
        const q = await opts.embedder.embed(query);
        const hits = searchEmbeddings(opts.embeddingIndex, q, top_k * 4);
        const bestBySdk = new Map<string, { score: number; scenarioIds: Set<string> }>();
        for (const h of hits) {
          const existing = bestBySdk.get(h.record.sdk_name);
          if (!existing || h.score > existing.score) {
            bestBySdk.set(h.record.sdk_name, {
              score: h.score,
              scenarioIds: new Set(existing?.scenarioIds ?? []),
            });
          }
          if (h.record.scenario_id) {
            bestBySdk.get(h.record.sdk_name)!.scenarioIds.add(h.record.scenario_id);
          }
        }
        const out: RegistryHit[] = [];
        for (const [name, info] of bestBySdk) {
          const entry = byName.get(name);
          if (!entry) continue;
          out.push({
            name,
            summary: entry.manifest.summary,
            score: info.score,
            scenarios: entry.manifest.scenarios
              .filter((s) => info.scenarioIds.has(s.id))
              .map((s) => ({ id: s.id, title: s.title })),
          });
        }
        return out.sort((a, b) => b.score - a.score).slice(0, top_k);
      }

      // Substring fallback when no embeddings are available.
      {
      const q = query.toLowerCase().trim();
      const tokens = q.split(/\s+/).filter(Boolean);
      if (tokens.length === 0) return [];

      const scored: RegistryHit[] = catalog.entries.map((e) => {
        const haystack = (
          e.manifest.summary +
          ' ' +
          e.manifest.tags.join(' ') +
          ' ' +
          e.manifest.scenarios.map((s) => s.title + ' ' + s.when_to_use).join(' ')
        ).toLowerCase();

        // Score = fraction of query tokens that appear, weighted toward summary hits.
        let hits = 0;
        for (const t of tokens) if (haystack.includes(t)) hits++;
        const score = hits / tokens.length;

        return {
          name: e.manifest.name,
          summary: e.manifest.summary,
          score,
          scenarios: e.manifest.scenarios.map((s) => ({ id: s.id, title: s.title })),
        };
      });

      return scored
        .filter((h) => h.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, top_k);
      }
    },

    findCompatibleSdks(name) {
      const target = byName.get(name);
      if (!target) return [];

      const targetProvides = new Set(target.manifest.provides.events.map((e) => e.name));
      const targetConsumes = new Set(target.manifest.consumes.events.map((e) => e.name));

      const out = new Set<string>();
      for (const other of catalog.entries) {
        if (other.manifest.name === name) continue;
        // Other consumes something we produce.
        for (const ev of other.manifest.consumes.events) {
          if (targetProvides.has(ev.name)) out.add(other.manifest.name);
        }
        // Other produces something we consume.
        for (const ev of other.manifest.provides.events) {
          if (targetConsumes.has(ev.name)) out.add(other.manifest.name);
        }
      }
      return Array.from(out).sort();
    },
  };
}

/**
 * Backward-compat wrapper. The full implementation lives in ./scaffold.ts
 * (E2 Phase 3). Re-exported here so callers that imported getScaffoldStub
 * during Phase 1 still resolve; new callers should use getScaffold from
 * the package root.
 */
export function getScaffoldStub(
  registry: Registry,
  sdk_names: string[],
  app_name: string,
): { app_name: string; sdk_names: string[]; notes: string } {
  return {
    app_name,
    sdk_names: sdk_names.filter((n) => registry.get(n) !== null),
    notes: 'Use getScaffold() from @projexlight/sdk-registry; this stub is kept for back-compat.',
  };
}

export type { Catalog, CatalogEntry, RegistryHit } from './types';
export type { SdkCapabilityManifest };
