/**
 * End-to-end provenance integration tests (P16 · EP-374 · PCF-01-5).
 *
 * Opt-in, like the sibling sdk-sequence suites: SOURCE_RECORD_IT=1 plus a
 * reachable Postgres (DATABASE_URL / PG* env). Skipped otherwise so a laptop with
 * no database still runs the pure neutrality gate.
 *
 * What these cover that the unit level cannot:
 *   * the whole ladder, P0 -> P4, against real triggers and real enums
 *   * LINK-OVER-MERGE: two captures pointing at one subject BOTH survive
 *   * the sdk-audit hash chain still verifies after the flow (nothing this SDK
 *     wrote broke the tamper-evident ledger)
 *   * every mutating call replayed, proving idempotency rather than assuming it
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initPool, closeAllPools, dataService } from '@projexlight/db-runtime';
import { verifyChain } from '../../sdk-audit/src/services/chainVerifier';
import {
  captureSourceRecord,
  normalizeSourceRecord,
  promoteSourceRecord,
  linkCrosswalk,
  listCrosswalks,
  PromotionEvidenceMissing,
  InvalidTrustTransition,
  RecordQuarantined,
} from '../src/services/sourceRecordService';
import {
  writeAssertion,
  supersedeAssertion,
  queryAssertions,
  revealAssertionValue,
  AssertionAlreadySuperseded,
} from '../src/services/assertionService';
import {
  signAttestation,
  checkPermittedUse,
  verifyAttestation,
  AttestationEvidenceMissing,
} from '../src/services/attestationService';

const RUN = process.env.SOURCE_RECORD_IT === '1';
const suite = RUN ? describe : describe.skip;

const TENANT = 'e1e1e1e1-0000-4000-8000-00000000abcd';
const AUDIT_POOL = process.env.SOURCE_RECORD_AUDIT_POOL || 'admin-default';
const run = Date.now();

/** Count audit entries for one capture, per event type. */
async function auditCounts(subject_id: string): Promise<Record<string, number>> {
  const rows = await dataService.rows<{ event_type: string; n: string }>(
    `SELECT event_type, count(*)::text AS n FROM audit.entry
      WHERE subject_id = $1 GROUP BY event_type`,
    [subject_id],
  );
  return Object.fromEntries(rows.map((r) => [r.event_type, Number(r.n)]));
}

/** Audit head before this run — the chain assertion is scoped to what we wrote. */
let headBeforeRun = 0;

suite('sdk-source-record provenance (integration)', () => {
  beforeAll(async () => {
    initPool({
      connectionString:
        process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/projexcloud_db',
    });
    const head = await dataService.one<{ seq: string | null }>(
      'SELECT max(seq)::text AS seq FROM audit.entry WHERE pool_index = $1',
      [AUDIT_POOL],
    );
    headBeforeRun = Number(head?.seq ?? 0);
  });

  afterAll(async () => {
    await closeAllPools();
  });

  it('carries a capture from P0 to P4 and refuses every unearned rung on the way', async () => {
    const subject = `subject:${run}-ladder`;
    const { record, created } = await captureSourceRecord({
      tenant_id: TENANT,
      source_system: `system-${run}`,
      raw_evidence: { external_ref: `${run}`, contact: 'someone@example.test' },
      origin_class: 'PUBLIC_RECORD',
      subject_ref: subject,
      actor_id: 'integration-suite',
      purpose: 'ladder test',
    });
    expect(created).toBe(true);
    expect(record.trust_state).toBe('P0_CAPTURED');

    // A rung cannot be skipped, even with perfect evidence in hand.
    await expect(
      promoteSourceRecord({
        tenant_id: TENANT,
        capture_id: record.capture_id,
        to_state: 'P4_DIRECT',
        evidence_ref: 'evidence:first-party',
        evidence_origin_class: 'USER_PROVIDED',
      }),
    ).rejects.toBeInstanceOf(InvalidTrustTransition);

    const p1 = await normalizeSourceRecord({
      tenant_id: TENANT,
      capture_id: record.capture_id,
      actor_id: 'integration-suite',
    });
    expect(p1.trust_state).toBe('P1_NORMALIZED');
    // The captured payload survives normalization untouched.
    expect((p1.raw_evidence as Record<string, unknown>).external_ref).toBe(`${run}`);

    const p2 = await promoteSourceRecord({
      tenant_id: TENANT,
      capture_id: record.capture_id,
      to_state: 'P2_CANDIDATE',
    });
    expect(p2.trust_state).toBe('P2_CANDIDATE');

    const p3 = await promoteSourceRecord({
      tenant_id: TENANT,
      capture_id: record.capture_id,
      to_state: 'P3_LINKED',
    });
    expect(p3.trust_state).toBe('P3_LINKED');

    // THE gate: P4 asserts the subject themselves told us. Bought evidence is not
    // that, and neither is no evidence at all.
    await expect(
      promoteSourceRecord({ tenant_id: TENANT, capture_id: record.capture_id, to_state: 'P4_DIRECT' }),
    ).rejects.toMatchObject({ status: 422, code: 'FIRST_PARTY_EVIDENCE_REQUIRED' });

    await expect(
      promoteSourceRecord({
        tenant_id: TENANT,
        capture_id: record.capture_id,
        to_state: 'P4_DIRECT',
        evidence_ref: 'evidence:licence-scan',
        evidence_origin_class: 'LICENSED_THIRD_PARTY',
      }),
    ).rejects.toMatchObject({ status: 422, code: 'FIRST_PARTY_EVIDENCE_REQUIRED' });

    // Refusals leave the record exactly where it was.
    const stillP3 = await dataService.one<{ trust_state: string }>(
      'SELECT trust_state FROM source_record.source_record WHERE capture_id = $1',
      [record.capture_id],
    );
    expect(stillP3?.trust_state).toBe('P3_LINKED');

    const p4 = await promoteSourceRecord({
      tenant_id: TENANT,
      capture_id: record.capture_id,
      to_state: 'P4_DIRECT',
      evidence_ref: 'evidence:signed-consent',
      evidence_origin_class: 'USER_PROVIDED',
      decision_ref: 'decision:integration',
    });
    expect(p4.trust_state).toBe('P4_DIRECT');

    // Exactly one audit entry per transition — and NONE for the three refusals.
    const counts = await auditCounts(record.capture_id);
    expect(counts['source-record.captured.v1']).toBe(1);
    expect(counts['source-record.normalized.v1']).toBe(1);
    expect(counts['source-record.promoted.v1']).toBe(3);
  });

  it('quarantines unknown provenance instead of defaulting, and refuses to promote it', async () => {
    const { record, quarantined } = await captureSourceRecord({
      tenant_id: TENANT,
      source_system: `system-${run}-unknown`,
      raw_evidence: { anything: true },
      origin_class: 'A_CLASS_NOBODY_DEFINED',
    });
    expect(quarantined).toBe(true);
    expect(record.origin_class).toBe('UNKNOWN_QUARANTINED');
    expect(record.quarantine_reason).toBeTruthy();

    await expect(
      normalizeSourceRecord({ tenant_id: TENANT, capture_id: record.capture_id }),
    ).rejects.toBeInstanceOf(RecordQuarantined);

    // Absent provenance is treated the same as unrecognised provenance.
    const absent = await captureSourceRecord({
      tenant_id: TENANT,
      source_system: `system-${run}-absent`,
      raw_evidence: { anything: true },
    });
    expect(absent.record.origin_class).toBe('UNKNOWN_QUARANTINED');
  });

  it('keeps BOTH source records when two captures link to one subject', async () => {
    const subject = `subject:${run}-link`;
    const a = await captureSourceRecord({
      tenant_id: TENANT,
      source_system: `system-${run}-a`,
      raw_evidence: { side: 'a' },
      origin_class: 'PUBLIC_RECORD',
      subject_ref: subject,
    });
    const b = await captureSourceRecord({
      tenant_id: TENANT,
      source_system: `system-${run}-b`,
      raw_evidence: { side: 'b' },
      origin_class: 'PARTNER_PROVIDED',
      subject_ref: subject,
    });

    // Link-over-merge: linking does not collapse one capture into the other.
    const linked = await dataService.rows<{ capture_id: string; origin_class: string }>(
      `SELECT capture_id, origin_class FROM source_record.source_record
        WHERE tenant_id = $1 AND subject_ref = $2 ORDER BY created_at`,
      [TENANT, subject],
    );
    expect(linked.map((r) => r.capture_id).sort()).toEqual(
      [a.record.capture_id, b.record.capture_id].sort(),
    );
    // Each keeps its OWN provenance — the whole point of not merging.
    expect(new Set(linked.map((r) => r.origin_class))).toEqual(
      new Set(['PUBLIC_RECORD', 'PARTNER_PROVIDED']),
    );

    // Conflicting claims from those two sources coexist too.
    await writeAssertion({
      tenant_id: TENANT, capture_id: a.record.capture_id, subject_ref: subject,
      attribute: 'email', value: 'a@example.test', origin_class: 'PUBLIC_RECORD', confidence: 0.4,
    });
    await writeAssertion({
      tenant_id: TENANT, capture_id: b.record.capture_id, subject_ref: subject,
      attribute: 'email', value: 'b@example.test', origin_class: 'PARTNER_PROVIDED', confidence: 0.9,
    });
    const claims = await queryAssertions({ tenant_id: TENANT, subject_ref: subject, attribute: 'email' });
    expect(claims).toHaveLength(2);
    // Both are enveloped, and neither plaintext is recoverable from the row itself.
    expect(claims.every((c) => c.value_encrypted)).toBe(true);
    const revealed = await Promise.all(
      claims.map((c) => revealAssertionValue(TENANT, c.assertion_id)),
    );
    expect(new Set(revealed)).toEqual(new Set(['a@example.test', 'b@example.test']));
  });

  it('supersedes a claim without destroying it, and refuses a second supersede', async () => {
    const subject = `subject:${run}-supersede`;
    const first = await writeAssertion({
      tenant_id: TENANT, subject_ref: subject, attribute: 'email',
      value: 'stale@example.test', origin_class: 'LICENSED_THIRD_PARTY', confidence: 0.3,
    });
    const before = await dataService.one<{ value: string; confidence: string }>(
      'SELECT value, confidence FROM source_record.source_assertion WHERE assertion_id = $1',
      [first.assertion_id],
    );

    const { prior, replacement } = await supersedeAssertion({
      tenant_id: TENANT,
      assertion_id: first.assertion_id,
      replacement: { value: 'fresh@example.test', origin_class: 'LICENSED_THIRD_PARTY', confidence: 0.7 },
      reason: 'supplier correction',
    });
    expect(prior.status).toBe('SUPERSEDED');
    expect(prior.superseded_by).toBe(replacement.assertion_id);

    const after = await dataService.one<{ value: string; confidence: string }>(
      'SELECT value, confidence FROM source_record.source_assertion WHERE assertion_id = $1',
      [first.assertion_id],
    );
    expect(after?.value).toBe(before?.value);
    expect(after?.confidence).toBe(before?.confidence);
    expect(await revealAssertionValue(TENANT, first.assertion_id)).toBe('stale@example.test');

    await expect(
      supersedeAssertion({
        tenant_id: TENANT,
        assertion_id: first.assertion_id,
        replacement: { value: 'third@example.test', origin_class: 'LICENSED_THIRD_PARTY' },
      }),
    ).rejects.toBeInstanceOf(AssertionAlreadySuperseded);

    // The refused supersede left no orphan successor behind.
    const total = await dataService.one<{ n: string }>(
      'SELECT count(*)::text AS n FROM source_record.source_assertion WHERE subject_ref = $1',
      [subject],
    );
    expect(total?.n).toBe('2');
  });

  it('refuses to attest bought data without paperwork, then enforces the attested purpose', async () => {
    const subject = `subject:${run}-rights`;
    const cap = await captureSourceRecord({
      tenant_id: TENANT,
      source_system: `system-${run}-rights`,
      raw_evidence: { list: 'purchased' },
      origin_class: 'LICENSED_THIRD_PARTY',
      subject_ref: subject,
    });

    await expect(
      signAttestation({
        tenant_id: TENANT,
        attestor_principal: 'principal:integration',
        origin_class: 'LICENSED_THIRD_PARTY',
        permitted_uses: ['analytics'],
        capture_id: cap.record.capture_id,
      }),
    ).rejects.toBeInstanceOf(AttestationEvidenceMissing);

    const att = await signAttestation({
      tenant_id: TENANT,
      attestor_principal: 'principal:integration',
      origin_class: 'LICENSED_THIRD_PARTY',
      permitted_uses: ['analytics'],
      capture_id: cap.record.capture_id,
      evidence_blob_ref: 'evidence:licence-agreement',
      collection_period_start: new Date(Date.now() - 86_400_000).toISOString(),
      collection_period_end: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect((await verifyAttestation(TENANT, att.attestation_id)).valid).toBe(true);

    expect((await checkPermittedUse({ tenant_id: TENANT, subject_ref: subject, purpose: 'analytics' })).permitted).toBe(true);

    const refused = await checkPermittedUse({ tenant_id: TENANT, subject_ref: subject, purpose: 'resale' });
    expect(refused.permitted).toBe(false);
    expect(refused.reason).toBe('PURPOSE_NOT_ATTESTED');
    expect(refused.permitted_uses).toContain('analytics');

    const lapsed = await checkPermittedUse({
      tenant_id: TENANT, subject_ref: subject, purpose: 'analytics',
      at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
    expect(lapsed.reason).toBe('COLLECTION_PERIOD_LAPSED');
  });

  it('proves every mutating call idempotent by replaying it', async () => {
    const subject = `subject:${run}-replay`;
    const fingerprint = `fp-${run}-replay`;
    const payload = { z: 1, a: { n: 2, m: 3 } };

    const first = await captureSourceRecord({
      tenant_id: TENANT, source_system: `system-${run}-replay`, raw_evidence: payload,
      fingerprint, origin_class: 'FIRST_PARTY_DIRECT', subject_ref: subject,
    });
    // Same payload, keys re-ordered, fingerprint omitted so it is derived: the
    // content hash must land on the SAME capture.
    const replay = await captureSourceRecord({
      tenant_id: TENANT, source_system: `system-${run}-replay`,
      raw_evidence: { a: { m: 3, n: 2 }, z: 1 }, fingerprint,
      origin_class: 'FIRST_PARTY_DIRECT',
    });
    expect(replay.created).toBe(false);
    expect(replay.record.capture_id).toBe(first.record.capture_id);
    // A retry is not an event: no second capture entry in the ledger.
    expect((await auditCounts(first.record.capture_id))['source-record.captured.v1']).toBe(1);

    // normalize replayed: state does not move twice, no second transition entry.
    await normalizeSourceRecord({ tenant_id: TENANT, capture_id: first.record.capture_id });
    await normalizeSourceRecord({ tenant_id: TENANT, capture_id: first.record.capture_id });
    const afterNormalize = await auditCounts(first.record.capture_id);
    expect(afterNormalize['source-record.normalized.v1']).toBe(1);

    // promote replayed: the second call cannot repeat the rung.
    await promoteSourceRecord({ tenant_id: TENANT, capture_id: first.record.capture_id, to_state: 'P2_CANDIDATE' });
    await expect(
      promoteSourceRecord({ tenant_id: TENANT, capture_id: first.record.capture_id, to_state: 'P2_CANDIDATE' }),
    ).rejects.toBeInstanceOf(InvalidTrustTransition);
    expect((await auditCounts(first.record.capture_id))['source-record.promoted.v1']).toBe(1);

    // crosswalk replayed: same row, not a duplicate and not an error.
    const external_id = `EXT-${run}-replay`;
    const cw1 = await linkCrosswalk({
      tenant_id: TENANT, capture_id: first.record.capture_id,
      external_system: 'system-x', external_id,
    });
    const cw2 = await linkCrosswalk({
      tenant_id: TENANT, capture_id: first.record.capture_id,
      external_system: 'system-x', external_id,
    });
    expect(cw2.crosswalk_id).toBe(cw1.crosswalk_id);
    expect(await listCrosswalks(TENANT, first.record.capture_id)).toHaveLength(1);
  });

  it('leaves the sdk-audit chain linked unbroken across the entries it wrote', async () => {
    const head = await dataService.one<{ seq: string | null }>(
      'SELECT max(seq)::text AS seq FROM audit.entry WHERE pool_index = $1',
      [AUDIT_POOL],
    );
    const headAfterRun = Number(head?.seq ?? 0);

    // Scoped to THIS run's segment: a shared long-lived pool accumulates history
    // from every other SDK, and a failure sourced from someone else's entries gets
    // ignored within a week.
    expect(
      headAfterRun,
      'the flow above appended no audit entries — this assertion would be vacuous',
    ).toBeGreaterThan(headBeforeRun);

    // LINKAGE is the property this SDK could actually break: every entry's
    // prev_hash must equal the preceding entry's entry_hash, with no gap or fork.
    const linkage = await dataService.one<{ breaks: string; checked: string }>(
      `WITH c AS (
         SELECT seq, prev_hash, lag(entry_hash) OVER (ORDER BY seq) AS expected_prev
           FROM audit.entry WHERE pool_index = $1
       )
       SELECT count(*) FILTER (WHERE seq > $2 AND prev_hash IS DISTINCT FROM expected_prev)::text AS breaks,
              count(*) FILTER (WHERE seq > $2)::text AS checked
         FROM c`,
      [AUDIT_POOL, headBeforeRun],
    );
    expect(Number(linkage?.checked)).toBe(headAfterRun - headBeforeRun);
    expect(Number(linkage?.breaks), 'prev_hash linkage broken in this run’s segment').toBe(0);

    /*
     * Content re-verification (verifyChain) is asserted only as NOT-WORSE-THAN the
     * pre-existing baseline, because it is currently broken platform-wide and not
     * by anything here:
     *
     *   auditService.computeHash hashes `input.payload` in JS insertion order,
     *   while chainVerifier.recomputeHash hashes the SAME payload after a jsonb
     *   round-trip, which reorders keys (shortest first, then bytewise). Any
     *   payload whose insertion order differs from jsonb's storage order therefore
     *   fails to re-verify. Entries written in June fail identically — seq 101,
     *   5000 and 14400 all mismatch — and seq 100 passes only because its two keys
     *   happen to already be in jsonb order.
     *
     * The consequence is worth stating plainly: today a genuine tamper is
     * indistinguishable from this noise. The fix is to canonicalize the payload
     * (sorted keys) on BOTH sides, or store it as `json` rather than `jsonb`; it
     * belongs in sdk-audit, not here, because it changes the hash contract for
     * every producer on the platform.
     */
    const proof = await verifyChain({
      pool_index: AUDIT_POOL,
      from_seq: headBeforeRun + 1,
      to_seq: headAfterRun,
    });
    expect(proof.entries_checked).toBeGreaterThan(0);
    if (!proof.ok) {
      const baseline = await verifyChain({ pool_index: AUDIT_POOL, from_seq: 1, to_seq: 200 });
      expect(
        baseline.ok,
        'content re-verification failed for this run BUT passes on historical entries — ' +
          'that would make the drift ours, not pre-existing. Investigate before shipping.',
      ).toBe(false);
    }
  });
});
