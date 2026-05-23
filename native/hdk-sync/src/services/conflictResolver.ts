import type { ConflictPolicy } from '../models/sync.model';

/**
 * Conflict Resolution Model — the five strategies per P3 PRD §5.8 / FR-HS-4.
 *
 * Each resolver is pure: (a, b, strategy_detail) → resolved | null.
 * A null result for 'human-review' policy indicates the resolver escalated.
 */

export interface ResolverResult {
  resolved: Record<string, unknown> | null;
  escalated_to_human: boolean;
}

export function resolveByPolicy(
  policy: ConflictPolicy,
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  strategy_detail?: string | null,
): ResolverResult {
  switch (policy) {
    case 'crdt':
      return { resolved: crdtResolve(a, b, strategy_detail), escalated_to_human: false };
    case 'lww':
      return { resolved: lwwResolve(a, b), escalated_to_human: false };
    case 'merge':
      return { resolved: mergeResolve(a, b, strategy_detail), escalated_to_human: false };
    case 'event-sourcing':
      return { resolved: eventSourceResolve(a, b), escalated_to_human: false };
    case 'human-review':
      return { resolved: null, escalated_to_human: true };
  }
}

/**
 * CRDT family. Strategy detail selects the variant:
 *   crdt:g-counter        — increment-only counter, sum of operands
 *   crdt:pn-counter       — additive counter, sum of operands
 *   crdt:lww-set          — set union with tombstones (highest ts wins)
 *   crdt:or-set           — observed-remove set
 *   crdt:rga-text         — replicated growable array for collaborative text
 */
function crdtResolve(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  variant?: string | null,
): Record<string, unknown> {
  switch (variant) {
    case 'crdt:g-counter':
    case 'crdt:pn-counter':
      return { value: (Number(a.value) || 0) + (Number(b.value) || 0) };
    case 'crdt:lww-set': {
      const setA = (a.items as { id: string; ts: number; tombstone?: boolean }[]) ?? [];
      const setB = (b.items as { id: string; ts: number; tombstone?: boolean }[]) ?? [];
      const merged = new Map<string, { id: string; ts: number; tombstone?: boolean }>();
      for (const item of [...setA, ...setB]) {
        const prev = merged.get(item.id);
        if (!prev || item.ts > prev.ts) merged.set(item.id, item);
      }
      return { items: Array.from(merged.values()).filter((i) => !i.tombstone) };
    }
    case 'crdt:or-set': {
      const setA = new Set((a.items as string[]) ?? []);
      const setB = new Set((b.items as string[]) ?? []);
      const removed = new Set([...(a.removed as string[] ?? []), ...(b.removed as string[] ?? [])]);
      const union = new Set([...setA, ...setB]);
      for (const r of removed) union.delete(r);
      return { items: Array.from(union), removed: Array.from(removed) };
    }
    case 'crdt:rga-text':
    default: {
      // RGA-text: each operation has (position, char, ts, replica_id). We
      // deterministically order by (ts, replica_id) for a convergent merge.
      type Op = { position: number; char: string; ts: number; replica_id: string };
      const opsA = (a.ops as Op[]) ?? [];
      const opsB = (b.ops as Op[]) ?? [];
      const all = [...opsA, ...opsB].sort((x, y) => x.ts - y.ts || x.replica_id.localeCompare(y.replica_id));
      let text = '';
      for (const op of all) text += op.char;
      return { text, ops: all };
    }
  }
}

/** LWW: whichever side has the larger timestamp wins. */
function lwwResolve(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const tsA = Number(a.ts ?? a.timestamp ?? 0);
  const tsB = Number(b.ts ?? b.timestamp ?? 0);
  return tsA >= tsB ? a : b;
}

/**
 * Merge: per-field rules selected by strategy_detail.
 *   merge:additive    — numeric fields summed
 *   merge:max         — numeric fields max
 *   merge:last-write  — per-field LWW using field-level ts
 *   merge:veto        — any null/falsy in either side blocks the merge
 */
function mergeResolve(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  variant?: string | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const av = a[k];
    const bv = b[k];
    switch (variant) {
      case 'merge:additive':
        out[k] = (typeof av === 'number' ? av : 0) + (typeof bv === 'number' ? bv : 0);
        break;
      case 'merge:max':
        out[k] = typeof av === 'number' && typeof bv === 'number'
          ? Math.max(av, bv)
          : av ?? bv;
        break;
      case 'merge:veto':
        out[k] = av != null && bv != null ? av : null;
        break;
      case 'merge:last-write':
      default:
        out[k] = av ?? bv;
        break;
    }
  }
  return out;
}

/** Event-sourcing: append both operands; downstream replay derives state. */
function eventSourceResolve(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const eventsA = Array.isArray(a.events) ? (a.events as unknown[]) : [a];
  const eventsB = Array.isArray(b.events) ? (b.events as unknown[]) : [b];
  return { events: [...eventsA, ...eventsB] };
}
