import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import { startRun, registerWorkflow, registerStep } from '@projexlight/sdk-workflow';
import { suspendTenant } from '@projexlight/sdk-tenant-lifecycle';
import type { DunningStage, DunningStateRecord } from '../models/billing.model';

/**
 * Dunning workflow per FR-BIL-4.
 *
 * Orchestrates collection on overdue invoices through five stages:
 *   reminder-1 → reminder-2 → final-notice → service-suspend → written-off
 *
 * Each stage transition is persisted on billing.dunning_state and emitted
 * as a billing.dunning.advanced.v1 audit envelope. The actual notify /
 * suspend steps are registered into sdk-workflow; production wires
 * notify-step to sdk-notification.sendNotification() and suspend-step to
 * sdk-tenant-lifecycle.suspendTenant().
 */

const DUNNING_WORKFLOW_NAME = 'dunning-collection';
const STAGE_PROGRESSION: DunningStage[] = [
  'reminder-1', 'reminder-2', 'final-notice', 'service-suspend', 'written-off',
];

let registered = false;

/**
 * Registers the dunning workflow + step handlers. Idempotent — safe to
 * call at boot. Real notify / suspend handlers can be re-registered after
 * this call via registerStep() to override the defaults.
 */
export function registerDunningWorkflow(): void {
  if (registered) return;
  registered = true;

  registerStep('dunning.send-reminder', async (ctx, input) => {
    // Default no-op handler; production overrides with sdk-notification call.
    return { sent: true, stage: input.stage as string };
  });

  registerStep('dunning.send-final-notice', async (ctx, input) => {
    return { sent: true, stage: 'final-notice' as const, input };
  });

  registerStep('dunning.suspend-tenant', async (_ctx, input) => {
    // FR-BIL-4 + FR-TLC-5: drive the actual lifecycle FSM. The step input
    // carries tenant_id from the workflow envelope (see startDunningForInvoice).
    const tenant_id = input.tenant_id as string;
    if (!tenant_id) return { suspended: false, reason: 'missing tenant_id' };
    try {
      const state = await suspendTenant(tenant_id, 'overdue-invoice', 'sdk-billing.dunning');
      return { suspended: true, tenant_id, current_state: state.current_state };
    } catch (err) {
      // Already-suspended is not a billing failure; just record + carry on.
      return { suspended: false, tenant_id, error: (err as Error).message };
    }
  });

  registerStep('dunning.write-off', async (_ctx, input) => {
    return { written_off: true, invoice_id: input.invoice_id as string };
  });

  void registerWorkflow({
    name: DUNNING_WORKFLOW_NAME,
    version: '1.0.0',
    namespace: 'admin',
    step_specs: [
      { name: 'dunning.send-reminder' },
      { name: 'dunning.send-reminder' },
      { name: 'dunning.send-final-notice' },
      { name: 'dunning.suspend-tenant' },
      { name: 'dunning.write-off' },
    ],
  }).catch(() => { /* tolerate registry double-registration during dev */ });
}

export async function startDunningForInvoice(args: {
  invoice_id: string;
  tenant_id: string;
}): Promise<DunningStateRecord> {
  registerDunningWorkflow();

  // Start sdk-workflow run; envelope carries tenant context for downstream steps.
  const run = await startRun({
    name: DUNNING_WORKFLOW_NAME,
    version: '1.0.0',
    namespace: 'admin',
    envelope: { tenant_id: args.tenant_id, actor: { kind: 'service' } },
    input: { invoice_id: args.invoice_id, tenant_id: args.tenant_id },
  });

  const rows = await dataService.rows<DunningStateRecord>(
    `INSERT INTO billing.dunning_state (invoice_id, stage, workflow_run_id, last_action_at)
     VALUES ($1, 'reminder-1', $2, now())
     ON CONFLICT (invoice_id) DO UPDATE
       SET workflow_run_id = EXCLUDED.workflow_run_id,
           last_action_at  = now()
     RETURNING dunning_id, invoice_id, stage, workflow_run_id, last_action_at`,
    [args.invoice_id, run.run_id],
  );

  await appendAuditEntry({
    pool_index: 'admin',
    event_type: 'billing.dunning.advanced.v1',
    tenant_id: args.tenant_id,
    actor_kind: 'service',
    actor_id: 'sdk-billing',
    subject_kind: 'invoice',
    subject_id: args.invoice_id,
    payload: { invoice_id: args.invoice_id, stage: 'reminder-1', run_id: run.run_id },
  });

  return rows[0];
}

export async function advanceDunningStage(args: {
  invoice_id: string;
  tenant_id: string;
}): Promise<DunningStateRecord | null> {
  const current = await dataService.one<DunningStateRecord>(
    `SELECT dunning_id, invoice_id, stage, workflow_run_id, last_action_at
       FROM billing.dunning_state WHERE invoice_id = $1`,
    [args.invoice_id],
  );
  if (!current) return null;
  const idx = STAGE_PROGRESSION.indexOf(current.stage);
  if (idx < 0 || idx === STAGE_PROGRESSION.length - 1) return current;
  const next = STAGE_PROGRESSION[idx + 1];
  const rows = await dataService.rows<DunningStateRecord>(
    `UPDATE billing.dunning_state
        SET stage = $2, last_action_at = now()
      WHERE invoice_id = $1
      RETURNING dunning_id, invoice_id, stage, workflow_run_id, last_action_at`,
    [args.invoice_id, next],
  );
  await appendAuditEntry({
    pool_index: 'admin',
    event_type: 'billing.dunning.advanced.v1',
    tenant_id: args.tenant_id,
    actor_kind: 'service',
    actor_id: 'sdk-billing',
    subject_kind: 'invoice',
    subject_id: args.invoice_id,
    payload: { invoice_id: args.invoice_id, stage: next },
  });
  return rows[0];
}
