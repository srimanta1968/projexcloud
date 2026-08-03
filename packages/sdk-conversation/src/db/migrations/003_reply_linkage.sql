-- Migration 003: reply detection and outbound linkage (P16 · EP-381 · PCF-08-2).
--
-- 002 left `in_reply_to_message_id` NULL and said "set by reply detection". This adds
-- the state around that column, because the link itself is not the whole story:
--
--   * An inbound message that could NOT be matched must stay a first-class row. The
--     tempting shortcut — drop it, or leave it looking identical to a matched one — loses
--     the customer's actual reply, which is the one thing in this table nobody can
--     regenerate. So `reply_link_state` starts at UNMATCHED for every inbound message and
--     only becomes LINKED when a parent is genuinely found. UNMATCHED is a QUEUE, not an
--     error: it is indexed so triage can work through it.
--
--   * HOW a link was made decides how much you may trust it. A provider echoing its own
--     message id is proof; "the most recent outbound on this channel" is a guess that
--     happens to be right most of the time. Recording `reply_link_method` keeps those
--     distinguishable after the fact, so a consumer can treat a heuristic link as
--     provisional instead of discovering months later that everything looked equally
--     certain.
--
-- The invariant is maintained by trigger rather than left to callers: state and direction
-- cannot drift apart, however the row was written.

ALTER TABLE conversation.message
  ADD COLUMN IF NOT EXISTS reply_link_state TEXT NOT NULL DEFAULT 'NOT_APPLICABLE',
  ADD COLUMN IF NOT EXISTS reply_link_method TEXT,
  ADD COLUMN IF NOT EXISTS reply_linked_at TIMESTAMPTZ,
  /*
   * The parent id AS THE PROVIDER STATED IT — an email In-Reply-To, or the id an SMS /
   * social webhook echoes back. Kept even when it matches nothing we hold: it is the only
   * evidence of what the provider claimed, and a later backfill of the parent can use it
   * to link retroactively.
   */
  ADD COLUMN IF NOT EXISTS provider_in_reply_to_key TEXT,
  /*
   * Email References: the full ancestor chain, oldest first. Kept as an array because the
   * LAST entry is the immediate parent and earlier ones are progressively weaker
   * fallbacks when a client rewrites In-Reply-To.
   */
  ADD COLUMN IF NOT EXISTS provider_reference_keys TEXT[];

-- Existing inbound rows predate detection: they are unmatched, not "not applicable".
UPDATE conversation.message
   SET reply_link_state = CASE
         WHEN in_reply_to_message_id IS NOT NULL THEN 'LINKED'
         ELSE 'UNMATCHED'
       END
 WHERE direction = 'INBOUND'
   AND reply_link_state = 'NOT_APPLICABLE';

-- ---------------------------------------------------------------------------
-- Invariants.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conv_message_reply_state_values') THEN
    ALTER TABLE conversation.message
      ADD CONSTRAINT conv_message_reply_state_values
      CHECK (reply_link_state IN ('NOT_APPLICABLE', 'LINKED', 'UNMATCHED'));
  END IF;

  -- Only an INBOUND message can be linked or awaiting a link. An outbound message or an
  -- internal note has nothing to be a reply TO, so the states are not merely unused there
  -- — they are meaningless, and allowing them would put rows in the triage queue that no
  -- amount of work could ever clear.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conv_message_reply_state_direction') THEN
    ALTER TABLE conversation.message
      ADD CONSTRAINT conv_message_reply_state_direction
      CHECK (
        (direction = 'INBOUND' AND reply_link_state IN ('LINKED', 'UNMATCHED'))
        OR (direction <> 'INBOUND' AND reply_link_state = 'NOT_APPLICABLE')
      );
  END IF;

  -- LINKED must actually carry the link, and an unlinked row must not claim a method or a
  -- timestamp. Without this, "LINKED with a NULL parent" is representable and every reader
  -- has to defend against it.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conv_message_reply_link_shape') THEN
    ALTER TABLE conversation.message
      ADD CONSTRAINT conv_message_reply_link_shape
      CHECK (
        (reply_link_state = 'LINKED'
           AND in_reply_to_message_id IS NOT NULL
           AND reply_link_method IS NOT NULL
           AND reply_linked_at IS NOT NULL)
        OR (reply_link_state <> 'LINKED'
           AND in_reply_to_message_id IS NULL
           AND reply_link_method IS NULL
           AND reply_linked_at IS NULL)
      );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conv_message_reply_method_values') THEN
    ALTER TABLE conversation.message
      ADD CONSTRAINT conv_message_reply_method_values
      CHECK (reply_link_method IS NULL OR reply_link_method IN (
        'PROVIDER_REPLY_ID',   -- the provider echoed our own message id. Proof.
        'EMAIL_HEADER',        -- In-Reply-To / References matched an outbound Message-ID.
        'PROVIDER_THREAD_KEY', -- same carrier conversation / DM thread.
        'CHANNEL_RECENCY'      -- heuristic: most recent outbound on this thread+channel.
      ));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Keep state and direction consistent no matter who writes the row.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION conversation.normalize_reply_state() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.direction <> 'INBOUND' THEN
    NEW.reply_link_state := 'NOT_APPLICABLE';
    NEW.in_reply_to_message_id := NULL;
    NEW.reply_link_method := NULL;
    NEW.reply_linked_at := NULL;
  ELSIF NEW.in_reply_to_message_id IS NOT NULL THEN
    NEW.reply_link_state := 'LINKED';
    NEW.reply_link_method := COALESCE(NEW.reply_link_method, 'PROVIDER_REPLY_ID');
    NEW.reply_linked_at := COALESCE(NEW.reply_linked_at, now());
  ELSE
    -- The default that matters: an inbound message with no parent is RETAINED and
    -- FLAGGED, never dropped and never silently treated as resolved.
    NEW.reply_link_state := 'UNMATCHED';
    NEW.reply_link_method := NULL;
    NEW.reply_linked_at := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS conv_message_reply_state ON conversation.message;
CREATE TRIGGER conv_message_reply_state
  BEFORE INSERT OR UPDATE OF direction, in_reply_to_message_id, reply_link_state,
                             reply_link_method, reply_linked_at
  ON conversation.message
  FOR EACH ROW EXECUTE FUNCTION conversation.normalize_reply_state();

-- ---------------------------------------------------------------------------
-- Indexes.
-- ---------------------------------------------------------------------------
-- The triage queue: unmatched inbound messages, oldest first.
CREATE INDEX IF NOT EXISTS conv_message_unmatched_idx
  ON conversation.message (tenant_id, occurred_at)
  WHERE reply_link_state = 'UNMATCHED';

-- Resolution lookups: find the outbound whose provider id the reply names.
CREATE INDEX IF NOT EXISTS conv_message_provider_msg_key_idx
  ON conversation.message (tenant_id, provider_message_key)
  WHERE provider_message_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS conv_message_in_reply_to_key_idx
  ON conversation.message (tenant_id, provider_in_reply_to_key)
  WHERE provider_in_reply_to_key IS NOT NULL;

COMMENT ON COLUMN conversation.message.reply_link_state IS
  'INBOUND only: UNMATCHED (retained + flagged for triage) or LINKED. Others NOT_APPLICABLE.';
COMMENT ON COLUMN conversation.message.reply_link_method IS
  'How the link was established — proof (PROVIDER_REPLY_ID/EMAIL_HEADER) vs guess (CHANNEL_RECENCY).';
