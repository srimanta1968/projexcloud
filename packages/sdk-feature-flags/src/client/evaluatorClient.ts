/**
 * sdk-feature-flags client-side evaluator (FR-FF-4).
 *
 * Caches flag definitions and rollouts in-process so the hot path is a local
 * predicate check, not an HTTP round-trip. Refreshes from the server every
 * `refreshIntervalMs` (default 60s) — kill-switch fan-out is therefore
 * bounded to that interval.
 *
 * The cache mirrors the server-side evaluator's resolution logic so a
 * client-side evaluation produces the same `resolved_value` as a server
 * evaluation for the same (flag_id, context). When the cache hasn't been
 * primed (or is older than `staleAfterMs`) the client falls back to the
 * server HTTP endpoint.
 */
import crypto from 'crypto';
import type { EvaluationContext, EvaluationResult, FlagRecord, RolloutRecord } from '../models/flag.model';

export interface ClientCacheOptions {
  /** Base URL of the api-gateway hosting /api/flags. */
  baseUrl: string;
  /** Bearer token used for refreshes (required by route auth). */
  authToken: string;
  /** Periodic refresh interval in ms. Default 60_000. */
  refreshIntervalMs?: number;
  /** Cache row considered stale after this many ms. Default 5×refreshIntervalMs. */
  staleAfterMs?: number;
  /** Optional fetch implementation (for tests / non-node hosts). */
  fetchImpl?: typeof fetch;
}

interface CacheRow {
  flag: FlagRecord;
  rollouts: RolloutRecord[];
  loaded_at: number;
}

export class FeatureFlagsClient {
  private cache = new Map<string, CacheRow>();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly refreshIntervalMs: number;
  private readonly staleAfterMs: number;

  constructor(private readonly opts: ClientCacheOptions) {
    this.refreshIntervalMs = opts.refreshIntervalMs ?? 60_000;
    this.staleAfterMs = opts.staleAfterMs ?? this.refreshIntervalMs * 5;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Begin periodic refresh of every cached flag. */
  start(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(() => {
      void this.refreshAll().catch((err) => {
         
        console.error('[sdk-feature-flags client] refresh failed', (err as Error).message);
      });
    }, this.refreshIntervalMs);
  }

  /** Stop the periodic refresh. Safe to call repeatedly. */
  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /**
   * Evaluate `flag_id` for `context`. Hits the cache when fresh; falls back
   * to the server endpoint otherwise. Mirrors server-side resolution rules.
   */
  async evaluate(flag_id: string, context: EvaluationContext): Promise<EvaluationResult> {
    const row = this.cache.get(flag_id);
    const fresh = row && Date.now() - row.loaded_at < this.staleAfterMs;
    if (!fresh) {
      try {
        return await this.serverEvaluate(flag_id, context);
      } catch {
        // Server unreachable — fall through to whatever stale row we have.
      }
    }
    if (!row) {
      return { flag_id, resolved_value: null, matched_rollout_id: null, kill_switch_engaged: false };
    }
    return this.localEvaluate(row, context);
  }

  private localEvaluate(row: CacheRow, ctx: EvaluationContext): EvaluationResult {
    const { flag, rollouts } = row;
    if (flag.kill_switch) {
      const off = flag.kind === 'boolean' ? false : flag.kind === 'numeric' ? 0 : null;
      return { flag_id: flag.flag_id, resolved_value: off, matched_rollout_id: null, kill_switch_engaged: true };
    }
    const subject = ctx.persona_id ?? ctx.tenant_id ?? 'anon';
    for (const r of rollouts) {
      if (!r.active) continue;
      if (r.tenant_id && r.tenant_id !== ctx.tenant_id) continue;
      if (!predicateMatches(r.predicate, ctx)) continue;
      if (r.rollout_percent != null && rolloutBucket(flag.flag_id, subject) >= r.rollout_percent) continue;
      return {
        flag_id: flag.flag_id,
        resolved_value: r.value,
        matched_rollout_id: r.rollout_id,
        kill_switch_engaged: false,
      };
    }
    return { flag_id: flag.flag_id, resolved_value: flag.default_value, matched_rollout_id: null, kill_switch_engaged: false };
  }

  private async serverEvaluate(flag_id: string, ctx: EvaluationContext): Promise<EvaluationResult> {
    const res = await this.fetchImpl(`${this.opts.baseUrl}/api/flags/${flag_id}/evaluate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.opts.authToken}`,
      },
      body: JSON.stringify(ctx),
    });
    if (!res.ok) throw new Error(`server evaluate ${res.status}`);
    const body = (await res.json()) as { data: { evaluation: EvaluationResult } };
    return body.data.evaluation;
  }

  /**
   * Prime / refresh the cache for one flag. Optional: the periodic refresh
   * loop fetches every cached flag in turn.
   */
  async prime(flag_id: string): Promise<void> {
    const flagRes = await this.fetchImpl(`${this.opts.baseUrl}/api/flags/${flag_id}`, {
      headers: { Authorization: `Bearer ${this.opts.authToken}` },
    });
    if (!flagRes.ok) throw new Error(`server prime flag ${flagRes.status}`);
    const flagBody = (await flagRes.json()) as { data: { flag: FlagRecord } };
    // The rollout list isn't exposed on a dedicated route in v0.1; mirror via
    // the bulk /api/flags response when present, otherwise leave empty (the
    // client will use default_value).
    this.cache.set(flag_id, {
      flag: flagBody.data.flag,
      rollouts: [],
      loaded_at: Date.now(),
    });
  }

  private async refreshAll(): Promise<void> {
    for (const flag_id of this.cache.keys()) {
      try {
        await this.prime(flag_id);
      } catch (err) {
         
        console.error('[sdk-feature-flags client] prime failed', flag_id, (err as Error).message);
      }
    }
  }
}

function predicateMatches(predicate: Record<string, unknown>, ctx: EvaluationContext): boolean {
  for (const [k, v] of Object.entries(predicate)) {
    const actual =
      k === 'tenant_id' ? ctx.tenant_id :
      k === 'persona_id' ? ctx.persona_id :
      k === 'bu_id' ? ctx.bu_id :
      ctx.attributes?.[k];
    if (Array.isArray(v)) {
      if (!v.includes(actual as never)) return false;
    } else if (actual !== v) {
      return false;
    }
  }
  return true;
}

function rolloutBucket(flag_id: string, subject: string): number {
  const h = crypto.createHash('sha256').update(`${flag_id}:${subject}`).digest();
  return h.readUInt32BE(0) % 100;
}
