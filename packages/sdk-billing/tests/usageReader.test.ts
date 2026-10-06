import { describe, expect, it, vi } from 'vitest';

// persona.persona lookups go through db-runtime; the ClickHouse query is injected.
vi.mock('@projexlight/db-runtime', () => ({
  dataService: {
    one: vi.fn(async () => ({ exists: true })),
    rows: vi.fn(async () => [
      { persona_id: '11111111-1111-1111-1111-111111111111', kind: 'clinician' },
      { persona_id: '22222222-2222-2222-2222-222222222222', kind: 'clinician' },
    ]),
  },
}));

import { ClickHouseUsageReader, type UsageReader } from '../src/services/usageReader';

const today = new Date().toISOString().slice(0, 10);
const period = { tenant_id: 't-1', period_start: today, period_end: today };

describe('ClickHouseUsageReader (TK-3235)', () => {
  it('keeps the app/BU/encounter splits and collapses persona_id to its kind', async () => {
    const ch = vi.fn(async () => [
      { sku: 'api.call', app_id: 'app-a', bu_id: 'bu-1', persona_id: '11111111-1111-1111-1111-111111111111', encounter_id: '', actor_kind: 'human', units: '3' },
      { sku: 'api.call', app_id: 'app-a', bu_id: 'bu-1', persona_id: '22222222-2222-2222-2222-222222222222', encounter_id: '', actor_kind: 'human', units: '4' },
      { sku: 'api.call', app_id: 'app-b', bu_id: '', persona_id: '', encounter_id: 'enc-9', actor_kind: 'agent', units: '5' },
    ]);
    const usage = await new ClickHouseUsageReader(ch as never).readUsage(period);
    expect(usage).toHaveLength(2);
    expect(usage).toContainEqual(expect.objectContaining({ app_id: 'app-a', bu_id: 'bu-1', persona_kind: 'clinician', encounter_id: null, units: 7 }));
    expect(usage).toContainEqual(expect.objectContaining({ app_id: 'app-b', bu_id: null, persona_kind: null, encounter_id: 'enc-9', actor_kind: 'agent', units: 5 }));
  });

  it('falls back to the ledger reader when ClickHouse fails, has no events, or the period is past raw retention', async () => {
    const fallback: UsageReader = { readUsage: vi.fn(async () => [{ sku: 'x', app_id: null, bu_id: null, persona_kind: null, encounter_id: null, actor_kind: null, units: 1 }]) };
    const failing = new ClickHouseUsageReader((async () => { throw new Error('down'); }) as never, fallback);
    expect(await failing.readUsage(period)).toHaveLength(1);
    const ch = vi.fn();
    await new ClickHouseUsageReader(ch as never, fallback).readUsage({ ...period, period_start: '2020-01-01' });
    expect(ch).not.toHaveBeenCalled();
    expect(await new ClickHouseUsageReader((async () => []) as never, fallback).readUsage(period)).toHaveLength(1);
    expect(fallback.readUsage).toHaveBeenCalledTimes(3);
  });

  it('reports the newest event time for live-meter lag, null when the tenant has none', async () => {
    const reader = new ClickHouseUsageReader((async () => [{ n: '2', last: '2026-10-06 10:00:00.000' }]) as never);
    expect((await reader.lastEventAt({ tenant_id: 't-1', since: today }))?.toISOString()).toBe('2026-10-06T10:00:00.000Z');
    const empty = new ClickHouseUsageReader((async () => [{ n: '0', last: '1970-01-01 00:00:00.000' }]) as never);
    expect(await empty.lastEventAt({ tenant_id: 't-1', since: today })).toBeNull();
  });
});
