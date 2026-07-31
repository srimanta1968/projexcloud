/**
 * Backup designation and the acceptance window (P16 · EP-377 · PCF-04-3).
 *
 * The acceptance criterion is that the window EXPIRING is what hands the work to
 * the backup — nothing earlier. Two failures are being guarded against and they
 * pull in opposite directions: naming the backup while the primary still has time
 * invites a caller to notify them both (so the primary loses the offer they were
 * given), and never naming them leaves the work with somebody who has already
 * gone quiet. So the arithmetic is asserted on both sides of the deadline and
 * exactly on it.
 *
 * The arithmetic is pure and runs everywhere. The write side needs a database:
 *
 *   COVERAGE_IT=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/projexcloud_db \
 *     pnpm --filter @projexlight/sdk-coverage test
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { closeAllPools, dataService, initPool } from '@projexlight/db-runtime';
import {
  backupAfterExpiry,
  CoverageValidationError,
  designateBackup,
  listBackups,
} from '../src/services/presenceService';

const RUN = process.env.COVERAGE_IT === '1';
const suite = RUN ? describe : describe.skip;

const TENANT = randomUUID();
const PRIMARY = randomUUID();
const BACKUP = randomUUID();
const OTHER_BACKUP = randomUUID();

const OFFERED = new Date('2026-08-10T09:00:00Z');
const after = (minutes: number): Date => new Date(OFFERED.getTime() + minutes * 60_000);

/* --------------------------------------------------------------- pure */

describe('acceptance-window expiry (pure)', () => {
  const five = { backup_persona_id: BACKUP, acceptance_window_minutes: 5 };

  it('names nobody while the primary still has time', () => {
    const state = backupAfterExpiry(five, OFFERED, after(2));
    expect(state.expired).toBe(false);
    // falls_to is null ON PURPOSE while the window is open. A caller handed the
    // backup id early would notify them, and the primary would lose an offer they
    // were still inside the window for.
    expect(state.falls_to).toBeNull();
    expect(state.seconds_remaining).toBe(180);
  });

  it('falls to the backup once the window runs out', () => {
    const state = backupAfterExpiry(five, OFFERED, after(6));
    expect(state.expired).toBe(true);
    expect(state.falls_to).toBe(BACKUP);
    expect(state.seconds_remaining).toBe(0);
  });

  it('expires exactly ON the deadline, not a tick after it', () => {
    // A 5-minute window that is still open at 5:00 is a 5-minute-and-something
    // window, and the discrepancy shows up as work sitting unassigned past its SLA.
    const state = backupAfterExpiry(five, OFFERED, after(5));
    expect(state.expired).toBe(true);
    expect(state.falls_to).toBe(BACKUP);
  });

  it('treats a zero-minute window as an immediate handover', () => {
    // Zero means "notify the backup at the same time", which the schema requires to
    // be said explicitly rather than arrived at by leaving the field blank.
    const state = backupAfterExpiry(
      { backup_persona_id: BACKUP, acceptance_window_minutes: 0 }, OFFERED, OFFERED,
    );
    expect(state.expired).toBe(true);
    expect(state.falls_to).toBe(BACKUP);
    expect(state.seconds_remaining).toBe(0);
  });

  it('never reports negative time remaining', () => {
    // Somebody renders this in a UI; "-42s remaining" is a bug report waiting to
    // happen and the expired flag already carries the meaning.
    expect(backupAfterExpiry(five, OFFERED, after(90)).seconds_remaining).toBe(0);
  });

  it('rounds a part-second up so it is not reported as expired early', () => {
    const state = backupAfterExpiry(five, OFFERED, new Date(OFFERED.getTime() + 4 * 60_000 + 59_500));
    expect(state.expired).toBe(false);
    expect(state.seconds_remaining).toBe(1);
  });

  it('measures from the OFFER, not from the shift or from now', () => {
    // The same designation offered at two different instants expires at two
    // different instants; the window belongs to the offer.
    const early = backupAfterExpiry(five, OFFERED, after(4));
    const late = backupAfterExpiry(five, after(10), after(4));
    expect(early.expired).toBe(false);
    // Offered ten minutes in the FUTURE relative to the clock: not expired, and the
    // remaining time reflects the later offer rather than going negative.
    expect(late.expired).toBe(false);
    expect(late.seconds_remaining).toBe(11 * 60);
  });
});

/* -------------------------------------------------------- the write side */

suite('backup designation (integration)', () => {
  beforeAll(async () => {
    initPool({
      connectionString:
        process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/projexcloud_db',
      max: 4,
    });
  });

  afterAll(async () => {
    await dataService.query(`DELETE FROM coverage.backup_designation WHERE tenant_id = $1`, [TENANT]);
    await closeAllPools();
  });

  it('stores a designation with the default five-minute window', async () => {
    const row = await designateBackup({
      tenant_id: TENANT, primary_persona_id: PRIMARY, backup_persona_id: BACKUP, scope: 'queue-a',
    });
    expect(row.acceptance_window_minutes).toBe(5);
    expect(row.is_active).toBe(true);
  });

  it('drives the fallback end to end from a stored designation', async () => {
    const row = await designateBackup({
      tenant_id: TENANT, primary_persona_id: PRIMARY, backup_persona_id: BACKUP,
      scope: 'queue-b', acceptance_window_minutes: 15,
    });
    // The stored window, not a constant in the test: a designation edited in the
    // database has to change the moment the work falls over.
    const stillOffered = backupAfterExpiry(row, OFFERED, after(14));
    const expired = backupAfterExpiry(row, OFFERED, after(15));
    expect(stillOffered.falls_to).toBeNull();
    expect(expired.falls_to).toBe(BACKUP);
  });

  it('replaces the active designation for a scope rather than accumulating them', async () => {
    await designateBackup({
      tenant_id: TENANT, primary_persona_id: PRIMARY, backup_persona_id: BACKUP,
      scope: 'queue-c', acceptance_window_minutes: 5,
    });
    const updated = await designateBackup({
      tenant_id: TENANT, primary_persona_id: PRIMARY, backup_persona_id: OTHER_BACKUP,
      scope: 'queue-c', acceptance_window_minutes: 20,
    });
    expect(updated.backup_persona_id).toBe(OTHER_BACKUP);
    expect(updated.acceptance_window_minutes).toBe(20);

    // Two active rows for one scope would make "who catches this" ambiguous, and
    // whichever one the query happened to return first would decide it.
    const forScope = (await listBackups(TENANT)).filter((d) => d.scope === 'queue-c');
    expect(forScope).toHaveLength(1);
    expect(forScope[0].backup_persona_id).toBe(OTHER_BACKUP);
  });

  it('keeps designations for different scopes side by side', async () => {
    const scopes = (await listBackups(TENANT)).map((d) => d.scope).sort();
    expect(scopes).toEqual(['queue-a', 'queue-b', 'queue-c']);
  });

  it('refuses a persona as their own backup, with a sentence rather than a constraint name', async () => {
    await expect(designateBackup({
      tenant_id: TENANT, primary_persona_id: PRIMARY, backup_persona_id: PRIMARY,
    })).rejects.toBeInstanceOf(CoverageValidationError);
    await expect(designateBackup({
      tenant_id: TENANT, primary_persona_id: PRIMARY, backup_persona_id: PRIMARY,
    })).rejects.toThrow(/cannot be their own backup/);
  });

  it('refuses a negative or fractional acceptance window', async () => {
    for (const acceptance_window_minutes of [-1, 2.5]) {
      await expect(designateBackup({
        tenant_id: TENANT, primary_persona_id: PRIMARY, backup_persona_id: BACKUP,
        scope: 'queue-d', acceptance_window_minutes,
      })).rejects.toBeInstanceOf(CoverageValidationError);
    }
    // And nothing was written by the refused calls.
    expect((await listBackups(TENANT)).some((d) => d.scope === 'queue-d')).toBe(false);
  });
});
