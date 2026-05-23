import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import type {
  CreateTicketInput,
  QueueRecord,
  TicketRecord,
  TicketStatus,
} from '../models/ticket.model';
import { SLA_DEFAULTS_MS } from '../models/ticket.model';

const SR_AUDIT_POOL = process.env.SR_AUDIT_POOL || 'admin-default';

async function emitSrAudit(opts: {
  event_type:
    | 'service-request.ticket.created.v1'
    | 'service-request.ticket.transitioned.v1'
    | 'service-request.ticket.sla.breached.v1';
  tenant_id: string;
  subject_id: string;
  actor_id: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  try {
    await appendAuditEntry({
      pool_index: SR_AUDIT_POOL,
      event_type: opts.event_type,
      actor_kind: 'service',
      actor_id: opts.actor_id,
      tenant_id: opts.tenant_id,
      subject_kind: 'service_request.ticket',
      subject_id: opts.subject_id,
      retention_class: 'regulated',
      payload: opts.payload,
    });
  } catch (err) {
    console.error('[sdk-service-request] audit emit failed', opts.event_type, (err as Error).message);
  }
}

export async function createTicket(input: CreateTicketInput): Promise<TicketRecord> {
  const priority = input.priority ?? 'normal';
  const slaDefaults = SLA_DEFAULTS_MS[priority];
  const now = Date.now();
  const rows = await dataService.rows<TicketRecord>(
    `INSERT INTO service_request.ticket
       (tenant_id, encounter_id, requester_persona_id, queue_id, priority, severity,
        sla_first_response_at, sla_resolution_at, external_refs)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     RETURNING ticket_id, tenant_id, encounter_id, requester_persona_id, assignee_persona_id,
               queue_id, priority, severity, status,
               sla_first_response_at, sla_resolution_at, first_responded_at, resolved_at,
               external_refs, created_at, updated_at`,
    [
      input.tenant_id,
      input.encounter_id,
      input.requester_persona_id,
      input.queue_id ?? null,
      priority,
      input.severity ?? 'minor',
      new Date(now + slaDefaults.first_response),
      new Date(now + slaDefaults.resolution),
      JSON.stringify(input.external_refs ?? {}),
    ],
  );
  const ticket = rows[0];
  await emitSrAudit({
    event_type: 'service-request.ticket.created.v1',
    tenant_id: ticket.tenant_id,
    subject_id: ticket.ticket_id,
    actor_id: 'sdk-service-request.createTicket',
    payload: { encounter_id: ticket.encounter_id, priority: ticket.priority, severity: ticket.severity },
  });
  return ticket;
}

export async function assignTicket(ticket_id: string, assignee_persona_id: string): Promise<TicketRecord | null> {
  const rows = await dataService.rows<TicketRecord>(
    `UPDATE service_request.ticket
        SET assignee_persona_id = $2, updated_at = now()
      WHERE ticket_id = $1
      RETURNING ticket_id, tenant_id, encounter_id, requester_persona_id, assignee_persona_id,
                queue_id, priority, severity, status,
                sla_first_response_at, sla_resolution_at, first_responded_at, resolved_at,
                external_refs, created_at, updated_at`,
    [ticket_id, assignee_persona_id],
  );
  return rows[0] ?? null;
}

/** Exported for unit testing — see tests/ticketTransitions.test.ts. */
export const VALID_TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  new: ['in-progress', 'closed'],
  'in-progress': ['awaiting-customer', 'resolved'],
  'awaiting-customer': ['in-progress', 'resolved'],
  resolved: ['closed'],
  closed: [],
};

export async function transitionTicket(ticket_id: string, to: TicketStatus): Promise<TicketRecord | null> {
  const current = await dataService.one<TicketRecord>(
    `SELECT ticket_id, tenant_id, encounter_id, requester_persona_id, assignee_persona_id,
            queue_id, priority, severity, status,
            sla_first_response_at, sla_resolution_at, first_responded_at, resolved_at,
            external_refs, created_at, updated_at
       FROM service_request.ticket WHERE ticket_id = $1`,
    [ticket_id],
  );
  if (!current) return null;
  if (!VALID_TRANSITIONS[current.status].includes(to)) {
    throw new Error(`Invalid ticket transition ${current.status} → ${to}`);
  }
  const sets: string[] = ['status = $2', 'updated_at = now()'];
  const params: unknown[] = [ticket_id, to];
  if (to === 'in-progress' && !current.first_responded_at) sets.push('first_responded_at = now()');
  if (to === 'resolved') sets.push('resolved_at = now()');
  const rows = await dataService.rows<TicketRecord>(
    `UPDATE service_request.ticket SET ${sets.join(', ')} WHERE ticket_id = $1
     RETURNING ticket_id, tenant_id, encounter_id, requester_persona_id, assignee_persona_id,
               queue_id, priority, severity, status,
               sla_first_response_at, sla_resolution_at, first_responded_at, resolved_at,
               external_refs, created_at, updated_at`,
    params,
  );
  const next = rows[0];
  await emitSrAudit({
    event_type: 'service-request.ticket.transitioned.v1',
    tenant_id: next.tenant_id,
    subject_id: next.ticket_id,
    actor_id: 'sdk-service-request.transitionTicket',
    payload: { from: current.status, to: next.status },
  });
  return next;
}

export async function getTicket(ticket_id: string): Promise<TicketRecord | null> {
  return dataService.one<TicketRecord>(
    `SELECT ticket_id, tenant_id, encounter_id, requester_persona_id, assignee_persona_id,
            queue_id, priority, severity, status,
            sla_first_response_at, sla_resolution_at, first_responded_at, resolved_at,
            external_refs, created_at, updated_at
       FROM service_request.ticket WHERE ticket_id = $1`,
    [ticket_id],
  );
}

export async function createQueue(tenant_id: string, name: string, priority = 100): Promise<QueueRecord> {
  const rows = await dataService.rows<QueueRecord>(
    `INSERT INTO service_request.queue (tenant_id, name, priority)
     VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, name) DO UPDATE SET priority = EXCLUDED.priority
     RETURNING queue_id, tenant_id, name, priority, created_at`,
    [tenant_id, name, priority],
  );
  return rows[0];
}

/**
 * SLA breach scanner. Returns tickets whose sla_resolution_at is past and
 * status is not resolved/closed. The scheduler in api-gateway calls this
 * periodically and emits service-request.ticket.sla.breached.v1 events.
 * Leader-elected via pg_try_advisory_xact_lock (same pattern as DSAR SLA
 * watcher) to avoid duplicate alerts across replicas.
 */
export async function findSlaBreaches(): Promise<TicketRecord[]> {
  return dataService.rows<TicketRecord>(
    `SELECT ticket_id, tenant_id, encounter_id, requester_persona_id, assignee_persona_id,
            queue_id, priority, severity, status,
            sla_first_response_at, sla_resolution_at, first_responded_at, resolved_at,
            external_refs, created_at, updated_at
       FROM service_request.ticket
      WHERE status NOT IN ('resolved','closed')
        AND sla_resolution_at < now()`,
  );
}

export async function notifySlaBreach(ticket: TicketRecord): Promise<void> {
  await emitSrAudit({
    event_type: 'service-request.ticket.sla.breached.v1',
    tenant_id: ticket.tenant_id,
    subject_id: ticket.ticket_id,
    actor_id: 'sdk-service-request.slaScanner',
    payload: { priority: ticket.priority, severity: ticket.severity, sla_resolution_at: ticket.sla_resolution_at },
  });
}
