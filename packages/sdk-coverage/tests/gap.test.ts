/**
 * Gap detection ahead of the window (P16 · EP-377 · PCF-04-3).
 *
 * The acceptance criterion is a tense, not a value: the alert must fire BEFORE
 * the gap opens. So every assertion here pins the clock explicitly and checks the
 * relationship between the instant the scan ran and the instant the hole starts —
 * an alert delivered at 09:00 about a hole that opened at 08:00 is not an early
 * warning, it is a post-mortem.
 *
 * The pure interval arithmetic underneath (gapsBetween) is exhausted in
 * capacity.test.ts without a database. What needs a database is the part that
 * reads a real roster, so this suite is opt-in:
 *
 *   COVERAGE_IT=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/projexcloud_db \
 *     pnpm --filter @projexlight/sdk-coverage test
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { closeAllPools, dataService, initPool } from '@projexlight/db-runtime';
import { addRosterEntry } from '../src/services/onCallService';
import {
  detectGaps,
  GapWindowError,
  hasGapNotifier,
  scanAndAlert,
  setGapNotifier,
  type GapAlert,
} from '../src/services/gapService';

const RUN = process.env.COVERAGE_IT === '1';
const suite = RUN ? describe : describe.skip;

const TENANT = randomUUID();
/** A rotation with a deliberate 08:00-10:00 hole in tier 1. */
const HOLED = `rot-holed-${Date.now()}`;
/** A second holed rotation, so a failing delivery can be shown not to stop the rest. */
const ALSO_HOLED = `rot-also-${Date.now()}`;
/** Covered end to end — the control. */
const COVERED = `rot-covered-${Date.now()}`;

const P1 = randomUUID();
const P2 = randomUUID();

const H = 3_600_000;
const BASE = new Date('2026-08-10T00:00:00Z').getTime();
const at = (hours: number): Date => new Date(BASE + hours * H);
const DAY = { from: at(0), to: at(24) };

beforeAll(async () => {
  if (!RUN) return;
  initPool({
    connectionString:
      process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/projexcloud_db',
    max: 4,
  });
  for (const rotation_ref of [HOLED, ALSO_HOLED]) {
    await addRosterEntry({
      tenant_id: TENANT, rotation_ref, persona_id: P1, tier: 1, starts_at: at(0), ends_at: at(8),
    });
    await addRosterEntry({
      tenant_id: TENANT, rotation_ref, persona_id: P2, tier: 1, starts_at: at(10), ends_at: at(24),
    });
  }
  await addRosterEntry({
    tenant_id: TENANT, rotation_ref: COVERED, persona_id: P1, tier: 1, starts_at: at(0), ends_at: at(24),
  });
});

afterEach(() => {
  setGapNotifier(null);
});

afterAll(async () => {
  if (!RUN) return;
  setGapNotifier(null);
  await dataService.query(`DELETE FROM coverage.on_call_roster WHERE tenant_id = $1`, [TENANT]);
  await closeAllPools();
});

suite('gap detection is ahead of the window', () => {
  it('finds the hole and says how long there is to fix it', async () => {
    const gaps = await detectGaps({
      tenant_id: TENANT, rotation_ref: HOLED, ...DAY, now: at(5),
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0].starts_at).toBe(at(8).toISOString());
    expect(gaps[0].minutes).toBe(120);
    // Three hours of warning, stated as a number somebody can act on rather than
    // left to be derived from two timestamps.
    expect(gaps[0].minutes_until_start).toBe(180);
    expect(gaps[0].imminent).toBe(true);
    expect(gaps[0].in_progress).toBe(false);
  });

  it('states a gap that has already opened instead of hiding it', async () => {
    const [gap] = await detectGaps({
      tenant_id: TENANT, rotation_ref: HOLED, ...DAY, now: at(9),
    });
    expect(gap.in_progress).toBe(true);
    // Negative, not clamped to zero: "it opened an hour ago" and "it opens now"
    // are different situations and the caller must be able to tell them apart.
    expect(gap.minutes_until_start).toBe(-60);
    // No longer imminent — the warning window has been and gone.
    expect(gap.imminent).toBe(false);
  });

  it('honours the lead time exactly at its boundary', async () => {
    const base = { tenant_id: TENANT, rotation_ref: HOLED, ...DAY, now: at(5) };
    // Exactly 180 minutes away with a 180-minute lead: inside the window.
    expect((await detectGaps({ ...base, lead_minutes: 180 }))[0].imminent).toBe(true);
    expect((await detectGaps({ ...base, lead_minutes: 179 }))[0].imminent).toBe(false);
  });

  it('reports nothing for a rotation covered end to end', async () => {
    const gaps = await detectGaps({
      tenant_id: TENANT, rotation_ref: COVERED, ...DAY, now: at(5),
    });
    expect(gaps).toEqual([]);
  });

  it('refuses an inverted window rather than silently returning no gaps', async () => {
    // Returning [] here would read as "the rota is fine" for a question that was
    // never asked.
    await expect(detectGaps({
      tenant_id: TENANT, rotation_ref: HOLED, from: at(24), to: at(0),
    })).rejects.toBeInstanceOf(GapWindowError);
    await expect(detectGaps({
      tenant_id: TENANT, rotation_ref: HOLED, from: at(8), to: at(8),
    })).rejects.toBeInstanceOf(GapWindowError);
  });

  it('scans a tier that does not exist and reports the whole window uncovered', async () => {
    // Tier 2 was never rostered. A missing tier is uncovered, not absent data.
    const gaps = await detectGaps({
      tenant_id: TENANT, rotation_ref: HOLED, ...DAY, tier: 2, now: at(5),
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0].minutes).toBe(1440);
    expect(gaps[0].tier).toBe(2);
  });
});

suite('gap alerting', () => {
  it('alerts BEFORE the gap opens', async () => {
    const alerts: GapAlert[] = [];
    setGapNotifier((alert) => { alerts.push(alert); });
    expect(hasGapNotifier()).toBe(true);

    const now = at(5);
    const result = await scanAndAlert({
      tenant_id: TENANT, rotation_refs: [HOLED], ...DAY, now,
    });

    expect(result.scanned_rotations).toBe(1);
    expect(result.alerted).toHaveLength(1);
    expect(alerts).toHaveLength(1);
    // The assertion the whole feature exists for: the alert was raised while the
    // window was still in the future.
    expect(now.getTime()).toBeLessThan(Date.parse(alerts[0].gap.starts_at));
    expect(alerts[0].gap.minutes_until_start).toBeGreaterThan(0);
    expect(alerts[0].rotation_ref).toBe(HOLED);
    expect(alerts[0].tenant_id).toBe(TENANT);
    expect(result.alerting_unavailable).toBe(false);
  });

  it('does not page about a hole three weeks out', async () => {
    // It is a planning item. Paging on it at 3am teaches people to mute the
    // channel, after which the gap that opens in an hour goes unread too.
    const alerts: GapAlert[] = [];
    setGapNotifier((alert) => { alerts.push(alert); });

    const result = await scanAndAlert({
      tenant_id: TENANT, rotation_refs: [HOLED], ...DAY, now: new Date(BASE - 21 * 24 * H),
    });

    expect(result.gaps).toHaveLength(1); // still REPORTED …
    expect(result.gaps[0].imminent).toBe(false);
    expect(alerts).toEqual([]); // … just not paged about
    expect(result.alerted).toEqual([]);
    expect(result.alerting_unavailable).toBe(false);
  });

  it('does not re-page a gap that is already in progress', async () => {
    const alerts: GapAlert[] = [];
    setGapNotifier((alert) => { alerts.push(alert); });

    const result = await scanAndAlert({
      tenant_id: TENANT, rotation_refs: [HOLED], ...DAY, now: at(9),
    });

    // By now the escalation ladder is already failing loudly; a second alert adds
    // noise to an incident rather than information.
    expect(result.gaps[0].in_progress).toBe(true);
    expect(alerts).toEqual([]);
  });

  it('says so when there is nobody to alert, instead of reporting all-clear', async () => {
    expect(hasGapNotifier()).toBe(false);
    const result = await scanAndAlert({
      tenant_id: TENANT, rotation_refs: [HOLED], ...DAY, now: at(5),
    });
    expect(result.gaps).toHaveLength(1);
    expect(result.alerted).toEqual([]);
    // alerted=[] on its own is indistinguishable from "no gaps found". This flag is
    // the difference, and it is what stops a green dashboard during a hole.
    expect(result.alerting_unavailable).toBe(true);
  });

  it('reports alerting_unavailable only when there was something to alert about', async () => {
    const result = await scanAndAlert({
      tenant_id: TENANT, rotation_refs: [COVERED], ...DAY, now: at(5),
    });
    expect(result.gaps).toEqual([]);
    expect(result.alerting_unavailable).toBe(false);
  });

  it('keeps delivering after one alert fails, and does not count the failure as sent', async () => {
    const delivered: string[] = [];
    setGapNotifier(async (alert) => {
      if (alert.rotation_ref === HOLED) throw new Error('pager unreachable');
      delivered.push(alert.rotation_ref);
    });

    const result = await scanAndAlert({
      tenant_id: TENANT, rotation_refs: [HOLED, ALSO_HOLED, COVERED], ...DAY, now: at(5),
    });

    expect(result.scanned_rotations).toBe(3);
    expect(result.gaps).toHaveLength(2);
    expect(delivered).toEqual([ALSO_HOLED]);
    // The undelivered gap stays in `gaps` and out of `alerted`: the difference
    // between the two lists is the honest failure signal.
    expect(result.alerted.map((g) => g.rotation_ref)).toEqual([ALSO_HOLED]);
    expect(result.gaps.map((g) => g.rotation_ref).sort()).toEqual([ALSO_HOLED, HOLED].sort());
  });

  it('scans every rotation it was given, including the covered ones', async () => {
    const result = await scanAndAlert({
      tenant_id: TENANT, rotation_refs: [HOLED, ALSO_HOLED, COVERED], ...DAY, now: at(5),
    });
    // The count is of rotations SCANNED, not of rotations with holes — otherwise a
    // scan that silently skipped a rotation would look identical to a clean one.
    expect(result.scanned_rotations).toBe(3);
    expect(result.gaps.map((g) => g.rotation_ref).sort()).toEqual([ALSO_HOLED, HOLED].sort());
  });
});
