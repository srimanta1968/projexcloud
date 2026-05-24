import type { DispatchTaskRef, DispatchTaskStatus } from '@projexlight/contracts';

/**
 * Dispatch live-update broker (P7 FR-DSP-2).
 *
 * Typed pub-sub the rest of sdk-dispatch publishes through; the host
 * runtime (api-gateway) subscribes and pipes messages to WebSocket
 * clients. Keeping the broker pure (no fastify, no ws library) lets
 * sdk-dispatch stay framework-free per the platform's dependency rule.
 *
 * Scoping: subscribers register per dispatcher persona_id and only
 * receive events for routes / tasks assigned to them. Server-side
 * filtering protects against a buggy client subscribing to "all"
 * (which would leak cross-tenant task updates).
 *
 * Event shapes mirror the registered envelope types:
 *   dispatch.task.enqueued.v1
 *   dispatch.task.assigned.v1
 *   dispatch.task.completed.v1
 *   dispatch.route.optimized.v1
 */

export type DispatchEventKind =
  | 'task.enqueued'
  | 'task.assigned'
  | 'task.completed'
  | 'task.status'
  | 'route.optimized';

export interface DispatchEvent {
  kind: DispatchEventKind;
  persona_id: string;
  task_id?: string;
  route_id?: string;
  task?: Pick<DispatchTaskRef, 'task_id' | 'status' | 'priority' | 'scheduled_for'>;
  status?: DispatchTaskStatus;
  emitted_at: string;
}

export type DispatchSubscriber = (event: DispatchEvent) => void;

interface SubscriptionEntry {
  persona_id: string;
  fn: DispatchSubscriber;
}

class InMemoryDispatchBroker {
  private subs = new Map<string, Set<SubscriptionEntry>>();

  subscribe(personaId: string, fn: DispatchSubscriber): () => void {
    const entry: SubscriptionEntry = { persona_id: personaId, fn };
    let set = this.subs.get(personaId);
    if (!set) {
      set = new Set();
      this.subs.set(personaId, set);
    }
    set.add(entry);
    return () => {
      const s = this.subs.get(personaId);
      if (!s) return;
      s.delete(entry);
      if (s.size === 0) this.subs.delete(personaId);
    };
  }

  publish(event: DispatchEvent): void {
    const set = this.subs.get(event.persona_id);
    if (!set || set.size === 0) return;
    for (const entry of set) {
      try {
        entry.fn(event);
      } catch (err) {
        console.warn('[dispatch-broker] subscriber threw:', (err as Error).message);
      }
    }
  }

  /** For ops/diagnostic surfaces. */
  subscriberCount(personaId?: string): number {
    if (personaId) return this.subs.get(personaId)?.size ?? 0;
    let total = 0;
    for (const s of this.subs.values()) total += s.size;
    return total;
  }
}

const _broker = new InMemoryDispatchBroker();

export function getDispatchBroker(): InMemoryDispatchBroker {
  return _broker;
}

/**
 * Convenience helpers for publishers. Each maps to one registered
 * dispatch.* event envelope.
 */
export function publishTaskAssigned(input: {
  persona_id: string;
  task_id: string;
  status?: DispatchTaskStatus;
}): void {
  _broker.publish({
    kind: 'task.assigned',
    persona_id: input.persona_id,
    task_id: input.task_id,
    status: input.status ?? 'assigned',
    emitted_at: new Date().toISOString(),
  });
}

export function publishTaskCompleted(input: {
  persona_id: string;
  task_id: string;
}): void {
  _broker.publish({
    kind: 'task.completed',
    persona_id: input.persona_id,
    task_id: input.task_id,
    status: 'completed',
    emitted_at: new Date().toISOString(),
  });
}

export function publishRouteOptimized(input: {
  persona_id: string;
  route_id: string;
}): void {
  _broker.publish({
    kind: 'route.optimized',
    persona_id: input.persona_id,
    route_id: input.route_id,
    emitted_at: new Date().toISOString(),
  });
}
