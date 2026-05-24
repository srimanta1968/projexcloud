import { evaluate } from '@projexlight/sdk-feature-flags';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import type { AgentContext } from '@projexlight/contracts';

/**
 * Per-agent kill-switch evaluation for sdk-ai-gateway hot path (FR-AGW-7).
 *
 * Every complete/stream call resolves the agent's `kill_switch_flag_id`
 * (from agent_definition) through sdk-feature-flags. When the flag is
 * ENGAGED for the request's tenant, the gateway refuses the call with a
 * KillSwitchError and emits `agent.kill-switch.triggered.v1` (regulated
 * retention). Operator flipping a flag halts every active agent run on
 * the next call within the cache TTL.
 */

const AGENT_AUDIT_POOL = process.env.AI_GATEWAY_AUDIT_POOL || 'admin-default';
const KILL_SWITCH_CACHE_TTL_MS = parseInt(
  process.env.AI_GATEWAY_KILL_SWITCH_CACHE_TTL_MS || '5000',
  10,
);

export class KillSwitchError extends Error {
  readonly code = 'KillSwitchEngaged';
  readonly agent_id: string;
  readonly flag_id: string;
  constructor(agent_id: string, flag_id: string) {
    super(`[ai-gateway] kill-switch engaged for agent ${agent_id} (flag ${flag_id})`);
    this.name = 'KillSwitchError';
    this.agent_id = agent_id;
    this.flag_id = flag_id;
  }
}

interface CacheEntry {
  engaged: boolean;
  cachedAt: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(flag_id: string, tenant_id: string | null): string {
  return `${flag_id}::${tenant_id ?? 'platform'}`;
}

/**
 * Check whether the kill-switch is engaged for this agent + tenant.
 * Cached for KILL_SWITCH_CACHE_TTL_MS so the hot path doesn't hammer
 * feature-flags storage. Tests can call invalidateKillSwitchCache().
 */
export async function isKillSwitchEngaged(input: {
  agent_id: string;
  flag_id: string | null;
  ctx: AgentContext;
}): Promise<boolean> {
  if (!input.flag_id) return false;
  const key = cacheKey(input.flag_id, input.ctx.tenant_id);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.cachedAt < KILL_SWITCH_CACHE_TTL_MS) {
    return hit.engaged;
  }
  let engaged = false;
  try {
    const decision = await evaluate(input.flag_id, {
      tenant_id: input.ctx.tenant_id ?? null,
      persona_id: input.ctx.acting_persona_id,
      agent_id: input.agent_id,
    } as Parameters<typeof evaluate>[1]);
    engaged = decision?.kill_switch_engaged === true || decision?.resolved_value === 'engaged';
  } catch (err) {
    // Fail-safe: if feature-flags is unreachable, do NOT block the call.
    // The TTL enforcer + meter still gate; kill-switch is best-effort.
    console.warn('[ai-gateway] kill-switch evaluate failed; treating as disengaged:', (err as Error).message);
    engaged = false;
  }
  cache.set(key, { engaged, cachedAt: Date.now() });
  return engaged;
}

/** Test/admin hook — invalidate the cache so the next evaluate hits storage. */
export function invalidateKillSwitchCache(): void {
  cache.clear();
}

/**
 * Throws KillSwitchError when the agent's kill-switch is engaged. Emits
 * the audit event before throwing so the operator sees the halt + the
 * specific agent/tenant context for postmortem.
 */
export async function assertKillSwitchDisengaged(input: {
  agent_id: string;
  flag_id: string | null;
  ctx: AgentContext;
}): Promise<void> {
  const engaged = await isKillSwitchEngaged(input);
  if (!engaged) return;
  try {
    await appendAuditEntry({
      pool_index: AGENT_AUDIT_POOL,
      event_type: 'agent.kill-switch.triggered.v1',
      actor_kind: 'service',
      actor_id: 'sdk-ai-gateway.kill-switch',
      tenant_id: input.ctx.tenant_id,
      subject_kind: 'agent.agent_definition',
      subject_id: input.agent_id,
      retention_class: 'regulated',
      payload: {
        flag_id: input.flag_id,
        agent_id: input.agent_id,
        run_id: input.ctx.run_id,
        trace_id: input.ctx.trace_id,
        surface: 'ai-gateway',
      },
    });
  } catch (auditErr) {
    console.error('[ai-gateway] kill-switch audit emit failed', (auditErr as Error).message);
  }
  throw new KillSwitchError(input.agent_id, input.flag_id ?? 'unknown');
}
