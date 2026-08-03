import { dataService } from '@projexlight/db-runtime';

/**
 * Bitemporal contextual roles (P16 · EP-384).
 *
 * A subject-object pair is not one relationship. Someone can be a patient's daughter AND
 * their registered carer AND their billing contact simultaneously, each starting and
 * ending on its own date and each believed for a different reason. Collapsing those into a
 * single edge forces a choice nobody should have to make — lose the distinction, or
 * overwrite a role that is still true — so role_label separates them and valid_from /
 * valid_to give each its own life.
 *
 * TRUST AND VALIDITY ARE DIFFERENT AXES. "Is this in force now" and "how sure are we it is
 * real" have different remedies: an expired carer role needs renewing, an unevidenced one
 * needs a document. A single `status` answers "inactive" to both and tells the operator
 * nothing about which.
 *
 * CLOSING IS NEVER A DELETE. Setting valid_to keeps the row answering the question "who
 * was the carer last March", which is exactly the question asked when something has gone
 * wrong. A deleted row cannot answer it.
 *
 * ADDITIVE: this module only adds functions. Existing relationship and role-assignment
 * services are untouched.
 */

export type TrustState = 'CONFIRMED' | 'CANDIDATE' | 'DOCUMENTED';

export const TRUST_STATES: TrustState[] = ['CONFIRMED', 'CANDIDATE', 'DOCUMENTED'];

/** The states whose whole meaning is "somebody checked" — so they must say what they checked. */
export const EVIDENCE_REQUIRED_STATES: TrustState[] = ['CONFIRMED', 'DOCUMENTED'];

export function requiresEvidence(trust_state: TrustState): boolean {
  return EVIDENCE_REQUIRED_STATES.includes(trust_state);
}

export interface ContextualRole {
  relationship_id: string;
  kind: string;
  persona_a: string;
  persona_b: string;
  role_label: string | null;
  trust_state: TrustState;
  valid_from: string;
  valid_to: string | null;
  closed_reason: string | null;
  evidence_refs: string[];
  scope: Record<string, unknown>;
  status: string;
  created_at: string;
}

interface RoleRow {
  relationship_id: string;
  kind: string;
  persona_a: string;
  persona_b: string;
  role_label: string | null;
  trust_state: string;
  valid_from: Date;
  valid_to: Date | null;
  closed_reason: string | null;
  evidence_refs: string[] | null;
  scope: Record<string, unknown> | null;
  status: string;
  created_at: Date;
}

const ROLE_COLUMNS = `
  relationship_id::text, kind, persona_a::text, persona_b::text, role_label, trust_state,
  valid_from, valid_to, closed_reason, evidence_refs, scope, status, created_at`;

function rowToRole(r: RoleRow): ContextualRole {
  return {
    relationship_id: r.relationship_id,
    kind: r.kind,
    persona_a: r.persona_a,
    persona_b: r.persona_b,
    role_label: r.role_label,
    trust_state: r.trust_state as TrustState,
    valid_from: r.valid_from.toISOString(),
    valid_to: r.valid_to ? r.valid_to.toISOString() : null,
    closed_reason: r.closed_reason,
    evidence_refs: r.evidence_refs ?? [],
    scope: r.scope ?? {},
    status: r.status,
    created_at: r.created_at.toISOString(),
  };
}

export interface GrantContextualRoleInput {
  kind: string;
  persona_a: string;
  persona_b: string;
  role_label?: string | null;
  trust_state?: TrustState;
  evidence_refs?: string[];
  valid_from?: string | Date;
  scope?: Record<string, unknown>;
  cross_tenant?: boolean;
}

/**
 * Grant one contextual role.
 *
 * The evidence rule is enforced here AND by a CHECK constraint. Both, deliberately: the
 * service gives a readable error naming the two states, and the constraint makes an
 * unevidenced CONFIRMED row unrepresentable however it was written — a backfill or a
 * direct insert cannot slip past a service-layer check.
 */
export async function grantContextualRole(
  input: GrantContextualRoleInput,
): Promise<ContextualRole> {
  const trust: TrustState = input.trust_state ?? 'CANDIDATE';
  if (!TRUST_STATES.includes(trust)) {
    throw new Error(`[sdk-rebac] trust_state must be one of: ${TRUST_STATES.join(', ')}`);
  }
  const evidence = (input.evidence_refs ?? []).map((e) => String(e).trim()).filter(Boolean);
  if (requiresEvidence(trust) && evidence.length === 0) {
    throw new Error(
      `[sdk-rebac] trust_state '${trust}' requires at least one evidence_ref — a ${trust} role ` +
        'with nothing behind it reads as checked to every downstream reader while resting on nothing',
    );
  }
  if (input.persona_a === input.persona_b) {
    throw new Error('[sdk-rebac] a persona cannot hold a contextual role to itself');
  }

  const row = await dataService.one<RoleRow>(
    `INSERT INTO rebac.relationship
       (kind, persona_a, persona_b, role_label, trust_state, evidence_refs,
        valid_from, scope, status, cross_tenant)
     VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6::text[],
             COALESCE($7::timestamptz, now()), COALESCE($8::jsonb, '{}'::jsonb), 'active', $9)
     RETURNING ${ROLE_COLUMNS}`,
    [
      input.kind,
      input.persona_a,
      input.persona_b,
      input.role_label ?? null,
      trust,
      evidence,
      input.valid_from ? new Date(input.valid_from).toISOString() : null,
      input.scope ? JSON.stringify(input.scope) : null,
      input.cross_tenant ?? false,
    ],
  );
  if (!row) throw new Error('[sdk-rebac] grantContextualRole insert failed');
  return rowToRole(row);
}

/**
 * Close a role by setting valid_to. NEVER a delete.
 *
 * Idempotent: closing an already-closed role returns it unchanged rather than moving the
 * date, because the first close is when it actually stopped being true and a second call
 * (a retry, a double-click) must not rewrite history.
 */
export async function closeContextualRole(input: {
  relationship_id: string;
  valid_to?: string | Date;
  reason?: string;
}): Promise<ContextualRole | null> {
  const row = await dataService.one<RoleRow>(
    `UPDATE rebac.relationship
        SET valid_to = COALESCE(valid_to, COALESCE($2::timestamptz, now())),
            closed_reason = COALESCE(closed_reason, $3),
            status = CASE WHEN valid_to IS NULL THEN 'terminated' ELSE status END,
            terminated_at = COALESCE(terminated_at, now())
      WHERE relationship_id = $1::uuid
    RETURNING ${ROLE_COLUMNS}`,
    [
      input.relationship_id,
      input.valid_to ? new Date(input.valid_to).toISOString() : null,
      input.reason ?? null,
    ],
  );
  return row ? rowToRole(row) : null;
}

export interface ListRolesInput {
  persona_a: string;
  persona_b?: string;
  kind?: string;
  role_label?: string;
  trust_state?: TrustState;
  /** Include roles already closed — the provenance view. */
  include_closed?: boolean;
  /** Ask what held at a past instant. NULL/omitted means "now". */
  as_of?: string | Date;
  limit?: number;
}

/**
 * List roles for a pair.
 *
 * `as_of` is the bitemporal read: valid_from <= t AND (valid_to IS NULL OR valid_to > t).
 * It is what lets "who was the carer last March" be answered from the same rows that
 * answer "who is the carer now" — no snapshot table, no history table, no divergence
 * between the two.
 */
export async function listContextualRoles(input: ListRolesInput): Promise<ContextualRole[]> {
  const asOf = input.as_of ? new Date(input.as_of).toISOString() : null;
  const res = await dataService.query<RoleRow>(
    `SELECT ${ROLE_COLUMNS}
       FROM rebac.relationship
      WHERE persona_a = $1::uuid
        AND ($2::uuid IS NULL OR persona_b = $2::uuid)
        AND ($3::text IS NULL OR kind = $3)
        AND ($4::text IS NULL OR role_label = $4)
        AND ($5::text IS NULL OR trust_state = $5)
        AND (
          $6::boolean IS TRUE
          OR (
            valid_from <= COALESCE($7::timestamptz, now())
            AND (valid_to IS NULL OR valid_to > COALESCE($7::timestamptz, now()))
          )
        )
      ORDER BY valid_from DESC, relationship_id
      LIMIT $8`,
    [
      input.persona_a,
      input.persona_b ?? null,
      input.kind ?? null,
      input.role_label ?? null,
      input.trust_state ?? null,
      input.include_closed ?? false,
      asOf,
      Math.min(Math.max(input.limit ?? 200, 1), 1000),
    ],
  );
  return res.rows.map(rowToRole);
}

/**
 * Re-state the trust in an existing role.
 *
 * Promoting to CONFIRMED or DOCUMENTED requires evidence in the SAME call — either newly
 * supplied or already on the row. Allowing a promotion first and evidence later would
 * leave a window in which an unevidenced CONFIRMED role exists, which is the exact state
 * the constraint is there to prevent.
 */
export async function attestContextualRole(input: {
  relationship_id: string;
  trust_state: TrustState;
  evidence_refs?: string[];
}): Promise<ContextualRole | null> {
  if (!TRUST_STATES.includes(input.trust_state)) {
    throw new Error(`[sdk-rebac] trust_state must be one of: ${TRUST_STATES.join(', ')}`);
  }
  const incoming = (input.evidence_refs ?? []).map((e) => String(e).trim()).filter(Boolean);

  const current = await dataService.one<{ evidence_refs: string[] | null }>(
    `SELECT evidence_refs FROM rebac.relationship WHERE relationship_id = $1::uuid`,
    [input.relationship_id],
  );
  if (!current) return null;

  const merged = Array.from(new Set([...(current.evidence_refs ?? []), ...incoming]));
  if (requiresEvidence(input.trust_state) && merged.length === 0) {
    throw new Error(
      `[sdk-rebac] promoting to '${input.trust_state}' requires at least one evidence_ref`,
    );
  }

  const row = await dataService.one<RoleRow>(
    `UPDATE rebac.relationship
        SET trust_state = $2, evidence_refs = $3::text[]
      WHERE relationship_id = $1::uuid
    RETURNING ${ROLE_COLUMNS}`,
    [input.relationship_id, input.trust_state, merged],
  );
  return row ? rowToRole(row) : null;
}
