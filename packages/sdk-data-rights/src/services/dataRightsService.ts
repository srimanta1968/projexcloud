import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import { shredKey } from '@projexlight/sdk-vault';
import type {
  CertificateRecord,
  DsarRequestRecord,
  DsarStatus,
  ExecutionRecord,
  PersonPoolResidencyRecord,
  ReconciliationRunRecord,
  SubmitRequestInput,
  TouchResidencyInput,
} from '../models/dataRights.model';

const DSAR_AUDIT_POOL = process.env.DSAR_AUDIT_POOL || 'admin-default';

async function emitDsarAudit(opts: {
  event_type:
    | 'data-rights.request.submitted.v1'
    | 'data-rights.request.transitioned.v1'
    | 'data-rights.executed.v1'
    | 'data-rights.certificate.issued.v1'
    | 'data-rights.reconciliation.completed.v1'
    | 'pool-residency.touched.v1';
  subject_kind: string;
  subject_id: string;
  actor_id: string;
  payload: Record<string, unknown>;
  retention_class?: 'operational' | 'regulated';
  tenant_id?: string | null;
}): Promise<string | null> {
  try {
    const entry = await appendAuditEntry({
      pool_index: DSAR_AUDIT_POOL,
      event_type: opts.event_type,
      actor_kind: 'service',
      actor_id: opts.actor_id,
      tenant_id: opts.tenant_id ?? null,
      subject_kind: opts.subject_kind,
      subject_id: opts.subject_id,
      retention_class: opts.retention_class ?? 'regulated',
      payload: opts.payload,
    });
    return entry.entry_id;
  } catch (err) {
     
    console.error('[sdk-data-rights] audit emit failed', opts.event_type, (err as Error).message);
    return null;
  }
}

/**
 * sdk-data-rights service per P3 PRD §5.4 / FR-DR-1..9.
 *
 * Workflow state machine:
 *   submitted → identity-verified → approval-pending → grace-period
 *             → executing → certificate-issued → audited
 */

const JURISDICTION_SLA_DAYS: Record<string, number> = {
  GDPR: 30,
  DPDP: 30,
  CCPA: 45,
  LGPD: 15,
};

function computeSlaDeadline(jurisdiction: string): Date {
  const days = JURISDICTION_SLA_DAYS[jurisdiction] ?? 30;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

/**
 * Touch the person_pool_residency registry (FR-DR-1). Every data-bearing
 * SDK must call this on first touch so DSAR knows where to fan out.
 */
export async function touchResidency(input: TouchResidencyInput): Promise<PersonPoolResidencyRecord> {
  // Two ON CONFLICT branches because the table has two partial UNIQUE indexes
  // (002 migration): one for NULL tenant_id (platform-scoped data like
  // sdk-device person_link), one for non-NULL. Picking the wrong target
  // throws ON CONFLICT … DO UPDATE specification does not match any unique index.
  const sql = input.tenant_id === null
    ? `INSERT INTO data_rights.person_pool_residency
         (person_id, pool_index, tenant_id, data_classes)
       VALUES ($1, $2, NULL, $3)
       ON CONFLICT (person_id, pool_index) WHERE tenant_id IS NULL DO UPDATE SET
         data_classes    = ARRAY(SELECT DISTINCT unnest(
                              data_rights.person_pool_residency.data_classes || EXCLUDED.data_classes)),
         last_touched_at = now()
       RETURNING residency_id, person_id, pool_index, tenant_id,
                 data_classes, first_touched_at, last_touched_at, last_reconciled_at`
    : `INSERT INTO data_rights.person_pool_residency
         (person_id, pool_index, tenant_id, data_classes)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (person_id, pool_index, tenant_id) WHERE tenant_id IS NOT NULL DO UPDATE SET
         data_classes    = ARRAY(SELECT DISTINCT unnest(
                              data_rights.person_pool_residency.data_classes || EXCLUDED.data_classes)),
         last_touched_at = now()
       RETURNING residency_id, person_id, pool_index, tenant_id,
                 data_classes, first_touched_at, last_touched_at, last_reconciled_at`;
  const params: unknown[] = input.tenant_id === null
    ? [input.person_id, input.pool_index, input.data_classes]
    : [input.person_id, input.pool_index, input.tenant_id, input.data_classes];
  const rows = await dataService.rows<PersonPoolResidencyRecord>(sql, params);
  const residency = rows[0];
  // Operational (sampled-grade) event so the projector and analytics see
  // every first-touch without overloading the regulated chain.
  await emitDsarAudit({
    event_type: 'pool-residency.touched.v1',
    subject_kind: 'identity.person',
    subject_id: residency.person_id,
    actor_id: 'sdk-data-rights.touchResidency',
    payload: { pool_index: residency.pool_index, data_classes: residency.data_classes },
    retention_class: 'operational',
    tenant_id: residency.tenant_id,
  });
  return residency;
}

export async function listResidency(person_id: string): Promise<PersonPoolResidencyRecord[]> {
  return dataService.rows<PersonPoolResidencyRecord>(
    `SELECT residency_id, person_id, pool_index, tenant_id,
            data_classes, first_touched_at, last_touched_at, last_reconciled_at
       FROM data_rights.person_pool_residency
      WHERE person_id = $1
      ORDER BY first_touched_at`,
    [person_id],
  );
}

/**
 * Submit a DSAR request (FR-DR-2). Computes SLA deadline from jurisdiction.
 */
export async function submitRequest(input: SubmitRequestInput): Promise<DsarRequestRecord> {
  const jurisdiction = input.jurisdiction ?? 'GDPR';
  const rows = await dataService.rows<DsarRequestRecord>(
    `INSERT INTO data_rights.request
       (person_id, tenant_id, kind, jurisdiction, sla_deadline, approval_policy)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING request_id, person_id, tenant_id, kind, jurisdiction,
               sla_deadline, status, submitted_at, verified_at, approved_at,
               grace_until, executed_at, certificate_at,
               approval_policy, approval_ref`,
    [
      input.person_id,
      input.tenant_id ?? null,
      input.kind,
      jurisdiction,
      computeSlaDeadline(jurisdiction),
      input.approval_policy ?? 'manager-approval',
    ],
  );
  const request = rows[0];
  await emitDsarAudit({
    event_type: 'data-rights.request.submitted.v1',
    subject_kind: 'identity.person',
    subject_id: request.person_id,
    actor_id: 'sdk-data-rights.submitRequest',
    payload: {
      request_id: request.request_id,
      kind: request.kind,
      jurisdiction: request.jurisdiction,
      sla_deadline: request.sla_deadline,
    },
    tenant_id: request.tenant_id,
  });
  return request;
}

export async function getRequest(request_id: string): Promise<DsarRequestRecord | null> {
  return dataService.one<DsarRequestRecord>(
    `SELECT request_id, person_id, tenant_id, kind, jurisdiction,
            sla_deadline, status, submitted_at, verified_at, approved_at,
            grace_until, executed_at, certificate_at,
            approval_policy, approval_ref
       FROM data_rights.request WHERE request_id = $1`,
    [request_id],
  );
}

/**
 * Advance DSAR state machine. Each transition checks the source status to
 * preserve the linear workflow; out-of-order transitions are rejected.
 */
/** Exported for unit testing — see tests/transitions.test.ts. */
export const TRANSITIONS: Record<DsarStatus, DsarStatus[]> = {
  submitted: ['identity-verified', 'rejected'],
  'identity-verified': ['approval-pending', 'rejected'],
  'approval-pending': ['grace-period', 'rejected'],
  'grace-period': ['executing'],
  executing: ['certificate-issued'],
  'certificate-issued': ['audited'],
  audited: [],
  rejected: [],
};

export async function transitionRequest(
  request_id: string,
  to: DsarStatus,
  extras: { grace_until?: Date; approval_ref?: string } = {},
): Promise<DsarRequestRecord | null> {
  const current = await getRequest(request_id);
  if (!current) return null;
  if (!TRANSITIONS[current.status].includes(to)) {
    throw new Error(`Invalid transition ${current.status} → ${to}`);
  }

  // FR-DR-9 approval-policy enforcement: when the caller requests the
  // 'approval-pending' state but the policy is 'auto', skip directly to
  // 'grace-period' (no human approval needed). The transition table is
  // unchanged — this is policy-side automation around it.
  if (to === 'approval-pending' && current.approval_policy === 'auto') {
    return transitionRequest(request_id, 'grace-period', extras);
  }

  const setClauses: string[] = ['status = $2'];
  const params: unknown[] = [request_id, to];
  if (to === 'identity-verified') setClauses.push('verified_at = now()');
  if (to === 'approval-pending' && extras.approval_ref) {
    setClauses.push(`approval_ref = $${params.length + 1}`);
    params.push(extras.approval_ref);
  }
  if (to === 'grace-period') {
    setClauses.push('approved_at = now()');
    if (extras.grace_until) {
      setClauses.push(`grace_until = $${params.length + 1}`);
      params.push(extras.grace_until);
    } else {
      setClauses.push(`grace_until = now() + INTERVAL '7 days'`);
    }
  }
  if (to === 'executing') setClauses.push('executed_at = now()');
  if (to === 'certificate-issued') setClauses.push('certificate_at = now()');

  const rows = await dataService.rows<DsarRequestRecord>(
    `UPDATE data_rights.request
        SET ${setClauses.join(', ')}
      WHERE request_id = $1
      RETURNING request_id, person_id, tenant_id, kind, jurisdiction,
                sla_deadline, status, submitted_at, verified_at, approved_at,
                grace_until, executed_at, certificate_at,
                approval_policy, approval_ref`,
    params,
  );
  const next = rows[0] ?? null;
  if (next) {
    await emitDsarAudit({
      event_type: 'data-rights.request.transitioned.v1',
      subject_kind: 'identity.person',
      subject_id: next.person_id,
      actor_id: 'sdk-data-rights.transitionRequest',
      payload: { request_id: next.request_id, from: current.status, to: next.status },
      tenant_id: next.tenant_id,
    });
  }
  return next;
}

/**
 * Plan executions: one row per (request, pool_index) from the residency
 * registry. Action depends on request kind.
 */
export async function planExecutions(request_id: string): Promise<ExecutionRecord[]> {
  const request = await getRequest(request_id);
  if (!request) return [];

  const residency = await listResidency(request.person_id);
  const action =
    request.kind === 'erasure'
      ? 'shred-person-key'
      : request.kind === 'access' || request.kind === 'portability'
        ? 'export'
        : 'rectify';

  const inserted: ExecutionRecord[] = [];
  for (const r of residency) {
    const rows = await dataService.rows<ExecutionRecord>(
      `INSERT INTO data_rights.execution (request_id, pool_index, action)
       VALUES ($1, $2, $3)
       RETURNING execution_id, request_id, pool_index, action,
                 shred_target_key_id, status, started_at, completed_at,
                 audit_entry_id, error_detail`,
      [request_id, r.pool_index, action],
    );
    inserted.push(rows[0]);
  }
  return inserted;
}

export async function recordExecutionResult(
  execution_id: string,
  status: 'succeeded' | 'failed',
  audit_entry_id?: string,
  error_detail?: string,
): Promise<ExecutionRecord | null> {
  const rows = await dataService.rows<ExecutionRecord>(
    `UPDATE data_rights.execution
        SET status = $2,
            completed_at = now(),
            audit_entry_id = COALESCE($3, audit_entry_id),
            error_detail = $4
      WHERE execution_id = $1
      RETURNING execution_id, request_id, pool_index, action,
                shred_target_key_id, status, started_at, completed_at,
                audit_entry_id, error_detail`,
    [execution_id, status, audit_entry_id ?? null, error_detail ?? null],
  );
  const execution = rows[0] ?? null;
  if (execution && execution.status === 'succeeded') {
    await emitDsarAudit({
      event_type: 'data-rights.executed.v1',
      subject_kind: 'data_rights.execution',
      subject_id: execution.execution_id,
      actor_id: 'sdk-data-rights.recordExecutionResult',
      payload: {
        request_id: execution.request_id,
        pool_index: execution.pool_index,
        action: execution.action,
      },
    });
  }
  return execution;
}

/**
 * FR-DR-5 + AC-9: invoke sdk-vault to cryptographically shred the key
 * referenced by `shred_target_key_id` on a `shred-*` execution.
 *
 * PROD HARDENING (key-ownership check): before shredKey() the function
 * verifies the target key actually belongs to the DSAR's subject — defeats
 * operator typos and cross-tenant injection on /plan-executions. A failed
 * check refuses the shred and marks the execution `failed` with a structured
 * `key-ownership-refused: <reason>` so the DSAR audit trail captures the
 * attempted-but-blocked shred.
 */
export async function performExecution(execution_id: string, operator_id = 'sdk-data-rights.performExecution'): Promise<ExecutionRecord | null> {
  const execution = await dataService.one<ExecutionRecord>(
    `SELECT execution_id, request_id, pool_index, action,
            shred_target_key_id, status, started_at, completed_at,
            audit_entry_id, error_detail
       FROM data_rights.execution WHERE execution_id = $1`,
    [execution_id],
  );
  if (!execution) return null;

  await dataService.query(
    `UPDATE data_rights.execution
        SET status = 'running', started_at = now()
      WHERE execution_id = $1 AND status = 'pending'`,
    [execution_id],
  );

  if (execution.action.startsWith('shred-')) {
    if (!execution.shred_target_key_id) {
      return recordExecutionResult(execution_id, 'failed', undefined, 'missing shred_target_key_id');
    }
    const ownership = await verifyKeyOwnership(execution);
    if (!ownership.ok) {
      return recordExecutionResult(execution_id, 'failed', undefined, `key-ownership-refused: ${ownership.reason}`);
    }
    try {
      await shredKey(
        execution.shred_target_key_id,
        { kind: 'service', id: operator_id },
        `data-rights:${execution.action}`,
      );
    } catch (err) {
      return recordExecutionResult(execution_id, 'failed', undefined, (err as Error).message);
    }
  }
  return recordExecutionResult(execution_id, 'succeeded');
}

/**
 * Verify that `execution.shred_target_key_id` is a key the request's subject
 * actually owns. Returns `{ok:true}` on match or `{ok:false, reason}` on
 * refusal. Action-aware:
 *   - shred-person-key:    vault.key.tier='person' AND scope_id=request.person_id
 *   - shred-persona-key:   key referenced by a persona belonging to request.person_id
 *   - shred-encounter-key: vault.key.tier='encounter' AND tenant matches (P5 will tighten)
 */
async function verifyKeyOwnership(execution: ExecutionRecord): Promise<{ ok: true } | { ok: false; reason: string }> {
  const request = await getRequest(execution.request_id);
  if (!request) return { ok: false, reason: 'request not found' };
  if (!execution.shred_target_key_id) return { ok: false, reason: 'missing key_id' };

  const key = await dataService.one<{
    tier: string;
    scope_id: string | null;
    tenant_id: string | null;
    state: string;
  }>(
    `SELECT tier, scope_id, tenant_id, state
       FROM vault.key WHERE key_id = $1`,
    [execution.shred_target_key_id],
  );
  if (!key) return { ok: false, reason: 'vault key not found' };
  if (key.state === 'shredded') return { ok: false, reason: 'key already shredded' };

  switch (execution.action) {
    case 'shred-person-key':
      if (key.tier !== 'person') return { ok: false, reason: `expected tier=person, got ${key.tier}` };
      if (key.scope_id !== request.person_id) {
        return { ok: false, reason: `key scope_id ${key.scope_id} != request person_id ${request.person_id}` };
      }
      return { ok: true };
    case 'shred-persona-key': {
      const persona = await dataService.one<{ persona_id: string; person_id: string }>(
        `SELECT p.persona_id, ai.person_id
           FROM persona.persona p
           JOIN persona.membership m ON p.membership_id = m.membership_id
           JOIN persona.app_identity ai ON m.app_identity_id = ai.app_identity_id
          WHERE p.persona_key_ref = $1
          LIMIT 1`,
        [execution.shred_target_key_id],
      );
      if (!persona) return { ok: false, reason: 'no persona references this key' };
      if (persona.person_id !== request.person_id) {
        return { ok: false, reason: `persona belongs to ${persona.person_id}, not ${request.person_id}` };
      }
      return { ok: true };
    }
    case 'shred-encounter-key':
      // P5 ships the encounter↔person link; for P3 we accept tenant match.
      if (key.tier !== 'encounter') return { ok: false, reason: `expected tier=encounter, got ${key.tier}` };
      if (request.tenant_id && key.tenant_id !== request.tenant_id) {
        return { ok: false, reason: 'encounter key tenant mismatch' };
      }
      return { ok: true };
    default:
      return { ok: false, reason: `unsupported action ${execution.action}` };
  }
}

export async function issueCertificate(
  request_id: string,
  shred_proofs: Record<string, string>,
  artifact_s3_key?: string,
  signed_by_audit_entry_id?: string,
): Promise<CertificateRecord> {
  const request = await getRequest(request_id);
  // FR-DR-7: seal the certificate with an audit entry — its entry_id becomes
  // the cert's `signed_by_audit_entry_id`. Caller-supplied IDs win when
  // present so the externally-orchestrated DSAR flow can pre-seal.
  const sealId =
    signed_by_audit_entry_id ??
    (await emitDsarAudit({
      event_type: 'data-rights.certificate.issued.v1',
      subject_kind: 'identity.person',
      subject_id: request?.person_id ?? request_id,
      actor_id: 'sdk-data-rights.issueCertificate',
      payload: {
        request_id,
        artifact_s3_key: artifact_s3_key ?? null,
        proof_count: Object.keys(shred_proofs).length,
        kind: request?.kind,
        jurisdiction: request?.jurisdiction,
      },
      tenant_id: request?.tenant_id ?? null,
    }));
  const rows = await dataService.rows<CertificateRecord>(
    `INSERT INTO data_rights.certificate
       (request_id, artifact_s3_key, shred_proofs, signed_by_audit_entry_id)
     VALUES ($1, $2, $3::jsonb, $4)
     RETURNING certificate_id, request_id, format, artifact_s3_key,
               shred_proofs, signed_by_audit_entry_id, issued_at`,
    [request_id, artifact_s3_key ?? null, JSON.stringify(shred_proofs), sealId],
  );
  return rows[0];
}

/**
 * Weekly reconciliation (FR-DR-8). Compares residency to actual data
 * presence; state='red' blocks DSAR completion. This implementation is the
 * scaffold — actual cross-pool inspection composes with each SDK in P4+.
 */
export async function recordReconciliationRun(
  discrepancies: ReconciliationRunRecord['discrepancies'],
): Promise<ReconciliationRunRecord> {
  const state = discrepancies.length > 0 ? 'red' : 'green';
  const rows = await dataService.rows<ReconciliationRunRecord>(
    `INSERT INTO data_rights.reconciliation_run
       (completed_at, discrepancies, state)
     VALUES (now(), $1::jsonb, $2)
     RETURNING run_id, started_at, completed_at, discrepancies, state`,
    [JSON.stringify(discrepancies), state],
  );
  // Stamp last_reconciled_at on every touched (person, pool, tenant).
  await dataService.query(
    `UPDATE data_rights.person_pool_residency SET last_reconciled_at = now()`,
  );
  return rows[0];
}

export async function isReconciliationGreen(): Promise<boolean> {
  const row = await dataService.one<{ state: 'green' | 'red' }>(
    `SELECT state FROM data_rights.reconciliation_run
      ORDER BY started_at DESC LIMIT 1`,
  );
  return row?.state !== 'red';
}
