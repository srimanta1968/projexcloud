import { dataService } from '@projexlight/db-runtime';

/**
 * @projexlight/sdk-crm — mandatory NEXT-action model + save-gate (P14·E4, TK-3630).
 *
 * A non-terminal deal must always have exactly ONE open NEXT action (type / owner /
 * due-time / purpose). setNextAction replaces the current open one; the save-gate
 * (checkSaveGate / assertSaveGate) blocks a save or stage-advance on a non-terminal deal
 * that has none. Terminal deals (closed-won/lost, or an is_terminal funnel stage) are exempt.
 */

const TERMINAL_STAGES = ['closed-won', 'closed-lost'];

export interface NextActionRow {
  next_action_id: string;
  tenant_id: string;
  deal_id: string;
  action_type: string;
  owner_persona_id: string | null;
  due_at: string;
  purpose: string | null;
  outcome: string | null;
  status: string;
  completed_at: string | null;
  created_at: string;
}

const NA_COLS = `next_action_id, tenant_id, deal_id, action_type, owner_persona_id, due_at,
  purpose, outcome, status, completed_at, created_at`;

export interface SetNextActionInput {
  tenantId: string;
  dealId: string;
  actionType?: string;
  ownerPersonaId?: string;
  dueAt: string;
  purpose?: string;
}

/** Raised when a deal id doesn't resolve for the tenant. */
export class DealNotFoundError extends Error {
  constructor() { super('DEAL_NOT_FOUND'); this.name = 'DealNotFoundError'; }
}
/** Raised by the save-gate when a non-terminal deal has no open next action. */
export class NextActionRequiredError extends Error {
  constructor(msg = 'a non-terminal deal must have an open NEXT action') { super(msg); this.name = 'NextActionRequiredError'; }
}

async function loadDeal(tenantId: string, dealId: string): Promise<{ stage: string; is_terminal: boolean } | null> {
  return dataService.one<{ stage: string; is_terminal: boolean }>(
    `SELECT d.stage,
            (d.stage = ANY($3) OR COALESCE(fs.is_terminal, false)) AS is_terminal
       FROM crm.deal d
       LEFT JOIN crm.funnel_stage fs ON fs.stage_id = d.funnel_stage_id
      WHERE d.tenant_id = $1 AND d.deal_id = $2`,
    [tenantId, dealId, TERMINAL_STAGES],
  );
}

/**
 * Set (replace) the deal's open NEXT action. Any existing open action is cancelled first
 * so there is always exactly one open action. Runs in a transaction to keep the single-
 * open invariant under the partial-unique index.
 */
export async function setNextAction(input: SetNextActionInput): Promise<NextActionRow> {
  const deal = await loadDeal(input.tenantId, input.dealId);
  if (!deal) throw new DealNotFoundError();
  return dataService.tx<NextActionRow>(async (q) => {
    await q(
      `UPDATE crm.next_action SET status = 'cancelled', updated_at = now()
        WHERE tenant_id = $1 AND deal_id = $2 AND status = 'open'`,
      [input.tenantId, input.dealId],
    );
    const inserted = await q<NextActionRow>(
      `INSERT INTO crm.next_action (tenant_id, deal_id, action_type, owner_persona_id, due_at, purpose)
       VALUES ($1,$2,COALESCE($3,'call'),$4,$5,$6)
       RETURNING ${NA_COLS}`,
      [input.tenantId, input.dealId, input.actionType ?? null, input.ownerPersonaId ?? null, input.dueAt, input.purpose ?? null],
    );
    return inserted.rows[0];
  });
}

/** Get the deal's current open NEXT action (or null). */
export async function getOpenNextAction(tenantId: string, dealId: string): Promise<NextActionRow | null> {
  return dataService.one<NextActionRow>(
    `SELECT ${NA_COLS} FROM crm.next_action
      WHERE tenant_id = $1 AND deal_id = $2 AND status = 'open' LIMIT 1`,
    [tenantId, dealId],
  );
}

/** Complete the open NEXT action with an outcome. Returns the completed row (or null if none open). */
export async function completeNextAction(tenantId: string, dealId: string, outcome?: string): Promise<NextActionRow | null> {
  const rows = await dataService.rows<NextActionRow>(
    `UPDATE crm.next_action
        SET status = 'completed', outcome = COALESCE($3, outcome), completed_at = now(), updated_at = now()
      WHERE tenant_id = $1 AND deal_id = $2 AND status = 'open'
      RETURNING ${NA_COLS}`,
    [tenantId, dealId, outcome ?? null],
  );
  return rows[0] ?? null;
}

export interface SaveGateResult {
  allowed: boolean;
  reason: string;
  is_terminal: boolean;
  has_open_next_action: boolean;
}

/**
 * The save-gate: a non-terminal deal is allowed to save / advance only if it has an open
 * NEXT action. Terminal deals are always allowed. Returns a structured verdict.
 */
export async function checkSaveGate(tenantId: string, dealId: string): Promise<SaveGateResult> {
  const deal = await loadDeal(tenantId, dealId);
  if (!deal) throw new DealNotFoundError();
  if (deal.is_terminal) {
    return { allowed: true, reason: 'deal is terminal — no NEXT action required', is_terminal: true, has_open_next_action: false };
  }
  const open = await getOpenNextAction(tenantId, dealId);
  const hasOpen = open !== null;
  return {
    allowed: hasOpen,
    reason: hasOpen ? 'open NEXT action present' : 'non-terminal deal has no open NEXT action',
    is_terminal: false,
    has_open_next_action: hasOpen,
  };
}

/** Throw NextActionRequiredError if the save-gate blocks. Call before persisting a save/advance. */
export async function assertSaveGate(tenantId: string, dealId: string): Promise<void> {
  const gate = await checkSaveGate(tenantId, dealId);
  if (!gate.allowed) throw new NextActionRequiredError(gate.reason);
}
