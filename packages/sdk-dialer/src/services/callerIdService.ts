import { dataService } from '@projexlight/db-runtime';
import { notFound, validationError } from '../models/errors';

/**
 * The tenant's caller-ID pool (VA·E5 · TK-4487).
 *
 * pickCallerId chooses the number an outbound call presents: among the tenant's ACTIVE
 * numbers (narrowed to the campaign's caller_id_pool when it has one), a number sharing
 * the destination's NANP area code first ("local presence" answers more often), then the
 * least recently used. The pick is stamped with last_used_at so load spreads across the
 * pool. Attestation is the STIR/SHAKEN level the tenant's carrier signs the number at.
 */

export const ATTESTATIONS = ['A', 'B', 'C'] as const;
export type Attestation = (typeof ATTESTATIONS)[number];

export interface CallerId {
  caller_id_id: string;
  phone_number: string;
  attestation: Attestation;
  label: string | null;
  active: boolean;
  last_used_at: string | null;
  created_at: string;
}

const E164_RE = /^\+[1-9][0-9]{6,14}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLS = `caller_id_id, phone_number, attestation, label, active, last_used_at, created_at`;
const iso = (r: CallerId): CallerId => ({
  ...r,
  last_used_at: r.last_used_at ? new Date(r.last_used_at).toISOString() : null,
  created_at: new Date(r.created_at).toISOString(),
});

/** Adds a number to the pool (or re-activates it with the new attestation). */
export async function addCallerId(tenantId: string, input: { phone_number?: unknown; attestation?: unknown; label?: unknown }): Promise<CallerId> {
  if (typeof input.phone_number !== 'string' || !E164_RE.test(input.phone_number)) throw validationError('phone_number must be E.164, e.g. +14155550100');
  const attestation = input.attestation ?? 'B';
  if (!(ATTESTATIONS as readonly unknown[]).includes(attestation)) throw validationError('attestation must be A, B or C');
  if (input.label !== undefined && input.label !== null && (typeof input.label !== 'string' || input.label.length > 120)) throw validationError('label must be at most 120 characters');
  const row = await dataService.one<CallerId>(
    `INSERT INTO dialer.caller_id (tenant_id, phone_number, attestation, label)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, phone_number) DO UPDATE SET
       attestation = EXCLUDED.attestation, label = COALESCE(EXCLUDED.label, dialer.caller_id.label),
       active = true, updated_at = now()
     RETURNING ${COLS}`,
    [tenantId, input.phone_number, attestation, input.label ?? null],
  );
  return iso(row as CallerId);
}

export async function listCallerIds(tenantId: string, opts: { active?: string } = {}): Promise<CallerId[]> {
  if (opts.active !== undefined && opts.active !== 'true' && opts.active !== 'false') throw validationError('active must be true or false');
  const rows = await dataService.rows<CallerId>(
    `SELECT ${COLS} FROM dialer.caller_id
      WHERE tenant_id = $1 AND ($2::boolean IS NULL OR active = $2::boolean)
      ORDER BY phone_number`,
    [tenantId, opts.active === undefined ? null : opts.active === 'true'],
  );
  return rows.map(iso);
}

/** Takes a number out of rotation (kept for history; re-add to re-activate). */
export async function deactivateCallerId(tenantId: string, callerIdId: string): Promise<CallerId> {
  if (!UUID_RE.test(callerIdId)) throw notFound('caller ID not found');
  const row = await dataService.one<CallerId>(
    `UPDATE dialer.caller_id SET active = false, updated_at = now()
      WHERE tenant_id = $1 AND caller_id_id = $2 RETURNING ${COLS}`,
    [tenantId, callerIdId],
  );
  if (!row) throw notFound('caller ID not found');
  return iso(row);
}

/** NANP area code of an E.164 number (+1 NPA ...), else null. */
const npa = (n: string): string | null => (n.startsWith('+1') && n.length === 12 ? n.slice(2, 5) : null);

/**
 * Picks and stamps a caller ID for a call to `toNumber`. Returns null when the tenant has
 * no usable number (the call cannot be presented and must not be placed).
 */
export async function pickCallerId(tenantId: string, toNumber: string, campaignPool: string[] | null): Promise<{ phone_number: string; attestation: Attestation } | null> {
  const restrict = campaignPool && campaignPool.length > 0 ? campaignPool : null;
  const row = await dataService.one<{ phone_number: string; attestation: Attestation }>(
    `UPDATE dialer.caller_id SET last_used_at = now(), updated_at = now()
      WHERE caller_id_id = (
        SELECT caller_id_id FROM dialer.caller_id
         WHERE tenant_id = $1 AND active AND ($2::text[] IS NULL OR phone_number = ANY($2::text[]))
         ORDER BY (substring(phone_number from 3 for 3) = $3) DESC NULLS LAST, last_used_at NULLS FIRST, phone_number
         LIMIT 1
         FOR UPDATE SKIP LOCKED)
      RETURNING phone_number, attestation`,
    [tenantId, restrict, npa(toNumber) ?? ''],
  );
  return row ?? null;
}

/** Guard used when a caller asked for a specific from number: it must be an active pool number. */
export async function ownedCallerId(tenantId: string, phoneNumber: string): Promise<{ phone_number: string; attestation: Attestation } | null> {
  return dataService.one<{ phone_number: string; attestation: Attestation }>(
    `SELECT phone_number, attestation FROM dialer.caller_id WHERE tenant_id = $1 AND phone_number = $2 AND active`,
    [tenantId, phoneNumber],
  );
}

