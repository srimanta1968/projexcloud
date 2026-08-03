-- Migration 001: sdk-data-credits — capability broker & credit ledger (P16 · EP-378 · PCF-05-1).
--
--   capability          — the OUTCOME a tenant can buy, and what it costs in credits
--   provider_binding    — who actually serves it, for how much, on which key  [INTERNAL]
--   provider_attempt    — which binding was tried, what it really cost        [INTERNAL]
--   credit_account      — balance and the part of it already spoken for
--   capability_request  — one tenant asking for one outcome about one subject
--   reservation         — the hold placed before execution, and its settlement
--   result_cache        — an answer already paid for, reusable inside its TTL
--   budget_policy       — who may spend, how much, and who has to ask first
--   credit_ledger       — the append-only record of every credit movement
--
-- THE ONE STRUCTURAL PROMISE. A tenant buys an OUTCOME ("validate.phone"), never a
-- vendor. Which provider served it, what key was used, how healthy that provider is
-- and what it truly cost are the broker's business and must never cross the tenant
-- boundary. That promise is kept HERE, in the shape of the tables, rather than left
-- to each handler to remember:
--
--   * provider_binding and provider_attempt carry NO tenant_id column at all. Every
--     tenant-scoped read in this SDK is `WHERE tenant_id = $1`; a table with no such
--     column cannot appear in one without somebody deliberately writing an
--     untenanted join. A leak becomes a visible act, not an oversight.
--   * no tenant-visible table holds a provider reference. capability_request and
--     reservation record WHAT was asked and WHAT it cost in credits; the provider,
--     the latency and the true vendor cost live only in provider_attempt.
--   * true cost is stored in micros of the platform's own accounting unit, on the
--     internal side only. Credits are the tenant-facing unit and the two never meet
--     in one row.
--
-- Credits are NUMERIC, never float: a fraction of a credit that rounds differently
-- on two machines turns a balance into an argument.
--
-- Idempotent + re-runnable; rollback in ../down/001_init_data_credits.down.sql.

CREATE SCHEMA IF NOT EXISTS data_credits;

DO $$ BEGIN
  /*
   * The four settlement cases, and the reason this is an enum rather than a
   * boolean: only MATCHED costs anything. A no-match, a provider failure and a
   * cache hit are all free to the tenant, but they are NOT the same event — one is
   * a fact about the world, one is a fact about a vendor, one is a fact about our
   * own cache — and a report that cannot tell them apart cannot tell a bad provider
   * from a bad question.
   */
  CREATE TYPE data_credits.settlement_outcome AS ENUM (
    'MATCHED',
    'NO_MATCH',
    'TECHNICAL_FAILURE',
    'CACHE_HIT'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE data_credits.request_status AS ENUM (
    'PENDING_APPROVAL',
    'APPROVED',
    'REJECTED',
    'EXECUTING',
    'COMPLETED',
    'FAILED'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  /*
   * Health is the broker's own observation, not the vendor's status page. DEGRADED
   * exists so a provider that is slow-but-working can be demoted below a healthy
   * alternative without being taken out of the chain entirely.
   */
  CREATE TYPE data_credits.provider_health AS ENUM (
    'HEALTHY',
    'DEGRADED',
    'UNAVAILABLE'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE data_credits.budget_mode AS ENUM (
    'REQUEST_ONLY',
    'DAILY_CAP',
    'FULL'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  /*
   * Every reason a balance moves. RESERVATION and RELEASE move only the reserved
   * column; CHARGE and REFUND move the balance. Keeping them separate is what lets
   * an export show "you were quoted 5, you were charged 0, here is the release"
   * instead of a single net number that hides the quote.
   */
  CREATE TYPE data_credits.ledger_entry_type AS ENUM (
    'GRANT',
    'RESERVATION',
    'CHARGE',
    'REFUND',
    'RELEASE',
    'ADJUSTMENT'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE OR REPLACE FUNCTION data_credits.touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================== capability
/*
 * The catalog, in the tenant's language: an outcome, a label, a price.
 *
 * `key` is OUTCOME-NAMED by constraint — verb.noun, lowercase — because the naming
 * is the abstraction. "validate.phone" survives changing vendor three times;
 * "twilio-lookup" is a vendor name wearing a capability's clothes, and the day it
 * is retired every tenant integration breaks with it.
 *
 * tenant_id NULL is the PLATFORM default row; a row with a tenant_id overrides it
 * for that tenant (a negotiated price). The unique index is total rather than
 * partial: NULLs are distinct in a unique index, so a partial index would silently
 * allow two platform rows for the same key, and the resolver would pick whichever
 * the planner returned first.
 */
CREATE TABLE IF NOT EXISTS data_credits.capability (
  capability_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID,
  key           TEXT NOT NULL
    CONSTRAINT capability_key_is_outcome_named
      CHECK (key ~ '^[a-z][a-z0-9]*(\.[a-z0-9][a-z0-9-]*)+$'),
  outcome_label TEXT NOT NULL CHECK (length(btrim(outcome_label)) > 0),
  description   TEXT,
  -- What the tenant pays. The vendor's price is NOT here and never will be.
  credit_price  NUMERIC(12,4) NOT NULL CHECK (credit_price >= 0),
  category      TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS capability_scope_key_idx
  ON data_credits.capability
     (COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), key);
CREATE INDEX IF NOT EXISTS capability_category_idx
  ON data_credits.capability (category) WHERE is_active;

DROP TRIGGER IF EXISTS capability_touch_trg ON data_credits.capability;
CREATE TRIGGER capability_touch_trg
  BEFORE UPDATE ON data_credits.capability
  FOR EACH ROW EXECUTE FUNCTION data_credits.touch_updated_at();

-- ======================================================== provider_binding
/*
 * INTERNAL. Deliberately has NO tenant_id — see the header. This is the table the
 * whole vendor-opacity promise rests on, so the absence is a feature and adding one
 * "for convenience" would quietly dissolve the boundary.
 *
 * Credentials are NEVER stored here. `secret_ref` is a pointer into sdk-secrets and
 * a CHECK enforces the scheme, so a raw key pasted into this column fails at write
 * time rather than sitting in a table nobody re-reads.
 *
 * The fallback chain is `priority` ascending, filtered by health. Modelling it as
 * an explicit linked chain (next_binding_id) was rejected: a chain has to be
 * re-linked whenever a provider is added or retired, and a half-relinked chain
 * fails by SKIPPING a provider silently, which is exactly the failure the fallback
 * exists to prevent.
 */
CREATE TABLE IF NOT EXISTS data_credits.provider_binding (
  binding_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  capability_id UUID NOT NULL
    REFERENCES data_credits.capability (capability_id) ON DELETE CASCADE,
  provider_key  TEXT NOT NULL CHECK (length(btrim(provider_key)) > 0),
  secret_ref    TEXT NOT NULL
    CONSTRAINT provider_binding_secret_is_a_reference
      CHECK (secret_ref ~ '^secret://'),
  -- Ascending: 1 is tried first. Ties are broken by health then by binding_id, so
  -- the order is total and a retry lands somewhere deterministic.
  priority      INTEGER NOT NULL DEFAULT 100 CHECK (priority > 0),
  health_state  data_credits.provider_health NOT NULL DEFAULT 'HEALTHY',
  health_checked_at TIMESTAMPTZ,
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  -- The REAL cost, in micros of the platform accounting unit. Internal-only: this
  -- is the number that must never appear in a tenant response.
  true_cost_micros BIGINT NOT NULL DEFAULT 0 CHECK (true_cost_micros >= 0),
  is_active     BOOLEAN NOT NULL DEFAULT true,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One binding per provider per capability. Two would make "which credentials" a
-- coin toss at the moment of a call.
CREATE UNIQUE INDEX IF NOT EXISTS provider_binding_capability_provider_idx
  ON data_credits.provider_binding (capability_id, provider_key);
CREATE INDEX IF NOT EXISTS provider_binding_chain_idx
  ON data_credits.provider_binding (capability_id, priority ASC) WHERE is_active;

DROP TRIGGER IF EXISTS provider_binding_touch_trg ON data_credits.provider_binding;
CREATE TRIGGER provider_binding_touch_trg
  BEFORE UPDATE ON data_credits.provider_binding
  FOR EACH ROW EXECUTE FUNCTION data_credits.touch_updated_at();

-- ========================================================== credit_account
/*
 * balance is what the tenant has; reserved is the part of it already promised to
 * in-flight requests. Available is balance - reserved, and it is NOT stored — a
 * third column would be a second source of truth for a number that is a subtraction.
 *
 * reserved <= balance is a CHECK rather than service logic. Overcommitting is the
 * failure that only shows up under concurrency, weeks later, as a balance that went
 * negative with no single request to blame.
 */
CREATE TABLE IF NOT EXISTS data_credits.credit_account (
  account_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  balance     NUMERIC(14,4) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  reserved    NUMERIC(14,4) NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  is_active   BOOLEAN NOT NULL DEFAULT true,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT credit_account_reserved_within_balance CHECK (reserved <= balance)
);

CREATE UNIQUE INDEX IF NOT EXISTS credit_account_tenant_idx
  ON data_credits.credit_account (tenant_id);

DROP TRIGGER IF EXISTS credit_account_touch_trg ON data_credits.credit_account;
CREATE TRIGGER credit_account_touch_trg
  BEFORE UPDATE ON data_credits.credit_account
  FOR EACH ROW EXECUTE FUNCTION data_credits.touch_updated_at();

-- ====================================================== capability_request
/*
 * One tenant asking for one outcome about one subject.
 *
 * The subject is a FINGERPRINT, not the phone number or the email. The broker does
 * not need the raw value to bill, cache or audit, and a table of everything every
 * tenant ever looked up is a breach waiting for an excuse. The raw subject is the
 * caller's to hold.
 *
 * No provider column, on purpose — see the header.
 */
CREATE TABLE IF NOT EXISTS data_credits.capability_request (
  request_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL,
  capability_id UUID NOT NULL REFERENCES data_credits.capability (capability_id),
  -- Who asked, and under which role the budget policy is evaluated. Loose refs:
  -- personas live in sdk-persona and this package must not depend on it.
  requested_by_persona_id UUID,
  role_ref      TEXT,
  subject_fingerprint TEXT NOT NULL CHECK (length(btrim(subject_fingerprint)) > 0),
  status        data_credits.request_status NOT NULL DEFAULT 'PENDING_APPROVAL',
  outcome       data_credits.settlement_outcome,
  -- The answer as the tenant sees it. NULL until execution resolves.
  result        JSONB,
  served_from_cache BOOLEAN NOT NULL DEFAULT false,
  -- The sdk-approval decision this request waited on, when its role required one.
  approval_ref  TEXT,
  approved_at   TIMESTAMPTZ,
  executed_at   TIMESTAMPTZ,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  /*
   * A finished request has an outcome and a time; an unfinished one has neither.
   * Half-finished rows are how a report ends up counting the same request as both
   * pending and complete.
   */
  CONSTRAINT capability_request_completed_shape CHECK (
    (status <> 'COMPLETED') OR (outcome IS NOT NULL AND executed_at IS NOT NULL)
  ),
  CONSTRAINT capability_request_cache_outcome CHECK (
    served_from_cache = false OR outcome = 'CACHE_HIT'
  )
);

CREATE INDEX IF NOT EXISTS capability_request_tenant_created_idx
  ON data_credits.capability_request (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS capability_request_subject_idx
  ON data_credits.capability_request (tenant_id, capability_id, subject_fingerprint);
CREATE INDEX IF NOT EXISTS capability_request_pending_idx
  ON data_credits.capability_request (tenant_id, status)
  WHERE status IN ('PENDING_APPROVAL', 'APPROVED', 'EXECUTING');

DROP TRIGGER IF EXISTS capability_request_touch_trg ON data_credits.capability_request;
CREATE TRIGGER capability_request_touch_trg
  BEFORE UPDATE ON data_credits.capability_request
  FOR EACH ROW EXECUTE FUNCTION data_credits.touch_updated_at();

-- ============================================================= reservation
/*
 * The hold placed before anything is executed, and how it ended.
 *
 * Two invariants are enforced here rather than in the service, because both are
 * promises to the tenant and a promise kept only by the current version of one
 * function is not kept at all:
 *
 *   1. NO_MATCH, TECHNICAL_FAILURE and CACHE_HIT settle to EXACTLY zero. A vendor
 *      that found nothing, a vendor that fell over, and an answer we already had
 *      are all free. Any code path that tries to charge for one of them fails at
 *      the write.
 *   2. settled_credits <= estimated_credits. The quote is a ceiling. Charging more
 *      than was reserved is how a "5 credit" lookup becomes a support ticket.
 */
CREATE TABLE IF NOT EXISTS data_credits.reservation (
  reservation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  request_id     UUID NOT NULL
    REFERENCES data_credits.capability_request (request_id) ON DELETE CASCADE,
  estimated_credits NUMERIC(12,4) NOT NULL CHECK (estimated_credits >= 0),
  reserved_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_credits NUMERIC(12,4) CHECK (settled_credits >= 0),
  settled_at     TIMESTAMPTZ,
  outcome        data_credits.settlement_outcome,
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Settled means all three together, or none of them. A row with an outcome but no
  -- charge is unreadable: nobody can tell a free settlement from an unfinished one.
  CONSTRAINT reservation_settlement_shape CHECK (
    (settled_at IS NULL AND outcome IS NULL AND settled_credits IS NULL)
    OR (settled_at IS NOT NULL AND outcome IS NOT NULL AND settled_credits IS NOT NULL)
  ),
  CONSTRAINT reservation_zero_settlement_outcomes CHECK (
    outcome IS NULL
    OR outcome = 'MATCHED'
    OR settled_credits = 0
  ),
  CONSTRAINT reservation_never_exceeds_quote CHECK (
    settled_credits IS NULL OR settled_credits <= estimated_credits
  )
);

-- One reservation per request: a second hold on the same request would double-count
-- against the balance and neither would be wrong on its own.
CREATE UNIQUE INDEX IF NOT EXISTS reservation_request_idx
  ON data_credits.reservation (request_id);
CREATE INDEX IF NOT EXISTS reservation_open_idx
  ON data_credits.reservation (tenant_id, reserved_at) WHERE settled_at IS NULL;

DROP TRIGGER IF EXISTS reservation_touch_trg ON data_credits.reservation;
CREATE TRIGGER reservation_touch_trg
  BEFORE UPDATE ON data_credits.reservation
  FOR EACH ROW EXECUTE FUNCTION data_credits.touch_updated_at();

/*
 * Settle once. A retry that repeats the SAME settlement is allowed through
 * unchanged — that is what makes the service's settle idempotent under an at-least-
 * once caller — while a retry that asserts a DIFFERENT outcome or a different charge
 * is refused. Silently accepting the second one would mean the last retry to arrive
 * decides what the tenant paid.
 */
CREATE OR REPLACE FUNCTION data_credits.reject_resettlement()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.settled_at IS NULL THEN
    RETURN NEW;
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

DROP TRIGGER IF EXISTS reservation_settle_once_trg ON data_credits.reservation;
CREATE TRIGGER reservation_settle_once_trg
  BEFORE UPDATE ON data_credits.reservation
  FOR EACH ROW EXECUTE FUNCTION data_credits.reject_resettlement();

-- ============================================================ result_cache
/*
 * An answer already paid for. A hit inside the TTL is served free and increments
 * reuse_count, which is the number that tells a tenant what the cache saved them.
 *
 * expires_at is DERIVED by trigger from fetched_at + ttl_seconds rather than being
 * a generated column: timestamptz + interval is STABLE, not IMMUTABLE, so Postgres
 * refuses it in a GENERATED expression. Deriving it in one trigger keeps the two
 * from ever disagreeing, which is what would happen if each writer computed it.
 */
CREATE TABLE IF NOT EXISTS data_credits.result_cache (
  cache_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL,
  capability_id UUID NOT NULL
    REFERENCES data_credits.capability (capability_id) ON DELETE CASCADE,
  subject_fingerprint TEXT NOT NULL CHECK (length(btrim(subject_fingerprint)) > 0),
  result        JSONB NOT NULL,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ttl_seconds   INTEGER NOT NULL CHECK (ttl_seconds > 0),
  expires_at    TIMESTAMPTZ NOT NULL,
  reuse_count   INTEGER NOT NULL DEFAULT 0 CHECK (reuse_count >= 0),
  last_reused_at TIMESTAMPTZ,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Cache entries are per TENANT as well as per capability and subject: a result one
-- tenant paid for is not another tenant's to reuse, whatever the fingerprint says.
CREATE UNIQUE INDEX IF NOT EXISTS result_cache_subject_idx
  ON data_credits.result_cache (tenant_id, capability_id, subject_fingerprint);
CREATE INDEX IF NOT EXISTS result_cache_expiry_idx
  ON data_credits.result_cache (expires_at);

CREATE OR REPLACE FUNCTION data_credits.derive_cache_expiry()
RETURNS TRIGGER AS $$
BEGIN
  NEW.expires_at := NEW.fetched_at + make_interval(secs => NEW.ttl_seconds);
  IF TG_OP = 'UPDATE' THEN
    NEW.updated_at := now();
    -- A reuse counter that can go DOWN is not a counter. Under-reporting reuse
    -- under-reports what the cache saved, which is the one thing it is for.
    IF NEW.reuse_count < OLD.reuse_count THEN
      RAISE EXCEPTION 'result_cache % reuse_count cannot decrease (% -> %)',
        OLD.cache_id, OLD.reuse_count, NEW.reuse_count
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS result_cache_expiry_trg ON data_credits.result_cache;
CREATE TRIGGER result_cache_expiry_trg
  BEFORE INSERT OR UPDATE ON data_credits.result_cache
  FOR EACH ROW EXECUTE FUNCTION data_credits.derive_cache_expiry();

-- =========================================================== budget_policy
/*
 * Who may spend, how much, and who has to ask first.
 *
 * DAILY_CAP with no cap is refused by CHECK. An unenforceable policy that reads as
 * a limit is worse than no policy: the dashboard says "capped" and the spend says
 * otherwise.
 *
 * bulk_approval_threshold applies REGARDLESS of mode, including FULL — the point of
 * a bulk threshold is that a single enormous request is a different decision from
 * the thousand small ones the role was trusted with.
 */
CREATE TABLE IF NOT EXISTS data_credits.budget_policy (
  policy_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  role_ref    TEXT NOT NULL CHECK (length(btrim(role_ref)) > 0),
  mode        data_credits.budget_mode NOT NULL DEFAULT 'REQUEST_ONLY',
  daily_cap   NUMERIC(12,4) CHECK (daily_cap IS NULL OR daily_cap >= 0),
  bulk_approval_threshold NUMERIC(12,4)
    CHECK (bulk_approval_threshold IS NULL OR bulk_approval_threshold >= 0),
  is_active   BOOLEAN NOT NULL DEFAULT true,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT budget_policy_daily_cap_present CHECK (
    mode <> 'DAILY_CAP' OR daily_cap IS NOT NULL
  )
);

-- One policy per role. TOTAL rather than partial-on-is_active so the PUT upsert can
-- infer this index without repeating a predicate — a partial unique index makes
-- ON CONFLICT fail at runtime with "no unique or exclusion constraint matching".
CREATE UNIQUE INDEX IF NOT EXISTS budget_policy_tenant_role_idx
  ON data_credits.budget_policy (tenant_id, role_ref);

DROP TRIGGER IF EXISTS budget_policy_touch_trg ON data_credits.budget_policy;
CREATE TRIGGER budget_policy_touch_trg
  BEFORE UPDATE ON data_credits.budget_policy
  FOR EACH ROW EXECUTE FUNCTION data_credits.touch_updated_at();

-- ============================================================ credit_ledger
/*
 * Every credit movement, append-only and exportable.
 *
 * Two deltas rather than one signed amount: a RESERVATION moves `reserved` without
 * touching `balance`, and a CHARGE moves both. Collapsing them into a single number
 * would make the export unable to show what the tenant was quoted before they were
 * charged — which is the exact question a disputed invoice asks.
 *
 * balance_after / reserved_after are the account as it stood immediately after this
 * entry. Storing them makes the ledger independently readable: replaying deltas to
 * find a discrepancy assumes no entry is missing, which is what you are trying to
 * check.
 *
 * request_id and reservation_id are LOOSE references with no foreign key, which is
 * deliberate and was arrived at the hard way. A FK with ON DELETE SET NULL makes the
 * database issue an UPDATE against this table when a request is removed — and that
 * UPDATE is refused by the append-only trigger below, so deleting a request became
 * impossible the moment it was billed. ON DELETE RESTRICT has the same effect, more
 * loudly. The right answer is that a financial record must OUTLIVE the operational
 * row it describes: a request may be purged for privacy or retention and the entry
 * that says what the tenant paid stays exactly as it was written.
 */
CREATE TABLE IF NOT EXISTS data_credits.credit_ledger (
  ledger_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- A total order for export. BIGSERIAL rather than a timestamp: two entries in the
  -- same millisecond are ordinary, and an export that reorders them is not a ledger.
  entry_no    BIGSERIAL NOT NULL,
  tenant_id   UUID NOT NULL,
  entry_type  data_credits.ledger_entry_type NOT NULL,
  request_id  UUID,
  reservation_id UUID,
  balance_delta  NUMERIC(14,4) NOT NULL DEFAULT 0,
  reserved_delta NUMERIC(14,4) NOT NULL DEFAULT 0,
  balance_after  NUMERIC(14,4) NOT NULL CHECK (balance_after >= 0),
  reserved_after NUMERIC(14,4) NOT NULL CHECK (reserved_after >= 0),
  -- Why, in one line, for the human reading the export.
  reason      TEXT,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- An entry that moves nothing is noise in an audit trail; if it happened, some
  -- delta is non-zero.
  CONSTRAINT credit_ledger_moves_something CHECK (
    balance_delta <> 0 OR reserved_delta <> 0
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_entry_no_idx
  ON data_credits.credit_ledger (entry_no);
CREATE INDEX IF NOT EXISTS credit_ledger_tenant_idx
  ON data_credits.credit_ledger (tenant_id, entry_no DESC);
CREATE INDEX IF NOT EXISTS credit_ledger_request_idx
  ON data_credits.credit_ledger (request_id) WHERE request_id IS NOT NULL;

/*
 * Append-only, enforced. Not "we never call update" — a ledger whose immutability
 * lives in a convention is a ledger somebody will correct by hand at 2am with the
 * best of intentions. Corrections are new ADJUSTMENT entries.
 */
CREATE OR REPLACE FUNCTION data_credits.reject_ledger_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'credit_ledger is append-only — entry % cannot be %; post a correcting ADJUSTMENT entry instead',
    COALESCE(OLD.ledger_id, NEW.ledger_id),
    CASE TG_OP WHEN 'DELETE' THEN 'deleted' ELSE 'updated' END
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS credit_ledger_append_only_trg ON data_credits.credit_ledger;
CREATE TRIGGER credit_ledger_append_only_trg
  BEFORE UPDATE OR DELETE ON data_credits.credit_ledger
  FOR EACH ROW EXECUTE FUNCTION data_credits.reject_ledger_mutation();

-- ========================================================= provider_attempt
/*
 * INTERNAL. Which binding was tried for a request, in what order, how it went and
 * what it really cost. Also has NO tenant_id, for the same reason as
 * provider_binding.
 *
 * This exists so the fallback chain is DEBUGGABLE without being VISIBLE. Without
 * it, "the third provider answered after two timeouts" would have to be recorded on
 * the request itself, where it would be one careless `SELECT *` away from the
 * tenant — and the true vendor cost would have nowhere to live at all.
 */
CREATE TABLE IF NOT EXISTS data_credits.provider_attempt (
  attempt_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id  UUID NOT NULL
    REFERENCES data_credits.capability_request (request_id) ON DELETE CASCADE,
  binding_id  UUID NOT NULL
    REFERENCES data_credits.provider_binding (binding_id) ON DELETE CASCADE,
  attempt_no  INTEGER NOT NULL CHECK (attempt_no > 0),
  outcome     data_credits.settlement_outcome NOT NULL,
  latency_ms  INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  true_cost_micros BIGINT NOT NULL DEFAULT 0 CHECK (true_cost_micros >= 0),
  error_code  TEXT,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS provider_attempt_order_idx
  ON data_credits.provider_attempt (request_id, attempt_no);
CREATE INDEX IF NOT EXISTS provider_attempt_binding_idx
  ON data_credits.provider_attempt (binding_id, attempted_at DESC);

/*
 * The opacity boundary, stated once in the catalog so it is checkable rather than
 * remembered. A contract test reads these comments' subject tables and asserts no
 * tenant-scoped query path touches them; the absence of tenant_id is what makes
 * that assertion mechanical.
 */
COMMENT ON TABLE data_credits.provider_binding IS
  'INTERNAL — vendor identity, credentials reference, health and true cost. No tenant_id by design: never reachable from a tenant-scoped query path.';
COMMENT ON TABLE data_credits.provider_attempt IS
  'INTERNAL — per-attempt fallback trace and true vendor cost. No tenant_id by design: never reachable from a tenant-scoped query path.';
