import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import {
  TENANT_LIFECYCLE_OFFBOARDED,
  TENANT_LIFECYCLE_SANDBOX_CREATED,
  TENANT_LIFECYCLE_TRANSITIONED,
} from '../events';
import type {
  CreateSandboxInput,
  TenantLifecycleEventRecord,
  TenantLifecycleSandboxRecord,
  TenantLifecycleState,
  TenantLifecycleStateRecord,
} from '../models/tenantLifecycle.model';

const TLC_AUDIT_POOL = process.env.TENANT_LIFECYCLE_AUDIT_POOL || 'admin-default';

/**
 * Exported for unit testing — see tests/lifecycleTransitions.test.ts.
 *
 * State machine per P4 §5.9 / FR-TLC-1:
 *   - active is the steady state; can be suspended (dunning), offboarded
 *     (admin request), or spawn a sandbox child.
 *   - suspended is recoverable (reinstate → active) or terminal-bound
 *     (offboard → offboarding).
 *   - offboarding is a timer-window: the offboard_deadline_at gate is
 *     enforced by the scheduler before flipping to offboarded.
 *   - sandbox is a leaf state for child tenants spun up by createSandboxTenant.
 *   - offboarded is terminal.
 */
export const VALID_TRANSITIONS: Record<TenantLifecycleState, TenantLifecycleState[]> = {
  active:      ['suspended', 'offboarding', 'sandbox'],
  suspended:   ['active', 'offboarding'],
  offboarding: ['offboarded'],
  sandbox:     ['offboarded'],
  offboarded:  [],
};

export function isTerminal(state: TenantLifecycleState): boolean {
  return VALID_TRANSITIONS[state].length === 0;
}

async function emitTlcAudit(opts: {
  event_type: typeof TENANT_LIFECYCLE_TRANSITIONED
    | typeof TENANT_LIFECYCLE_SANDBOX_CREATED
    | typeof TENANT_LIFECYCLE_OFFBOARDED;
  tenant_id: string;
  actor_id: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  try {
    await appendAuditEntry({
      pool_index: TLC_AUDIT_POOL,
      event_type: opts.event_type,
      actor_kind: 'service',
      actor_id: opts.actor_id,
      tenant_id: opts.tenant_id,
      subject_kind: 'tenant',
      subject_id: opts.tenant_id,
      retention_class: 'regulated',
      payload: opts.payload,
    });
  } catch (err) {
    console.error('[sdk-tenant-lifecycle] audit emit failed', opts.event_type, (err as Error).message);
  }
}

export async function getState(tenant_id: string): Promise<TenantLifecycleStateRecord | null> {
  return dataService.one<TenantLifecycleStateRecord>(
    `SELECT tenant_id, current_state, suspended_reason, sandbox_parent_tenant_id,
            offboard_deadline_at, updated_at, updated_by
       FROM tenant_lifecycle.state WHERE tenant_id = $1`,
    [tenant_id],
  );
}

/**
 * Core FSM transition. Reads current state, validates against
 * VALID_TRANSITIONS, persists state + appends to tenant_lifecycle.event +
 * emits the matching audit envelope. If the tenant has no state row yet,
 * the implicit start state is 'active'.
 */
export async function transitionTenant(
  tenant_id: string,
  to_state: TenantLifecycleState,
  reason: string | undefined,
  actor_id: string,
  extras: { offboard_deadline_at?: Date } = {},
): Promise<TenantLifecycleStateRecord> {
  const current = await getState(tenant_id);
  const from: TenantLifecycleState = current?.current_state ?? 'active';

  if (!VALID_TRANSITIONS[from].includes(to_state)) {
    throw new Error(`Invalid tenant lifecycle transition ${from} → ${to_state}`);
  }

  const suspended_reason = to_state === 'suspended' ? (reason ?? null) : null;
  const offboard_deadline_at =
    to_state === 'offboarding' ? (extras.offboard_deadline_at ?? null) : null;

  const rows = await dataService.rows<TenantLifecycleStateRecord>(
    `INSERT INTO tenant_lifecycle.state
        (tenant_id, current_state, suspended_reason, offboard_deadline_at, updated_at, updated_by)
     VALUES ($1, $2, $3, $4, now(), $5)
     ON CONFLICT (tenant_id) DO UPDATE
        SET current_state        = EXCLUDED.current_state,
            suspended_reason     = EXCLUDED.suspended_reason,
            offboard_deadline_at = EXCLUDED.offboard_deadline_at,
            updated_at           = now(),
            updated_by           = EXCLUDED.updated_by
     RETURNING tenant_id, current_state, suspended_reason, sandbox_parent_tenant_id,
               offboard_deadline_at, updated_at, updated_by`,
    [tenant_id, to_state, suspended_reason, offboard_deadline_at, actor_id],
  );
  const next = rows[0];

  await dataService.query(
    `INSERT INTO tenant_lifecycle.event
        (tenant_id, from_state, to_state, reason, actor_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      tenant_id,
      from,
      to_state,
      reason ?? null,
      actor_id,
      JSON.stringify({ offboard_deadline_at: offboard_deadline_at?.toISOString() ?? null }),
    ],
  );

  await emitTlcAudit({
    event_type: TENANT_LIFECYCLE_TRANSITIONED,
    tenant_id,
    actor_id,
    payload: { from, to: to_state, reason: reason ?? null },
  });

  // Terminal: also emit the .offboarded envelope so downstream consumers
  // (sdk-data-rights certificate-of-destruction, billing close-out) have a
  // single subscribable event without parsing transitioned-to=offboarded.
  if (to_state === 'offboarded') {
    await emitTlcAudit({
      event_type: TENANT_LIFECYCLE_OFFBOARDED,
      tenant_id,
      actor_id,
      payload: { from, reason: reason ?? null },
    });
  }

  return next;
}

/** Convenience wrapper used by sdk-billing dunning's suspend-tenant step. */
export async function suspendTenant(
  tenant_id: string,
  reason: string,
  actor_id: string,
): Promise<TenantLifecycleStateRecord> {
  return transitionTenant(tenant_id, 'suspended', reason, actor_id);
}

export async function reinstateTenant(
  tenant_id: string,
  actor_id: string,
): Promise<TenantLifecycleStateRecord> {
  return transitionTenant(tenant_id, 'active', 'reinstated', actor_id);
}

export async function offboardTenant(
  tenant_id: string,
  actor_id: string,
  deadline_at: Date,
): Promise<TenantLifecycleStateRecord> {
  return transitionTenant(tenant_id, 'offboarding', 'offboard-requested', actor_id, {
    offboard_deadline_at: deadline_at,
  });
}

/**
 * Provisions a sandbox child tenant under `parent_tenant_id`. The sandbox
 * gets a fresh tenant_id (gen_random_uuid), its state row starts at 'sandbox'
 * (with sandbox_parent_tenant_id back-link), and the sandbox config row is
 * written for the sanitization profile. Returns the sandbox row.
 */
export async function createSandboxTenant(
  input: CreateSandboxInput,
): Promise<TenantLifecycleSandboxRecord> {
  const sandboxRows = await dataService.rows<TenantLifecycleSandboxRecord>(
    `INSERT INTO tenant_lifecycle.sandbox
        (sandbox_tenant_id, parent_tenant_id, expires_at, sanitization_policy)
     VALUES (gen_random_uuid(), $1, $2, COALESCE($3, 'default-mask-pii'))
     RETURNING sandbox_tenant_id, parent_tenant_id, created_at, expires_at, sanitization_policy`,
    [input.parent_tenant_id, input.expires_at ?? null, input.sanitization_policy ?? null],
  );
  const sandbox = sandboxRows[0];

  await dataService.query(
    `INSERT INTO tenant_lifecycle.state
        (tenant_id, current_state, sandbox_parent_tenant_id, updated_at, updated_by)
     VALUES ($1, 'sandbox', $2, now(), $3)
     ON CONFLICT (tenant_id) DO NOTHING`,
    [sandbox.sandbox_tenant_id, input.parent_tenant_id, input.actor_id],
  );

  await dataService.query(
    `INSERT INTO tenant_lifecycle.event
        (tenant_id, from_state, to_state, reason, actor_id, payload)
     VALUES ($1, NULL, 'sandbox', 'sandbox-created', $2, $3::jsonb)`,
    [
      sandbox.sandbox_tenant_id,
      input.actor_id,
      JSON.stringify({
        parent_tenant_id: input.parent_tenant_id,
        sanitization_policy: sandbox.sanitization_policy,
        expires_at: sandbox.expires_at?.toISOString() ?? null,
      }),
    ],
  );

  await emitTlcAudit({
    event_type: TENANT_LIFECYCLE_SANDBOX_CREATED,
    tenant_id: input.parent_tenant_id,
    actor_id: input.actor_id,
    payload: {
      sandbox_tenant_id: sandbox.sandbox_tenant_id,
      sanitization_policy: sandbox.sanitization_policy,
      expires_at: sandbox.expires_at,
    },
  });

  return sandbox;
}

export async function listEvents(tenant_id: string, limit = 50): Promise<TenantLifecycleEventRecord[]> {
  return dataService.rows<TenantLifecycleEventRecord>(
    `SELECT event_id, tenant_id, from_state, to_state, reason, actor_id, occurred_at, payload
       FROM tenant_lifecycle.event
      WHERE tenant_id = $1
      ORDER BY occurred_at DESC
      LIMIT $2`,
    [tenant_id, limit],
  );
}

/**
 * Scheduler tick: flip every offboarding tenant whose deadline has passed
 * to 'offboarded'. Idempotent — emits one audit per flipped tenant.
 * The api-gateway boot wires a setInterval around this; see startOffboardDeadlineScheduler.
 */
export async function runOffboardDeadlineTick(): Promise<{ flipped: number }> {
  const due = await dataService.rows<{ tenant_id: string }>(
    `SELECT tenant_id FROM tenant_lifecycle.state
      WHERE current_state = 'offboarding'
        AND offboard_deadline_at IS NOT NULL
        AND offboard_deadline_at <= now()`,
  );
  let flipped = 0;
  for (const row of due) {
    try {
      await transitionTenant(row.tenant_id, 'offboarded', 'deadline-reached', 'sdk-tenant-lifecycle.scheduler');
      flipped++;
    } catch (err) {
      console.error('[sdk-tenant-lifecycle] offboard flip failed', row.tenant_id, (err as Error).message);
    }
  }
  return { flipped };
}

export interface OffboardSchedulerOptions {
  enabled: boolean;
  intervalMs: number;
}

export interface OffboardSchedulerHandle {
  stop: () => void;
}

export function startOffboardDeadlineScheduler(opts: OffboardSchedulerOptions): OffboardSchedulerHandle {
  if (!opts.enabled) return { stop: () => undefined };
  const timer = setInterval(() => {
    runOffboardDeadlineTick().catch((err) => {
      console.error('[sdk-tenant-lifecycle] offboard tick failed:', err);
    });
  }, opts.intervalMs);
  return { stop: () => clearInterval(timer) };
}
