// P10/E1 — leak-case unit tests for the obligation enforcement helper.
// Runs with Node's built-in runner (zero deps): `node --test` after build.
// Imports the compiled public API so it tests exactly what consumers import.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyObligations, maskRow, rowMatchesFilter, REDACTED } from '../dist/index.js';

test('mask_fields redacts a declared top-level field server-side', () => {
  const rows = [{ id: '1', name: 'Ann', ssn: '111-22-3333' }];
  const out = applyObligations(rows, { mask_fields: ['ssn'] });
  assert.equal(out.rows[0].ssn, REDACTED);
  assert.equal(out.rows[0].name, 'Ann');
  assert.deepEqual(out.masked_fields, ['ssn']);
});

test('LEAK CASE: masked value never reaches the serialized wire', () => {
  const rows = [{ id: '1', ssn: '111-22-3333', patient: { dob: '1990-01-01' } }];
  const out = applyObligations(rows, { mask_fields: ['ssn', 'patient.dob'] });
  const wire = JSON.stringify(out.rows);
  assert.ok(!wire.includes('111-22-3333'), 'ssn leaked to the wire');
  assert.ok(!wire.includes('1990-01-01'), 'nested dob leaked to the wire');
});

test('masking never mutates the caller’s input objects', () => {
  const original = { id: '1', ssn: '111-22-3333' };
  maskRow(original, ['ssn']);
  assert.equal(original.ssn, '111-22-3333', 'input was mutated');
});

test('nested dot-path masking redacts the leaf only', () => {
  const out = maskRow({ patient: { dob: 'x', name: 'Ann' } }, ['patient.dob']);
  assert.equal(out.patient.dob, REDACTED);
  assert.equal(out.patient.name, 'Ann');
});

test('row_filter BYPASS CASE: rows are dropped even when the caller forgot to filter', () => {
  const rows = [
    { id: '1', tenant_id: 'A' },
    { id: '2', tenant_id: 'B' },
    { id: '3', tenant_id: 'A' },
  ];
  const out = applyObligations(rows, { row_filter: { tenant_id: 'A' } });
  assert.equal(out.rows.length, 2);
  assert.equal(out.filtered_out, 1);
  assert.ok(out.rows.every((r) => r.tenant_id === 'A'));
});

test('row_filter matches nested dot-path keys with AND semantics', () => {
  const filter = { 'patient.tenant_id': 'A', status: 'active' };
  assert.equal(rowMatchesFilter({ patient: { tenant_id: 'A' }, status: 'active' }, filter), true);
  assert.equal(rowMatchesFilter({ patient: { tenant_id: 'A' }, status: 'closed' }, filter), false);
  assert.equal(rowMatchesFilter({ patient: { tenant_id: 'B' }, status: 'active' }, filter), false);
});

test('filter then mask compose: survivors are filtered AND masked', () => {
  const rows = [
    { id: '1', tenant_id: 'A', ssn: 'keep-secret' },
    { id: '2', tenant_id: 'B', ssn: 'other' },
  ];
  const out = applyObligations(rows, { row_filter: { tenant_id: 'A' }, mask_fields: ['ssn'] });
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].ssn, REDACTED);
});

test('absent / empty obligations are a no-op (pre-P10 behaviour)', () => {
  const rows = [{ id: '1', ssn: 's' }];
  assert.equal(applyObligations(rows, undefined).rows, rows);
  assert.equal(applyObligations(rows, null).rows, rows);
  const empty = applyObligations(rows, {});
  assert.deepEqual(empty.rows, rows);
  assert.equal(empty.filtered_out, 0);
});
