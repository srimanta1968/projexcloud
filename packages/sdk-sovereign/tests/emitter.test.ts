import { describe, it, expect } from 'vitest';
import { setSovereignEmitter } from '../src/services/regionService';

describe('sdk-sovereign emitter wiring', () => {
  it('setSovereignEmitter replaces the default emitter without throwing', async () => {
    const seen: Array<{ event_type: string; region_id: string }> = [];
    setSovereignEmitter(async (e) => {
      seen.push({ event_type: e.event_type, region_id: e.region_id });
    });
    // Sanity: the function should be replaceable repeatedly.
    setSovereignEmitter(() => undefined);
    setSovereignEmitter(async (e) => {
      seen.push({ event_type: e.event_type, region_id: e.region_id });
    });
    expect(seen.length).toBe(0); // emit isn't fired here; only registration tested
  });
});
