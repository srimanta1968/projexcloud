import { randomUUID } from 'crypto';
import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import type {
  ConversationSessionRef,
  ConversationStatus,
  ConversationHandoff,
  ConversationHandoffKind,
} from '@projexlight/contracts';

/**
 * Conversation session lifecycle (FR-CVS-1, FR-CVS-3).
 *
 * One session = one chat. Status walks `started → active → handed-off →
 * closed`. Every session owns a HARD-isolated `vector_namespace` so
 * multi-turn memory written here cannot bleed across tenants (composes
 * with P6A FR-ART-13).
 *
 * Audit retention is `regulated` for session lifecycle (open/close/
 * handoff) since transcripts and handoffs are evidence in regulated
 * verticals (Healthcare, Finance).
 */

const CONVERSATION_AUDIT_POOL = process.env.CONVERSATION_AUDIT_POOL || 'admin-default';

export interface OpenSessionInput {
  tenant_id: string;
  subject_persona_id: string;
  agent_id?: string | null;
  /** Optional override; defaults to `conv-${session_id}`. */
  vector_namespace?: string;
}

interface SessionRow {
  session_id: string;
  tenant_id: string;
  subject_persona_id: string;
  agent_id: string | null;
  status: string;
  started_at: Date;
  last_active_at: Date;
  closed_at: Date | null;
  vector_namespace: string;
}

function rowToSession(r: SessionRow): ConversationSessionRef {
  return {
    session_id: r.session_id,
    tenant_id: r.tenant_id,
    subject_persona_id: r.subject_persona_id,
    agent_id: r.agent_id,
    status: r.status as ConversationStatus,
    started_at: r.started_at.toISOString(),
    last_active_at: r.last_active_at.toISOString(),
    vector_namespace: r.vector_namespace,
  };
}

export async function openSession(input: OpenSessionInput): Promise<ConversationSessionRef> {
  const sessionId = randomUUID();
  const vectorNamespace = input.vector_namespace ?? `conv-${sessionId}`;

  const row = await dataService.one<SessionRow>(
    `INSERT INTO conversation.session
       (session_id, tenant_id, subject_persona_id, agent_id, status, vector_namespace)
     VALUES ($1, $2::uuid, $3::uuid, $4, 'started', $5)
     RETURNING session_id, tenant_id::text, subject_persona_id::text,
               agent_id::text, status, started_at, last_active_at, closed_at, vector_namespace`,
    [sessionId, input.tenant_id, input.subject_persona_id, input.agent_id ?? null, vectorNamespace],
  );
  if (!row) throw new Error('[sdk-conversation] openSession insert failed');

  try {
    await appendAuditEntry({
      pool_index: CONVERSATION_AUDIT_POOL,
      event_type: 'conversation.session.opened.v1',
      actor_kind: 'service',
      actor_id: 'sdk-conversation',
      tenant_id: input.tenant_id,
      subject_kind: 'conversation.session',
      subject_id: sessionId,
      retention_class: 'regulated',
      payload: {
        session_id: sessionId,
        subject_persona_id: input.subject_persona_id,
        agent_id: input.agent_id ?? null,
        vector_namespace: vectorNamespace,
      },
    });
  } catch (err) {
    console.warn('[sdk-conversation] open audit failed (non-fatal):', (err as Error).message);
  }

  return rowToSession(row);
}

export async function getSession(session_id: string): Promise<ConversationSessionRef | null> {
  const row = await dataService.one<SessionRow>(
    `SELECT session_id, tenant_id::text, subject_persona_id::text, agent_id::text,
            status, started_at, last_active_at, closed_at, vector_namespace
       FROM conversation.session
      WHERE session_id = $1`,
    [session_id],
  );
  return row ? rowToSession(row) : null;
}

export async function setSessionActive(session_id: string): Promise<void> {
  await dataService.query(
    `UPDATE conversation.session
        SET status = CASE WHEN status = 'started' THEN 'active' ELSE status END,
            last_active_at = now()
      WHERE session_id = $1`,
    [session_id],
  );
}

export async function touchSession(session_id: string): Promise<void> {
  await dataService.query(
    `UPDATE conversation.session SET last_active_at = now() WHERE session_id = $1`,
    [session_id],
  );
}

export async function closeSession(input: { session_id: string; reason?: string }): Promise<ConversationSessionRef> {
  const row = await dataService.one<SessionRow>(
    `UPDATE conversation.session
        SET status = 'closed',
            closed_at = now(),
            last_active_at = now()
      WHERE session_id = $1
    RETURNING session_id, tenant_id::text, subject_persona_id::text,
              agent_id::text, status, started_at, last_active_at, closed_at, vector_namespace`,
    [input.session_id],
  );
  if (!row) throw new Error(`[sdk-conversation] session ${input.session_id} not found`);

  try {
    await appendAuditEntry({
      pool_index: CONVERSATION_AUDIT_POOL,
      event_type: 'conversation.session.closed.v1',
      actor_kind: 'service',
      actor_id: 'sdk-conversation',
      tenant_id: row.tenant_id,
      subject_kind: 'conversation.session',
      subject_id: input.session_id,
      retention_class: 'regulated',
      payload: { reason: input.reason ?? 'caller closed session' },
    });
  } catch (err) {
    console.warn('[sdk-conversation] close audit failed (non-fatal):', (err as Error).message);
  }

  return rowToSession(row);
}

export interface HandoffInput {
  session_id: string;
  from_kind: ConversationHandoffKind;
  to_persona_id: string;
  reason: string;
}

export async function handoff(input: HandoffInput): Promise<ConversationHandoff> {
  const handoffId = randomUUID();
  const row = await dataService.one<{
    handoff_id: string;
    session_id: string;
    from_kind: string;
    to_persona_id: string;
    reason: string;
    transferred_at: Date;
    resumed_at: Date | null;
  }>(
    `WITH ins AS (
       INSERT INTO conversation.handoff
         (handoff_id, session_id, from_kind, to_persona_id, reason)
       VALUES ($1, $2, $3, $4::uuid, $5)
       RETURNING handoff_id, session_id, from_kind, to_persona_id::text,
                 reason, transferred_at, resumed_at
     ), upd AS (
       UPDATE conversation.session
          SET status = 'handed-off', last_active_at = now()
        WHERE session_id = $2
       RETURNING session_id
     )
     SELECT * FROM ins`,
    [handoffId, input.session_id, input.from_kind, input.to_persona_id, input.reason],
  );
  if (!row) throw new Error(`[sdk-conversation] handoff insert failed for session ${input.session_id}`);

  // Look up tenant for audit emit.
  const sess = await dataService.one<{ tenant_id: string }>(
    `SELECT tenant_id::text FROM conversation.session WHERE session_id = $1`,
    [input.session_id],
  );
  try {
    await appendAuditEntry({
      pool_index: CONVERSATION_AUDIT_POOL,
      event_type: 'conversation.handoff.v1',
      actor_kind: 'service',
      actor_id: 'sdk-conversation',
      tenant_id: sess?.tenant_id ?? null,
      subject_kind: 'conversation.session',
      subject_id: input.session_id,
      retention_class: 'regulated',
      payload: {
        handoff_id: handoffId,
        from_kind: input.from_kind,
        to_persona_id: input.to_persona_id,
        reason: input.reason,
      },
    });
  } catch (err) {
    console.warn('[sdk-conversation] handoff audit failed (non-fatal):', (err as Error).message);
  }

  return {
    handoff_id: row.handoff_id,
    session_id: row.session_id,
    from_kind: row.from_kind as ConversationHandoffKind,
    to_persona_id: row.to_persona_id,
    reason: row.reason,
    transferred_at: row.transferred_at.toISOString(),
    resumed_at: row.resumed_at ? row.resumed_at.toISOString() : null,
  };
}

export async function resumeHandoff(handoff_id: string): Promise<ConversationHandoff> {
  const row = await dataService.one<{
    handoff_id: string;
    session_id: string;
    from_kind: string;
    to_persona_id: string;
    reason: string;
    transferred_at: Date;
    resumed_at: Date | null;
  }>(
    `UPDATE conversation.handoff
        SET resumed_at = now()
      WHERE handoff_id = $1 AND resumed_at IS NULL
    RETURNING handoff_id, session_id, from_kind, to_persona_id::text,
              reason, transferred_at, resumed_at`,
    [handoff_id],
  );
  if (!row) throw new Error(`[sdk-conversation] handoff ${handoff_id} not found or already resumed`);

  // Re-activate the session.
  await dataService.query(
    `UPDATE conversation.session SET status = 'active', last_active_at = now() WHERE session_id = $1`,
    [row.session_id],
  );

  return {
    handoff_id: row.handoff_id,
    session_id: row.session_id,
    from_kind: row.from_kind as ConversationHandoffKind,
    to_persona_id: row.to_persona_id,
    reason: row.reason,
    transferred_at: row.transferred_at.toISOString(),
    resumed_at: row.resumed_at?.toISOString() ?? null,
  };
}
