import { describe, expect, it } from 'vitest';
import { validateBlueprint } from '../src/validator';
import { validBlueprint } from './fixtures';

describe('validateBlueprint — happy path', () => {
  it('accepts a complete blueprint', () => {
    const r = validateBlueprint(validBlueprint());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.id).toBe('demo-blueprint');
      expect(r.value.sdks.length).toBe(2);
    }
  });
});

describe('validateBlueprint — structural failures', () => {
  it('rejects non-object input', () => {
    const r = validateBlueprint('hello');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/JSON\/YAML object/);
  });

  it('rejects invalid id', () => {
    const r = validateBlueprint(validBlueprint({ id: 'Bad_Id!' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes('id'))).toBe(true);
  });

  it('rejects unsupported schema_version', () => {
    const r = validateBlueprint(validBlueprint({ schema_version: '9.9' as never }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes('schema_version'))).toBe(true);
  });

  it('rejects an unknown pack', () => {
    const r = validateBlueprint(validBlueprint({ pack: 'space-pirates' as never }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes('pack'))).toBe(true);
  });

  it('rejects empty sdks array', () => {
    const r = validateBlueprint(validBlueprint({ sdks: [] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes('must be non-empty'))).toBe(true);
  });

  it('rejects sdks[].name without @projexlight scope', () => {
    const r = validateBlueprint(validBlueprint({ sdks: [{ name: 'sdk-vault' }] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes('@projexlight/'))).toBe(true);
  });

  it('rejects summary longer than 500 chars', () => {
    const r = validateBlueprint(validBlueprint({ summary: 'x'.repeat(501) }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes('summary is too long'))).toBe(true);
  });

  it('rejects enum question without options', () => {
    const bp = validBlueprint();
    bp.clarifying_questions = [
      { id: 'q1', prompt: 'choose', type: 'enum' as const },
    ];
    const r = validateBlueprint(bp);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes('options is required'))).toBe(true);
  });

  it('rejects duplicate clarifying_questions ids', () => {
    const bp = validBlueprint();
    bp.clarifying_questions = [
      { id: 'q', prompt: 'a?', type: 'string' },
      { id: 'q', prompt: 'b?', type: 'string' },
    ];
    const r = validateBlueprint(bp);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes('duplicated'))).toBe(true);
  });

  it('rejects missing outputs', () => {
    const bp = validBlueprint();
    delete (bp as Record<string, unknown>).outputs;
    const r = validateBlueprint(bp);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes('outputs'))).toBe(true);
  });

  it('rejects non-positive estimated_minutes', () => {
    const r = validateBlueprint(validBlueprint({ estimated_minutes: 0 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes('estimated_minutes'))).toBe(true);
  });
});
