import crypto from 'crypto';
import { dataService } from '@projexlight/db-runtime';
import { emitEvent } from '@projexlight/sdk-audit';
import { decide, submitRequest } from './approvalService';
import type { Decision } from '../models/approval.model';

/**
 * P10/E4 — audited break-glass emergency access (Architecture v3.2 §11A.6).
 *
 * Break-glass is scoped, time-bounded, and approval-gated through the existing
 * approval.request flow. Granting and every use are fully audited; each use
 * emits a certificate-of-action.
 */

const POOL_INDEX = process.env.POOL_INDEX || 'admin';

export type BreakGlassStatus = 'pending' | 'active' | 'expired' | 'revoked';

export interface BreakGlassGrant {
  grant_id: string;
  tenant_id: string;
  request_id: string | null;
  requester_persona_id: string;
  scope: Record<string, unknown>;
  justification: string;
  status: BreakGlassStatus;
  ttl_minutes: number;
  granted_at: Date | null;
  expires_at: Date | null;
  certificate: Record<string, unknown> | null;
  use_count: number;
  created_at: Date;
}

export interface RequestBreakGlassInput {
  tenant_id: string;
  /** Approval route that gates emergency access (sdk-approval). */
  route_id: string;
  requester_persona_id: string;
  /** What the grant authorizes, e.g. { resource: 'patient.record', actions: ['read'] }. */
  scope: Record<string, unknown>;
  justification: string;
  ttl_minutes?: number;
}

export interface RequestBreakGlassResult {
  grant: BreakGlassGrant;
  pending_step_ids: string[];
}

export class BreakGlassError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BreakGlassError';
  }
}

/**
 * Requests emergency access: opens an approval request (sdk-approval) and a
 * pending grant linked to it. The grant only becomes usable once the approval
 * is granted via decideBreakGlass.
 */
export async function requestBreakGlass(input: RequestBreakGlassInput): Promise<RequestBreakGlassResult> {
  if (!input.justification) throw new BreakGlassError('justification is required');
  const submitted = await submitRequest({
    tenant_id: input.tenant_id,
    route_id: input.route_id,
    subject_kind: 'break_glass',
    subject_id: input.requester_persona_id,
    initiator_persona_id: input.requester_persona_id,
    reason: input.justification,
  });
  const grant = await dataService.one<BreakGlassGrant>(
    `INSERT INTO approval.break_glass_grant
       (tenant_id, request_id, requester_persona_id, scope, justification, ttl_minutes, status)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, 'pending')
     RETURNING grant_id, tenant_id, request_id, requester_persona_id, scope,
               justification, status, ttl_minutes, granted_at, expires_at,
               certificate, use_count, created_at`,
    [
      input.tenant_id,
      submitted.request.request_id,
      input.requester_persona_id,
      JSON.stringify(input.scope ?? {}),
      input.justification,
      input.ttl_minutes ?? 60,
    ],
  );
  if (!grant) throw new BreakGlassError('failed to create break-glass grant');
  return { grant, pending_step_ids: submitted.pending_steps.map((s) => s.step_id) };
}

/**
 * Records an approval decision on the gating request. When the request reaches
 * 'approved' the grant activates — scoped and time-bounded (now + ttl) — and a
 * security.break_glass.granted.v1 event is emitted. A rejection revokes it.
 */
export async function decideBreakGlass(
  grant_id: string,
  step_id: string,
  acting_persona_id: string,
  decision: Decision,
  reason?: string,
): Promise<BreakGlassGrant> {
  const grant = await getBreakGlass(grant_id);
  if (!grant) throw new BreakGlassError(`grant ${grant_id} not found`);
  if (grant.status !== 'pending') {
    throw new BreakGlassError(`grant ${grant_id} is ${grant.status}, not pending`);
  }
  const result = await decide({ step_id, decision, reason, acting_persona_id });

  if (result.request.status === 'approved') {
    const updated = await dataService.one<BreakGlassGrant>(
      `UPDATE approval.break_glass_grant
          SET status = 'active', granted_at = now(),
              expires_at = now() + (ttl_minutes || ' minutes')::interval
        WHERE grant_id = $1
        RETURNING grant_id, tenant_id, request_id, requester_persona_id, scope,
                  justification, status, ttl_minutes, granted_at, expires_at,
                  certificate, use_count, created_at`,
      [grant_id],
    );
    await emitEvent({
      event_type: 'security.break_glass.granted.v1',
      payload: {
        grant_id,
        request_id: grant.request_id,
        requester_persona_id: grant.requester_persona_id,
        scope: grant.scope,
        expires_at: updated?.expires_at ?? null,
      },
      pool_index: POOL_INDEX,
      actor_kind: 'human',
      actor_id: acting_persona_id,
      tenant_id: grant.tenant_id,
      subject_kind: 'break_glass',
      subject_id: grant_id,
    });
    return updated ?? grant;
  }

  if (result.request.status === 'rejected') {
    const updated = await dataService.one<BreakGlassGrant>(
      `UPDATE approval.break_glass_grant SET status = 'revoked' WHERE grant_id = $1
        RETURNING grant_id, tenant_id, request_id, requester_persona_id, scope,
                  justification, status, ttl_minutes, granted_at, expires_at,
                  certificate, use_count, created_at`,
      [grant_id],
    );
    return updated ?? grant;
  }
  return grant; // still pending (multi-step route)
}

/**
 * Exercises an active grant. Verifies the grant is active, in-window, and the
 * action is within scope; emits a certificate-of-action (security.break_glass.
 * used.v1) and persists it. Returns the certificate.
 */
export async function useBreakGlass(
  grant_id: string,
  input: { action: string; target_id?: string; acting_persona_id: string },
): Promise<Record<string, unknown>> {
  const grant = await getBreakGlass(grant_id);
  if (!grant) throw new BreakGlassError(`grant ${grant_id} not found`);

  if (grant.status === 'active' && grant.expires_at && grant.expires_at.getTime() <= Date.now()) {
    await dataService.query(
      `UPDATE approval.break_glass_grant SET status = 'expired' WHERE grant_id = $1`,
      [grant_id],
    );
    throw new BreakGlassError(`grant ${grant_id} has expired`);
  }
  if (grant.status !== 'active') {
    throw new BreakGlassError(`grant ${grant_id} is ${grant.status}, not active`);
  }

  const scopeActions = (grant.scope as { actions?: unknown }).actions;
  if (Array.isArray(scopeActions) && !scopeActions.includes(input.action)) {
    throw new BreakGlassError(`action '${input.action}' is outside the grant scope`);
  }

  const used_at = new Date().toISOString();
  const certBody = {
    grant_id,
    action: input.action,
    target_id: input.target_id ?? null,
    used_by: input.acting_persona_id,
    used_at,
    scope: grant.scope,
  };
  const cert_hash = crypto.createHash('sha256').update(JSON.stringify(certBody)).digest('hex');
  const certificate = { ...certBody, cert_hash };

  await dataService.query(
    `UPDATE approval.break_glass_grant
        SET certificate = $2::jsonb, use_count = use_count + 1
      WHERE grant_id = $1`,
    [grant_id, JSON.stringify(certificate)],
  );
  await emitEvent({
    event_type: 'security.break_glass.used.v1',
    payload: certificate,
    pool_index: POOL_INDEX,
    actor_kind: 'human',
    actor_id: input.acting_persona_id,
    tenant_id: grant.tenant_id,
    subject_kind: 'break_glass',
    subject_id: grant_id,
  });
  return certificate;
}

/** Reads a break-glass grant by id. */
export async function getBreakGlass(grant_id: string): Promise<BreakGlassGrant | null> {
  return dataService.one<BreakGlassGrant>(
    `SELECT grant_id, tenant_id, request_id, requester_persona_id, scope,
            justification, status, ttl_minutes, granted_at, expires_at,
            certificate, use_count, created_at
       FROM approval.break_glass_grant WHERE grant_id = $1`,
    [grant_id],
  );
}
