import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { closeAllPools, dataService, initPool } from '@projexlight/db-runtime';
import {
  addRosterEntry,
  findRosterGaps,
  makeSlaOnCallResolver,
  resolveOnCall,
} from '../src/services/onCallService';
import {
  getCapacity,
  upsertCapacityPolicy,
  useLoadProvider,
} from '../src/services/capacityService';

/**
 * On-call resolution and capacity against a real database.
 *
 *   COVERAGE_IT=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/projexcloud_db \
 *     pnpm --filter @projexlight/sdk-coverage test
 */

const RUN = process.env.COVERAGE_IT === '1';
const suite = RUN ? describe : describe.skip;

const TENANT = randomUUID();
const ROTATION = `rot-${Date.now()}`;
const P1 = randomUUID();
const P2 = randomUUID();
const MGR = randomUUID();

const H = 3_600_000;
const BASE = new Date('2026-08-03T00:00:00Z').getTime();
const at = (hours: number): Date => new Date(BASE + hours * H);

/**
 * Pool lifecycle is file-level, not per-suite: a suite that closed the pool in
 * its own afterAll would leave every later suite in the file talking to a closed
 * connection, which surfaces as "pool 'default' not registered" rather than as
 * anything resembling the real problem.
 */
beforeAll(async () => {
  if (!RUN) return;
  initPool({
    connectionString:
      process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/projexcloud_db',
    max: 4,
  });
});

afterAll(async () => {
  if (!RUN) return;
  await dataService.query(`DELETE FROM coverage.on_call_roster WHERE tenant_id = $1`, [TENANT]);
  await dataService.query(`DELETE FROM coverage.capacity_policy WHERE tenant_id = $1`, [TENANT]);
  await closeAllPools();
});

suite('on-call resolution (integration)', () => {
  beforeAll(async () => {
    // Tier 1 covers 00:00-08:00 and 10:00-24:00, leaving a deliberate 2h hole.
    await addRosterEntry({ tenant_id: TENANT, rotation_ref: ROTATION, persona_id: P1, tier: 1, starts_at: at(0), ends_at: at(8) });
    await addRosterEntry({ tenant_id: TENANT, rotation_ref: ROTATION, persona_id: P2, tier: 1, starts_at: at(10), ends_at: at(24) });
    // Tier 2 covers the whole day; a manager is on duty for the morning only.
    await addRosterEntry({ tenant_id: TENANT, rotation_ref: ROTATION, persona_id: P2, tier: 2, starts_at: at(0), ends_at: at(24) });
    await addRosterEntry({
      tenant_id: TENANT, rotation_ref: ROTATION, persona_id: MGR, tier: 2,
      starts_at: at(0), ends_at: at(12), is_manager_on_duty: true,
    });
  });

  it('resolves the correct tier order at an instant', async () => {
    const r = await resolveOnCall({ tenant_id: TENANT, rotation_ref: ROTATION, at: at(3) });
    expect(r.tiers[0].tier).toBe(1);
    expect(r.tiers[0].persona_ids).toEqual([P1]);
    // Tier 1 first is the whole point: the ladder pages them before tier 2.
    expect(r.persona_ids[0]).toBe(P1);
    expect(r.uncovered).toBe(false);
  });

  it('reports the manager on duty only while they are rostered', async () => {
    const morning = await resolveOnCall({ tenant_id: TENANT, rotation_ref: ROTATION, at: at(3) });
    const evening = await resolveOnCall({ tenant_id: TENANT, rotation_ref: ROTATION, at: at(20) });
    expect(morning.manager_on_duty_ids).toContain(MGR);
    expect(evening.manager_on_duty_ids).not.toContain(MGR);
  });

  it('still resolves tier 2 during the tier-1 hole', async () => {
    const r = await resolveOnCall({ tenant_id: TENANT, rotation_ref: ROTATION, at: at(9) });
    expect(r.tiers.map((t) => t.tier)).toEqual([2]);
    expect(r.uncovered).toBe(false);
  });

  it('hands over cleanly at the boundary instant', async () => {
    // Half-open [starts_at, ends_at): at exactly 08:00 P1 is off, not doubled up.
    const r = await resolveOnCall({ tenant_id: TENANT, rotation_ref: ROTATION, at: at(8), max_tier: 1 });
    expect(r.persona_ids).not.toContain(P1);
    expect(r.uncovered).toBe(true);
  });

  it('says uncovered rather than returning an empty success', async () => {
    const r = await resolveOnCall({ tenant_id: TENANT, rotation_ref: `${ROTATION}-absent`, at: at(3) });
    expect(r.persona_ids).toEqual([]);
    expect(r.uncovered).toBe(true);
  });

  it('detects the tier-1 gap before the window opens', async () => {
    const gaps = await findRosterGaps({
      tenant_id: TENANT, rotation_ref: ROTATION, from: at(0), to: at(24), tier: 1,
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0].minutes).toBe(120);
    expect(gaps[0].starts_at).toBe(at(8).toISOString());
  });

  it('reports no gap on the fully covered tier', async () => {
    const gaps = await findRosterGaps({
      tenant_id: TENANT, rotation_ref: ROTATION, from: at(0), to: at(24), tier: 2,
    });
    expect(gaps).toEqual([]);
  });

  it('the sdk-sla resolver returns tier-ordered ids and empties honestly', async () => {
    const resolve = makeSlaOnCallResolver();
    const covered = await resolve({ tenant_id: TENANT, rotation_ref: ROTATION, at: at(3).toISOString() });
    expect(covered[0]).toBe(P1);
    // Empty, NOT a fallback: sdk-sla refuses to fire a rung at nobody and retries,
    // which surfaces the gap instead of hiding it behind a substitute audience.
    const empty = await resolve({ tenant_id: TENANT, rotation_ref: `${ROTATION}-absent`, at: at(3).toISOString() });
    expect(empty).toEqual([]);
  });
});

suite('capacity against a live load provider (integration)', () => {
  it('measures load live and freezes at the configured threshold', async () => {
    await upsertCapacityPolicy({
      tenant_id: TENANT,
      persona_id: P1,
      max_concurrent_by_band: { urgent: 2, standard: 10 },
      freeze_threshold_by_band: { standard: 0.5 },
    });

    // A provider standing in for sdk-assignment's open work. The point under test
    // is that the figure is asked for at evaluation time, not read from a column.
    let openUrgent = 0;
    useLoadProvider(async ({ persona_ids }) => {
      const out: Record<string, Record<string, number>> = {};
      for (const id of persona_ids) out[id] = { urgent: openUrgent, standard: 5 };
      return out;
    });

    const before = await getCapacity({ tenant_id: TENANT, persona_ids: [P1] });
    expect(before[0].bands.find((b) => b.band === 'urgent')).toMatchObject({ load: 0, frozen: false });
    // 5 of 10 with a 0.5 threshold is already frozen - headroom reserved on purpose.
    expect(before[0].bands.find((b) => b.band === 'standard')?.frozen).toBe(true);

    openUrgent = 2;
    const after = await getCapacity({ tenant_id: TENANT, persona_ids: [P1] });
    expect(after[0].bands.find((b) => b.band === 'urgent')?.frozen).toBe(true);
    expect(after[0].fully_frozen).toBe(true);

    useLoadProvider(null);
  });

  it('a persona-scoped policy beats a role-scoped one', async () => {
    await upsertCapacityPolicy({
      tenant_id: TENANT, role_ref: 'agent', max_concurrent_by_band: { urgent: 99 },
    });
    useLoadProvider(async ({ persona_ids }) => Object.fromEntries(persona_ids.map((id) => [id, {}])));

    const [p1, p2] = await getCapacity({
      tenant_id: TENANT, persona_ids: [P1, P2], role_ref: 'agent',
    });
    // P1 has their own policy (urgent 2); P2 falls back to the role's (urgent 99).
    expect(p1.bands.find((b) => b.band === 'urgent')?.limit).toBe(2);
    expect(p2.bands.find((b) => b.band === 'urgent')?.limit).toBe(99);

    useLoadProvider(null);
  });
});
