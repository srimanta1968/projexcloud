import { getPool } from '@projexlight/db-runtime';

/**
 * App-level encounter-seal guard (P7 FR-EVD-5 / AC-11).
 *
 * The authoritative defense is the BEFORE INSERT trigger
 * evidence.block_capture_on_sealed_encounter() created by migration
 * 002_evidence_seal_guard.sql. This helper exists for two reasons:
 *
 *   1. Pre-flight check before kicking off a long-running capture
 *      (e.g. an upload-URL handoff) so the client gets a clean 409
 *      Conflict at the start, not after they've uploaded 50MB.
 *   2. Multi-pool deploys where evidence.capture lives in the Evidence
 *      Pool and engagement.encounter lives in the App Pool — the DB
 *      trigger gracefully no-ops in that topology (the engagement
 *      schema isn't there) and this helper has to do the work.
 */

export type EncounterSealState = 'open' | 'in-progress' | 'closed' | 'sealed' | 'missing';

export interface EncounterSealStatus {
  encounter_id: string;
  state: EncounterSealState;
  sealed_at: string | null;
}

/**
 * Look up an encounter's seal state. Returns 'missing' (not throwing) when
 * the encounter row doesn't exist so callers can compose with their own
 * 404 vs 409 mapping.
 */
export async function getEncounterSealStatus(encounterId: string): Promise<EncounterSealStatus> {
  const pool = getPool();
  const { rows } = await pool.query<{ state: string; sealed_at: Date | null }>(
    `SELECT state, sealed_at FROM engagement.encounter WHERE encounter_id = $1`,
    [encounterId],
  );
  if (rows.length === 0) {
    return { encounter_id: encounterId, state: 'missing', sealed_at: null };
  }
  const row = rows[0];
  return {
    encounter_id: encounterId,
    state: row.state as EncounterSealState,
    sealed_at: row.sealed_at ? row.sealed_at.toISOString() : null,
  };
}

/**
 * Error thrown when a caller tries to attach evidence to a sealed encounter.
 * Carries the encounter_id so the gateway can render a meaningful 409.
 */
export class EncounterSealedError extends Error {
  readonly code = 'encounter_sealed' as const;
  readonly status_code = 409;
  constructor(public readonly encounter_id: string, public readonly sealed_at: string | null) {
    super(
      `encounter ${encounter_id} is sealed${sealed_at ? ` (at ${sealed_at})` : ''} — no new evidence captures may reference it`,
    );
    this.name = 'EncounterSealedError';
  }
}

/**
 * Convenience guard: throw EncounterSealedError if the encounter is sealed.
 * Use at the entry point of any capture-creation flow.
 */
export async function assertEncounterNotSealed(encounterId: string): Promise<void> {
  const status = await getEncounterSealStatus(encounterId);
  if (status.state === 'sealed') {
    throw new EncounterSealedError(encounterId, status.sealed_at);
  }
}
