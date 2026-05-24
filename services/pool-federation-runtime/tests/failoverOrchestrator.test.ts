import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ORCHESTRATOR_CONFIG,
  startFailoverOrchestrator,
} from '../src/failoverOrchestrator';

describe('failoverOrchestrator surface', () => {
  it('exposes default config', () => {
    expect(DEFAULT_ORCHESTRATOR_CONFIG.intervalMs).toBe(10_000);
    expect(DEFAULT_ORCHESTRATOR_CONFIG.failureThreshold).toBe(3);
    expect(DEFAULT_ORCHESTRATOR_CONFIG.enabled).toBe(true);
  });

  it('disabled orchestrator never probes', async () => {
    const handle = startFailoverOrchestrator({
      enabled: false,
      probe: async () => ({
        region: 'noop',
        healthy: true,
        observed_at: new Date().toISOString(),
        latency_ms: 0,
      }),
    });
    // Brief delay so any accidental tick would have fired.
    await new Promise((r) => setTimeout(r, 50));
    expect(handle.stats().probes).toBe(0);
    await handle.stop();
  });
});
