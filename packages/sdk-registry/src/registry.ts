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

/** Load a catalog from disk and return a Registry over it. */
export function loadRegistry(catalogPath: string): Registry {
  const raw = readFileSync(catalogPath, 'utf-8');
  const catalog = JSON.parse(raw) as Catalog;
  return registryFromCatalog(catalog);
}

/** Construct a Registry over an in-memory catalog (useful for tests). */
export function registryFromCatalog(catalog: Catalog): Registry {
  const byName = new Map<string, CatalogEntry>();
  for (const e of catalog.entries) byName.set(e.manifest.name, e);

  return {
    list: () => catalog.entries,

    get: (name) => byName.get(name) ?? null,

    async searchByIntent(query, top_k = 5) {
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

/** Stub kept so consumers can already import the symbol; full impl in E2.F6. */
export function getScaffoldStub(
  registry: Registry,
  sdk_names: string[],
  app_name: string,
): { app_name: string; sdk_names: string[]; notes: string } {
  return {
    app_name,
    sdk_names: sdk_names.filter((n) => registry.get(n) !== null),
    notes: 'E2.F6 getScaffold pending — currently a no-op stub; tree generation lands in next phase.',
  };
}

export type { Catalog, CatalogEntry, RegistryHit } from './types';
export type { SdkCapabilityManifest };
