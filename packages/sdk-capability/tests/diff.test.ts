import { describe, expect, it } from 'vitest';
import { diffManifests } from '../src/validator';
import { validManifest } from './fixtures';

describe('diffManifests', () => {
  it('identical manifests produce empty diff', () => {
    const d = diffManifests(validManifest(), validManifest());
    expect(d.added).toHaveLength(0);
    expect(d.removed).toHaveLength(0);
    expect(d.changed).toHaveLength(0);
    expect(d.is_breaking).toBe(false);
  });

  it('detects removed event as breaking', () => {
    const a = validManifest();
    const b = validManifest();
    b.provides.events = [];
    const d = diffManifests(a, b);
    expect(d.removed.find((c) => c.kind === 'event')?.identifier).toBe('example.created.v1');
    expect(d.is_breaking).toBe(true);
  });

  it('detects added scenario as non-breaking', () => {
    const a = validManifest();
    const b = validManifest();
    b.scenarios.push({
      id: 's4',
      title: 'New scenario',
      when_to_use: 'when a new use case emerges',
      example_code: "console.log('something new');",
      expected_outcome: 'a new outcome occurs',
    });
    const d = diffManifests(a, b);
    expect(d.added.find((c) => c.kind === 'scenario')?.identifier).toBe('s4');
    expect(d.is_breaking).toBe(false);
  });

  it('detects changed endpoint signature as breaking', () => {
    const a = validManifest();
    const b = validManifest();
    b.provides.endpoints[0].description = 'updated description';
    const d = diffManifests(a, b);
    expect(d.changed.find((c) => c.kind === 'endpoint')).toBeDefined();
    expect(d.is_breaking).toBe(true);
  });

  it('detects pool_placement change as breaking', () => {
    const a = validManifest();
    const b = validManifest({ pool_placement: 'evidence' });
    const d = diffManifests(a, b);
    expect(d.changed.find((c) => c.kind === 'pool_placement')).toBeDefined();
    expect(d.is_breaking).toBe(true);
  });

  it('detects removed compliance regime as breaking', () => {
    const a = validManifest({ compliance_posture: { regimes: ['SOC2', 'HIPAA'] } });
    const b = validManifest({ compliance_posture: { regimes: ['SOC2'] } });
    const d = diffManifests(a, b);
    expect(d.removed.find((c) => c.kind === 'compliance_regime')?.identifier).toBe('HIPAA');
    expect(d.is_breaking).toBe(true);
  });

  it('detects added compliance regime as non-breaking', () => {
    const a = validManifest({ compliance_posture: { regimes: ['SOC2'] } });
    const b = validManifest({ compliance_posture: { regimes: ['SOC2', 'HIPAA'] } });
    const d = diffManifests(a, b);
    expect(d.added.find((c) => c.kind === 'compliance_regime')?.identifier).toBe('HIPAA');
    expect(d.is_breaking).toBe(false);
  });

  it('detects renamed event as added + removed (no rename heuristic)', () => {
    const a = validManifest();
    const b = validManifest();
    b.provides.events[0].name = 'example.renamed.v1';
    const d = diffManifests(a, b);
    expect(d.removed.find((c) => c.identifier === 'example.created.v1')).toBeDefined();
    expect(d.added.find((c) => c.identifier === 'example.renamed.v1')).toBeDefined();
    expect(d.is_breaking).toBe(true);
  });
});
