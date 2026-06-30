import { dataService } from '@projexlight/db-runtime';
import { verifyKey } from '@projexlight/sdk-api-keys';
import { getCommandBroker } from './commandBroker';
import { COMMAND_ACK_SCOPE, assetScope } from './commandCreds';

/**
 * sdk-command — command & control (actuation) for the physical-AI fleet
 * (P12 · E1). A command targets an asset (robot) or one of its components.
 * Issuing authorizes via sdk-rebac (relationship) + sdk-policy (geofence / time
 * / condition) through pluggable hooks — the gateway wires the real governance
 * SDKs at boot, so sdk-command composes them rather than reimplementing them.
 *
 * Risk-class drives approval gating (high/critical land as `pending`, awaiting
 * an approval grant; low/medium auto-`approved`). Dispatch + ack live in later
 * P12 tasks.
 */

export type RiskClass = 'low' | 'medium' | 'high' | 'critical';
export type CommandStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'dispatched'
  | 'acked'
  | 'failed'
  | 'expired'
  | 'cancelled';

export interface IssueCommandInput {
  tenant_id: string;
  target_asset_id: string;
  target_component_id?: string | null;
  type: string;
  params?: Record<string, unknown>;
  /** Explicit risk class; classified from `type` when omitted. */
  risk_class?: RiskClass;
  issued_by: string;
}

export interface CommandRecord {
  command_id: string;
  tenant_id: string;
  target_asset_id: string;
  target_component_id: string | null;
  type: string;
  params: Record<string, unknown>;
  risk_class: RiskClass;
  status: CommandStatus;
  approval_id: string | null;
  issued_by: string;
  issued_at: string;
  dispatched_at: string | null;
  ack_at: string | null;
  ack_result: Record<string, unknown> | null;
}

export interface AuthorizeContext {
  tenant_id: string;
  issued_by: string;
  target_asset_id: string;
  target_component_id: string | null;
  type: string;
  risk_class: RiskClass;
  params: Record<string, unknown>;
}

export interface AuthorizeDecision {
  allow: boolean;
  reason?: string;
}

/** Audit event emitted at each command-lifecycle transition. */
export interface CommandAuditEvent {
  action:
    | 'command.issued'
    | 'command.gated'
    | 'command.approved'
    | 'command.rejected'
    | 'command.dispatched'
    | 'command.acked'
    | 'command.failed';
  command_id: string;
  tenant_id: string;
  actor_id: string;
  type: string;
  risk_class: RiskClass;
  status: CommandStatus;
  approval_id?: string | null;
  reason?: string;
}

/**
 * Governance hooks. Defaults allow / no-op (so an unconfigured deploy still
 * functions, matching the sdk-ingest hook convention). The gateway wires:
 *   - rebac:  sdk-rebac relationship check (can issuer actuate this asset?)
 *   - policy: sdk-policy evaluation (geofence / time-window / condition)
 *   - requestApproval: sdk-approval — open a grant for a risky command
 *   - audit: sdk-audit — append the command-lifecycle entry to the ledger
 */
export interface CommandHooks {
  rebac?(ctx: AuthorizeContext): Promise<AuthorizeDecision>;
  policy?(ctx: AuthorizeContext): Promise<AuthorizeDecision>;
  requestApproval?(ctx: AuthorizeContext): Promise<{ approval_id: string } | null>;
  audit?(event: CommandAuditEvent): Promise<void>;
}

let _hooks: CommandHooks = {};
export function setCommandHooks(hooks: CommandHooks): void {
  _hooks = hooks;
}

/** Command types that require explicit approval by default (high risk). */
const HIGH_RISK_TYPES = new Set([
  'estop',
  'stop',
  'firmware_update',
  'disable_safety',
  'calibrate',
  'reboot',
  'self_destruct',
]);

/** Classify a command's risk from its type. Conservative: unknown → 'medium'. */
export function classifyRisk(type: string): RiskClass {
  const t = type.toLowerCase();
  if (t === 'self_destruct' || t === 'disable_safety') return 'critical';
  if (HIGH_RISK_TYPES.has(t)) return 'high';
  if (t === 'move' || t === 'grip' || t === 'release' || t === 'set_param') return 'low';
  return 'medium';
}

/** True when a risk class requires an approval grant before dispatch. */
export function requiresApproval(risk: RiskClass): boolean {
  return risk === 'high' || risk === 'critical';
}

export class CommandAuthorizationError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'CommandAuthorizationError';
  }
}

/**
 * Issue a command: authorize (rebac + policy), classify risk, and persist.
 * Throws CommandAuthorizationError when either governance check denies. The
 * persisted status is `pending` when the risk class requires approval, else
 * `approved` (ready for dispatch).
 */
export async function issueCommand(input: IssueCommandInput): Promise<CommandRecord> {
  if (!input.tenant_id) throw new Error('tenant_id is required');
  if (!input.target_asset_id) throw new Error('target_asset_id is required');
  if (!input.type) throw new Error('type is required');
  if (!input.issued_by) throw new Error('issued_by is required');

  const risk_class = input.risk_class ?? classifyRisk(input.type);
  const params = input.params ?? {};
  const ctx: AuthorizeContext = {
    tenant_id: input.tenant_id,
    issued_by: input.issued_by,
    target_asset_id: input.target_asset_id,
    target_component_id: input.target_component_id ?? null,
    type: input.type,
    risk_class,
    params,
  };

  const rebac = (await _hooks.rebac?.(ctx)) ?? { allow: true };
  if (!rebac.allow) throw new CommandAuthorizationError(rebac.reason ?? 'rebac denied');
  const policy = (await _hooks.policy?.(ctx)) ?? { allow: true };
  if (!policy.allow) throw new CommandAuthorizationError(policy.reason ?? 'policy denied');

  const gated = requiresApproval(risk_class);
  const status: CommandStatus = gated ? 'pending' : 'approved';

  // Risky commands open an approval grant before they can be dispatched.
  let approval_id: string | null = null;
  if (gated) {
    try {
      approval_id = (await _hooks.requestApproval?.(ctx))?.approval_id ?? null;
    } catch (err) {
      console.warn('[sdk-command] approval request failed:', (err as Error).message);
    }
  }

  const row = await dataService.one<CommandRecord>(
    `INSERT INTO command.command
       (tenant_id, target_asset_id, target_component_id, type, params, risk_class, status, approval_id, issued_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
     RETURNING command_id::text, tenant_id::text, target_asset_id::text,
               target_component_id::text, type, params, risk_class, status,
               approval_id::text, issued_by::text, issued_at,
               dispatched_at, ack_at, ack_result`,
    [
      input.tenant_id,
      input.target_asset_id,
      input.target_component_id ?? null,
      input.type,
      JSON.stringify(params),
      risk_class,
      status,
      approval_id,
      input.issued_by,
    ],
  );
  if (!row) throw new Error('failed to persist command');

  await emitAudit({
    action: gated ? 'command.gated' : 'command.issued',
    command_id: row.command_id,
    tenant_id: row.tenant_id,
    actor_id: input.issued_by,
    type: row.type,
    risk_class,
    status: row.status,
    approval_id,
  });
  return row;
}

/** Best-effort audit emit; never blocks the command path. */
async function emitAudit(event: CommandAuditEvent): Promise<void> {
  try {
    await _hooks.audit?.(event);
  } catch (err) {
    console.warn('[sdk-command] audit hook failed:', (err as Error).message);
  }
}

export interface CommandDecisionInput {
  approved: boolean;
  decided_by: string;
  reason?: string;
}

/**
 * Apply an approval decision to a gated (pending) command: approve → `approved`
 * (dispatchable) or reject → `rejected`. No-op (returns the row unchanged) when
 * the command is not pending. Audited either way.
 */
export async function applyCommandApprovalDecision(
  tenant_id: string,
  command_id: string,
  decision: CommandDecisionInput,
): Promise<CommandRecord | null> {
  if (!decision.decided_by) throw new Error('decided_by is required');
  const next: CommandStatus = decision.approved ? 'approved' : 'rejected';
  const row = await dataService.one<CommandRecord>(
    `UPDATE command.command
        SET status = $3, updated_at = now()
      WHERE tenant_id = $1::uuid AND command_id = $2::uuid AND status = 'pending'
     RETURNING command_id::text, tenant_id::text, target_asset_id::text,
               target_component_id::text, type, params, risk_class, status,
               approval_id::text, issued_by::text, issued_at,
               dispatched_at, ack_at, ack_result`,
    [tenant_id, command_id, next],
  );
  if (!row) return null;

  await emitAudit({
    action: decision.approved ? 'command.approved' : 'command.rejected',
    command_id: row.command_id,
    tenant_id: row.tenant_id,
    actor_id: decision.decided_by,
    type: row.type,
    risk_class: row.risk_class,
    status: row.status,
    approval_id: row.approval_id,
    reason: decision.reason,
  });
  return row;
}

/** Read a single command by id, scoped to a tenant. */
export async function getCommand(tenant_id: string, command_id: string): Promise<CommandRecord | null> {
  return dataService.one<CommandRecord>(
    `SELECT command_id::text, tenant_id::text, target_asset_id::text,
            target_component_id::text, type, params, risk_class, status,
            approval_id::text, issued_by::text, issued_at,
            dispatched_at, ack_at, ack_result
       FROM command.command
      WHERE tenant_id = $1::uuid AND command_id = $2::uuid`,
    [tenant_id, command_id],
  );
}

/** List recent commands for an asset, scoped to a tenant. */
export async function listCommandsByAsset(
  tenant_id: string,
  target_asset_id: string,
  limit = 100,
): Promise<CommandRecord[]> {
  return dataService.rows<CommandRecord>(
    `SELECT command_id::text, tenant_id::text, target_asset_id::text,
            target_component_id::text, type, params, risk_class, status,
            approval_id::text, issued_by::text, issued_at,
            dispatched_at, ack_at, ack_result
       FROM command.command
      WHERE tenant_id = $1::uuid AND target_asset_id = $2::uuid
      ORDER BY issued_at DESC
      LIMIT $3`,
    [tenant_id, target_asset_id, limit],
  );
}

/* --------------------------------------------------- delivery + ack loop */

const SELECT_COMMAND_COLS = `command_id::text, tenant_id::text, target_asset_id::text,
            target_component_id::text, type, params, risk_class, status,
            approval_id::text, issued_by::text, issued_at,
            dispatched_at, ack_at, ack_result`;

const DISPATCH_INTERVAL_MS = parseInt(process.env.COMMAND_DISPATCH_INTERVAL_MS || '2000', 10);
const DISPATCH_BATCH = parseInt(process.env.COMMAND_DISPATCH_BATCH || '50', 10);

/**
 * Dispatch one approved command: flip approved → dispatched and publish it to
 * the per-asset delivery channel (broker → WebSocket → robot/edge). Returns the
 * dispatched command, or null when it is not in 'approved' state.
 */
export async function dispatchCommand(tenant_id: string, command_id: string): Promise<CommandRecord | null> {
  const row = await dataService.one<CommandRecord>(
    `UPDATE command.command
        SET status = 'dispatched', dispatched_at = now(), updated_at = now()
      WHERE tenant_id = $1::uuid AND command_id = $2::uuid AND status = 'approved'
     RETURNING ${SELECT_COMMAND_COLS}`,
    [tenant_id, command_id],
  );
  if (!row) return null;

  getCommandBroker().publish({
    kind: 'command.dispatched',
    asset_id: row.target_asset_id,
    command_id: row.command_id,
    tenant_id: row.tenant_id,
    type: row.type,
    params: row.params,
    emitted_at: new Date().toISOString(),
  });
  await emitAudit({
    action: 'command.dispatched',
    command_id: row.command_id,
    tenant_id: row.tenant_id,
    actor_id: 'sdk-command:dispatcher',
    type: row.type,
    risk_class: row.risk_class,
    status: row.status,
    approval_id: row.approval_id,
  });
  return row;
}

/** Dispatch up to `limit` approved commands across all tenants. Returns count dispatched. */
export async function dispatchApprovedCommands(limit = DISPATCH_BATCH): Promise<number> {
  const pending = await dataService.rows<{ tenant_id: string; command_id: string }>(
    `SELECT tenant_id::text AS tenant_id, command_id::text AS command_id
       FROM command.command WHERE status = 'approved'
      ORDER BY issued_at ASC LIMIT $1`,
    [limit],
  );
  let dispatched = 0;
  for (const p of pending) {
    const row = await dispatchCommand(p.tenant_id, p.command_id);
    if (row) dispatched += 1;
  }
  return dispatched;
}

export interface AckInput {
  ok: boolean;
  code?: string;
  message?: string;
  data?: Record<string, unknown>;
}

/**
 * Close the loop: record the robot/edge ack/feedback for a dispatched command.
 * ok → 'acked', else → 'failed'. No-op (null) when not in 'dispatched' state.
 */
export async function recordAck(
  tenant_id: string,
  command_id: string,
  ack: AckInput,
): Promise<CommandRecord | null> {
  const next: CommandStatus = ack.ok ? 'acked' : 'failed';
  const ackResult = {
    ok: ack.ok,
    code: ack.code ?? null,
    message: ack.message ?? null,
    data: ack.data ?? null,
  };
  const row = await dataService.one<CommandRecord>(
    `UPDATE command.command
        SET status = $3, ack_at = now(), ack_result = $4::jsonb, updated_at = now()
      WHERE tenant_id = $1::uuid AND command_id = $2::uuid AND status = 'dispatched'
     RETURNING ${SELECT_COMMAND_COLS}`,
    [tenant_id, command_id, next, JSON.stringify(ackResult)],
  );
  if (!row) return null;

  await emitAudit({
    action: ack.ok ? 'command.acked' : 'command.failed',
    command_id: row.command_id,
    tenant_id: row.tenant_id,
    actor_id: 'robot:' + row.target_asset_id,
    type: row.type,
    risk_class: row.risk_class,
    status: row.status,
    approval_id: row.approval_id,
    reason: ack.message,
  });
  return row;
}

export type AckOutcome = 'ok' | 'unauthorized' | 'forbidden' | 'not_found' | 'conflict';

export interface AckWithCredentialResult {
  outcome: AckOutcome;
  command?: CommandRecord;
  error?: string;
}

/**
 * Robot/edge ack path: authenticate with the per-robot scoped credential
 * (sdk-api-keys) rather than a user JWT, then record the ack. The credential
 * must be active and scoped (command:ack + asset:<target_asset_id>) to the
 * command's asset. Fail-closed at each step.
 */
export async function ackCommandWithCredential(
  plaintext: string,
  command_id: string,
  ack: AckInput,
): Promise<AckWithCredentialResult> {
  if (!plaintext) return { outcome: 'unauthorized', error: 'missing credential' };
  const key = await verifyKey(plaintext);
  if (!key) return { outcome: 'unauthorized', error: 'invalid, expired, or revoked key' };

  const cmd = await getCommand(key.tenant_id, command_id);
  if (!cmd) return { outcome: 'not_found', error: 'command not found' };

  if (!key.scopes.includes(COMMAND_ACK_SCOPE) || !key.scopes.includes(assetScope(cmd.target_asset_id))) {
    return { outcome: 'forbidden', error: 'credential not scoped to this command' };
  }

  const updated = await recordAck(key.tenant_id, command_id, ack);
  if (!updated) return { outcome: 'conflict', error: 'command not in dispatched state' };
  return { outcome: 'ok', command: updated };
}

/**
 * Start the background dispatcher: every COMMAND_DISPATCH_INTERVAL_MS, push any
 * approved commands onto the delivery channel. Decoupled from the issue/approve
 * request path. Returns a stop function. Failures are logged, never fatal.
 */
export function startCommandDispatcher(): () => void {
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await dispatchApprovedCommands();
    } catch (err) {
      console.warn('[sdk-command] dispatcher tick failed:', (err as Error).message);
    }
  };
  const timer = setInterval(() => { void tick(); }, DISPATCH_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
