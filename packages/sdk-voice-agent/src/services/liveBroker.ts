import type { CallTurn } from './callService';

/**
 * Live-call pub/sub (VA·E2 · TK-4477).
 *
 * The SDK publishes; the api-gateway's WebSocket route subscribes per call and pipes
 * events to authorized viewers. Kept framework-free (no fastify, no ws) like the
 * dispatch and command brokers. In-process: subscribers only see events published
 * on the same gateway instance, which holds for the single-gateway deployment; a
 * multi-instance gateway swaps this for a Redis-backed broker behind the same shape.
 */

export type LiveEventKind = 'turn' | 'status' | 'ended';

export interface LiveEvent {
  kind: LiveEventKind;
  call_id: string;
  turn?: Omit<CallTurn, 'created_at'>;
  status?: string;
  disposition?: string | null;
  emitted_at: string;
}

export type LiveSubscriber = (event: LiveEvent) => void;

class InMemoryLiveBroker {
  private subs = new Map<string, Set<LiveSubscriber>>();

  subscribe(callId: string, fn: LiveSubscriber): () => void {
    let set = this.subs.get(callId);
    if (!set) {
      set = new Set();
      this.subs.set(callId, set);
    }
    set.add(fn);
    return () => {
      const s = this.subs.get(callId);
      if (!s) return;
      s.delete(fn);
      if (s.size === 0) this.subs.delete(callId);
    };
  }

  publish(event: LiveEvent): void {
    const set = this.subs.get(event.call_id);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(event);
      } catch {
        // One broken subscriber must not starve the others.
      }
    }
  }

  subscriberCount(callId: string): number {
    return this.subs.get(callId)?.size ?? 0;
  }
}

let broker: InMemoryLiveBroker | null = null;

export function getLiveCallBroker(): InMemoryLiveBroker {
  if (!broker) broker = new InMemoryLiveBroker();
  return broker;
}
