import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import { touchResidency } from '@projexlight/sdk-data-rights';
import type {
  AppIdentityRecord,
  AssignRoleInput,
  CreateAppIdentityInput,
  CreateMembershipInput,
  CreatePersonaInput,
  MembershipRecord,
  PersonaRecord,
  RoleAssignmentRecord,
} from '../models/persona.model';

const PERSONA_AUDIT_POOL = process.env.PERSONA_AUDIT_POOL || 'admin-default';

/**
 * Best-effort audit emit. Persona writes are L2/L3/L4 lifecycle events
 * (regulated retention) — audit chain failure must not roll back the
 * primary write; the persona row IS the source of truth.
 */
async function emitPersonaAudit(opts: {
  event_type:
    | 'identity.persona.created.v1'
    | 'identity.persona.shred.v1'
    | 'identity.membership.created.v1'
    | 'identity.membership.terminated.v1'
    | 'identity.role.assigned.v1'
    | 'identity.role.revoked.v1';
  tenant_id?: string | null;
  subject_kind: string;
  subject_id: string;
  actor_id: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  try {
    await appendAuditEntry({
      pool_index: PERSONA_AUDIT_POOL,
      event_type: opts.event_type,
      actor_kind: 'service',
      actor_id: opts.actor_id,
      tenant_id: opts.tenant_id ?? null,
      subject_kind: opts.subject_kind,
      subject_id: opts.subject_id,
      retention_class: 'regulated',
      payload: opts.payload,
    });
  } catch (err) {
     
    console.error('[sdk-persona] audit emit failed', opts.event_type, (err as Error).message);
  }
}

async function touchPersonaResidency(person_id: string, tenant_id: string): Promise<void> {
  try {
    await touchResidency({
      person_id,
      pool_index: PERSONA_AUDIT_POOL,
      tenant_id,
      data_classes: ['persona'],
    });
  } catch (err) {
     
    console.error('[sdk-persona] residency touch failed', (err as Error).message);
  }
}

/**
 * sdk-persona service per P3 PRD §5.2 / FR-PSN-1..9.
 *
 * Owns the L2/L3/L4 identity layer registry. Every domain SDK from P3 onwards
 * navigates through Persona — direct sdk-identity reads are blocked by lint OC-4.
 */

export async function createAppIdentity(input: CreateAppIdentityInput): Promise<AppIdentityRecord> {
  const rows = await dataService.rows<AppIdentityRecord>(
    `INSERT INTO persona.app_identity (person_id, app_id)
     VALUES ($1, $2)
     ON CONFLICT (person_id, app_id) DO UPDATE SET status = persona.app_identity.status
     RETURNING app_identity_id, person_id, app_id, status,
               merged_into_app_identity_id, created_at`,
    [input.person_id, input.app_id],
  );
  return rows[0];
}

export async function getAppIdentity(app_identity_id: string): Promise<AppIdentityRecord | null> {
  return dataService.one<AppIdentityRecord>(
    `SELECT app_identity_id, person_id, app_id, status,
            merged_into_app_identity_id, created_at
       FROM persona.app_identity WHERE app_identity_id = $1`,
    [app_identity_id],
  );
}

export async function listAppIdentitiesForPerson(person_id: string): Promise<AppIdentityRecord[]> {
  return dataService.rows<AppIdentityRecord>(
    `SELECT app_identity_id, person_id, app_id, status,
            merged_into_app_identity_id, created_at
       FROM persona.app_identity WHERE person_id = $1 ORDER BY created_at`,
    [person_id],
  );
}

export async function createMembership(input: CreateMembershipInput): Promise<MembershipRecord> {
  const rows = await dataService.rows<MembershipRecord>(
    `INSERT INTO persona.membership (app_identity_id, tenant_id)
     VALUES ($1, $2)
     ON CONFLICT (app_identity_id, tenant_id) DO UPDATE SET status = persona.membership.status
     RETURNING membership_id, app_identity_id, tenant_id, status, joined_at, terminated_at`,
    [input.app_identity_id, input.tenant_id],
  );
  const membership = rows[0];
  await emitPersonaAudit({
    event_type: 'identity.membership.created.v1',
    tenant_id: membership.tenant_id,
    subject_kind: 'persona.membership',
    subject_id: membership.membership_id,
    actor_id: 'sdk-persona.createMembership',
    payload: { app_identity_id: membership.app_identity_id, tenant_id: membership.tenant_id },
  });
  // FR-DR-1 fan-out: resolve person_id via app_identity row.
  const personRow = await dataService.one<{ person_id: string }>(
    `SELECT person_id FROM persona.app_identity WHERE app_identity_id = $1`,
    [membership.app_identity_id],
  );
  if (personRow?.person_id) {
    await touchPersonaResidency(personRow.person_id, membership.tenant_id);
  }
  return membership;
}

export async function listMembershipsForAppIdentity(app_identity_id: string): Promise<MembershipRecord[]> {
  return dataService.rows<MembershipRecord>(
    `SELECT membership_id, app_identity_id, tenant_id, status, joined_at, terminated_at
       FROM persona.membership WHERE app_identity_id = $1 ORDER BY joined_at`,
    [app_identity_id],
  );
}

export async function terminateMembership(membership_id: string): Promise<MembershipRecord | null> {
  const rows = await dataService.rows<MembershipRecord>(
    `UPDATE persona.membership
        SET status = 'terminated', terminated_at = now()
      WHERE membership_id = $1
      RETURNING membership_id, app_identity_id, tenant_id, status, joined_at, terminated_at`,
    [membership_id],
  );
  const membership = rows[0] ?? null;
  if (membership) {
    await emitPersonaAudit({
      event_type: 'identity.membership.terminated.v1',
      tenant_id: membership.tenant_id,
      subject_kind: 'persona.membership',
      subject_id: membership.membership_id,
      actor_id: 'sdk-persona.terminateMembership',
      payload: { app_identity_id: membership.app_identity_id, tenant_id: membership.tenant_id },
    });
  }
  return membership;
}

export async function createPersona(input: CreatePersonaInput): Promise<PersonaRecord> {
  const rows = await dataService.rows<PersonaRecord>(
    `INSERT INTO persona.persona (
        membership_id, kind, primary_role_template_id, bu_id, persona_key_ref
     ) VALUES ($1, $2, $3, $4, $5)
     RETURNING persona_id, membership_id, kind, primary_role_template_id,
               bu_id, persona_key_ref, status, created_at, shredded_at`,
    [
      input.membership_id,
      input.kind,
      input.primary_role_template_id ?? null,
      input.bu_id ?? null,
      input.persona_key_ref ?? null,
    ],
  );
  const persona = rows[0];
  // Resolve tenant_id + person_id via the membership chain for audit + residency.
  const ctx = await dataService.one<{ tenant_id: string; person_id: string }>(
    `SELECT m.tenant_id, ai.person_id
       FROM persona.membership m
       JOIN persona.app_identity ai ON m.app_identity_id = ai.app_identity_id
      WHERE m.membership_id = $1`,
    [input.membership_id],
  );
  await emitPersonaAudit({
    event_type: 'identity.persona.created.v1',
    tenant_id: ctx?.tenant_id ?? null,
    subject_kind: 'persona.persona',
    subject_id: persona.persona_id,
    actor_id: 'sdk-persona.createPersona',
    payload: { kind: persona.kind, membership_id: persona.membership_id },
  });
  if (ctx?.person_id && ctx?.tenant_id) {
    await touchPersonaResidency(ctx.person_id, ctx.tenant_id);
  }
  return persona;
}

export async function getPersona(persona_id: string): Promise<PersonaRecord | null> {
  return dataService.one<PersonaRecord>(
    `SELECT persona_id, membership_id, kind, primary_role_template_id,
            bu_id, persona_key_ref, status, created_at, shredded_at
       FROM persona.persona WHERE persona_id = $1`,
    [persona_id],
  );
}

export async function listPersonasForMembership(membership_id: string): Promise<PersonaRecord[]> {
  return dataService.rows<PersonaRecord>(
    `SELECT persona_id, membership_id, kind, primary_role_template_id,
            bu_id, persona_key_ref, status, created_at, shredded_at
       FROM persona.persona WHERE membership_id = $1 ORDER BY created_at`,
    [membership_id],
  );
}

/**
 * Persona shred — independent of person shred (FR-PSN-7).
 * Sets status='shredded' and clears persona_key_ref (Vault is responsible for
 * the cryptographic shred of the actual key material).
 */
export async function shredPersona(persona_id: string): Promise<PersonaRecord | null> {
  const rows = await dataService.rows<PersonaRecord>(
    `UPDATE persona.persona
        SET status = 'shredded',
            shredded_at = now(),
            persona_key_ref = NULL
      WHERE persona_id = $1 AND status <> 'shredded'
      RETURNING persona_id, membership_id, kind, primary_role_template_id,
                bu_id, persona_key_ref, status, created_at, shredded_at`,
    [persona_id],
  );
  const persona = rows[0] ?? null;
  if (persona) {
    const ctx = await dataService.one<{ tenant_id: string }>(
      `SELECT tenant_id FROM persona.membership WHERE membership_id = $1`,
      [persona.membership_id],
    );
    await emitPersonaAudit({
      event_type: 'identity.persona.shred.v1',
      tenant_id: ctx?.tenant_id ?? null,
      subject_kind: 'persona.persona',
      subject_id: persona.persona_id,
      actor_id: 'sdk-persona.shredPersona',
      payload: { kind: persona.kind, membership_id: persona.membership_id },
    });
  }
  return persona;
}

export async function assignRole(input: AssignRoleInput): Promise<RoleAssignmentRecord> {
  const rows = await dataService.rows<RoleAssignmentRecord>(
    `INSERT INTO persona.role_assignment (persona_id, role_template_id, assigned_by)
     VALUES ($1, $2, $3)
     RETURNING assignment_id, persona_id, role_template_id, assigned_at, revoked_at, assigned_by`,
    [input.persona_id, input.role_template_id, input.assigned_by ?? null],
  );
  const assignment = rows[0];
  await emitPersonaAudit({
    event_type: 'identity.role.assigned.v1',
    subject_kind: 'persona.role_assignment',
    subject_id: assignment.assignment_id,
    actor_id: input.assigned_by ?? 'sdk-persona.assignRole',
    payload: { persona_id: assignment.persona_id, role_template_id: assignment.role_template_id },
  });
  return assignment;
}

export async function revokeRoleAssignment(assignment_id: string): Promise<RoleAssignmentRecord | null> {
  const rows = await dataService.rows<RoleAssignmentRecord>(
    `UPDATE persona.role_assignment
        SET revoked_at = now()
      WHERE assignment_id = $1 AND revoked_at IS NULL
      RETURNING assignment_id, persona_id, role_template_id, assigned_at, revoked_at, assigned_by`,
    [assignment_id],
  );
  const assignment = rows[0] ?? null;
  if (assignment) {
    await emitPersonaAudit({
      event_type: 'identity.role.revoked.v1',
      subject_kind: 'persona.role_assignment',
      subject_id: assignment.assignment_id,
      actor_id: 'sdk-persona.revokeRoleAssignment',
      payload: { persona_id: assignment.persona_id, role_template_id: assignment.role_template_id },
    });
  }
  return assignment;
}

export async function listRolesForPersona(persona_id: string): Promise<RoleAssignmentRecord[]> {
  return dataService.rows<RoleAssignmentRecord>(
    `SELECT assignment_id, persona_id, role_template_id, assigned_at, revoked_at, assigned_by
       FROM persona.role_assignment
      WHERE persona_id = $1 AND revoked_at IS NULL
      ORDER BY assigned_at`,
    [persona_id],
  );
}

/**
 * The REVERSE of listRolesForPersona: who holds this role?
 *
 * WHY THIS EXISTS. Every read in this SDK was forward-only — you could ask what
 * roles a persona holds, never who holds a role. That is the wrong direction for
 * the two things callers actually need: routing a case to a reviewer ("which
 * personas are data stewards?") and addressing an audience ("tell the sales
 * managers"). A consuming app that names its audiences by ROLE — which is what
 * they are — had no way to turn one into people, and no way to synthesise it
 * either, because it does not hold persona ids in the first place.
 *
 * TWO WAYS TO HOLD A ROLE, AND BOTH COUNT. A persona can hold a role through an
 * explicit persona.role_assignment grant, or through the primary_role_template_id
 * stamped on it at creation. Reading only the assignment table silently misses
 * everyone who never had a role added after signup — which, for a tenant that
 * provisions its people with a starting role template and never touches them
 * again, is EVERYONE. That would return an empty list for a role dozens of people
 * hold, and an empty list reads as "nobody to notify" rather than as a bug.
 *
 * ONE ROW PER PERSONA. The two sources overlap: a persona whose primary template
 * is X and who also has an explicit grant of X appears in both. This returns each
 * persona once — the caller fanning out a notification must not send twice, and
 * de-duplicating in every caller is the kind of thing one of them forgets.
 * `held_via` reports 'assignment' in preference to 'primary' so the more specific
 * provenance is the one shown.
 *
 * TENANT_ID IS REQUIRED, NOT OPTIONAL. persona.role_assignment carries no tenant
 * column; the tenant lives one join away on persona.membership. An unscoped
 * reverse lookup would therefore return every tenant's role holders to whoever
 * asked — the same defect that made the EMPI review surface cross-tenant. Making
 * the parameter mandatory is what stops that being reachable at all, rather than
 * relying on every caller to remember to filter.
 *
 * Suspended and terminated memberships, and non-active personas, are excluded:
 * "who holds this role" is a question about who can act now.
 */
export interface RoleHolder {
  persona_id: string;
  membership_id: string;
  tenant_id: string;
  kind: string;
  bu_id: string | null;
  /** 'assignment' = an explicit grant; 'primary' = the persona's starting role template. */
  held_via: 'assignment' | 'primary';
  /** When the explicit grant was made. NULL for 'primary' — that is set at persona creation. */
  assigned_at: string | null;
}

export interface ListRoleHoldersInput {
  role_template_id: string;
  /** Mandatory — see the tenant-scoping note above. */
  tenant_id: string;
  /** Include holders via primary_role_template_id. Default true; false narrows to explicit grants. */
  include_primary?: boolean;
  limit?: number;
}

export async function listRoleHolders(input: ListRoleHoldersInput): Promise<RoleHolder[]> {
  return dataService.rows<RoleHolder>(
    `SELECT DISTINCT ON (persona_id)
            persona_id, membership_id, tenant_id, kind, bu_id, held_via, assigned_at
       FROM (
         SELECT p.persona_id, p.membership_id, m.tenant_id, p.kind, p.bu_id,
                'assignment'::text AS held_via, ra.assigned_at
           FROM persona.role_assignment ra
           JOIN persona.persona    p ON p.persona_id    = ra.persona_id
           JOIN persona.membership m ON m.membership_id = p.membership_id
          WHERE ra.role_template_id = $1::uuid
            AND ra.revoked_at IS NULL
            AND m.tenant_id = $2::uuid
            AND p.status = 'active'
            AND m.status = 'active'
         UNION ALL
         SELECT p.persona_id, p.membership_id, m.tenant_id, p.kind, p.bu_id,
                'primary'::text AS held_via, NULL::timestamptz AS assigned_at
           FROM persona.persona    p
           JOIN persona.membership m ON m.membership_id = p.membership_id
          WHERE p.primary_role_template_id = $1::uuid
            AND $3::boolean IS TRUE
            AND m.tenant_id = $2::uuid
            AND p.status = 'active'
            AND m.status = 'active'
       ) holders
      -- 'assignment' sorts before 'primary' alphabetically, which is the preference
      -- DISTINCT ON needs: the explicit grant wins when a persona holds both.
      ORDER BY persona_id, held_via, assigned_at
      LIMIT $4`,
    [
      input.role_template_id,
      input.tenant_id,
      input.include_primary ?? true,
      Math.min(Math.max(input.limit ?? 200, 1), 1000),
    ],
  );
}
