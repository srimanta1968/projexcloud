// P10/E7 — cross-SDK integration + regression tests for the P10 access path:
//   resolver (probabilistic match) -> policy (consent gate) -> gateway
//   (obligation enforcement) -> audit.
// Runs with `node --test` against built dist (zero deps). Asserts the new
// P10 surfaces compose AND that pre-P10 behaviour is preserved when the new
// optional features are unused.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyObligations,
  hasActiveConsent,
  maskRow,
  CONSENT_ABSENT_REASON,
} from '../../packages/contracts/dist/index.js';
import { scoreMatch } from '../../packages/sdk-identity-resolver/dist/services/fieldMatch.js';

// ── Helper mirroring the policy consent-gate + gateway enforcement composition ──
function decide({ policyAllows, purposeBound, purpose, receipts, obligations, rows }) {
  const consentSatisfied = !purposeBound || hasActiveConsent(receipts, purpose);
  const allowed = policyAllows && consentSatisfied;
  const reason = !consentSatisfied ? CONSENT_ABSENT_REASON : allowed ? 'permit' : 'deny';
  const enforced = allowed ? applyObligations(rows, obligations) : { rows: [], masked_fields: [], filtered_out: 0 };
  return { allowed, reason, enforced };
}

test('E2E: resolver match -> consent-allowed purpose-bound read -> obligations enforced', () => {
  // resolver: a strong probabilistic match surfaces a candidate
  const m = scoreMatch(
    { name: 'Ann Lee', dob: '1990-01-01', phone: '555-111-2222' },
    { name: 'Ann Lee', dob: '1990-01-01', phone: '999-111-2222' },
  );
  assert.ok(m.score >= 0.7, `expected strong match, got ${m.score}`);

  // policy+consent+gateway: treatment consent present, obligations mask ssn + filter tenant
  const result = decide({
    policyAllows: true,
    purposeBound: true,
    purpose: 'hipaa.treatment',
    receipts: [{ purpose_id: 'hipaa.treatment' }],
    obligations: { mask_fields: ['ssn'], row_filter: { tenant_id: 'A' } },
    rows: [
      { id: '1', tenant_id: 'A', ssn: '111-22-3333' },
      { id: '2', tenant_id: 'B', ssn: '444-55-6666' },
    ],
  });
  assert.equal(result.allowed, true);
  assert.equal(result.enforced.rows.length, 1, 'row_filter should drop the other tenant');
  assert.equal(result.enforced.rows[0].ssn, null, 'ssn must be masked');
  assert.ok(!JSON.stringify(result.enforced.rows).includes('111-22-3333'));
});

test('E2E: purpose-bound read with NO consent fails closed (consent_absent)', () => {
  const result = decide({
    policyAllows: true,
    purposeBound: true,
    purpose: 'hipaa.marketing',
    receipts: [{ purpose_id: 'hipaa.treatment' }], // wrong purpose
    obligations: { mask_fields: ['ssn'] },
    rows: [{ id: '1', ssn: '111-22-3333' }],
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, CONSENT_ABSENT_REASON);
  assert.equal(result.enforced.rows.length, 0);
});

test('E2E: revoked consent fails closed', () => {
  const ok = hasActiveConsent([{ purpose_id: 'p', revoked_at: '2026-01-01T00:00:00Z' }], 'p');
  assert.equal(ok, false);
});

test('REGRESSION: pre-P10 read (no obligations, not purpose-bound) is unchanged', () => {
  const rows = [{ id: '1', ssn: '111-22-3333' }];
  const result = decide({ policyAllows: true, purposeBound: false, rows, obligations: undefined });
  assert.equal(result.allowed, true);
  assert.equal(result.reason, 'permit');
  // identical rows, nothing masked or filtered
  assert.equal(result.enforced.rows, rows);
  assert.equal(result.enforced.masked_fields.length, 0);
  assert.equal(result.enforced.filtered_out, 0);
});

test('REGRESSION: optional P10 fields absent are pure no-ops', () => {
  const rows = [{ id: '1', ssn: 's' }];
  assert.equal(applyObligations(rows, undefined).rows, rows);
  assert.equal(applyObligations(rows, null).rows, rows);
  assert.equal(hasActiveConsent(undefined, 'p'), false);
  assert.deepEqual(maskRow({ a: 1 }, []), { a: 1 });
});

test('REGRESSION: a DENY never serializes rows', () => {
  const result = decide({
    policyAllows: false,
    purposeBound: false,
    rows: [{ id: '1', ssn: 's' }],
    obligations: { mask_fields: ['ssn'] },
  });
  assert.equal(result.allowed, false);
  assert.equal(result.enforced.rows.length, 0);
});
