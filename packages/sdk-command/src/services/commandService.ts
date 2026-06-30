import { dataService } from '@projexlight/db-runtime';

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

/**
 * Governance hooks. Defaults allow (so an unconfigured deploy still functions,
 * matching the sdk-ingest hook convention). The gateway wires:
 *   - rebac:  sdk-rebac relationship check (can issuer actuate this asset?)
 *   - policy: sdk-policy evaluation (geofence / time-window / condition)
 */
export interface CommandHooks {
  rebac?(ctx: AuthorizeContext): Promise<AuthorizeDecision>;
  policy?(ctx: AuthorizeContext): Promise<AuthorizeDecision>;
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

  const status: CommandStatus = requiresApproval(risk_class) ? 'pending' : 'approved';

  const row = await dataService.one<CommandRecord>(
    `INSERT INTO command.command
       (tenant_id, target_asset_id, target_component_id, type, params, risk_class, status, issued_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
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
      input.issued_by,
    ],
  );
  if (!row) throw new Error('failed to persist command');
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
