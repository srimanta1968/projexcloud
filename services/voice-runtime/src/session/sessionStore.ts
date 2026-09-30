import type { Redis } from '@projexlight/redis-runtime';
import type { Bootstrap } from '../controlPlane';
import { log } from '../log';

/**
 * Per-call session context (VA·E1 · TK-4457).
 *
 * The bootstrap payload lives in process memory for the whole call — prompt, stack, key
 * handles, tools, session token — so a conversation turn never reaches Postgres or the
 * control plane (VA-ADR-8). Redis holds only a minimal MIRROR of each live session (who is
 * on which worker, turn count, last activity), never keys or transcript text, so operators
 * and a restarted worker can see what was running:
 *
 *   voice:session:{call_id}          HASH, TTL = VOICE_SESSION_TTL_S, refreshed every turn
 *   voice:worker:{worker}:sessions   SET of the worker's live call ids (same TTL)
 *
 * The TTL is sliding: a worker that dies mid-call leaves keys that expire on their own.
 * Normal call end deletes them. Redis is advisory — a Redis error is logged and never breaks
 * a call.
 */

/** One line of the call transcript, with its latency breakdown (voice_agent.call_turn shape). */
export interface TurnRecord {
  turn_index: number;
  speaker: 'caller' | 'agent';
  text: string;
  /** ms since the session opened. */
  started_ms: number;
  /** Caller turns: end of speech -> final transcript. */
  stt_ms?: number | null;
  /** Agent turns: LLM request -> first token. */
  ttft_ms?: number | null;
  /** Agent turns: end of the caller's turn -> first agent audio. */
  ttfa_ms?: number | null;
  interrupted: boolean;
  tool_calls?: { name: string; ok: boolean; error: string | null; status: number | null; ms: number }[];
  model?: string;
}

export interface SessionContext {
  callId: string;
  tenantId: string;
  room: string;
  openedAt: number;
  boot: Bootstrap;
  turn: number;
  lastTurnAt: number | null;
  /** The transcript, kept in memory and written once at call end (TK-4467). */
  turns: TurnRecord[];
}

export const sessionKey = (callId: string): string => `voice:session:${callId}`;
export const workerKey = (worker: string): string => `voice:worker:${worker}:sessions`;

export class SessionStore {
  private readonly sessions = new Map<string, SessionContext>();

  constructor(
    private readonly redis: Redis | null,
    private readonly worker: string,
    private readonly ttlSeconds: number,
  ) {}

  get(callId: string): SessionContext | undefined {
    return this.sessions.get(callId);
  }

  size(): number {
    return this.sessions.size;
  }

  private mirror(op: string, fn: (r: Redis) => Promise<unknown>): void {
    if (!this.redis) return;
    fn(this.redis).catch((err: Error) => log.warn('session mirror write failed', { op, error: err.message }));
  }

  open(boot: Bootstrap, room: string): SessionContext {
    const ctx: SessionContext = {
      callId: boot.call.call_id,
      tenantId: boot.call.tenant_id,
      room,
      openedAt: Date.now(),
      boot,
      turn: 0,
      lastTurnAt: null,
      turns: [],
    };
    this.sessions.set(ctx.callId, ctx);
    const key = sessionKey(ctx.callId);
    this.mirror('open', (r) =>
      r.multi()
        .hset(key, {
          call_id: ctx.callId,
          tenant_id: ctx.tenantId,
          agent_id: boot.agent.agent_id,
          agent_version_id: boot.agent.version_id,
          direction: boot.call.direction,
          is_test: String(boot.call.is_test),
          worker: this.worker,
          room,
          status: 'active',
          turns: '0',
          opened_at: new Date(ctx.openedAt).toISOString(),
        })
        .expire(key, this.ttlSeconds)
        .sadd(workerKey(this.worker), ctx.callId)
        .expire(workerKey(this.worker), this.ttlSeconds)
        .exec(),
    );
    return ctx;
  }

  /** Called once per completed turn: bumps the counter and slides the TTL. */
  touch(callId: string): void {
    const ctx = this.sessions.get(callId);
    if (!ctx) return;
    ctx.turn += 1;
    ctx.lastTurnAt = Date.now();
    const key = sessionKey(callId);
    this.mirror('touch', (r) =>
      r.multi()
        .hset(key, { turns: String(ctx.turn), last_turn_at: new Date(ctx.lastTurnAt!).toISOString() })
        .expire(key, this.ttlSeconds)
        .expire(workerKey(this.worker), this.ttlSeconds)
        .exec(),
    );
  }

  close(callId: string): SessionContext | undefined {
    const ctx = this.sessions.get(callId);
    this.sessions.delete(callId);
    this.mirror('close', (r) => r.multi().del(sessionKey(callId)).srem(workerKey(this.worker), callId).exec());
    return ctx;
  }
}
