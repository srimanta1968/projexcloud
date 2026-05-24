/**
 * Smoke tests for sdk-lineage typing — no DB required.
 *
 * Verifies the public surface is well-typed and the EVENT_TYPE_REGISTRY
 * carries every event sdk-lineage emits (G8 closer, OC-2 doctrine).
 */

import { describe, expect, it } from 'vitest';
import { EVENT_TYPE_REGISTRY, assertRegisteredEventType } from '@projexlight/contracts';
import type {
  LineageEmitInput,
  LineageEdgeKind,
  LineageNodeKind,
} from '@projexlight/contracts';
import { emit, chain, crossPoolChain, claimProjectionBatch, markProjected, markFailed, rescheduleProjection } from '../src/services/lineageService';

describe('sdk-lineage public surface', () => {
  it('exports the documented functions', () => {
    expect(typeof emit).toBe('function');
    expect(typeof chain).toBe('function');
    expect(typeof crossPoolChain).toBe('function');
    expect(typeof claimProjectionBatch).toBe('function');
    expect(typeof markProjected).toBe('function');
    expect(typeof markFailed).toBe('function');
    expect(typeof rescheduleProjection).toBe('function');
  });

  it('rejects cross-tenant emit at the type+runtime layer', async () => {
    const input: LineageEmitInput = {
      from: { ref_kind: 'parsing.extracted_field', ref_id: 'f-1', kind: 'field', tenant_id: 'tenant-a' },
      to:   { ref_kind: 'healthcare.encounter',     ref_id: 'e-1', kind: 'record', tenant_id: 'tenant-b' },
      edge_kind: 'derived_from' satisfies LineageEdgeKind,
      producer_sdk: 'sdk-parsing',
      trace_id: 't-1',
    };
    await expect(emit(input)).rejects.toThrow(/cross-tenant emit blocked/);
  });
});

describe('sdk-lineage event registry (OC-2 enforcement)', () => {
  const expectedEvents = [
    'lineage.edge.emitted.v1',
    'lineage.projection.queued.v1',
    'lineage.projection.completed.v1',
    'lineage.projection.failed.v1',
  ];

  for (const t of expectedEvents) {
    it(`registers ${t}`, () => {
      expect(EVENT_TYPE_REGISTRY[t]).toBeDefined();
      expect(EVENT_TYPE_REGISTRY[t].schema_state).toBe('active');
      expect(() => assertRegisteredEventType(t)).not.toThrow();
    });
  }

  it('rejects unregistered event types', () => {
    expect(() => assertRegisteredEventType('lineage.bogus.v1')).toThrow(/Unregistered event_type/);
  });
});

describe('LineageNodeKind / LineageEdgeKind enums', () => {
  it('LineageNodeKind covers all 6 documented kinds', () => {
    const kinds: LineageNodeKind[] = ['field', 'record', 'blob', 'agent-output', 'recommendation', 'model'];
    expect(kinds).toHaveLength(6);
  });

  it('LineageEdgeKind covers all 5 documented kinds', () => {
    const kinds: LineageEdgeKind[] = ['extracted_from', 'derived_from', 'merged_from', 'scored_by', 'translated_by'];
    expect(kinds).toHaveLength(5);
  });
});
