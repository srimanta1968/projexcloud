/**
 * P9 / E2.F2 — normalized catalog producer + dependency graph derivation.
 *
 * Determinism contract (AC-2):
 *   - Entries sorted by name
 *   - Inside each manifest's arrays, intra-array order preserved as authored
 *     (the manifest IS the source of truth — we don't re-sort SDK owners'
 *     intentional ordering)
 *   - Graph adjacency lists sorted alphabetically
 *   - serializeCatalog() produces stable JSON with sorted keys at every
 *     object so two builds against identical inputs produce byte-identical
 *     output
 *
 * built_at is the only non-deterministic field; CI sets it to the commit
 * timestamp via env so determinism survives.
 */

import { createHash } from 'node:crypto';
import { Catalog, CatalogEntry, DependencyGraph } from './types';
import { ScanResult } from './scanner';
import { SdkCapabilityManifest } from '@projexlight/sdk-capability';

export interface BuildCatalogOptions {
  scan: ScanResult[];
  /** ISO timestamp; default new Date().toISOString(). Set in CI for determinism. */
  built_at?: string;
}

export function buildCatalog(opts: BuildCatalogOptions): Catalog {
  const entries: CatalogEntry[] = opts.scan
    .filter((r): r is ScanResult & { status: 'OK'; manifest: SdkCapabilityManifest } =>
      r.status === 'OK' && !!r.manifest,
    )
    .map((r) => ({ path: r.path, manifest: r.manifest }))
    .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));

  const graph = deriveGraph(entries);
  const counts = countTotals(entries, graph);

  return {
    catalog_version: '1.0',
    built_at: opts.built_at ?? new Date().toISOString(),
    entries,
    graph,
    counts,
  };
}

/**
 * Derives the consumer↔producer graph from manifests:
 *   for every SDK X
 *     for every event Y in X.consumes.events
 *       find SDK Z where Y.name is in Z.provides.events
 *       add edge X → Z
 */
function deriveGraph(entries: CatalogEntry[]): DependencyGraph {
  const producers: Record<string, string[]> = {};
  const consumers: Record<string, string[]> = {};
  const edges: DependencyGraph['edges'] = [];

  for (const e of entries) {
    for (const ev of e.manifest.provides.events) {
      (producers[ev.name] ||= []).push(e.manifest.name);
    }
  }

  for (const consumer of entries) {
    for (const consumedEvent of consumer.manifest.consumes.events) {
      const producerSdks = producers[consumedEvent.name] ?? [];
      for (const producerName of producerSdks) {
        edges.push({
          consumer_sdk: consumer.manifest.name,
          producer_sdk: producerName,
          event: consumedEvent.name,
        });
      }
      (consumers[consumedEvent.name] ||= []).push(consumer.manifest.name);
    }
  }

  // Sort adjacency lists + edges for determinism.
  for (const k of Object.keys(producers)) producers[k].sort();
  for (const k of Object.keys(consumers)) consumers[k].sort();
  edges.sort((a, b) => {
    const k1 = `${a.consumer_sdk}|${a.producer_sdk}|${a.event}`;
    const k2 = `${b.consumer_sdk}|${b.producer_sdk}|${b.event}`;
    return k1.localeCompare(k2);
  });

  return { consumers, producers, edges };
}

function countTotals(entries: CatalogEntry[], graph: DependencyGraph) {
  const eventsProduced = Object.keys(graph.producers).length;
  const allConsumed = new Set<string>();
  for (const e of entries) {
    for (const ev of e.manifest.consumes.events) allConsumed.add(ev.name);
  }
  const unmatched = Array.from(allConsumed).filter((name) => !graph.producers[name]).length;

  return {
    sdks: entries.length,
    endpoints: entries.reduce((n, e) => n + e.manifest.provides.endpoints.length, 0),
    events_produced: eventsProduced,
    events_consumed_unmatched: unmatched,
    scenarios: entries.reduce((n, e) => n + e.manifest.scenarios.length, 0),
  };
}

/**
 * Returns a stable JSON string of the catalog (sorted keys at every object,
 * preserved array order). Two builds with identical inputs and identical
 * built_at produce byte-identical output. AC-2.
 */
export function serializeCatalog(catalog: Catalog): string {
  return stableStringify(catalog) + '\n';
}

/** sha256 hex of the serialized catalog bytes. Useful for CI determinism tests. */
export function catalogContentHash(catalog: Catalog): string {
  return createHash('sha256').update(serializeCatalog(catalog), 'utf-8').digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}
