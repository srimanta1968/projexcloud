import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import {
  createStepsForIndex,
  evaluateStepCompletion,
  getStepSpec,
  nextStepIndex,
} from './routingEngine';
import type {
  CreateRouteInput,
  DecideInput,
  DecideResult,
  RequestRecord,
  RouteRecord,
  RouteStepSpec,
  StepRecord,
  SubmitRequestInput,
  SubmitRequestResult,
} from '../models/approval.model';

export class RouteNotFoundError extends Error {
  readonly code = 'RouteNotFound';
  constructor(id: string) { super(`Approval route ${id} not found`); }
}
export class StepNotFoundError extends Error {
  readonly code = 'StepNotFound';
  constructor(id: string) { super(`Approval step ${id} not found`); }
}
export class NotYourStepError extends Error {
  readonly code = 'NotYourStep';
  constructor(approver: string, acting: string) {
    super(`Step is assigned to ${approver}, not ${acting}`);
  }
}
export class StepAlreadyDecidedError extends Error {
  readonly code = 'StepAlreadyDecided';
  constructor(id: string) { super(`Step ${id} already has a decision`); }
}

/* --------------------------------------------------------- Route registry */

export async function createRoute(input: CreateRouteInput): Promise<RouteRecord> {
  const rows = await dataService.rows<RouteRecord>(
    `INSERT INTO approval.route (
       tenant_id, name, description, kind_pattern, steps, delegation_rules, status
     ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 'active')
     RETURNING route_id, tenant_id, name, description, kind_pattern,
               steps, delegation_rules, status, created_at`,
    [
      input.tenant_id,
      input.name,
      input.description ?? null,
      input.kind_pattern ?? null,
      JSON.stringify(input.steps),
      JSON.stringify(input.delegation_rules ?? {}),
    ],
  );
  return rows[0];
}

async function loadRoute(route_id: string): Promise<RouteRecord> {
  const row = await dataService.one<RouteRecord>(
    `SELECT route_id, tenant_id, name, description, kind_pattern,
            steps, delegation_rules, status, created_at
       FROM approval.route WHERE route_id = $1`,
    [route_id],
  );
  if (!row) throw new RouteNotFoundError(route_id);
  return row;
}

/* --------------------------------------------------------- Request submit */

export async function submitRequest(input: SubmitRequestInput): Promise<SubmitRequestResult> {
  const route = await loadRoute(input.route_id);

  // ON CONFLICT keeps the existing open request rather than spawning a
  // duplicate chain. We re-fetch the in-flight request if one exists.
  const inFlight = await dataService.one<RequestRecord>(
    `SELECT request_id, route_id, tenant_id, subject_kind, subject_id,
            initiator_persona_id, reason, status, final_decision,
            requested_at, resolved_at
       FROM approval.request
      WHERE tenant_id = $1 AND subject_kind = $2 AND subject_id = $3
        AND status = 'pending'`,
    [input.tenant_id, input.subject_kind, input.subject_id],
  );
  if (inFlight) {
    const steps = await loadPendingSteps(inFlight.request_id);
    return { request: inFlight, pending_steps: steps };
  }

  const reqRows = await dataService.rows<RequestRecord>(
    `INSERT INTO approval.request (
       route_id, tenant_id, subject_kind, subject_id, initiator_persona_id, reason
     ) VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING request_id, route_id, tenant_id, subject_kind, subject_id,
               initiator_persona_id, reason, status, final_decision,
               requested_at, resolved_at`,
    [
      input.route_id,
      input.tenant_id,
      input.subject_kind,
      input.subject_id,
      input.initiator_persona_id,
      input.reason ?? null,
    ],
  );
  const request = reqRows[0];

  const pending_steps = await createStepsForIndex({
    request_id: request.request_id,
    route,
    step_index: 0,
  });

  return { request, pending_steps };
}

async function loadPendingSteps(request_id: string): Promise<StepRecord[]> {
  return dataService.rows<StepRecord>(
    `SELECT step_id, request_id, step_index, approver_persona_id,
            decision, reason, sla_deadline, acted_at,
            delegated_from, auto_escalated
       FROM approval.step
      WHERE request_id = $1 AND decision IS NULL
      ORDER BY step_index ASC`,
    [request_id],
  );
}

/* ----------------------------------------------------------------- Decide */

export async function decide(input: DecideInput): Promise<DecideResult> {
  const step = await dataService.one<StepRecord>(
    `SELECT step_id, request_id, step_index, approver_persona_id,
            decision, reason, sla_deadline, acted_at,
            delegated_from, auto_escalated
       FROM approval.step WHERE step_id = $1`,
    [input.step_id],
  );
  if (!step) throw new StepNotFoundError(input.step_id);
  if (step.decision !== null) throw new StepAlreadyDecidedError(input.step_id);
  if (step.approver_persona_id !== input.acting_persona_id) {
    throw new NotYourStepError(step.approver_persona_id, input.acting_persona_id);
  }

  const stepRows = await dataService.rows<StepRecord>(
    `UPDATE approval.step
        SET decision = $2, reason = $3, acted_at = now()
      WHERE step_id = $1
      RETURNING step_id, request_id, step_index, approver_persona_id,
                decision, reason, sla_deadline, acted_at,
                delegated_from, auto_escalated`,
    [input.step_id, input.decision, input.reason ?? null],
  );
  const updatedStep = stepRows[0];

  // Reload request + route to determine next move.
  const request = await dataService.one<RequestRecord>(
    `SELECT request_id, route_id, tenant_id, subject_kind, subject_id,
            initiator_persona_id, reason, status, final_decision,
            requested_at, resolved_at
       FROM approval.request WHERE request_id = $1`,
    [updatedStep.request_id],
  );
  if (!request) throw new Error('Request not found after step decide');
  const route = await loadRoute(request.route_id);

  const spec = getStepSpec(route, updatedStep.step_index);
  const completion = spec
    ? await evaluateStepCompletion({
        request_id: request.request_id,
        step_index: updatedStep.step_index,
        spec: spec as RouteStepSpec,
      })
    : { complete: false, outcome: null };

  let next_steps: StepRecord[] = [];
  let finalRequest = request;

  if (completion.complete && completion.outcome === 'reject') {
    finalRequest = await finalizeRequest(request.request_id, 'rejected', 'reject');
  } else if (completion.complete && completion.outcome === 'approve') {
    const next = nextStepIndex(route, updatedStep.step_index);
    if (next === -1) {
      finalRequest = await finalizeRequest(request.request_id, 'approved', 'approve');
    } else {
      next_steps = await createStepsForIndex({
        request_id: request.request_id,
        route,
        step_index: next,
      });
    }
  }

  await appendAuditEntry({
    pool_index: 'admin',
    event_type: 'approval.step.decided.v1',
    tenant_id: request.tenant_id,
    actor_kind: 'human',
    actor_id: input.acting_persona_id,
    subject_kind: 'approval_step',
    subject_id: updatedStep.step_id,
    payload: {
      request_id: request.request_id,
      step_index: updatedStep.step_index,
      decision: input.decision,
      reason: input.reason ?? null,
      request_status: finalRequest.status,
    },
  });

  return { step: updatedStep, request: finalRequest, next_steps };
}

async function finalizeRequest(
  request_id: string,
  status: 'approved' | 'rejected',
  final_decision: 'approve' | 'reject',
): Promise<RequestRecord> {
  const rows = await dataService.rows<RequestRecord>(
    `UPDATE approval.request
        SET status = $2, final_decision = $3, resolved_at = now()
      WHERE request_id = $1
      RETURNING request_id, route_id, tenant_id, subject_kind, subject_id,
                initiator_persona_id, reason, status, final_decision,
                requested_at, resolved_at`,
    [request_id, status, final_decision],
  );
  return rows[0];
}

/* --------------------------------------------------------- Query helpers */

export async function getRequest(request_id: string): Promise<{
  request: RequestRecord;
  steps: StepRecord[];
} | null> {
  const request = await dataService.one<RequestRecord>(
    `SELECT request_id, route_id, tenant_id, subject_kind, subject_id,
            initiator_persona_id, reason, status, final_decision,
            requested_at, resolved_at
       FROM approval.request WHERE request_id = $1`,
    [request_id],
  );
  if (!request) return null;
  const steps = await dataService.rows<StepRecord>(
    `SELECT step_id, request_id, step_index, approver_persona_id,
            decision, reason, sla_deadline, acted_at,
            delegated_from, auto_escalated
       FROM approval.step
      WHERE request_id = $1 ORDER BY step_index ASC, acted_at NULLS FIRST`,
    [request_id],
  );
  return { request, steps };
}
