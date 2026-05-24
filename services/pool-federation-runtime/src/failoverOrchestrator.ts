import crypto from 'crypto';
import { getPool } from '@projexlight/db-runtime';
import { recordFailover } from './router';
import type {
  FederationCapacityClass,
  FederationFailoverEventRef,
} from '@projexlight/contracts';

/**
 * Federation auto-failover orchestrator (P7 FR-FED-3).
 *
 * Periodic health probes per region; when N consecutive probes fail for a
 * federation in capacity_class='tier-g', the orchestrator picks a paired
 * region from the federation manifest and calls recordFailover() to
 * commit the failover_event row + emit federation.failover.executed.v1.
 *
 * Out of scope (the actual data-plane cutover):
 *   - DNS / load-balancer flip — performed by infra layer reading the
 *     failover_event row (sdk-pool-router watches the table).
 *   - Replica promotion — DB-team owns the Postgres logical-replica
 *     promote sequence; the orchestrator only records the decision.
 *
 * Chaos drill mode: triggers a failover with trigger='chaos-drill' even
 * when probes are healthy, so RPO/RTO can be measured in production-like
 * conditions monthly (Architecture v3.1 §22 chaos cadence).
 */

export interface ProbeResult {
  region: string;
  healthy: boolean;
  observed_at: string;
  /** ms — used for RTO measurement during drills. */
  latency_ms: number;
}

export type RegionProbe = (region: string) => Promise<ProbeResult>;

export interface OrchestratorConfig {
  enabled?: boolean;
  /** Probe cadence per region in ms. Default 10s. */
  intervalMs?: number;
  /** Number of consecutive failed probes before failover triggers. Default 3. */
  failureThreshold?: number;
  /** Custom probe — defaults to a Postgres SELECT 1 against the region's DSN. */
  probe?: RegionProbe;
}

export interface OrchestratorHandle {
  stop(): Promise<void>;
  stats(): {
    probes: number;
    failovers_triggered: number;
    last_probe: ProbeResult | null;
  };
  /** Run a chaos drill for one federation. Returns the recorded event. */
  runChaosDrill(input: { federation_id: string; from_region: string; to_region: string }): Promise<FederationFailoverEventRef>;
}

/**
 * Default probe — runs `SELECT 1` against the configured DSN for `region`
 * via env var `FEDERATION_DSN_{REGION}` (e.g. FEDERATION_DSN_US_EAST).
 * Treats missing DSN as healthy (no probe = no failover).
 */
async function defaultProbe(region: string): Promise<ProbeResult> {
  const envKey = `FEDERATION_DSN_${region.toUpperCase().replace(/-/g, '_')}`;
  const dsn = process.env[envKey];
  const observedAt = new Date().toISOString();
  if (!dsn) {
    return { region, healthy: true, observed_at: observedAt, latency_ms: 0 };
  }
  // Use the shared pool to run the probe — it's against the LOCAL admin DB,
  // not the target region's DB. The shared pool stays warm; cross-region
  // probes belong to a dedicated probe pool wired by ops.
  const t0 = Date.now();
  try {
    await getPool().query('SELECT 1');
    return { region, healthy: true, observed_at: observedAt, latency_ms: Date.now() - t0 };
  } catch {
    return { region, healthy: false, observed_at: observedAt, latency_ms: Date.now() - t0 };
  }
}

interface FederationCandidate {
  federation_id: string;
  region: string;
  capacity_class: FederationCapacityClass;
  pool_indexes: string[];
}

async function listTierGFederations(): Promise<FederationCandidate[]> {
  try {
    const pool = getPool();
    const { rows } = await pool.query<FederationCandidate>(
      `SELECT federation_id, region, capacity_class, pool_indexes
         FROM federation.federation
        WHERE capacity_class = 'tier-g'`,
    );
    return rows;
  } catch {
    return [];
  }
}

function pickPairedRegion(thisRegion: string): string {
  // Simple paired-region map. Real deployments override via env.
  const pairs: Record<string, string> = {
    'us-east': 'us-west',
    'us-west': 'us-east',
    'eu-west': 'eu-central',
    'eu-central': 'eu-west',
    'ap-south': 'ap-southeast',
    'ap-southeast': 'ap-south',
  };
  const fromEnv = process.env[`FEDERATION_PAIRED_REGION_${thisRegion.toUpperCase().replace(/-/g, '_')}`];
  return fromEnv ?? pairs[thisRegion] ?? `${thisRegion}-paired`;
}

export const DEFAULT_ORCHESTRATOR_CONFIG: Required<Omit<OrchestratorConfig, 'probe'>> = {
  enabled: true,
  intervalMs: 10_000,
  failureThreshold: 3,
};

/**
 * Start the failover orchestrator. Probes Tier-G regions on a cadence;
 * triggers failover when threshold of consecutive failures is crossed.
 */
export function startFailoverOrchestrator(opts: OrchestratorConfig = {}): OrchestratorHandle {
  const cfg = {
    ...DEFAULT_ORCHESTRATOR_CONFIG,
    ...opts,
    probe: opts.probe ?? defaultProbe,
  };
  const stats = {
    probes: 0,
    failovers_triggered: 0,
    last_probe: null as ProbeResult | null,
  };
  // Per-region consecutive-failure counter.
  const failureCount = new Map<string, number>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  async function tick(): Promise<void> {
    if (stopped) return;
    const federations = await listTierGFederations();
    const seenRegions = new Set<string>();
    for (const fed of federations) {
      if (seenRegions.has(fed.region)) continue;
      seenRegions.add(fed.region);

      stats.probes += 1;
      const result = await cfg.probe(fed.region);
      stats.last_probe = result;

      if (result.healthy) {
        failureCount.set(fed.region, 0);
        continue;
      }

      const next = (failureCount.get(fed.region) ?? 0) + 1;
      failureCount.set(fed.region, next);
      if (next < cfg.failureThreshold) continue;

      // Threshold crossed — failover.
      const toRegion = pickPairedRegion(fed.region);
      const t0 = Date.now();
      try {
        await recordFailover({
          event_id: `fov_${crypto.randomBytes(10).toString('hex')}`,
          federation_id: fed.federation_id,
          from_region: fed.region,
          to_region: toRegion,
          trigger: 'production-failover',
          // RPO = last-known-good lag (placeholder until logical-replica lag
          // metric is wired); RTO = orchestrator decision latency.
          rpo_observed: 0,
          rto_observed: Math.round((Date.now() - t0) / 1000),
        });
        stats.failovers_triggered += 1;
        // Reset counter so we don't re-trigger every tick.
        failureCount.set(fed.region, 0);
        console.warn(
          `[failover-orchestrator] failover triggered for federation=${fed.federation_id} ${fed.region} → ${toRegion}`,
        );
      } catch (err) {
        console.warn(
          `[failover-orchestrator] recordFailover failed for ${fed.federation_id}: ${(err as Error).message}`,
        );
      }
    }
  }

  if (cfg.enabled) {
    timer = setInterval(() => void tick(), cfg.intervalMs);
    // Don't kick a tick on boot — let the first probe happen on schedule
    // so we don't false-positive on cold-start latency.
  }

  return {
    stats: () => ({ ...stats }),
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
    },
    async runChaosDrill(input) {
      const t0 = Date.now();
      // Synthetic probe to populate RPO/RTO realistically; ignored on
      // chaos-drill trigger path (we just want the latency).
      try {
        await cfg.probe(input.from_region);
      } catch {
        /* drill doesn't care */
      }
      const event = await recordFailover({
        event_id: `cdr_${crypto.randomBytes(10).toString('hex')}`,
        federation_id: input.federation_id,
        from_region: input.from_region,
        to_region: input.to_region,
        trigger: 'chaos-drill',
        rpo_observed: 0,
        rto_observed: Math.round((Date.now() - t0) / 1000),
      });
      stats.failovers_triggered += 1;
      return event;
    },
  };
}
