import { verifyAllMeterChains, type MeterChainProof } from './chainVerifier';

export interface MeterVerifierConfig {
  enabled: boolean;
  intervalMs: number;
}

export interface MeterVerifierHandle {
  stop: () => void;
}

type BreakHandler = (proof: MeterChainProof) => Promise<void> | void;

let _onBreak: BreakHandler = (proof) => {
  console.error(
    `[meter-verifier] CHAIN BREAK tenant=${proof.tenant_id} day=${proof.break_at_day} reason="${proof.break_reason}"`,
  );
};

export function setMeterBreakHandler(handler: BreakHandler): void {
  _onBreak = handler;
}

/**
 * Starts the meter usage-ledger chain verifier scheduler (AC-11). On each
 * tick walks every tenant's chain; emits to the break handler when tamper
 * is detected. Pair with `setMeterBreakHandler` to send a `usage.chain.break.v1`
 * audit event in production.
 */
export function startMeterVerifierScheduler(cfg: MeterVerifierConfig): MeterVerifierHandle {
  if (!cfg.enabled) return { stop: () => {} };
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const proofs = await verifyAllMeterChains();
      for (const p of proofs) {
        if (!p.ok) await _onBreak(p);
      }
      console.log(`[meter-verifier] tick: ${proofs.length} tenants verified, ${proofs.filter((p) => !p.ok).length} breaks`);
    } catch (err) {
      console.error('[meter-verifier] tick failed:', (err as Error).message);
    } finally {
      if (!stopped) timer = setTimeout(tick, cfg.intervalMs);
    }
  };

  timer = setTimeout(tick, cfg.intervalMs);
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
