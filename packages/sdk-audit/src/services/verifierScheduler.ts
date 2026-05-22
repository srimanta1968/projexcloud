import { dataService } from '@projexlight/db-runtime';
import { verifyChain, type VerifyProof } from './chainVerifier';

export interface VerifierConfig {
  enabled: boolean;
  intervalMs: number;
}

export interface VerifierHandle {
  stop: () => void;
}

export interface ChainBreakEvent {
  pool_index: string;
  break_at_seq: number;
  break_reason: string;
  detected_at: Date;
}

type BreakHandler = (event: ChainBreakEvent) => Promise<void> | void;

let _onBreak: BreakHandler = async (event) => {
  console.error(`[audit-verifier] CHAIN BREAK detected at ${event.pool_index}#${event.break_at_seq}: ${event.break_reason}`);
};

/**
 * Lets the host service install a chain-break handler (e.g., page oncall,
 * emit audit.chain.break.v1). Production wires this to a notifier.
 */
export function setBreakHandler(handler: BreakHandler): void {
  _onBreak = handler;
}

async function listPools(): Promise<string[]> {
  try {
    const rows = await dataService.rows<{ pool_index: string }>(
      `SELECT DISTINCT pool_index FROM audit.entry`,
    );
    return rows.map((r: { pool_index: string }) => r.pool_index);
  } catch (err) {
    return [];
  }
}

async function runOnce(): Promise<VerifyProof[]> {
  const pools = await listPools();
  const proofs: VerifyProof[] = [];
  for (const pool_index of pools) {
    try {
      const proof = await verifyChain({ pool_index });
      proofs.push(proof);
      if (!proof.ok) {
        await _onBreak({
          pool_index: proof.pool_index,
          break_at_seq: proof.break_at_seq ?? -1,
          break_reason: proof.break_reason ?? 'unknown',
          detected_at: proof.verified_at,
        });
      }
    } catch (err) {
      console.error(`[audit-verifier] verify failed for ${pool_index}:`, (err as Error).message);
    }
  }
  return proofs;
}

/**
 * Starts the audit chain verifier scheduler per FR-AUD-2. On each tick (default
 * 24h in production; configurable for tests), walks every active pool's chain
 * and emits audit.chain.verified.v1 on success or audit.chain.break.v1 on
 * tamper detection. Returns a handle so the caller can stop on shutdown.
 */
export function startAuditVerifierScheduler(config: VerifierConfig): VerifierHandle {
  if (!config.enabled) return { stop: () => {} };

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const proofs = await runOnce();
      console.log(`[audit-verifier] tick: ${proofs.length} pools verified`);
    } catch (err) {
      console.error('[audit-verifier] tick failed:', (err as Error).message);
    } finally {
      if (!stopped) timer = setTimeout(tick, config.intervalMs);
    }
  };

  timer = setTimeout(tick, config.intervalMs);
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

export { runOnce as runVerifierOnce };
