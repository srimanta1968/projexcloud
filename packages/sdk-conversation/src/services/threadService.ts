import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';

/**
 * Omnichannel thread + message model (P16 · EP-381 · PCF-08-1).
 *
 * 001's session/turn model is an AI chat: turns keyed by a monotonic `seq` the
 * server assigns on arrival. That is right for a chat and wrong for a
 * conversation that runs across email, SMS and a social DM, because a provider
 * tells you about a message when it gets around to it. So here:
 *
 *   * ORDER IS BY `occurred_at` — when the thing actually happened. `received_at`
 *     (when we heard about it) is kept as a diagnostic and used only to break
 *     ties, so a backfilled 09:00 SMS still renders above the 09:04 reply that
 *     reached the webhook first.
 *
 *   * INTERNAL_NOTE is structurally distinct, not a flag. `addInternalNote` is
 *     the ONLY way to write one and it hard-codes the undispatchable shape; the
 *     dispatch reader (`claimPendingDispatch`) excludes the channel outright;
 *     and migration 002's CHECK constraints make a dispatchable note
 *     unrepresentable. Three independent layers, because a note delivered to the
 *     customer it is about is the failure this model exists to prevent.
 *
 * The session/turn/handoff surface in `sessionService` / `messageService` is
 * untouched and keeps working exactly as it did.
 */

const CONVERSATION_AUDIT_POOL = process.env.CONVERSATION_AUDIT_POOL || 'admin-default';

export type ThreadChannel =
  | 'EMAIL'
  | 'SMS'
  | 'VOICE'
  | 'VOICEMAIL'
  | 'SOCIAL_DM'
  | 'WEB_CHAT'
  | 'IN_PERSON'
  | 'INTERNAL_NOTE';

export type MessageDirection = 'INBOUND' | 'OUTBOUND' | 'INTERNAL';

export type DeliveryState =
  | 'PENDING'
  | 'SENT'
  | 'DELIVERED'
  | 'READ'
  | 'FAILED'
  | 'BOUNCED'
  | 'RECEIVED'
  | 'NOT_APPLICABLE';

export type ReadState = 'UNREAD' | 'READ';

export type ThreadStatus = 'open' | 'awaiting_reply' | 'closed';

/** The one channel that must never reach a carrier. */
const INTERNAL_NOTE: ThreadChannel = 'INTERNAL_NOTE';

/** Channels a dispatcher may pick up — every channel except the internal note. */
export const DISPATCHABLE_CHANNELS: ThreadChannel[] = [
  'EMAIL',
  'SMS',
  'VOICE',
  'VOICEMAIL',
  'SOCIAL_DM',
  'WEB_CHAT',
  'IN_PERSON',
];

export interface ConversationThread {
  thread_id: string;
  tenant_id: string;
  subject_ref: string;
  subject_kind: string | null;
  channel_set: ThreadChannel[];
  purpose: string;
  related_object_ref: string | null;
  sender_identity_ref: string | null;
  current_eligibility_snapshot: Record<string, unknown>;
  eligibility_snapshot_at: string | null;
  status: ThreadStatus;
  last_message_at: string | null;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  unread_count: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  metadata: Record<string, unknown>;
}

export interface ConversationMessage {
  message_id: string;
  tenant_id: string;
  thread_id: string;
  channel: ThreadChannel;
  direction: MessageDirection;
  external_message_id: string | null;
  delivery_state: DeliveryState;
  delivery_detail: string | null;
  read_state: ReadState;
  body_ref: string;
  body_preview: string | null;
  actor: string;
  occurred_at: string;
  received_at: string;
  in_reply_to_message_id: string | null;
  provider_thread_key: string | null;
  provider_message_key: string | null;
  created_at: string;
  metadata: Record<string, unknown>;
}

interface ThreadRow {
  thread_id: string;
  tenant_id: string;
  subject_ref: string;
  subject_kind: string | null;
  channel_set: string[];
  purpose: string;
  related_object_ref: string | null;
  sender_identity_ref: string | null;
  current_eligibility_snapshot: Record<string, unknown> | null;
  eligibility_snapshot_at: Date | null;
  status: string;
  last_message_at: Date | null;
  last_inbound_at: Date | null;
  last_outbound_at: Date | null;
  unread_count: number | string;
  created_at: Date;
  updated_at: Date;
  closed_at: Date | null;
  metadata: Record<string, unknown> | null;
}

interface MessageRow {
  message_id: string;
  tenant_id: string;
  thread_id: string;
  channel: string;
  direction: string;
  external_message_id: string | null;
  delivery_state: string;
  delivery_detail: string | null;
  read_state: string;
  body_ref: string;
  body_preview: string | null;
  actor: string;
  occurred_at: Date;
  received_at: Date;
  in_reply_to_message_id: string | null;
  provider_thread_key: string | null;
  provider_message_key: string | null;
  created_at: Date;
  metadata: Record<string, unknown> | null;
}

const THREAD_COLUMNS = `
  thread_id::text, tenant_id::text, subject_ref, subject_kind, channel_set, purpose,
  related_object_ref, sender_identity_ref, current_eligibility_snapshot,
  eligibility_snapshot_at, status, last_message_at, last_inbound_at, last_outbound_at,
  unread_count, created_at, updated_at, closed_at, metadata`;

const MESSAGE_COLUMNS = `
  message_id::text, tenant_id::text, thread_id::text, channel, direction,
  external_message_id, delivery_state, delivery_detail, read_state, body_ref,
  body_preview, actor, occurred_at, received_at,
  in_reply_to_message_id::text, provider_thread_key, provider_message_key,
  created_at, metadata`;

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

function rowToThread(r: ThreadRow): ConversationThread {
  return {
    thread_id: r.thread_id,
    tenant_id: r.tenant_id,
    subject_ref: r.subject_ref,
    subject_kind: r.subject_kind,
    channel_set: (r.channel_set ?? []) as ThreadChannel[],
    purpose: r.purpose,
    related_object_ref: r.related_object_ref,
    sender_identity_ref: r.sender_identity_ref,
    current_eligibility_snapshot: r.current_eligibility_snapshot ?? {},
    eligibility_snapshot_at: iso(r.eligibility_snapshot_at),
    status: r.status as ThreadStatus,
    last_message_at: iso(r.last_message_at),
    last_inbound_at: iso(r.last_inbound_at),
    last_outbound_at: iso(r.last_outbound_at),
    unread_count: Number(r.unread_count ?? 0),
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
    closed_at: iso(r.closed_at),
    metadata: r.metadata ?? {},
  };
}

function rowToMessage(r: MessageRow): ConversationMessage {
  return {
    message_id: r.message_id,
    tenant_id: r.tenant_id,
    thread_id: r.thread_id,
    channel: r.channel as ThreadChannel,
    direction: r.direction as MessageDirection,
    external_message_id: r.external_message_id,
    delivery_state: r.delivery_state as DeliveryState,
    delivery_detail: r.delivery_detail,
    read_state: r.read_state as ReadState,
    body_ref: r.body_ref,
    body_preview: r.body_preview,
    actor: r.actor,
    occurred_at: r.occurred_at.toISOString(),
    received_at: r.received_at.toISOString(),
    in_reply_to_message_id: r.in_reply_to_message_id,
    provider_thread_key: r.provider_thread_key,
    provider_message_key: r.provider_message_key,
    created_at: r.created_at.toISOString(),
    metadata: r.metadata ?? {},
  };
}

// ---------------------------------------------------------------------------
// Thread
// ---------------------------------------------------------------------------

export interface OpenThreadInput {
  tenant_id: string;
  /** `<kind>:<id>` — the lead / contact / ticket / deal this conversation is about. */
  subject_ref: string;
  subject_kind?: string | null;
  /** WHY this thread exists. Required: a thread with no purpose is one nobody can close. */
  purpose: string;
  related_object_ref?: string | null;
  sender_identity_ref?: string | null;
  /** What the CONSUMER decided about consent / quiet hours, and when. Never computed here. */
  eligibility_snapshot?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}

export async function openThread(input: OpenThreadInput): Promise<ConversationThread> {
  const purpose = (input.purpose ?? '').trim();
  if (!purpose) {
    throw new Error('[sdk-conversation] openThread requires a non-empty purpose');
  }
  const subjectRef = (input.subject_ref ?? '').trim();
  if (!subjectRef) {
    throw new Error('[sdk-conversation] openThread requires a non-empty subject_ref');
  }

  const snapshot = input.eligibility_snapshot ?? null;
  const row = await dataService.one<ThreadRow>(
    `INSERT INTO conversation.thread
       (tenant_id, subject_ref, subject_kind, purpose, related_object_ref,
        sender_identity_ref, current_eligibility_snapshot, eligibility_snapshot_at, metadata)
     VALUES ($1::uuid, $2, $3, $4, $5, $6,
             COALESCE($7::jsonb, '{}'::jsonb),
             CASE WHEN $7::jsonb IS NULL THEN NULL ELSE now() END,
             COALESCE($8::jsonb, '{}'::jsonb))
     RETURNING ${THREAD_COLUMNS}`,
    [
      input.tenant_id,
      subjectRef,
      input.subject_kind ?? null,
      purpose,
      input.related_object_ref ?? null,
      input.sender_identity_ref ?? null,
      snapshot ? JSON.stringify(snapshot) : null,
      input.metadata ? JSON.stringify(input.metadata) : null,
    ],
  );
  if (!row) throw new Error('[sdk-conversation] openThread insert failed');

  try {
    await appendAuditEntry({
      pool_index: CONVERSATION_AUDIT_POOL,
      event_type: 'conversation.thread.opened.v1',
      actor_kind: 'service',
      actor_id: 'sdk-conversation',
      tenant_id: input.tenant_id,
      subject_kind: 'conversation.thread',
      subject_id: row.thread_id,
      retention_class: 'regulated',
      payload: {
        thread_id: row.thread_id,
        subject_ref: subjectRef,
        purpose,
        related_object_ref: input.related_object_ref ?? null,
      },
    });
  } catch (err) {
    console.warn('[sdk-conversation] thread open audit failed (non-fatal):', (err as Error).message);
  }

  return rowToThread(row);
}

export async function getThread(thread_id: string): Promise<ConversationThread | null> {
  const row = await dataService.one<ThreadRow>(
    `SELECT ${THREAD_COLUMNS} FROM conversation.thread WHERE thread_id = $1::uuid`,
    [thread_id],
  );
  return row ? rowToThread(row) : null;
}

export interface ListThreadsInput {
  tenant_id: string;
  subject_ref?: string;
  status?: ThreadStatus;
  limit?: number;
  offset?: number;
}

/** The inbox read: most recently active first. */
export async function listThreads(input: ListThreadsInput): Promise<ConversationThread[]> {
  const res = await dataService.query<ThreadRow>(
    `SELECT ${THREAD_COLUMNS}
       FROM conversation.thread
      WHERE tenant_id = $1::uuid
        AND ($2::text IS NULL OR subject_ref = $2)
        AND ($3::text IS NULL OR status = $3)
      ORDER BY last_message_at DESC NULLS LAST, created_at DESC
      LIMIT $4 OFFSET $5`,
    [
      input.tenant_id,
      input.subject_ref ?? null,
      input.status ?? null,
      Math.min(Math.max(input.limit ?? 50, 1), 200),
      Math.max(input.offset ?? 0, 0),
    ],
  );
  return res.rows.map(rowToThread);
}

export interface InboxFilter {
  tenant_id: string;
  /** Only threads with at least one unread INBOUND message. */
  unread?: boolean;
  /** Only threads where we spoke last and are waiting on them. */
  awaiting_reply?: boolean;
  /** Only threads that have actually carried this channel. */
  channel?: ThreadChannel;
  /** Omit closed threads unless explicitly asked for. */
  include_closed?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * The agent inbox.
 *
 * Filters are ANDed and each is optional, so the no-filter call is the plain inbox. They
 * read the TRIGGER-MAINTAINED rollups (`unread_count`, `status`, `channel_set`) rather
 * than joining messages: those columns exist precisely so the inbox does not pay for a
 * per-thread subquery on every keystroke, and `channel_set` is GIN-indexed.
 *
 * `channel_set @> ARRAY[...]` asks "has this thread ever carried that channel", which is
 * what an agent filtering by SMS means — not "was the most recent message an SMS", which
 * would hide a conversation the moment someone replied by email.
 */
export async function listInbox(input: InboxFilter): Promise<ConversationThread[]> {
  const res = await dataService.query<ThreadRow>(
    `SELECT ${THREAD_COLUMNS}
       FROM conversation.thread
      WHERE tenant_id = $1::uuid
        AND ($2::boolean IS NOT TRUE OR unread_count > 0)
        AND ($3::boolean IS NOT TRUE OR status = 'awaiting_reply')
        AND ($4::text IS NULL OR channel_set @> ARRAY[$4]::text[])
        AND ($5::boolean IS TRUE OR status <> 'closed')
      ORDER BY last_message_at DESC NULLS LAST, created_at DESC
      LIMIT $6 OFFSET $7`,
    [
      input.tenant_id,
      input.unread ?? false,
      input.awaiting_reply ?? false,
      input.channel ?? null,
      input.include_closed ?? false,
      Math.min(Math.max(input.limit ?? 50, 1), 200),
      Math.max(input.offset ?? 0, 0),
    ],
  );
  return res.rows.map(rowToThread);
}

/**
 * Record what the consumer decided about eligibility, and WHEN.
 *
 * A snapshot, not a live verdict: a message sent last Tuesday has to be
 * explainable against the rules as they stood last Tuesday, so this overwrites
 * the current snapshot and stamps it rather than recomputing anything.
 */
export async function recordEligibilitySnapshot(input: {
  thread_id: string;
  snapshot: Record<string, unknown>;
}): Promise<ConversationThread> {
  const row = await dataService.one<ThreadRow>(
    `UPDATE conversation.thread
        SET current_eligibility_snapshot = $2::jsonb,
            eligibility_snapshot_at = now(),
            updated_at = now()
      WHERE thread_id = $1::uuid
    RETURNING ${THREAD_COLUMNS}`,
    [input.thread_id, JSON.stringify(input.snapshot ?? {})],
  );
  if (!row) throw new Error(`[sdk-conversation] thread ${input.thread_id} not found`);
  return rowToThread(row);
}

export async function closeThread(input: {
  thread_id: string;
  reason?: string;
}): Promise<ConversationThread> {
  const row = await dataService.one<ThreadRow>(
    `UPDATE conversation.thread
        SET status = 'closed', closed_at = now(), updated_at = now()
      WHERE thread_id = $1::uuid
    RETURNING ${THREAD_COLUMNS}`,
    [input.thread_id],
  );
  if (!row) throw new Error(`[sdk-conversation] thread ${input.thread_id} not found`);

  try {
    await appendAuditEntry({
      pool_index: CONVERSATION_AUDIT_POOL,
      event_type: 'conversation.thread.closed.v1',
      actor_kind: 'service',
      actor_id: 'sdk-conversation',
      tenant_id: row.tenant_id,
      subject_kind: 'conversation.thread',
      subject_id: input.thread_id,
      retention_class: 'regulated',
      payload: { reason: input.reason ?? 'caller closed thread' },
    });
  } catch (err) {
    console.warn('[sdk-conversation] thread close audit failed (non-fatal):', (err as Error).message);
  }

  return rowToThread(row);
}

/** Reopen a closed thread. Explicit, because the rollup trigger deliberately will not. */
export async function reopenThread(thread_id: string): Promise<ConversationThread> {
  const row = await dataService.one<ThreadRow>(
    `UPDATE conversation.thread
        SET status = 'open', closed_at = NULL, updated_at = now()
      WHERE thread_id = $1::uuid
    RETURNING ${THREAD_COLUMNS}`,
    [thread_id],
  );
  if (!row) throw new Error(`[sdk-conversation] thread ${thread_id} not found`);
  return rowToThread(row);
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface RecordMessageInput {
  tenant_id: string;
  thread_id: string;
  channel: ThreadChannel;
  direction: MessageDirection;
  /** Vault/blob reference. The body itself never lands in this table. */
  body_ref: string;
  body_preview?: string | null;
  /** `persona:<uuid>`, `contact:<ref>`, `agent:<id>` or `system`. */
  actor: string;
  /**
   * When the provider says it HAPPENED — the sort key. Defaults to now() only
   * because a locally-composed message happens as it is written; anything
   * arriving from a provider must pass the provider's own timestamp.
   */
  occurred_at?: string | Date;
  external_message_id?: string | null;
  delivery_state?: DeliveryState;
  delivery_detail?: string | null;
  read_state?: ReadState;
  in_reply_to_message_id?: string | null;
  provider_thread_key?: string | null;
  provider_message_key?: string | null;
  metadata?: Record<string, unknown> | null;
}

function normalizeOccurredAt(value: string | Date | undefined): Date {
  if (!value) return new Date();
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`[sdk-conversation] invalid occurred_at: ${String(value)}`);
  }
  return d;
}

/**
 * Write a message onto a thread.
 *
 * Idempotent on `(tenant_id, channel, external_message_id)`: a provider that
 * retries a webhook must find the row it already wrote rather than double-post
 * into the thread, so the conflict returns the existing row untouched.
 *
 * Internal notes are rejected here — `addInternalNote` is their only door,
 * because this function accepts a caller-supplied `delivery_state` and that is
 * exactly the field an internal note must never be allowed to set.
 */
export async function recordMessage(input: RecordMessageInput): Promise<ConversationMessage> {
  if (input.channel === INTERNAL_NOTE || input.direction === 'INTERNAL') {
    throw new Error(
      '[sdk-conversation] internal notes must be written via addInternalNote(), ' +
        'which forces the undispatchable shape',
    );
  }
  if (!input.body_ref || !input.body_ref.trim()) {
    throw new Error('[sdk-conversation] recordMessage requires a non-empty body_ref');
  }
  if (input.delivery_state === 'NOT_APPLICABLE') {
    throw new Error(
      "[sdk-conversation] delivery_state 'NOT_APPLICABLE' is reserved for internal notes",
    );
  }

  const occurredAt = normalizeOccurredAt(input.occurred_at);
  const defaultState: DeliveryState = input.direction === 'INBOUND' ? 'RECEIVED' : 'PENDING';

  const row = await dataService.one<MessageRow>(
    `INSERT INTO conversation.message
       (tenant_id, thread_id, channel, direction, external_message_id, delivery_state,
        delivery_detail, read_state, body_ref, body_preview, actor, occurred_at,
        in_reply_to_message_id, provider_thread_key, provider_message_key, metadata)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz,
             $13::uuid, $14, $15, COALESCE($16::jsonb, '{}'::jsonb))
     ON CONFLICT (tenant_id, channel, external_message_id)
       WHERE external_message_id IS NOT NULL
       DO UPDATE SET metadata = conversation.message.metadata
     RETURNING ${MESSAGE_COLUMNS}`,
    [
      input.tenant_id,
      input.thread_id,
      input.channel,
      input.direction,
      input.external_message_id ?? null,
      input.delivery_state ?? defaultState,
      input.delivery_detail ?? null,
      input.read_state ?? (input.direction === 'INBOUND' ? 'UNREAD' : 'READ'),
      input.body_ref,
      input.body_preview ?? null,
      input.actor,
      occurredAt.toISOString(),
      input.in_reply_to_message_id ?? null,
      input.provider_thread_key ?? null,
      input.provider_message_key ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
    ],
  );
  if (!row) throw new Error('[sdk-conversation] recordMessage insert failed');
  return rowToMessage(row);
}

export interface AddInternalNoteInput {
  tenant_id: string;
  thread_id: string;
  body_ref: string;
  body_preview?: string | null;
  actor: string;
  occurred_at?: string | Date;
  metadata?: Record<string, unknown> | null;
}

/**
 * Add a colleague-facing note to a thread.
 *
 * The undispatchable shape is hard-coded, not passed in: channel
 * `INTERNAL_NOTE`, direction `INTERNAL`, `external_message_id` NULL (nothing was
 * ever handed to a carrier) and `delivery_state` `NOT_APPLICABLE` rather than
 * `PENDING` — `PENDING` being precisely what a dispatcher claims. There is no
 * parameter a caller could set to make this row deliverable, and migration 002's
 * CHECK constraints reject such a row even if this function were bypassed.
 */
export async function addInternalNote(input: AddInternalNoteInput): Promise<ConversationMessage> {
  if (!input.body_ref || !input.body_ref.trim()) {
    throw new Error('[sdk-conversation] addInternalNote requires a non-empty body_ref');
  }
  const occurredAt = normalizeOccurredAt(input.occurred_at);

  const row = await dataService.one<MessageRow>(
    `INSERT INTO conversation.message
       (tenant_id, thread_id, channel, direction, external_message_id, delivery_state,
        read_state, body_ref, body_preview, actor, occurred_at, metadata)
     VALUES ($1::uuid, $2::uuid, 'INTERNAL_NOTE', 'INTERNAL', NULL, 'NOT_APPLICABLE',
             'READ', $3, $4, $5, $6::timestamptz, COALESCE($7::jsonb, '{}'::jsonb))
     RETURNING ${MESSAGE_COLUMNS}`,
    [
      input.tenant_id,
      input.thread_id,
      input.body_ref,
      input.body_preview ?? null,
      input.actor,
      occurredAt.toISOString(),
      input.metadata ? JSON.stringify(input.metadata) : null,
    ],
  );
  if (!row) throw new Error('[sdk-conversation] addInternalNote insert failed');
  return rowToMessage(row);
}

export interface ListMessagesInput {
  thread_id: string;
  limit?: number;
  offset?: number;
  /** Omit internal notes — what a customer-visible transcript export wants. */
  exclude_internal?: boolean;
}

/**
 * Render a thread in the order a human remembers it.
 *
 * `occurred_at` first, then `received_at` and `message_id` purely as
 * tie-breakers so the order is TOTAL and stable across repeated reads. Sorting
 * by arrival — or by an insert-assigned sequence — puts a late-delivered 09:00
 * message below the 09:04 reply to it.
 */
export async function listThreadMessages(
  input: ListMessagesInput,
): Promise<ConversationMessage[]> {
  const res = await dataService.query<MessageRow>(
    `SELECT ${MESSAGE_COLUMNS}
       FROM conversation.message
      WHERE thread_id = $1::uuid
        AND ($2::boolean IS NOT TRUE OR channel <> 'INTERNAL_NOTE')
      ORDER BY occurred_at ASC, received_at ASC, message_id ASC
      LIMIT $3 OFFSET $4`,
    [
      input.thread_id,
      input.exclude_internal ?? false,
      Math.min(Math.max(input.limit ?? 200, 1), 500),
      Math.max(input.offset ?? 0, 0),
    ],
  );
  return res.rows.map(rowToMessage);
}

export async function getMessage(message_id: string): Promise<ConversationMessage | null> {
  const row = await dataService.one<MessageRow>(
    `SELECT ${MESSAGE_COLUMNS} FROM conversation.message WHERE message_id = $1::uuid`,
    [message_id],
  );
  return row ? rowToMessage(row) : null;
}

/**
 * Advance a message's delivery state from a provider receipt.
 *
 * Internal notes are excluded in the predicate rather than checked first: a
 * delivery receipt naming an internal note is a bug somewhere upstream, and the
 * safe response is to match zero rows rather than to move the note toward
 * looking like something that was sent.
 */
export async function updateDeliveryState(input: {
  message_id: string;
  delivery_state: Exclude<DeliveryState, 'NOT_APPLICABLE'>;
  delivery_detail?: string | null;
}): Promise<ConversationMessage> {
  const row = await dataService.one<MessageRow>(
    `UPDATE conversation.message
        SET delivery_state = $2,
            delivery_detail = COALESCE($3, delivery_detail)
      WHERE message_id = $1::uuid
        AND channel <> 'INTERNAL_NOTE'
    RETURNING ${MESSAGE_COLUMNS}`,
    [input.message_id, input.delivery_state, input.delivery_detail ?? null],
  );
  if (!row) {
    throw new Error(
      `[sdk-conversation] message ${input.message_id} not found or is an internal note`,
    );
  }
  return rowToMessage(row);
}

/** Mark inbound messages read; the rollup trigger recomputes `unread_count`. */
export async function markThreadRead(thread_id: string): Promise<number> {
  const res = await dataService.query<{ message_id: string }>(
    `UPDATE conversation.message
        SET read_state = 'READ'
      WHERE thread_id = $1::uuid
        AND direction = 'INBOUND'
        AND read_state = 'UNREAD'
    RETURNING message_id::text`,
    [thread_id],
  );
  return res.rowCount ?? res.rows.length;
}

/**
 * The dispatcher's read: messages actually waiting to go out.
 *
 * `channel = ANY(DISPATCHABLE_CHANNELS)` is a positive allowlist rather than
 * `channel <> 'INTERNAL_NOTE'`, so a channel added to the enum later is
 * undispatchable until somebody deliberately adds it here. The default for a
 * new channel should be "not sent", not "sent".
 */
export async function claimPendingDispatch(input: {
  tenant_id: string;
  limit?: number;
}): Promise<ConversationMessage[]> {
  const res = await dataService.query<MessageRow>(
    `SELECT ${MESSAGE_COLUMNS}
       FROM conversation.message
      WHERE tenant_id = $1::uuid
        AND direction = 'OUTBOUND'
        AND delivery_state = 'PENDING'
        AND channel = ANY($2::text[])
      ORDER BY occurred_at ASC, received_at ASC, message_id ASC
      LIMIT $3`,
    [input.tenant_id, DISPATCHABLE_CHANNELS, Math.min(Math.max(input.limit ?? 100, 1), 500)],
  );
  return res.rows.map(rowToMessage);
}

/**
 * Belt-and-braces guard for any send path that did not come through
 * `claimPendingDispatch`. Throws rather than returning false, so a caller that
 * forgets to check the result still cannot dispatch.
 */
export function assertDispatchable(message: Pick<ConversationMessage, 'channel' | 'direction'>): void {
  if (message.channel === INTERNAL_NOTE || message.direction === 'INTERNAL') {
    throw new Error('[sdk-conversation] refusing to dispatch an internal note');
  }
}
