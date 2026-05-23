import { dataService } from '@projexlight/db-runtime';
import { resolveDelegate } from './delegation';
import type {
  DelegationRules,
  RouteRecord,
  RouteStepSpec,
  StepRecord,
} from '../models/approval.model';

/**
 * Routing engine per FR-APP-1,2,3.
 *
 * Walks route.steps jsonb and writes approval.step rows for the current
 * step_index. Supports:
 *   - single   : 1 row per spec
 *   - m-of-n   : N rows (one per candidate) at the same step_index;
 *                advances when M decisions=approve (or any reject)
 *   - role     : 1 row with the role_template's resolved persona
 *
 * Honors delegation rules at row-creation time so a persona who is OOO
 * gets routed to their delegate immediately.
 */

export function getStepSpec(route: RouteRecord, step_index: number): RouteStepSpec | null {
  return route.steps[step_index] ?? null;
}

export async function createStepsForIndex(args: {
  request_id: string;
  route: RouteRecord;
  step_index: number;
  /** Caller provides a role-template resolver so this SDK stays free of identity coupling. */
  resolveRoleTemplate?: (role_template_id: string, tenant_id: string) => Promise<string>;
}): Promise<StepRecord[]> {
  const spec = getStepSpec(args.route, args.step_index);
  if (!spec) return [];

  const sla_deadline = spec.sla_minutes
    ? new Date(Date.now() + spec.sla_minutes * 60_000)
    : null;

  const personas = await resolveStepPersonas(spec, args.route, args.route.tenant_id, args.resolveRoleTemplate);

  const created: StepRecord[] = [];
  for (const persona of personas) {
    const { resolved, chain } = resolveDelegate(persona, args.route.delegation_rules);
    const delegated_from = chain.length > 1 ? persona : null;

    const rows = await dataService.rows<StepRecord>(
      `INSERT INTO approval.step (
         request_id, step_index, approver_persona_id, sla_deadline, delegated_from
       ) VALUES ($1, $2, $3, $4, $5)
       RETURNING step_id, request_id, step_index, approver_persona_id,
                 decision, reason, sla_deadline, acted_at,
                 delegated_from, auto_escalated`,
      [args.request_id, args.step_index, resolved, sla_deadline, delegated_from],
    );
    created.push(rows[0]);
  }
  return created;
}

async function resolveStepPersonas(
  spec: RouteStepSpec,
  _route: RouteRecord,
  tenant_id: string,
  resolveRoleTemplate?: (role_template_id: string, tenant_id: string) => Promise<string>,
): Promise<string[]> {
  if (spec.kind === 'single') return [spec.approver_persona_id];
  if (spec.kind === 'm-of-n') return [...spec.approvers];
  if (spec.kind === 'role') {
    if (!resolveRoleTemplate) {
      throw new Error('role-kind step requires a resolveRoleTemplate callback');
    }
    const persona = await resolveRoleTemplate(spec.role_template_id, tenant_id);
    return [persona];
  }
  return [];
}

/**
 * Returns whether the step at `step_index` is complete: for 'single' or
 * 'role', that's the one row decided; for 'm-of-n', that's M approvals
 * (or any reject).
 *
 * Returns { complete, outcome }:
 *   - outcome='approve' → advance to next step_index
 *   - outcome='reject'  → terminate request as 'rejected'
 *   - outcome=null      → still waiting
 */
export async function evaluateStepCompletion(args: {
  request_id: string;
  step_index: number;
  spec: RouteStepSpec;
}): Promise<{ complete: boolean; outcome: 'approve' | 'reject' | null }> {
  const rows = await dataService.rows<{ decision: string | null }>(
    `SELECT decision FROM approval.step
      WHERE request_id = $1 AND step_index = $2`,
    [args.request_id, args.step_index],
  );

  const approvals = rows.filter((r) => r.decision === 'approve').length;
  const rejections = rows.filter((r) => r.decision === 'reject').length;

  // Any rejection short-circuits to reject (true even in m-of-n).
  if (rejections > 0) return { complete: true, outcome: 'reject' };

  if (args.spec.kind === 'm-of-n') {
    if (approvals >= args.spec.m) return { complete: true, outcome: 'approve' };
    return { complete: false, outcome: null };
  }

  // single or role: one row, decide based on its decision.
  const only = rows[0];
  if (!only) return { complete: false, outcome: null };
  if (only.decision === 'approve') return { complete: true, outcome: 'approve' };
  return { complete: false, outcome: null };
}

export function nextStepIndex(route: RouteRecord, current: number): number {
  return current + 1 < route.steps.length ? current + 1 : -1;
}

export type { DelegationRules };
