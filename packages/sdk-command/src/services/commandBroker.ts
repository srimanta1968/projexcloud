/**
 * Command delivery broker (P12 · E1).
 *
 * Pure in-memory pub-sub the dispatcher publishes approved commands through;
 * the host runtime (api-gateway) subscribes and pipes each command to the
 * robot/edge over a per-asset WebSocket. Kept framework-free (no fastify, no ws
 * library) per the platform dependency rule — mirrors sdk-dispatch's broker.
 *
 * Scoping: subscribers register per target_asset_id and only receive commands
 * for that asset, so an edge agent never sees another robot's commands.
 */

export interface CommandDeliveryEvent {
  kind: 'command.dispatched';
  asset_id: string;
  command_id: string;
  tenant_id: string;
  type: string;
  params: Record<string, unknown>;
  emitted_at: string;
}

export type CommandSubscriber = (event: CommandDeliveryEvent) => void;

interface SubscriptionEntry {
  asset_id: string;
  fn: CommandSubscriber;
}

class InMemoryCommandBroker {
  private subs = new Map<string, Set<SubscriptionEntry>>();

  subscribe(assetId: string, fn: CommandSubscriber): () => void {
    const entry: SubscriptionEntry = { asset_id: assetId, fn };
    let set = this.subs.get(assetId);
    if (!set) {
      set = new Set();
      this.subs.set(assetId, set);
    }
    set.add(entry);
    return () => {
      const s = this.subs.get(assetId);
      if (!s) return;
      s.delete(entry);
      if (s.size === 0) this.subs.delete(assetId);
    };
  }

  /** Publish a command to its asset's subscribers; returns the delivery count. */
  publish(event: CommandDeliveryEvent): number {
    const set = this.subs.get(event.asset_id);
    if (!set || set.size === 0) return 0;
    let delivered = 0;
    for (const entry of set) {
      try {
        entry.fn(event);
        delivered += 1;
      } catch (err) {
        console.warn('[command-broker] subscriber threw:', (err as Error).message);
      }
    }
    return delivered;
  }

  /** For ops/diagnostic surfaces. */
  subscriberCount(assetId?: string): number {
    if (assetId) return this.subs.get(assetId)?.size ?? 0;
    let total = 0;
    for (const s of this.subs.values()) total += s.size;
    return total;
  }
}

const _broker = new InMemoryCommandBroker();

export function getCommandBroker(): InMemoryCommandBroker {
  return _broker;
}
