-- Migration 002: the omnichannel thread and message model (P16 · EP-381 · PCF-08-1).
--
-- 001 modelled ONE thing: an AI chat session, with turns keyed by a monotonic seq the
-- server itself assigned. That is exactly right for a chat, and exactly wrong for a
-- conversation that runs across email, SMS and a social DM, for two reasons:
--
--   * A provider tells you about a message when it gets around to it. An SMS sent at
--     09:00 can arrive at your webhook after a reply sent at 09:04, and a thread ordered
--     by arrival then shows the answer above the question. So ORDER IS BY occurred_at —
--     when the thing actually happened — and arrival time is kept separately as
--     received_at, which is a diagnostic, not a sort key. A monotonic seq cannot express
--     this at all: it is assigned on arrival, so it BAKES IN the wrong order.
--
--   * A note to a colleague and a message to a customer are not the same kind of thing.
--     Keeping them in one table separated only by a flag means every send path has to
--     remember to check that flag, and the day one of them forgets, an internal note
--     about a customer is delivered to that customer. Here INTERNAL_NOTE is separated
--     STRUCTURALLY: the constraints below make an internal note that is dispatchable
--     unrepresentable, so the send path cannot get it wrong even if it tries.
--
-- 001's session/turn/handoff tables are UNTOUCHED and keep working exactly as they did.

-- ---------------------------------------------------------------------------
-- conversation.thread — one subject's conversation, across every channel.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversation.thread (
  thread_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL,

  /*
   * `<kind>:<id>` — the same subject-reference shape the rest of the platform uses, so a
   * thread can hang off a lead, a contact, a ticket or a deal without this package
   * knowing what any of those are.
   */
  subject_ref      TEXT NOT NULL CHECK (length(btrim(subject_ref)) > 0),
  subject_kind     TEXT,

  /*
   * Every channel this thread has actually carried, maintained by trigger from the
   * messages themselves rather than declared by the caller: a declared channel set drifts
   * the first time somebody replies by a route nobody predicted, and an inbox filtering
   * on a stale set silently hides threads.
   */
  channel_set      TEXT[] NOT NULL DEFAULT '{}',

  /*
   * WHY this conversation exists. Required, because a thread with no stated purpose is
   * one nobody can decide is finished, and it is the field a consumer needs to apply its
   * own policy (this SDK applies none).
   */
  purpose          TEXT NOT NULL CHECK (length(btrim(purpose)) > 0),

  /** Opaque to this package: the order, ticket or campaign the conversation is about. */
  related_object_ref TEXT,
  /** Which of the tenant's identities is speaking — a mailbox, a number, a page. */
  sender_identity_ref TEXT,

  /*
   * A SNAPSHOT, not a live verdict. Eligibility (consent, quiet hours, do-not-contact) is
   * the consumer's to decide; this column records what the consumer said and WHEN, so a
   * message sent last Tuesday can be explained against the rules as they stood last
   * Tuesday rather than as they stand now. Storing a live answer here would quietly
   * rewrite history every time policy changed.
   */
  current_eligibility_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  eligibility_snapshot_at TIMESTAMPTZ,

  status           TEXT NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open', 'awaiting_reply', 'closed')),

  /** Maintained by trigger from messages, so an inbox sorts without a subquery. */
  last_message_at  TIMESTAMPTZ,
  last_inbound_at  TIMESTAMPTZ,
  last_outbound_at TIMESTAMPTZ,
  unread_count     INTEGER NOT NULL DEFAULT 0 CHECK (unread_count >= 0),

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at        TIMESTAMPTZ,
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT conv_thread_closed_shape CHECK (
    (status = 'closed') = (closed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS conv_thread_subject_idx
  ON conversation.thread (tenant_id, subject_ref, last_message_at DESC);
-- The inbox reads: open threads, most recently active first.
CREATE INDEX IF NOT EXISTS conv_thread_inbox_idx
  ON conversation.thread (tenant_id, status, last_message_at DESC);
CREATE INDEX IF NOT EXISTS conv_thread_channel_set_idx
  ON conversation.thread USING GIN (channel_set);
CREATE INDEX IF NOT EXISTS conv_thread_related_idx
  ON conversation.thread (tenant_id, related_object_ref)
  WHERE related_object_ref IS NOT NULL;

-- ---------------------------------------------------------------------------
-- conversation.message — one message on a thread, on one channel.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversation.message (
  message_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL,
  thread_id        UUID NOT NULL
                     REFERENCES conversation.thread (thread_id) ON DELETE CASCADE,

  channel          TEXT NOT NULL CHECK (channel IN (
                     'EMAIL', 'SMS', 'VOICE', 'VOICEMAIL', 'SOCIAL_DM',
                     'WEB_CHAT', 'IN_PERSON', 'INTERNAL_NOTE')),
  direction        TEXT NOT NULL CHECK (direction IN ('INBOUND', 'OUTBOUND', 'INTERNAL')),

  /** The provider's own id. Unique per tenant+channel so a webhook retry is a no-op. */
  external_message_id TEXT,

  delivery_state   TEXT NOT NULL DEFAULT 'PENDING'
                     CHECK (delivery_state IN (
                       'PENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'BOUNCED',
                       'RECEIVED', 'NOT_APPLICABLE')),
  delivery_detail  TEXT,
  read_state       TEXT NOT NULL DEFAULT 'UNREAD'
                     CHECK (read_state IN ('UNREAD', 'READ')),

  /*
   * A REFERENCE to the body, never the body. Message text is customer content: it goes to
   * the vault/blob store like every other payload in this platform, and a column here
   * would put it in every backup, replica and query plan that touches this table.
   */
  body_ref         TEXT NOT NULL CHECK (length(btrim(body_ref)) > 0),
  body_preview     TEXT,

  /** Who sent it: `persona:<uuid>`, `contact:<ref>`, `agent:<id>`, `system`. */
  actor            TEXT NOT NULL CHECK (length(btrim(actor)) > 0),

  /*
   * WHEN IT HAPPENED, per the provider — the sort key. Distinct from received_at (when we
   * heard about it), because those two differ by minutes on a bad day and by hours when a
   * provider backfills, and only one of them is the order a human remembers.
   */
  occurred_at      TIMESTAMPTZ NOT NULL,
  received_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  /** Set by reply detection (PCF-08-2); NULL until a link is established. */
  in_reply_to_message_id UUID REFERENCES conversation.message (message_id) ON DELETE SET NULL,
  /** Provider threading keys — email Message-ID / In-Reply-To, SMS conversation id. */
  provider_thread_key TEXT,
  provider_message_key TEXT,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,

  /*
   * THE THREE CONSTRAINTS THAT MAKE AN UNDISPATCHABLE NOTE UNREPRESENTABLE.
   *
   * Together they say: an internal note is INTERNAL in direction, has no provider id (so
   * nothing was ever handed to a carrier), and its delivery_state is NOT_APPLICABLE
   * rather than PENDING — which is what a dispatcher picks up. A send path cannot mark an
   * internal note for delivery, because the row that would represent that cannot exist.
   */
  CONSTRAINT conv_message_note_is_internal CHECK (
    channel <> 'INTERNAL_NOTE' OR direction = 'INTERNAL'
  ),
  CONSTRAINT conv_message_internal_is_note CHECK (
    direction <> 'INTERNAL' OR channel = 'INTERNAL_NOTE'
  ),
  CONSTRAINT conv_message_note_never_dispatched CHECK (
    channel <> 'INTERNAL_NOTE'
    OR (external_message_id IS NULL AND delivery_state = 'NOT_APPLICABLE')
  ),
  -- Conversely, a customer-facing message must NOT claim the internal-only state.
  CONSTRAINT conv_message_dispatchable_state CHECK (
    channel = 'INTERNAL_NOTE' OR delivery_state <> 'NOT_APPLICABLE'
  ),
  CONSTRAINT conv_message_not_own_reply CHECK (
    in_reply_to_message_id IS NULL OR in_reply_to_message_id <> message_id
  )
);

-- The thread render: strictly by when things HAPPENED. received_at and message_id are
-- tie-breakers only, so the order is total and stable across repeated reads.
CREATE INDEX IF NOT EXISTS conv_message_thread_time_idx
  ON conversation.message (thread_id, occurred_at, received_at, message_id);
CREATE INDEX IF NOT EXISTS conv_message_tenant_time_idx
  ON conversation.message (tenant_id, occurred_at DESC);
-- A provider retry must find the row it already wrote rather than write a second one.
CREATE UNIQUE INDEX IF NOT EXISTS conv_message_external_idx
  ON conversation.message (tenant_id, channel, external_message_id)
  WHERE external_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS conv_message_reply_idx
  ON conversation.message (in_reply_to_message_id)
  WHERE in_reply_to_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS conv_message_provider_thread_idx
  ON conversation.message (tenant_id, provider_thread_key)
  WHERE provider_thread_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS conv_message_unread_idx
  ON conversation.message (thread_id)
  WHERE read_state = 'UNREAD' AND direction = 'INBOUND';

-- ---------------------------------------------------------------------------
-- Thread rollups, maintained by trigger.
--
-- Derived here rather than in the service because two writers (a webhook and an agent UI)
-- can insert into the same thread at the same time, and a read-modify-write in
-- application code loses one of them. last_message_at only ever moves FORWARD, so a
-- backfilled old message cannot drag a thread back down the inbox.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION conversation.thread_rollup() RETURNS TRIGGER AS $$
BEGIN
  UPDATE conversation.thread t
     SET last_message_at = GREATEST(COALESCE(t.last_message_at, NEW.occurred_at), NEW.occurred_at),
         last_inbound_at = CASE WHEN NEW.direction = 'INBOUND'
                                THEN GREATEST(COALESCE(t.last_inbound_at, NEW.occurred_at), NEW.occurred_at)
                                ELSE t.last_inbound_at END,
         last_outbound_at = CASE WHEN NEW.direction = 'OUTBOUND'
                                 THEN GREATEST(COALESCE(t.last_outbound_at, NEW.occurred_at), NEW.occurred_at)
                                 ELSE t.last_outbound_at END,
         channel_set = CASE WHEN NEW.channel = ANY (t.channel_set)
                            THEN t.channel_set
                            ELSE array_append(t.channel_set, NEW.channel) END,
         unread_count = (
           SELECT count(*) FROM conversation.message m
            WHERE m.thread_id = NEW.thread_id
              AND m.direction = 'INBOUND' AND m.read_state = 'UNREAD'
         ),
         -- An outbound message puts the thread in 'awaiting_reply'; an inbound one
         -- answers it. A CLOSED thread is left alone — reopening is a decision, not a
         -- side effect of a late delivery receipt.
         status = CASE
                    WHEN t.status = 'closed' THEN t.status
                    WHEN NEW.direction = 'OUTBOUND' THEN 'awaiting_reply'
                    WHEN NEW.direction = 'INBOUND' THEN 'open'
                    ELSE t.status
                  END,
         updated_at = now()
   WHERE t.thread_id = NEW.thread_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS conv_message_rollup ON conversation.message;
CREATE TRIGGER conv_message_rollup
  AFTER INSERT OR UPDATE OF read_state, direction, occurred_at ON conversation.message
  FOR EACH ROW EXECUTE FUNCTION conversation.thread_rollup();

COMMENT ON TABLE conversation.thread IS
  'sdk-conversation (P16 EP-381). One subject conversation across every channel; rollups by trigger.';
COMMENT ON TABLE conversation.message IS
  'sdk-conversation (P16 EP-381). Ordered by occurred_at, not arrival. INTERNAL_NOTE is structurally undispatchable.';
