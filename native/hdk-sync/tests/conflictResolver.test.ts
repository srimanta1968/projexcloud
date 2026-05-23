/**
 * AC-11 / FR-HS-4 unit tests for the five Conflict Resolution Model
 * strategies. Each test exercises one variant in isolation — the strategies
 * themselves must be deterministic + commutative so the sync chaos drill
 * (when it lands) can rely on replay-order independence.
 */
import { describe, expect, it } from 'vitest';
import { resolveByPolicy } from '../src/services/conflictResolver';

describe('resolveByPolicy — five strategies', () => {
  // -----------------------------------------------------------------------
  // CRDT family
  // -----------------------------------------------------------------------
  describe('crdt', () => {
    it('g-counter / pn-counter sums operand values', () => {
      const out = resolveByPolicy('crdt', { value: 3 }, { value: 7 }, 'crdt:g-counter');
      expect(out.resolved).toEqual({ value: 10 });
      expect(out.escalated_to_human).toBe(false);
    });

    it('lww-set merges and tombstones drop', () => {
      const a = { items: [{ id: 'x', ts: 10 }, { id: 'y', ts: 5, tombstone: true }] };
      const b = { items: [{ id: 'y', ts: 20 }] };
      const out = resolveByPolicy('crdt', a, b, 'crdt:lww-set');
      const items = (out.resolved as { items: { id: string }[] }).items;
      const ids = items.map((i) => i.id).sort();
      expect(ids).toEqual(['x', 'y']); // y's later ts=20 wins over tombstone at ts=5
    });

    it('or-set removed wins regardless of order', () => {
      const a = { items: ['x', 'y'], removed: [] };
      const b = { items: ['y', 'z'], removed: ['x'] };
      const out = resolveByPolicy('crdt', a, b, 'crdt:or-set');
      const items = ((out.resolved as { items: string[] }).items).sort();
      expect(items).toEqual(['y', 'z']);
    });

    it('rga-text is commutative — same final text regardless of input order', () => {
      const opsA = { ops: [{ position: 0, char: 'H', ts: 1, replica_id: 'd1' }] };
      const opsB = { ops: [{ position: 0, char: 'i', ts: 2, replica_id: 'd2' }] };
      const r1 = resolveByPolicy('crdt', opsA, opsB, 'crdt:rga-text');
      const r2 = resolveByPolicy('crdt', opsB, opsA, 'crdt:rga-text');
      expect((r1.resolved as { text: string }).text).toBe((r2.resolved as { text: string }).text);
      expect((r1.resolved as { text: string }).text).toBe('Hi');
    });
  });

  // -----------------------------------------------------------------------
  // LWW
  // -----------------------------------------------------------------------
  describe('lww', () => {
    it('higher timestamp wins', () => {
      const out = resolveByPolicy('lww', { value: 'A', ts: 1 }, { value: 'B', ts: 2 });
      expect(out.resolved).toEqual({ value: 'B', ts: 2 });
    });

    it('ties go to first operand (deterministic)', () => {
      const out = resolveByPolicy('lww', { value: 'A', ts: 5 }, { value: 'B', ts: 5 });
      expect(out.resolved).toEqual({ value: 'A', ts: 5 });
    });
  });

  // -----------------------------------------------------------------------
  // merge per-field variants
  // -----------------------------------------------------------------------
  describe('merge', () => {
    it('additive sums numeric fields', () => {
      const out = resolveByPolicy(
        'merge',
        { hours: 3, miles: 100 },
        { hours: 2, miles: 50 },
        'merge:additive',
      );
      expect(out.resolved).toEqual({ hours: 5, miles: 150 });
    });

    it('max picks larger numeric per field', () => {
      const out = resolveByPolicy('merge', { score: 80 }, { score: 95 }, 'merge:max');
      expect(out.resolved).toEqual({ score: 95 });
    });

    it('veto: any null/undefined field blocks merge for that field', () => {
      const out = resolveByPolicy('merge', { name: 'X', age: null }, { name: 'Y', age: 30 }, 'merge:veto');
      const r = out.resolved as { name: string; age: unknown };
      expect(r.name).toBe('X');
      expect(r.age).toBeNull();
    });

    it('last-write picks first non-null (default)', () => {
      const out = resolveByPolicy('merge', { color: undefined, size: 'M' }, { color: 'red', size: 'L' });
      expect(out.resolved).toEqual({ color: 'red', size: 'M' });
    });
  });

  // -----------------------------------------------------------------------
  // event-sourcing
  // -----------------------------------------------------------------------
  describe('event-sourcing', () => {
    it('concatenates operand events', () => {
      const out = resolveByPolicy(
        'event-sourcing',
        { events: [{ kind: 'open' }] },
        { events: [{ kind: 'close' }] },
      );
      expect(out.resolved).toEqual({ events: [{ kind: 'open' }, { kind: 'close' }] });
    });

    it('wraps non-array operands in events array', () => {
      const out = resolveByPolicy('event-sourcing', { ledger: 'a' }, { ledger: 'b' });
      const r = out.resolved as { events: unknown[] };
      expect(r.events.length).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // human-review escalation
  // -----------------------------------------------------------------------
  describe('human-review', () => {
    it('escalates and returns null resolved', () => {
      const out = resolveByPolicy('human-review', { a: 1 }, { b: 2 });
      expect(out.resolved).toBeNull();
      expect(out.escalated_to_human).toBe(true);
    });
  });
});
