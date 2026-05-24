/**
 * sdk-lineage deferred integration shim (S-4 / FR-TRC-1).
 *
 * sdk-trace pulls per-layer spans from sdk-telemetry + sdk-audit + sdk-meter
 * + sdk-lineage. sdk-lineage is P6B, so until it ships we need a graceful
 * fallback: detect at runtime whether sdk-lineage is loaded, and skip the
 * lineage layer in the timeline rather than crashing.
 *
 * The detector uses a runtime require() so static imports don't fail at
 * build time. P6B replaces this module with a real importer.
 */

export interface LineageEdge {
  edge_id: string;
  edge_type: 'extracted_from' | 'derived_from' | 'merged_from' | 'scored_by' | 'translated_by';
  source_id: string;
  target_id: string;
  recorded_at: string;
}

export interface LineageSource {
  available: boolean;
  /** Returns lineage edges referencing the given trace_id, or [] when unavailable. */
  edgesForTrace(trace_id: string): Promise<LineageEdge[]>;
}

const unavailable: LineageSource = {
  available: false,
  async edgesForTrace(): Promise<LineageEdge[]> {
    return [];
  },
};

let cached: LineageSource | null = null;

interface MaybeLineagePackage {
  getLineageEdgesForTrace?: (trace_id: string) => Promise<LineageEdge[]>;
}

/**
 * Returns a LineageSource. When @projexlight/sdk-lineage is installed, the
 * source delegates to its `getLineageEdgesForTrace` export. Otherwise the
 * source reports `available: false` and edgesForTrace returns [].
 *
 * Call once at boot — the result is cached for the process lifetime. P6B
 * sdk-lineage hot-swap requires a restart (acceptable: lineage is a P6B
 * SDK delivered as a versioned package, not a runtime config).
 */
export function getLineageSource(): LineageSource {
  if (cached) return cached;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod: MaybeLineagePackage = require('@projexlight/sdk-lineage');
    if (typeof mod.getLineageEdgesForTrace === 'function') {
      cached = {
        available: true,
        async edgesForTrace(trace_id: string): Promise<LineageEdge[]> {
          return mod.getLineageEdgesForTrace!(trace_id);
        },
      };
      return cached;
    }
  } catch {
    // sdk-lineage not installed — fall through to unavailable.
  }
  cached = unavailable;
  return cached;
}

/** Test/dev — clears the cached detection result. */
export function _resetLineageSourceCache(): void {
  cached = null;
}
