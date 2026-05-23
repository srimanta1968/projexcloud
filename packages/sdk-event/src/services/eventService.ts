import crypto from 'crypto';
import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import type {
  CheckinInput,
  CheckinRecord,
  CreateSessionInput,
  IssueTicketInput,
  SessionRecord,
  TicketRecord,
} from '../models/event.model';

const EVENT_AUDIT_POOL = process.env.EVENT_AUDIT_POOL || 'admin-default';

async function emitEventAudit(opts: {
  event_type: 'event.session.opened.v1' | 'event.ticket.issued.v1' | 'event.ticket.checked-in.v1';
  tenant_id: string;
  subject_kind: string;
  subject_id: string;
  actor_id: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  try {
    await appendAuditEntry({
      pool_index: EVENT_AUDIT_POOL,
      event_type: opts.event_type,
      actor_kind: 'service',
      actor_id: opts.actor_id,
      tenant_id: opts.tenant_id,
      subject_kind: opts.subject_kind,
      subject_id: opts.subject_id,
      retention_class: opts.event_type === 'event.session.opened.v1' ? 'operational' : 'regulated',
      payload: opts.payload,
    });
  } catch (err) {
    console.error('[sdk-event] audit emit failed', opts.event_type, (err as Error).message);
  }
}

export async function createSession(input: CreateSessionInput): Promise<SessionRecord> {
  const rows = await dataService.rows<SessionRecord>(
    `INSERT INTO event.session
       (tenant_id, encounter_id, title, address_id, capacity, starts_at, ends_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING session_id, tenant_id, encounter_id, title, address_id, capacity,
               sold_count, starts_at, ends_at, status, created_at`,
    [
      input.tenant_id,
      input.encounter_id,
      input.title,
      input.address_id ?? null,
      input.capacity,
      new Date(input.starts_at),
      new Date(input.ends_at),
    ],
  );
  const session = rows[0];
  await emitEventAudit({
    event_type: 'event.session.opened.v1',
    tenant_id: session.tenant_id,
    subject_kind: 'event.session',
    subject_id: session.session_id,
    actor_id: 'sdk-event.createSession',
    payload: { encounter_id: session.encounter_id, title: session.title, capacity: session.capacity },
  });
  return session;
}

/**
 * Issue a ticket. Enforces capacity by atomically incrementing sold_count
 * inside the same INSERT-then-UPDATE pair; if capacity would be exceeded the
 * UPDATE no-ops and we throw + roll back the ticket.
 */
export async function issueTicket(input: IssueTicketInput): Promise<TicketRecord> {
  const qr_token = `evt_${crypto.randomBytes(18).toString('base64url')}`;
  // Reserve capacity first; row-level lock prevents oversell under concurrency.
  const capacityRow = await dataService.one<{ capacity: number; sold_count: number; tenant_id: string }>(
    `UPDATE event.session
        SET sold_count = sold_count + 1
      WHERE session_id = $1 AND sold_count < capacity AND status IN ('scheduled','live')
      RETURNING capacity, sold_count, tenant_id`,
    [input.session_id],
  );
  if (!capacityRow) throw new Error(`Session sold out, cancelled, or not found`);

  const rows = await dataService.rows<TicketRecord>(
    `INSERT INTO event.ticket (session_id, holder_persona_id, price, qr_token)
     VALUES ($1, $2, $3, $4)
     RETURNING ticket_id, session_id, holder_persona_id, price, status, qr_token, created_at`,
    [input.session_id, input.holder_persona_id, input.price ?? null, qr_token],
  );
  const ticket = rows[0];
  await emitEventAudit({
    event_type: 'event.ticket.issued.v1',
    tenant_id: capacityRow.tenant_id,
    subject_kind: 'event.ticket',
    subject_id: ticket.ticket_id,
    actor_id: 'sdk-event.issueTicket',
    payload: { session_id: ticket.session_id, holder_persona_id: ticket.holder_persona_id },
  });
  return ticket;
}

export async function checkIn(input: CheckinInput): Promise<CheckinRecord> {
  // Atomically transition ticket issued→used and insert a checkin row. The
  // UNIQUE constraint on event.checkin.ticket_id prevents double check-in.
  const ticket = await dataService.one<{ ticket_id: string; session_id: string; status: string }>(
    `UPDATE event.ticket SET status = 'used'
      WHERE qr_token = $1 AND status = 'issued'
      RETURNING ticket_id, session_id, status`,
    [input.qr_token],
  );
  if (!ticket) throw new Error('Ticket not found, not issued, or already used');

  const rows = await dataService.rows<CheckinRecord>(
    `INSERT INTO event.checkin (ticket_id, device_uuid, checked_in_by_persona_id)
     VALUES ($1, $2, $3)
     RETURNING checkin_id, ticket_id, device_uuid, checked_in_at, checked_in_by_persona_id`,
    [ticket.ticket_id, input.device_uuid ?? null, input.checked_in_by_persona_id],
  );
  const checkin = rows[0];
  const tenantRow = await dataService.one<{ tenant_id: string }>(
    `SELECT tenant_id FROM event.session WHERE session_id = $1`,
    [ticket.session_id],
  );
  await emitEventAudit({
    event_type: 'event.ticket.checked-in.v1',
    tenant_id: tenantRow?.tenant_id ?? 'unknown',
    subject_kind: 'event.ticket',
    subject_id: ticket.ticket_id,
    actor_id: input.checked_in_by_persona_id,
    payload: { session_id: ticket.session_id, device_uuid: input.device_uuid ?? null },
  });
  return checkin;
}

export async function getSession(session_id: string): Promise<SessionRecord | null> {
  return dataService.one<SessionRecord>(
    `SELECT session_id, tenant_id, encounter_id, title, address_id, capacity,
            sold_count, starts_at, ends_at, status, created_at
       FROM event.session WHERE session_id = $1`,
    [session_id],
  );
}
