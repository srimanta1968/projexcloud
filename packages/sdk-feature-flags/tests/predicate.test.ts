import { describe, expect, it } from 'vitest';
import { predicateMatches } from '../src/services/featureFlagsService';

describe('predicateMatches', () => {
  it('empty predicate always matches (catch-all rollout)', () => {
    expect(predicateMatches({}, {})).toBe(true);
    expect(predicateMatches({}, { tenant_id: 't1' })).toBe(true);
  });

  it('equality match on structural field', () => {
    expect(predicateMatches({ tenant_id: 't1' }, { tenant_id: 't1' })).toBe(true);
    expect(predicateMatches({ tenant_id: 't1' }, { tenant_id: 't2' })).toBe(false);
  });

  it('array predicate is set-membership', () => {
    expect(predicateMatches({ tenant_id: ['t1', 't2'] }, { tenant_id: 't2' })).toBe(true);
    expect(predicateMatches({ tenant_id: ['t1', 't2'] }, { tenant_id: 't3' })).toBe(false);
  });

  it('attribute lookup falls back through ctx.attributes', () => {
    expect(
      predicateMatches({ vertical: 'healthcare' }, { attributes: { vertical: 'healthcare' } }),
    ).toBe(true);
    expect(
      predicateMatches({ vertical: 'healthcare' }, { attributes: { vertical: 'finance' } }),
    ).toBe(false);
  });

  it('rejects when any clause fails (AND semantics)', () => {
    expect(
      predicateMatches(
        { tenant_id: 't1', vertical: 'healthcare' },
        { tenant_id: 't1', attributes: { vertical: 'finance' } },
      ),
    ).toBe(false);
  });

  it('rejects when structural field is missing from context', () => {
    expect(predicateMatches({ persona_id: 'p1' }, {})).toBe(false);
  });
});
