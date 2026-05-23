/**
 * P5 AC-3 chaos drill: healthcare visit lifecycle end-to-end.
 *
 * Scenario (the canonical AC-3 walk-through from P5 PRD §AC-3):
 *   - Patient persona has an existing PCP (Primary Care Provider) doctor.
 *   - Patient walks into the clinic for an unplanned visit.
 *   - openEncounter(kind='visit') is called with the patient as required
 *     participant and the doctor as physician-of-record participant.
 *   - Mid-visit, the PCP issues an Encounter Grant to a consulting nurse
 *     (scope.methods=['chart.read'], TTL=8h). The nurse is NOT a participant
 *     but can read the chart for the duration.
 *   - checkGrant matrix: nurse can chart.read but NOT chart.write or
 *     billing.access; an unrelated persona has no grant at all.
 *   - PCP issues a follow-up "labs.order" grant to a phlebotomist with a
 *     tiny TTL; the test waits past expiry and re-checks → false.
 *   - Visit closes → required-participant gate is exercised (removing the
 *     PCP mid-visit blocks close).
 *   - Visit seals → encounter Vault key shredded; ALL grants (active +
 *     expired + revoked) are still queryable for audit but checkGrant
 *     returns false because the encounter is sealed.
 *   - Audit chain has open + grant.issued (×2) + sealed events for the
 *     encounter.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startChaosCtx, type ChaosCtx } from '../../../sdk-vault/tests/chaos/setup';
import { issueKey } from '@projexlight/sdk-vault';
import {
  openEncounter,
  transitionEncounter,
  addParticipant,
  removeParticipant,
  issueGrant,
  revokeGrant,
  checkGrant,
  listActiveGrants,
  listParticipants,
} from '../../src/services/engagementService';

const REGION = 'us-east-1';
const CLINIC_TENANT = '66666666-6666-6666-6666-666666666666';

// Personas (L4 surrogates — DSAR fan-out resolves persona → person via sdk-persona).
const PATIENT_PERSONA   = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PCP_PERSONA       = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const NURSE_PERSONA     = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const PHLEBOTOMIST_PSN  = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const RANDOM_STAFF_PSN  = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'; // never granted anything

async function seedClinicTenantKey(): Promise<string> {
  const root = await issueKey({ tier: 'root', kms_ref: 'kms-root', region: REGION }, { kind: 'service', id: 'ac-3.seed' });
  const app  = await issueKey({ tier: 'app', parent_key_id: root.key_id, kms_ref: 'kms-app', region: REGION }, { kind: 'service', id: 'ac-3.seed' });
  const pool = await issueKey({ tier: 'pool', parent_key_id: app.key_id, kms_ref: 'kms-pool', region: REGION }, { kind: 'service', id: 'ac-3.seed' });
  const ten  = await issueKey({ tier: 'tenant', parent_key_id: pool.key_id, kms_ref: 'kms-tenant', tenant_id: CLINIC_TENANT, region: REGION }, { kind: 'service', id: 'ac-3.seed' });
  return ten.key_id;
}

describe('AC-3: healthcare visit (PCP + nurse encounter grant + seal cascade)', () => {
  let ctx: ChaosCtx;
  let tenantKeyId: string;
  let encounterId: string;
  let nurseGrantId: string;

  beforeAll(async () => {
    ctx = await startChaosCtx();
    tenantKeyId = await seedClinicTenantKey();
  }, 180_000);

  afterAll(async () => { if (ctx) await ctx.stop(); });

  it('open visit with patient (required) + PCP (required) participants', async () => {
    const enc = await openEncounter({
      tenant_id: CLINIC_TENANT,
      kind: 'visit',
      parent_key_id: tenantKeyId,
      region: REGION,
      retention_policy: 'healthcare-7y',
    });
    encounterId = enc.encounter_id;
    expect(enc.state).toBe('open');
    expect(enc.kind).toBe('visit');
    expect(enc.vault_key_ref).toBeTruthy();

    await addParticipant({ encounter_id: encounterId, persona_id: PATIENT_PERSONA, role: 'patient',   required: true });
    await addParticipant({ encounter_id: encounterId, persona_id: PCP_PERSONA,     role: 'physician', required: true });

    const ps = await listParticipants(encounterId);
    expect(ps).toHaveLength(2);
    expect(ps.map((p) => p.role).sort()).toEqual(['patient', 'physician']);
    expect(ps.every((p) => p.required)).toBe(true);
  });

  it('addParticipant touches residency registry for each persona', async () => {
    const rows = await ctx.rows<{ person_id: string }>(
      `SELECT person_id FROM data_rights.person_pool_residency
        WHERE tenant_id = $1 ORDER BY person_id`,
      [CLINIC_TENANT],
    );
    const personIds = rows.map((r) => r.person_id);
    expect(personIds).toContain(PATIENT_PERSONA);
    expect(personIds).toContain(PCP_PERSONA);
  });

  it('PCP issues 8h chart.read grant to consulting nurse', async () => {
    const grant = await issueGrant({
      encounter_id: encounterId,
      grantee_persona_id: NURSE_PERSONA,
      issuer_persona_id: PCP_PERSONA,
      scope: { methods: ['chart.read'] },
      ttl_ms: 8 * 60 * 60 * 1000,
    });
    nurseGrantId = grant.grant_id;
    expect(grant.revoked_at).toBeNull();
    expect(new Date(grant.expires_at).getTime()).toBeGreaterThan(Date.now() + 7 * 60 * 60 * 1000);
  });

  it('checkGrant matrix: nurse=chart.read ✓ chart.write ✗ ; random staff ✗ ; PCP wildcard not implicit', async () => {
    expect(await checkGrant(encounterId, NURSE_PERSONA,    'chart.read')).toBe(true);
    expect(await checkGrant(encounterId, NURSE_PERSONA,    'chart.write')).toBe(false);
    expect(await checkGrant(encounterId, NURSE_PERSONA,    'billing.access')).toBe(false);
    expect(await checkGrant(encounterId, RANDOM_STAFF_PSN, 'chart.read')).toBe(false);
    // PCP is a participant — they don't NEED a grant; checkGrant is non-participant gating.
    // So a query for the PCP without a grant returns false (correct — gating is in the calling SDK).
    expect(await checkGrant(encounterId, PCP_PERSONA,      'chart.read')).toBe(false);
  });

  it('short-TTL grant expires: phlebotomist labs.order valid → expired after TTL', async () => {
    const grant = await issueGrant({
      encounter_id: encounterId,
      grantee_persona_id: PHLEBOTOMIST_PSN,
      issuer_persona_id: PCP_PERSONA,
      scope: { methods: ['labs.order'] },
      ttl_ms: 1000, // 1 second
    });
    expect(await checkGrant(encounterId, PHLEBOTOMIST_PSN, 'labs.order')).toBe(true);

    // Wait past expiry. (engagement.encounter_grant.expires_at is the gate.)
    await new Promise((r) => setTimeout(r, 1500));
    expect(await checkGrant(encounterId, PHLEBOTOMIST_PSN, 'labs.order')).toBe(false);

    // listActiveGrants must NOT return the expired grant.
    const active = await listActiveGrants(encounterId);
    expect(active.find((g) => g.grant_id === grant.grant_id)).toBeUndefined();
    // But the nurse grant (8h TTL) is still active.
    expect(active.find((g) => g.grant_id === nurseGrantId)).toBeTruthy();
  });

  it('revoking the nurse grant cuts access immediately', async () => {
    const revoked = await revokeGrant(nurseGrantId);
    expect(revoked).not.toBeNull();
    expect(revoked!.revoked_at).not.toBeNull();
    expect(await checkGrant(encounterId, NURSE_PERSONA, 'chart.read')).toBe(false);
  });

  it('required-participant gate: removing PCP before seal blocks close', async () => {
    const ps = await listParticipants(encounterId);
    const pcp = ps.find((p) => p.role === 'physician')!;
    await removeParticipant(pcp.participant_id);

    await expect(transitionEncounter(encounterId, 'closed', 'ac-3.bad-close'))
      .rejects.toThrow(/required participants have left/i);
  });

  it('re-add PCP, then close → sealed cascades vault key shred + audit entry', async () => {
    // Restore PCP — addParticipant ON CONFLICT clears left_at.
    await addParticipant({ encounter_id: encounterId, persona_id: PCP_PERSONA, role: 'physician', required: true });

    const closed = await transitionEncounter(encounterId, 'closed', 'ac-3.close');
    expect(closed.state).toBe('closed');
    expect(closed.closed_at).not.toBeNull();

    const sealed = await transitionEncounter(encounterId, 'sealed', 'ac-3.seal');
    expect(sealed.state).toBe('sealed');

    // Vault key is shredded.
    const key = await ctx.one<{ state: string; kms_ref: string | null }>(
      `SELECT state, kms_ref FROM vault.key WHERE key_id = $1`,
      [sealed.vault_key_ref!],
    );
    expect(key!.state).toBe('shredded');
    expect(key!.kms_ref).toBeNull();

    // Audit chain has the expected events for this encounter.
    const events = await ctx.rows<{ event_type: string }>(
      `SELECT event_type FROM audit.entry
        WHERE subject_kind = 'engagement.encounter' AND subject_id = $1
        ORDER BY seq`,
      [encounterId],
    );
    const types = events.map((e) => e.event_type);
    expect(types).toContain('engagement.encounter.opened.v1');
    expect(types).toContain('engagement.encounter.grant.issued.v1');
    expect(types).toContain('engagement.encounter.closed.v1');
    expect(types).toContain('engagement.encounter.sealed.v1');
    // Two grant.issued events (nurse + phlebotomist).
    expect(types.filter((t) => t === 'engagement.encounter.grant.issued.v1')).toHaveLength(2);
  });

  it('post-seal: encounter participants + grant rows survive for audit (no row deletion)', async () => {
    const participants = await listParticipants(encounterId);
    expect(participants.length).toBeGreaterThanOrEqual(2); // patient + (latest) PCP

    // Grants survive too — they're frozen audit evidence, just no longer active.
    const allGrants = await ctx.rows<{ grant_id: string }>(
      `SELECT grant_id FROM engagement.encounter_grant WHERE encounter_id = $1`,
      [encounterId],
    );
    expect(allGrants.length).toBeGreaterThanOrEqual(2); // nurse + phlebotomist
  });
});
