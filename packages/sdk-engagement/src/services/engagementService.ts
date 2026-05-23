import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import { touchResidency } from '@projexlight/sdk-data-rights';
import { issueKey, shredKey } from '@projexlight/sdk-vault';
import type {
  AddParticipantInput,
  EncounterRecord,
  EncounterState,
  GrantRecord,
  IssueGrantInput,
  OpenEncounterInput,
  ParticipantRecord,
} from '../models/engagement.model';

const ENGAGEMENT_AUDIT_POOL = process.env.ENGAGEMENT_AUDIT_POOL || 'admin-default';

/** Exported for unit testing — see tests/encounterTransitions.test.ts. */
export const VALID_TRANSITIONS: Record<EncounterState, EncounterState[]> = {
  'open': ['in-progress', 'closed', 'sealed'], // allow direct close for instant encounters
  'in-progress': ['closed', 'sealed'],
  'closed': ['sealed'],
  'sealed': [],
};

async function emitEngagementAudit(opts: {
  event_type:
    | 'engagement.encounter.opened.v1'
    | 'engagement.encounter.closed.v1'
    | 'engagement.encounter.sealed.v1'
    | 'engagement.relationship.created.v1'
    | 'engagement.relationship.terminated.v1'
    | 'engagement.encounter.grant.issued.v1';
  encounter_id: string;
  tenant_id: string;
  actor_id: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  try {
    await appendAuditEntry({
      pool_index: ENGAGEMENT_AUDIT_POOL,
      event_type: opts.event_type,
      actor_kind: 'service',
      actor_id: opts.actor_id,
      tenant_id: opts.tenant_id,
      subject_kind: 'engagement.encounter',
      subject_id: opts.encounter_id,
      retention_class: 'regulated',
      payload: opts.payload,
    });
  } catch (err) {
    console.error('[sdk-engagement] audit emit failed', opts.event_type, (err as Error).message);
  }
}

/**
 * FR-EN-1 + FR-EN-3: open an encounter and issue its per-encounter Vault key
 * in one operation. The key is parented to `parent_key_id` (the App Pool key
 * for this tenant) and stored as `engagement.encounter.vault_key_ref`. On
 * seal (FR-EN-3) the key is cryptographically shredded.
 */
export async function openEncounter(input: OpenEncounterInput): Promise<EncounterRecord> {
  // Issue the encounter key first; if vault fails we never write the row.
  const key = await issueKey(
    {
      tier: 'encounter',
      parent_key_id: input.parent_key_id,
      kms_ref: `kms-encounter-${Date.now()}`,
      tenant_id: input.tenant_id,
      region: input.region,
    },
    { kind: 'service', id: 'sdk-engagement.openEncounter' },
  );

  const rows = await dataService.rows<EncounterRecord>(
    `INSERT INTO engagement.encounter
       (tenant_id, kind, vault_key_ref, retention_policy, parent_encounter_id, address_id, billing_ref)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING encounter_id, tenant_id, kind, state, vault_key_ref,
               opened_at, closed_at, sealed_at, retention_policy,
               retention_expires_at, parent_encounter_id, address_id, billing_ref`,
    [
      input.tenant_id,
      input.kind,
      key.key_id,
      input.retention_policy ?? 'default-7y',
      input.parent_encounter_id ?? null,
      input.address_id ?? null,
      input.billing_ref ?? null,
    ],
  );
  const encounter = rows[0];
  await emitEngagementAudit({
    event_type: 'engagement.encounter.opened.v1',
    encounter_id: encounter.encounter_id,
    tenant_id: encounter.tenant_id,
    actor_id: 'sdk-engagement.openEncounter',
    payload: { kind: encounter.kind, vault_key_ref: encounter.vault_key_ref, retention_policy: encounter.retention_policy },
  });
  return encounter;
}

export async function getEncounter(encounter_id: string): Promise<EncounterRecord | null> {
  return dataService.one<EncounterRecord>(
    `SELECT encounter_id, tenant_id, kind, state, vault_key_ref,
            opened_at, closed_at, sealed_at, retention_policy,
            retention_expires_at, parent_encounter_id, address_id, billing_ref
       FROM engagement.encounter WHERE encounter_id = $1`,
    [encounter_id],
  );
}

/**
 * State-machine transition. closed/sealed states trigger audit events and,
 * for sealed, the cryptographic shred of the per-encounter Vault key.
 * Validates required participants on close.
 */
export async function transitionEncounter(
  encounter_id: string,
  to: EncounterState,
  actor_id = 'sdk-engagement.transitionEncounter',
): Promise<EncounterRecord> {
  const current = await getEncounter(encounter_id);
  if (!current) throw new Error(`Encounter ${encounter_id} not found`);
  if (!VALID_TRANSITIONS[current.state].includes(to)) {
    throw new Error(`Invalid encounter transition ${current.state} → ${to}`);
  }
  if (to === 'closed' || to === 'sealed') {
    const missing = await dataService.rows<{ role: string }>(
      `SELECT role FROM engagement.encounter_participant
        WHERE encounter_id = $1 AND required = TRUE AND left_at IS NOT NULL`,
      [encounter_id],
    );
    if (missing.length > 0) {
      throw new Error(`Cannot close encounter — required participants have left: ${missing.map((m) => m.role).join(', ')}`);
    }
  }

  const setClauses: string[] = ['state = $2'];
  const params: unknown[] = [encounter_id, to];
  if (to === 'closed') setClauses.push('closed_at = now()');
  if (to === 'sealed') {
    setClauses.push('sealed_at = now()');
    if (!current.closed_at) setClauses.push('closed_at = now()');
  }

  const rows = await dataService.rows<EncounterRecord>(
    `UPDATE engagement.encounter SET ${setClauses.join(', ')}
      WHERE encounter_id = $1
      RETURNING encounter_id, tenant_id, kind, state, vault_key_ref,
                opened_at, closed_at, sealed_at, retention_policy,
                retention_expires_at, parent_encounter_id, address_id, billing_ref`,
    params,
  );
  const next = rows[0];

  // FR-EN-3: seal triggers cryptographic shred of the per-encounter key.
  if (to === 'sealed' && next.vault_key_ref) {
    try {
      await shredKey(next.vault_key_ref, { kind: 'service', id: actor_id }, 'encounter-sealed');
    } catch (err) {
      console.error('[sdk-engagement] vault shred on seal failed', (err as Error).message);
    }
  }

  await emitEngagementAudit({
    event_type:
      to === 'sealed' ? 'engagement.encounter.sealed.v1' :
      to === 'closed' ? 'engagement.encounter.closed.v1' :
      'engagement.encounter.opened.v1', // in-progress just re-uses opened audit shape
    encounter_id: next.encounter_id,
    tenant_id: next.tenant_id,
    actor_id,
    payload: { from: current.state, to: next.state, vault_key_shredded: to === 'sealed' },
  });

  return next;
}

export async function addParticipant(input: AddParticipantInput): Promise<ParticipantRecord> {
  const rows = await dataService.rows<ParticipantRecord>(
    `INSERT INTO engagement.encounter_participant (encounter_id, persona_id, role, required)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (encounter_id, persona_id, role) DO UPDATE SET left_at = NULL
     RETURNING participant_id, encounter_id, persona_id, role, joined_at, left_at, required`,
    [input.encounter_id, input.persona_id, input.role, input.required ?? false],
  );
  const participant = rows[0];

  // FR-DR-1: residency touch — adding a persona to an encounter means that
  // person's data is now in this app pool.
  try {
    const enc = await getEncounter(input.encounter_id);
    if (enc) {
      // persona_id is the L4 ref; the underlying person_id is resolved by sdk-persona.
      // For residency we treat persona_id as a surrogate subject — DSAR fan-out via
      // sdk-persona translates persona → person when the request lands.
      await touchResidency({
        person_id: input.persona_id,
        pool_index: ENGAGEMENT_AUDIT_POOL,
        tenant_id: enc.tenant_id,
        data_classes: ['encounter'],
      });
    }
  } catch (err) {
    console.error('[sdk-engagement] residency touch failed', (err as Error).message);
  }

  return participant;
}

export async function removeParticipant(participant_id: string): Promise<ParticipantRecord | null> {
  const rows = await dataService.rows<ParticipantRecord>(
    `UPDATE engagement.encounter_participant
        SET left_at = now()
      WHERE participant_id = $1 AND left_at IS NULL
      RETURNING participant_id, encounter_id, persona_id, role, joined_at, left_at, required`,
    [participant_id],
  );
  return rows[0] ?? null;
}

export async function listParticipants(encounter_id: string): Promise<ParticipantRecord[]> {
  return dataService.rows<ParticipantRecord>(
    `SELECT participant_id, encounter_id, persona_id, role, joined_at, left_at, required
       FROM engagement.encounter_participant
      WHERE encounter_id = $1
      ORDER BY joined_at`,
    [encounter_id],
  );
}

/**
 * FR-EN-5: issue an Encounter Grant — a time/scope-bounded token that lets
 * a non-participant (e.g., consulting nurse) perform listed methods on the
 * encounter until `expires_at`. The actual capability-token enforcement is
 * P6A's agent runtime; this layer just records the grant.
 */
export async function issueGrant(input: IssueGrantInput): Promise<GrantRecord> {
  const expires = new Date(Date.now() + input.ttl_ms);
  const rows = await dataService.rows<GrantRecord>(
    `INSERT INTO engagement.encounter_grant
       (encounter_id, grantee_persona_id, issuer_persona_id, scope, expires_at, capability_token_ref)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6)
     RETURNING grant_id, encounter_id, grantee_persona_id, issuer_persona_id, scope,
               issued_at, expires_at, revoked_at, capability_token_ref`,
    [
      input.encounter_id,
      input.grantee_persona_id,
      input.issuer_persona_id,
      JSON.stringify(input.scope),
      expires,
      input.capability_token_ref ?? null,
    ],
  );
  const grant = rows[0];
  const enc = await getEncounter(grant.encounter_id);
  await emitEngagementAudit({
    event_type: 'engagement.encounter.grant.issued.v1',
    encounter_id: grant.encounter_id,
    tenant_id: enc?.tenant_id ?? 'unknown',
    actor_id: input.issuer_persona_id,
    payload: { grantee_persona_id: grant.grantee_persona_id, scope: grant.scope, expires_at: grant.expires_at },
  });
  return grant;
}

export async function revokeGrant(grant_id: string): Promise<GrantRecord | null> {
  const rows = await dataService.rows<GrantRecord>(
    `UPDATE engagement.encounter_grant
        SET revoked_at = now()
      WHERE grant_id = $1 AND revoked_at IS NULL
      RETURNING grant_id, encounter_id, grantee_persona_id, issuer_persona_id, scope,
                issued_at, expires_at, revoked_at, capability_token_ref`,
    [grant_id],
  );
  return rows[0] ?? null;
}

export async function listActiveGrants(encounter_id: string): Promise<GrantRecord[]> {
  return dataService.rows<GrantRecord>(
    `SELECT grant_id, encounter_id, grantee_persona_id, issuer_persona_id, scope,
            issued_at, expires_at, revoked_at, capability_token_ref
       FROM engagement.encounter_grant
      WHERE encounter_id = $1
        AND revoked_at IS NULL
        AND expires_at > now()
      ORDER BY issued_at`,
    [encounter_id],
  );
}

/**
 * Public boolean: is `grantee_persona_id` currently authorized for `method`
 * on `encounter_id`? Used by downstream SDKs (e.g., chart read) to gate
 * non-participant access. Method match against scope.methods[] is the
 * simplest enforcement; richer scope rules compose later.
 */
export async function checkGrant(
  encounter_id: string,
  grantee_persona_id: string,
  method: string,
): Promise<boolean> {
  const row = await dataService.one<{ scope: Record<string, unknown> }>(
    `SELECT scope FROM engagement.encounter_grant
      WHERE encounter_id = $1 AND grantee_persona_id = $2
        AND revoked_at IS NULL AND expires_at > now()
      ORDER BY issued_at DESC LIMIT 1`,
    [encounter_id, grantee_persona_id],
  );
  if (!row) return false;
  const methods = (row.scope.methods as string[] | undefined) ?? [];
  return methods.includes(method) || methods.includes('*');
}
