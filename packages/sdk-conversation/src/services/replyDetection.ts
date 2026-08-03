import { dataService } from '@projexlight/db-runtime';
import { emitEvent } from '@projexlight/sdk-audit';
import type { ConversationMessage, ThreadChannel } from './threadService';

/**
 * Reply detection and outbound linkage (P16 · EP-381 · PCF-08-2).
 *
 * Ties an inbound message back to the outbound message it answers, then says so out loud
 * so consumers can react without polling.
 *
 * THE LADDER. Four strategies, tried strongest first, because they are not equally
 * trustworthy and collapsing them into one "best guess" throws away the difference:
 *
 *   1. PROVIDER_REPLY_ID   — the provider handed back the id of OUR message. Proof.
 *   2. EMAIL_HEADER        — In-Reply-To, then References walked newest→oldest. Near-proof;
 *                            RFC 5322 threading, and what every mail client itself uses.
 *   3. PROVIDER_THREAD_KEY — same carrier conversation / DM thread. Right party and right
 *                            channel, but only identifies the CONVERSATION, so the parent
 *                            is the newest outbound in it.
 *   4. CHANNEL_RECENCY     — "the last thing we sent them here." A guess. Correct most of
 *                            the time on SMS, where the transport carries no threading at
 *                            all, and bounded by a window so a reply weeks later does not
 *                            attach itself to a long-dead campaign.
 *
 * The method is recorded on the row, so a consumer can treat a CHANNEL_RECENCY link as
 * provisional. A single "linked: true" would make a carrier's own echo and a timing guess
 * indistinguishable.
 *
 * AND IT NEVER DROPS ANYTHING. If no rung matches, the message stays, flagged UNMATCHED,
 * and an event says so. An inbound message is the one row in this schema nobody can
 * regenerate — the customer already said it.
 */

const CONVERSATION_AUDIT_POOL = process.env.CONVERSATION_AUDIT_POOL || 'admin-default';

/**
 * How far back the pure-recency guess may reach. Long enough to cover a normal
 * think-about-it delay, short enough that a reply to something ancient is left for a human
 * rather than silently attached to the wrong outreach.
 */
const RECENCY_WINDOW_HOURS = Number(process.env.CONVERSATION_REPLY_WINDOW_HOURS || 72);

export type ReplyLinkMethod =
  | 'PROVIDER_REPLY_ID'
  | 'EMAIL_HEADER'
  | 'PROVIDER_THREAD_KEY'
  | 'CHANNEL_RECENCY';

export type ReplyLinkState = 'NOT_APPLICABLE' | 'LINKED' | 'UNMATCHED';

/** Confidence tier for the method that produced a link. */
export type ReplyLinkConfidence = 'proof' | 'strong' | 'heuristic';

const METHOD_CONFIDENCE: Record<ReplyLinkMethod, ReplyLinkConfidence> = {
  PROVIDER_REPLY_ID: 'proof',
  EMAIL_HEADER: 'proof',
  PROVIDER_THREAD_KEY: 'strong',
  CHANNEL_RECENCY: 'heuristic',
};

export function confidenceOf(method: ReplyLinkMethod): ReplyLinkConfidence {
  return METHOD_CONFIDENCE[method];
}

export interface ReplySignals {
  /** The provider's own id for the message being answered (In-Reply-To, or a webhook echo). */
  provider_in_reply_to_key?: string | null;
  /** Email References, oldest → newest. The last entry is the immediate parent. */
  provider_reference_keys?: string[] | null;
  /** Carrier conversation / DM thread id, when the channel has one. */
  provider_thread_key?: string | null;
}

export interface DetectReplyInput {
  tenant_id: string;
  /** The inbound message to resolve. Must already exist (recorded, never dropped). */
  message_id: string;
  thread_id?: string | null;
  channel: ThreadChannel;
  occurred_at: string | Date;
  signals?: ReplySignals;
}

export interface ReplyLinkResult {
  linked: boolean;
  message_id: string;
  parent_message_id: string | null;
  method: ReplyLinkMethod | null;
  confidence: ReplyLinkConfidence | null;
  state: ReplyLinkState;
}

interface CandidateRow {
  message_id: string;
  thread_id: string;
  channel: string;
  occurred_at: Date;
}

function toDate(value: string | Date): Date {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`[sdk-conversation] invalid occurred_at: ${String(value)}`);
  }
  return d;
}

/**
 * Email References arrive as one space-separated header. Normalizing here (rather than at
 * each call site) keeps the angle brackets — which some clients send and some strip — from
 * deciding whether a thread links.
 */
export function parseReferenceKeys(raw: string | string[] | null | undefined): string[] {
  if (!raw) return [];
  // Split EVERY element, not just a bare string. References is one space-separated header,
  // and callers hand it over both ways — as the raw header and as a single-element array.
  // Trimming without splitting turns "<a@x> <b@y>" into the one id "a@x> <b@y", which
  // matches nothing and silently demotes a provable link to the recency guess.
  const parts = (Array.isArray(raw) ? raw : [raw]).flatMap((p) => String(p).split(/[\s,]+/));
  return parts
    .map((p) => p.trim().replace(/^<+|>+$/g, ''))
    .filter((p) => p.length > 0);
}

function normalizeKey(key: string | null | undefined): string | null {
  if (!key) return null;
  const k = key.trim().replace(/^<|>$/g, '');
  return k.length > 0 ? k : null;
}

/**
 * Find the outbound message a provider id names.
 *
 * Scoped to OUTBOUND on purpose: an inbound message can carry the same provider key when a
 * mail loop reflects our own id back, and linking a reply to another inbound would build a
 * chain that answers nothing.
 */
async function findByProviderKey(
  tenant_id: string,
  key: string,
): Promise<CandidateRow | null> {
  return dataService.one<CandidateRow>(
    `SELECT message_id::text, thread_id::text, channel, occurred_at
       FROM conversation.message
      WHERE tenant_id = $1::uuid
        AND direction = 'OUTBOUND'
        AND (provider_message_key = $2 OR external_message_id = $2)
      ORDER BY occurred_at DESC
      LIMIT 1`,
    [tenant_id, key],
  );
}

async function findByThreadKey(
  tenant_id: string,
  provider_thread_key: string,
  before: Date,
): Promise<CandidateRow | null> {
  return dataService.one<CandidateRow>(
    `SELECT message_id::text, thread_id::text, channel, occurred_at
       FROM conversation.message
      WHERE tenant_id = $1::uuid
        AND direction = 'OUTBOUND'
        AND provider_thread_key = $2
        AND occurred_at <= $3::timestamptz
      ORDER BY occurred_at DESC
      LIMIT 1`,
    [tenant_id, provider_thread_key, before.toISOString()],
  );
}

/**
 * The last thing we sent on this thread and channel, within the window.
 *
 * `occurred_at <= $4` matters: ordering is by when things HAPPENED (002), so a backfilled
 * outbound that arrived late must not become the parent of a reply that predates it.
 */
async function findByRecency(
  tenant_id: string,
  thread_id: string,
  channel: ThreadChannel,
  before: Date,
): Promise<CandidateRow | null> {
  const windowStart = new Date(before.getTime() - RECENCY_WINDOW_HOURS * 3600 * 1000);
  return dataService.one<CandidateRow>(
    `SELECT message_id::text, thread_id::text, channel, occurred_at
       FROM conversation.message
      WHERE tenant_id = $1::uuid
        AND thread_id = $2::uuid
        AND channel = $3
        AND direction = 'OUTBOUND'
        AND occurred_at <= $4::timestamptz
        AND occurred_at >= $5::timestamptz
      ORDER BY occurred_at DESC
      LIMIT 1`,
    [tenant_id, thread_id, channel, before.toISOString(), windowStart.toISOString()],
  );
}

/**
 * Resolve the parent WITHOUT writing anything — the ladder on its own.
 *
 * Separated from the write so the decision can be tested and inspected independently of
 * the side effects, and so a caller can preview a link before committing to it.
 */
export async function resolveReplyParent(
  input: DetectReplyInput,
): Promise<{ parent: CandidateRow | null; method: ReplyLinkMethod | null }> {
  const signals = input.signals ?? {};
  const occurredAt = toDate(input.occurred_at);

  // 1. The provider named our message outright.
  const direct = normalizeKey(signals.provider_in_reply_to_key);
  if (direct) {
    const hit = await findByProviderKey(input.tenant_id, direct);
    if (hit) return { parent: hit, method: 'PROVIDER_REPLY_ID' };
  }

  // 2. Email References, newest first — the immediate parent is the LAST entry, and each
  //    earlier one is a weaker fallback for clients that rewrite In-Reply-To.
  const refs = parseReferenceKeys(signals.provider_reference_keys);
  for (let i = refs.length - 1; i >= 0; i -= 1) {
    const hit = await findByProviderKey(input.tenant_id, refs[i]);
    if (hit) return { parent: hit, method: 'EMAIL_HEADER' };
  }

  // 3. Same carrier conversation / DM thread.
  const threadKey = normalizeKey(signals.provider_thread_key);
  if (threadKey) {
    const hit = await findByThreadKey(input.tenant_id, threadKey, occurredAt);
    if (hit) return { parent: hit, method: 'PROVIDER_THREAD_KEY' };
  }

  // 4. Last resort: the most recent outbound on this thread + channel, inside the window.
  if (input.thread_id) {
    const hit = await findByRecency(
      input.tenant_id,
      input.thread_id,
      input.channel,
      occurredAt,
    );
    if (hit) return { parent: hit, method: 'CHANNEL_RECENCY' };
  }

  return { parent: null, method: null };
}

/**
 * Resolve and PERSIST the link, then announce it.
 *
 * The event is emitted after the write commits, so a consumer that reacts immediately
 * (pausing a sequence, opening an owner task) reads a row that already says LINKED rather
 * than racing the transaction that produced it.
 */
export async function detectAndLinkReply(
  input: DetectReplyInput,
): Promise<ReplyLinkResult> {
  const { parent, method } = await resolveReplyParent(input);

  // Persist the provider signals regardless of the outcome: they are the evidence of what
  // the provider claimed, and a parent that arrives later can be linked retroactively.
  const signals = input.signals ?? {};
  const refs = parseReferenceKeys(signals.provider_reference_keys);

  if (!parent || !method) {
    const row = await dataService.one<{ thread_id: string; channel: string }>(
      `UPDATE conversation.message
          SET provider_in_reply_to_key = COALESCE($2, provider_in_reply_to_key),
              provider_reference_keys  = COALESCE($3::text[], provider_reference_keys)
        WHERE message_id = $1::uuid
          AND direction = 'INBOUND'
      RETURNING thread_id::text, channel`,
      [
        input.message_id,
        normalizeKey(signals.provider_in_reply_to_key),
        refs.length ? refs : null,
      ],
    );
    if (!row) {
      throw new Error(
        `[sdk-conversation] inbound message ${input.message_id} not found — ` +
          'record the message before running reply detection; it must never be dropped',
      );
    }

    // AC4: retained and FLAGGED. The trigger has already forced UNMATCHED; this event is
    // what puts it in front of a human without anyone polling the table.
    await emitEvent({
      event_type: 'conversation.reply.unmatched.v1',
      pool_index: CONVERSATION_AUDIT_POOL,
      actor_id: 'sdk-conversation',
      actor_kind: 'service',
      tenant_id: input.tenant_id,
      subject_kind: 'conversation.message',
      subject_id: input.message_id,
      payload: {
        message_id: input.message_id,
        thread_id: row.thread_id,
        channel: row.channel,
        occurred_at: toDate(input.occurred_at).toISOString(),
        provider_in_reply_to_key: normalizeKey(signals.provider_in_reply_to_key),
        reason: 'no outbound message matched any resolution strategy',
      },
    });

    return {
      linked: false,
      message_id: input.message_id,
      parent_message_id: null,
      method: null,
      confidence: null,
      state: 'UNMATCHED',
    };
  }

  const linkedRow = await dataService.one<{
    thread_id: string;
    channel: string;
    occurred_at: Date;
    reply_link_state: string;
  }>(
    `UPDATE conversation.message
        SET in_reply_to_message_id = $2::uuid,
            reply_link_method = $3,
            reply_linked_at = now(),
            provider_in_reply_to_key = COALESCE($4, provider_in_reply_to_key),
            provider_reference_keys  = COALESCE($5::text[], provider_reference_keys)
      WHERE message_id = $1::uuid
        AND direction = 'INBOUND'
        AND message_id <> $2::uuid
    RETURNING thread_id::text, channel, occurred_at, reply_link_state`,
    [
      input.message_id,
      parent.message_id,
      method,
      normalizeKey(signals.provider_in_reply_to_key),
      refs.length ? refs : null,
    ],
  );
  if (!linkedRow) {
    throw new Error(
      `[sdk-conversation] could not link inbound message ${input.message_id} ` +
        `to ${parent.message_id}`,
    );
  }

  // AC2: the linkage event. Carries everything a consumer needs to pause a sequence and
  // open an owner task in one hop — no follow-up read, no polling.
  await emitEvent({
    event_type: 'conversation.reply.linked.v1',
    pool_index: CONVERSATION_AUDIT_POOL,
    actor_id: 'sdk-conversation',
    actor_kind: 'service',
    tenant_id: input.tenant_id,
    subject_kind: 'conversation.message',
    subject_id: input.message_id,
    payload: {
      message_id: input.message_id,
      thread_id: linkedRow.thread_id,
      parent_message_id: parent.message_id,
      parent_thread_id: parent.thread_id,
      channel: linkedRow.channel,
      method,
      // A CHANNEL_RECENCY link is a guess; say so in the payload so a consumer can choose
      // to require 'proof' before taking an irreversible action.
      confidence: confidenceOf(method),
      occurred_at: linkedRow.occurred_at.toISOString(),
      parent_occurred_at: parent.occurred_at.toISOString(),
    },
  });

  return {
    linked: true,
    message_id: input.message_id,
    parent_message_id: parent.message_id,
    method,
    confidence: confidenceOf(method),
    state: 'LINKED',
  };
}

/**
 * The triage queue: inbound messages nobody could match, oldest first.
 *
 * Exists so AC4's "flagged rather than dropped" is actionable — a flag with no reader is
 * just a slower way of losing the message.
 */
export async function listUnmatchedInbound(input: {
  tenant_id: string;
  limit?: number;
  offset?: number;
}): Promise<ConversationMessage[]> {
  const res = await dataService.query<Record<string, never>>(
    `SELECT message_id::text, tenant_id::text, thread_id::text, channel, direction,
            external_message_id, delivery_state, delivery_detail, read_state, body_ref,
            body_preview, actor, occurred_at, received_at,
            in_reply_to_message_id::text, provider_thread_key, provider_message_key,
            created_at, metadata
       FROM conversation.message
      WHERE tenant_id = $1::uuid
        AND reply_link_state = 'UNMATCHED'
      ORDER BY occurred_at ASC, message_id ASC
      LIMIT $2 OFFSET $3`,
    [
      input.tenant_id,
      Math.min(Math.max(input.limit ?? 100, 1), 500),
      Math.max(input.offset ?? 0, 0),
    ],
  );
  return res.rows as unknown as ConversationMessage[];
}

/**
 * Re-run detection over the unmatched queue.
 *
 * The point is the late-arriving parent: providers backfill, and an outbound that shows up
 * after its reply leaves a message that WOULD link if asked again. Without this, the first
 * attempt is the only attempt and the queue only ever grows.
 */
export async function retryUnmatched(input: {
  tenant_id: string;
  limit?: number;
}): Promise<{ examined: number; linked: number }> {
  const pending = await dataService.query<{
    message_id: string;
    thread_id: string;
    channel: string;
    occurred_at: Date;
    provider_in_reply_to_key: string | null;
    provider_reference_keys: string[] | null;
    provider_thread_key: string | null;
  }>(
    `SELECT message_id::text, thread_id::text, channel, occurred_at,
            provider_in_reply_to_key, provider_reference_keys, provider_thread_key
       FROM conversation.message
      WHERE tenant_id = $1::uuid
        AND reply_link_state = 'UNMATCHED'
      ORDER BY occurred_at ASC
      LIMIT $2`,
    [input.tenant_id, Math.min(Math.max(input.limit ?? 100, 1), 500)],
  );

  let linked = 0;
  for (const row of pending.rows) {
    const result = await detectAndLinkReply({
      tenant_id: input.tenant_id,
      message_id: row.message_id,
      thread_id: row.thread_id,
      channel: row.channel as ThreadChannel,
      occurred_at: row.occurred_at,
      signals: {
        provider_in_reply_to_key: row.provider_in_reply_to_key,
        provider_reference_keys: row.provider_reference_keys,
        provider_thread_key: row.provider_thread_key,
      },
    });
    if (result.linked) linked += 1;
  }

  return { examined: pending.rows.length, linked };
}
