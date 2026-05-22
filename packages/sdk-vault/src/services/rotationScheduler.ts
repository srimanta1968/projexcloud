import { listKeysDueForRotation, rotateKey, type OperatorContext } from './keyService';

export interface SchedulerConfig {
  intervalMs: number;
  maxAgeDays: number;
  enabled: boolean;
}

export interface SchedulerHandle {
  stop: () => void;
}

const SYSTEM_OPERATOR: OperatorContext = { kind: 'service', id: 'sdk-vault.rotation-scheduler' };

/**
 * Starts the key rotation scheduler. On each tick, lists keys past
 * `maxAgeDays`, rotates each through keyService.rotateKey (which logs to
 * vault.key_operation). Designed for a single-replica run; production wires
 * a distributed lock around the loop body.
 *
 * Returns a handle so the caller can stop the loop on shutdown.
 */
export function startRotationScheduler(config: SchedulerConfig): SchedulerHandle {
  if (!config.enabled) {
    return { stop: () => {} };
  }

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const due = await listKeysDueForRotation(config.maxAgeDays);
      for (const key of due) {
        if (stopped) break;
        try {
          await rotateKey(key.key_id, SYSTEM_OPERATOR, 'scheduled-rotation');
        } catch (err) {
          console.error(`[rotation-scheduler] failed to rotate ${key.key_id}:`, (err as Error).message);
        }
      }
    } catch (err) {
      console.error('[rotation-scheduler] tick failed:', (err as Error).message);
    } finally {
      if (!stopped) {
        timer = setTimeout(tick, config.intervalMs);
      }
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
