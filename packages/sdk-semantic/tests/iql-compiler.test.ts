/**
 * Unit tests for the v1 IQL → ABAC + ReBAC compiler.
 *
 * Pure functional — no DB. Covers the two grammar forms shipped in v1
 * and the canonical PRD AC-9 example.
 */

import { describe, expect, it } from 'vitest';
import { compileIql } from '../src/services/policyService';

describe('compileIql — ALLOW form', () => {
  it('compiles the PRD AC-9 example (Doctor + care-team + Patient → write Prescription)', () => {
    const out = compileIql(
      'ALLOW Doctor WITH care-team(Patient) TO write Prescription',
    );
    expect(out.compiled_abac).toBe(
      'subject.type == "Doctor" && action == "write" && resource.type == "Prescription"',
    );
    expect(out.compiled_rebac).toMatchObject({
      effect: 'allow',
      require_edges: [
        {
          kind: 'care-team',
          from_object_type: 'Doctor',
          to_object_type: 'Patient',
          active: true,
        },
      ],
    });
  });

  it('compiles a hyphenated relation name', () => {
    const out = compileIql('ALLOW Buyer WITH owns(Property) TO read Property');
    expect(out.compiled_rebac).toMatchObject({
      effect: 'allow',
      require_edges: [
        { kind: 'owns', from_object_type: 'Buyer', to_object_type: 'Property' },
      ],
    });
  });
});

describe('compileIql — DENY form', () => {
  it('compiles a deny rule', () => {
    const out = compileIql('DENY Visitor TO write Encounter');
    expect(out.compiled_abac).toBe(
      'subject.type == "Visitor" && action == "write" && resource.type == "Encounter"',
    );
    expect(out.compiled_rebac).toMatchObject({ effect: 'deny', require_edges: [] });
  });
});

describe('compileIql — invalid forms', () => {
  it('rejects unknown grammar', () => {
    expect(() => compileIql('PERMIT Doctor everything')).toThrow(/IQL parse failed/);
  });

  it('rejects empty source', () => {
    expect(() => compileIql('')).toThrow();
  });
});
