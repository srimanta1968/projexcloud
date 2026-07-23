import { dataService } from '@projexlight/db-runtime';
import { transitionDeal } from './crmService';
import type { DealStage } from '../models/crm.model';

/**
 * @projexlight/sdk-crm — stage-transition guard engine (P14·E4, TK-3637).
 *
 * Guards deal stage moves: validates the from->to move against an injectable allowed-
 * transition map, runs an optional entry/exit-criteria hook, and enforces terminal-state
 * gating (a terminal stage — closed-won/closed-lost — has no permitted exits). Only a
 * PERMITTED move calls transitionDeal (which emits crm.deal.transitioned.v1). The map and
 * criteria hook are injectable so specific stage policy stays app-configurable.
 */

/** Default allowed-transition DAG. Terminal stages (closed-won/closed-lost) have no exits. */
export const DEFAULT_TRANSITIONS: Record<DealStage, DealStage[]> = {
  qualifying: ['proposal', 'negotiation', 'closed-won', 'closed-lost'],
  proposal: ['negotiation', 'qualifying', 'closed-won', 'closed-lost'],
  negotiation: ['proposal', 'closed-won', 'closed-lost'],
  'closed-won': [],
  'closed-lost': [],
};

const TERMINAL: DealStage[] = ['closed-won', 'closed-lost'];

let _transitions: Record<string, DealStage[]> = { ...DEFAULT_TRANSITIONS };
/** Inject a custom allowed-transition map (app stage policy). */
export function setStageTransitionMap(map: Record<string, DealStage[]>): void { _transitions = { ...map }; }
export function _resetStageTransitionMap(): void { _transitions = { ...DEFAULT_TRANSITIONS }; }

export interface StageCriteriaContext {
  deal_id: string;
  tenant_id: string;
  from_stage: DealStage;
  to_stage: DealStage;
}
/** Optional entry/exit-criteria hook — return {ok:false, reason} to block a move. */
export type StageCriteriaHook = (ctx: StageCriteriaContext) => Promise<{ ok: boolean; reason?: string }>;
const defaultCriteria: StageCriteriaHook = async () => ({ ok: true });
let _criteria: StageCriteriaHook = defaultCriteria;
export function setStageCriteriaHook(hook: StageCriteriaHook): void { _criteria = hook; }
export function _resetStageCriteriaHook(): void { _criteria = defaultCriteria; }

/** Raised when a deal id doesn't resolve. */
export class DealNotFoundError extends Error {
  constructor() { super('DEAL_NOT_FOUND'); this.name = 'DealNotFoundError'; }
}
/** Raised when a stage transition is not permitted. */
export class StageTransitionError extends Error {
  constructor(msg: string) { super(msg); this.name = 'StageTransitionError'; }
}

export interface StageGuardResult {
  allowed: boolean;
  reason: string;
  from_stage: DealStage;
  to_stage: DealStage;
  is_terminal_exit: boolean;
}

/**
 * Evaluate whether a deal may transition to `to_stage`: rejects a same-stage no-op, a
 * move out of a terminal stage (terminal gating), a from->to not in the allowed map, and
 * a criteria-hook veto. Returns a structured verdict.
 */
export async function checkStageTransition(deal_id: string, to_stage: DealStage): Promise<StageGuardResult> {
  const deal = await dataService.one<{ stage: DealStage; tenant_id: string }>(
    `SELECT stage, tenant_id FROM crm.deal WHERE deal_id = $1`,
    [deal_id],
  );
  if (!deal) throw new DealNotFoundError();
  const from = deal.stage;
  const verdict = (allowed: boolean, reason: string): StageGuardResult => ({
    allowed, reason, from_stage: from, to_stage, is_terminal_exit: TERMINAL.includes(from),
  });

  if (from === to_stage) return verdict(false, `deal is already in stage '${from}'`);
  if (TERMINAL.includes(from)) return verdict(false, `cannot transition out of terminal stage '${from}'`);
  const allowedTargets = _transitions[from] ?? [];
  if (!allowedTargets.includes(to_stage)) {
    return verdict(false, `transition '${from}' -> '${to_stage}' is not allowed`);
  }
  const crit = await _criteria({ deal_id, tenant_id: deal.tenant_id, from_stage: from, to_stage });
  if (!crit.ok) return verdict(false, crit.reason ?? 'entry criteria not met');
  return verdict(true, 'transition permitted');
}

/**
 * Guarded transition: validate then (only if permitted) apply via transitionDeal, which
 * emits crm.deal.transitioned.v1. Throws StageTransitionError on a blocked move.
 */
export async function guardedTransition(deal_id: string, to_stage: DealStage): ReturnType<typeof transitionDeal> {
  const gate = await checkStageTransition(deal_id, to_stage);
  if (!gate.allowed) throw new StageTransitionError(gate.reason);
  return transitionDeal(deal_id, to_stage);
}
