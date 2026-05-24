import { evaluate } from '@projexlight/sdk-feature-flags';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import { dataService } from '@projexlight/db-runtime';

/**
 * Per-agent kill-switch evaluation for sdk-agent-runtime (FR-ART kill-switch).
 *
 * Called at:
 *   1. agent_run start — refuse to create a run with status='terminated_kill_switch'.
 *   2. each tool invocation — abort with outcome='denied'.
 *
 * Composes with the TTL enforcer's periodic poll: the worker scans
 * agent_definition rows whose kill_switch_flag_id is engaged and force-
 * terminates running runs, so an operator flip propagates within the
 * TTL enforcer interval (default 1s) without per-call evaluation lag.
 */

const AGENT_AUDIT_POOL = process.env.AGENT_RUNTIME_AUDIT_POOL || 'admin-default';
const CACHE_TTL_MS = parseInt(process.env.AGENT_KILL_SWITCH_CACHE_TTL_MS || '5000', 10);

export class KillSwitchError extends Error {
  readonly code = 'KillSwitchEngaged';
  readonly agent_id: string;
  readonly flag_id: string;
  constructor(agent_id: string, flag_id: string) {
    super(`[agent-runtime] kill-switch engaged for agent ${agent_id} (flag ${flag_id})`);
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

export async function isAgentKillSwitchEngaged(
  agent_id: string,
  flag_id: string | null,
  tenant_id: string | null,
  persona_id: string | null,
): Promise<boolean> {
  if (!flag_id) return false;
  const key = `${flag_id}::${tenant_id ?? 'platform'}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.cachedAt < CACHE_TTL_MS) return hit.engaged;
  let engaged = false;
  try {
    const decision = await evaluate(flag_id, {
      tenant_id,
      persona_id,
      agent_id,
    } as Parameters<typeof evaluate>[1]);
    engaged = decision?.kill_switch_engaged === true || decision?.resolved_value === 'engaged';
  } catch (err) {
    console.warn('[agent-runtime] kill-switch evaluate failed:', (err as Error).message);
  }
  cache.set(key, { engaged, cachedAt: Date.now() });
  return engaged;
}

export function invalidateAgentKillSwitchCache(): void {
  cache.clear();
}

export async function assertAgentKillSwitchDisengaged(input: {
  agent_id: string;
  flag_id: string | null;
  tenant_id: string | null;
  persona_id: string | null;
  run_id?: string;
}): Promise<void> {
  const engaged = await isAgentKillSwitchEngaged(
    input.agent_id,
    input.flag_id,
    input.tenant_id,
    input.persona_id,
  );
  if (!engaged) return;
  try {
    await appendAuditEntry({
      pool_index: AGENT_AUDIT_POOL,
      event_type: 'agent.kill-switch.triggered.v1',
      actor_kind: 'service',
      actor_id: 'sdk-agent-runtime.kill-switch',
      tenant_id: input.tenant_id,
      subject_kind: 'agent.agent_definition',
      subject_id: input.agent_id,
      retention_class: 'regulated',
      payload: {
        flag_id: input.flag_id,
        agent_id: input.agent_id,
        run_id: input.run_id ?? null,
        surface: 'agent-runtime',
      },
    });
  } catch (auditErr) {
    console.error('[agent-runtime] kill-switch audit emit failed', (auditErr as Error).message);
  }
  throw new KillSwitchError(input.agent_id, input.flag_id ?? 'unknown');
}

/**
 * Periodic sweep: find every running agent_run whose agent_definition's
 * kill_switch_flag_id is now ENGAGED, and transition the run to
 * terminated_kill_switch. Called from the TTL enforcer's tick so we
 * don't add a second worker for this — the runtime already polls runs
 * once per second.
 */
export async function sweepKillSwitchedRuns(): Promise<number> {
  const candidates = await dataService.query<{
    run_id: string;
    agent_id: string;
    tenant_id: string | null;
    persona_id: string;
    kill_switch_flag_id: string | null;
  }>(
    `SELECT r.run_id, r.agent_id, r.tenant_id::text, r.persona_id::text,
            d.kill_switch_flag_id::text
       FROM agents.agent_run r
       JOIN agents.agent_definition d ON d.agent_id = r.agent_id
      WHERE r.status = 'running'
        AND d.kill_switch_flag_id IS NOT NULL
      LIMIT 100`,
  );

  let terminated = 0;
  for (const row of candidates.rows) {
    const engaged = await isAgentKillSwitchEngaged(
      row.agent_id,
      row.kill_switch_flag_id,
      row.tenant_id,
      row.persona_id,
    );
    if (!engaged) continue;
    const r = await dataService.one<{ run_id: string }>(
      `UPDATE agents.agent_run
          SET status = 'terminated_kill_switch', ended_at = now()
        WHERE run_id = $1 AND status = 'running'
        RETURNING run_id`,
      [row.run_id],
    );
    if (r) {
      terminated += 1;
      try {
        await appendAuditEntry({
          pool_index: AGENT_AUDIT_POOL,
          event_type: 'agent.run.terminated.v1',
          actor_kind: 'service',
          actor_id: 'sdk-agent-runtime.kill-switch-sweep',
          tenant_id: row.tenant_id,
          subject_kind: 'agent.agent_run',
          subject_id: row.run_id,
          retention_class: 'regulated',
          payload: {
            reason: 'kill_switch',
            agent_id: row.agent_id,
            flag_id: row.kill_switch_flag_id,
          },
        });
      } catch (auditErr) {
        console.error(
          '[agent-runtime] kill-switch termination audit failed',
          row.run_id,
          (auditErr as Error).message,
        );
      }
    }
  }
  return terminated;
}
