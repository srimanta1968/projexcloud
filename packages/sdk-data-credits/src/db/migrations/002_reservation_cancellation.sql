-- Migration 002: a reservation can also end WITHOUT ever executing (P16 · EP-378 · PCF-05-3).
--
-- 001 modelled exactly one ending: a reservation is settled, with one of the four
-- settlement outcomes. Role-based budgets introduce a second one. A REQUEST_ONLY role
-- creates a request that holds credits and then waits for a human, and that human may
-- say NO — at which point nothing was executed, nothing settles, and yet the hold has
-- to come back. Left alone it would sit against the tenant's available balance forever,
-- which is the quiet version of losing their money.
--
-- The four settlement outcomes are NOT extended to cover it. MATCHED, NO_MATCH,
-- TECHNICAL_FAILURE and CACHE_HIT are all statements about a LOOKUP that happened; a
-- rejected request never looked at anything, and recording it as NO_MATCH would tell a
-- report that the world had no answer when nobody asked the question. So a cancellation
-- is a separate ending with its own reason, and a reservation now ends EITHER settled OR
-- cancelled, never both.
--
-- Idempotent + additive; rollback in ../down/002_reservation_cancellation.down.sql.

ALTER TABLE data_credits.reservation
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE data_credits.reservation
  ADD COLUMN IF NOT EXISTS cancel_reason TEXT;

-- One ending, not two. A row that is both settled and cancelled cannot be reported on:
-- the charge says it happened and the cancellation says it did not.
DO $$ BEGIN
  ALTER TABLE data_credits.reservation
    ADD CONSTRAINT reservation_one_ending CHECK (
      cancelled_at IS NULL OR settled_at IS NULL
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- A cancellation names its reason. "It was cancelled" with no reason is unanswerable
-- three weeks later when somebody asks why their request never ran.
DO $$ BEGIN
  ALTER TABLE data_credits.reservation
    ADD CONSTRAINT reservation_cancellation_has_a_reason CHECK (
      cancelled_at IS NULL OR (cancel_reason IS NOT NULL AND length(btrim(cancel_reason)) > 0)
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS reservation_open_v2_idx
  ON data_credits.reservation (tenant_id, reserved_at)
  WHERE settled_at IS NULL AND cancelled_at IS NULL;

/*
 * Extends 001's settle-once trigger: a cancelled hold has already been given back, so
 * settling it afterwards would charge for a request that was refused — and releasing it
 * a second time would credit the tenant for money they never spent. Both directions are
 * refused here rather than in the service, for the same reason as every other rule on
 * this table: it is somebody's balance.
 */
CREATE OR REPLACE FUNCTION data_credits.reject_resettlement()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.cancelled_at IS NOT NULL THEN
    IF NEW.settled_at IS NOT NULL THEN
      RAISE EXCEPTION
        'reservation % was cancelled (%) and cannot be settled afterwards',
        OLD.reservation_id, OLD.cancel_reason
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at THEN
      RAISE EXCEPTION 'reservation % is already cancelled', OLD.reservation_id
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.settled_at IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION
      'reservation % is already settled as % and cannot be cancelled afterwards',
      OLD.reservation_id, OLD.outcome
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.outcome IS DISTINCT FROM OLD.outcome
     OR NEW.settled_credits IS DISTINCT FROM OLD.settled_credits THEN
    RAISE EXCEPTION
      'reservation % is already settled as % for % credits — a settlement is final',
      OLD.reservation_id, OLD.outcome, OLD.settled_credits
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- Same settlement arriving twice: keep the FIRST timestamp. The moment it settled
  -- is a fact about the first call, not about how many times the caller retried.
  NEW.settled_at := OLD.settled_at;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
