import type { KeyHandle, LayerConfig, RuntimeLayer, RuntimeLayerConfig } from '../controlPlane';

/**
 * Turn-boundary provider failover (VA·E1 · TK-4465).
 *
 * Each layer starts on its primary key. A retryable failure — 429, 5xx, or the provider
 * unreachable (status 0/504) — trips that layer: from the NEXT turn (the next LLM request,
 * the next TTS clause, an immediate STT reconnect) it runs on the stack's secondary key and
 * config, for the rest of the call. The in-flight turn is not retried mid-sentence; the
 * caller hears the graceful line for it. A layer without a secondary stays on its primary
 * (the degradation is still reported). Mirrors sdk-ai-gateway's breaker semantics, in memory,
 * with no Postgres on the hot path.
 */

export interface ActiveLayer extends LayerConfig {
  handle: KeyHandle;
  onSecondary: boolean;
}

export interface Degradation {
  layer: RuntimeLayer;
  from: KeyHandle;
  to: KeyHandle | null;
  toProvider: string | null;
  status: number;
  error: string;
}

/** Retryable statuses: rate-limited, server errors, unreachable/timeouts. */
export function isRetryable(status: number | undefined): boolean {
  if (status === undefined) return false;
  return status === 0 || status === 429 || status >= 500;
}

export class LayerFailover {
  private readonly tripped = new Set<RuntimeLayer>();

  constructor(private readonly layers: Record<RuntimeLayer, RuntimeLayerConfig>) {}

  /** The config + key a layer should use right now. */
  active(layer: RuntimeLayer): ActiveLayer {
    const l = this.layers[layer];
    if (this.tripped.has(layer) && l.secondary) {
      const { config, ...handle } = l.secondary;
      return { ...config, handle, onSecondary: true };
    }
    const { primary, secondary: _s, ...config } = l;
    return { ...config, handle: primary, onSecondary: false };
  }

  isTripped(layer: RuntimeLayer): boolean {
    return this.tripped.has(layer);
  }

  /**
   * Records a failure. Returns the degradation to report when this is the FIRST retryable
   * failure of the layer's primary, else null (non-retryable, already tripped, or it was
   * already the secondary failing).
   */
  report(layer: RuntimeLayer, status: number | undefined, error: string): Degradation | null {
    if (!isRetryable(status) || this.tripped.has(layer)) return null;
    this.tripped.add(layer);
    const l = this.layers[layer];
    return {
      layer,
      from: l.primary,
      to: l.secondary ?? null,
      toProvider: l.secondary ? l.secondary.config.provider : null,
      status: status ?? 0,
      error: error.slice(0, 300),
    };
  }
}
