/**
 * @projexlight/sdk-registry — P9 / E2 types.
 *
 * The catalog is the single source of truth that the MCP servers (E3),
 * CLI (E5), and cloud builder (E6) all read from. Deterministic per
 * content hash so CI builds are byte-identical when inputs unchanged
 * (AC-2 in PRD §7).
 */

import { SdkCapabilityManifest } from '@projexlight/sdk-capability';

/** A single SDK in the catalog. */
export interface CatalogEntry {
  /** Workspace-relative path, e.g. "packages/sdk-vault". */
  path: string;
  /** Manifest as authored. */
  manifest: SdkCapabilityManifest;
}

/**
 * Adjacency graph derived from manifests.
 *
 * `consumers[event_name]` lists the SDKs that consume the event.
 * `producers[event_name]` lists the SDKs that produce it (typically 1).
 * `edges` is the bipartite consumer → producer list, useful for graph
 * traversal (which SDKs do I depend on transitively).
 */
export interface DependencyGraph {
  consumers: Record<string, string[]>;
  producers: Record<string, string[]>;
  edges: Array<{ consumer_sdk: string; producer_sdk: string; event: string }>;
}

/** Full normalized catalog. Written to dist/registry.catalog.json. */
export interface Catalog {
  /** Catalog spec version — pinned at "1.0" for now. */
  catalog_version: '1.0';
  /** ISO timestamp the catalog was built at (deterministic per inputs only when build_at is omitted; CI sets via env). */
  built_at: string;
  /** SDKs sorted by manifest.name for deterministic output. */
  entries: CatalogEntry[];
  /** Derived graph. */
  graph: DependencyGraph;
  /** Counts for at-a-glance health. */
  counts: {
    sdks: number;
    endpoints: number;
    events_produced: number;
    events_consumed_unmatched: number;
    scenarios: number;
  };
}

/** Returned by registry.searchByIntent (E2.F3 embedding work plugs in here). */
export interface RegistryHit {
  name: string;
  summary: string;
  score: number;
  scenarios: Array<{ id: string; title: string }>;
}

/** A virtual file tree returned by getScaffold(). Caller writes to disk. */
export interface ScaffoldTree {
  app_name: string;
  files: Array<{ path: string; contents: string }>;
}
