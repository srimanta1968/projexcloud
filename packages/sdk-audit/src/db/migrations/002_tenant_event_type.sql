-- Migration 002: tenant-scoped extension of the event type registry (TK-4144).
--
-- EVENT_TYPE_REGISTRY in @projexlight/contracts is a compile-time constant and
-- the gateway exposed only read routes over it, so a consuming application had
-- no supported way to add its own audit event types: every append returned
-- 400 UnregisteredEventType, and because the emit path is non-throwing by
-- design that permanent rejection looked exactly like a transient blip. Apps
-- reported governed actions as recorded while their chain stayed empty.
--
-- This table holds the TENANT side of the vocabulary. Resolution reads the
-- platform baseline FIRST and this table second, so a tenant can never shadow
-- or redefine a platform type, and one tenant's registration is invisible to
-- every other tenant. OC-2 is untouched: a type in neither place is rejected.

CREATE SCHEMA IF NOT EXISTS audit;

CREATE TABLE IF NOT EXISTS audit.tenant_event_type (
  tenant_id         UUID NOT NULL,
  event_type        TEXT NOT NULL,
  retention_class   TEXT NOT NULL
                      CHECK (retention_class IN ('transient','operational','regulated')),
  conflict_policy   TEXT NOT NULL
                      CHECK (conflict_policy IN ('crdt','lww','merge','event-sourcing','human-review')),
  schema_state      TEXT NOT NULL DEFAULT 'active'
                      CHECK (schema_state IN ('active','deprecated','retired')),
  compaction_policy TEXT NOT NULL DEFAULT 'none'
                      CHECK (compaction_policy IN ('none','lww','count')),
  schema_version    INTEGER NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  registered_by     TEXT,
  registered_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, event_type)
);

-- No secondary index: the primary key is already (tenant_id, event_type), which
-- serves both the point lookup on the append path and the tenant-prefix scan
-- behind GET /api/events/types. A second index on the same columns would cost
-- a write on every registration and answer nothing new.

-- ADDITIVE-ONLY, enforced in the database rather than only in the service.
-- Mirrors the rule stated in events.ts ("never remove or mutate existing
-- rows"): registration CREATES a type, it never redefines one. Silently
-- changing a live type's retention_class would alter the regulatory meaning of
-- entries already written under it, and the ledger cannot be re-derived.
--
-- UPDATE is blocked; DELETE deliberately is NOT. A tenant that registers a
-- well-formed but wrong name would otherwise be stuck with it forever, and an
-- operator removing an unused row changes the meaning of nothing — whereas
-- mutating a row in place rewrites the past.
CREATE OR REPLACE FUNCTION audit.tenant_event_type_no_mutate()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit.tenant_event_type is additive-only; % is forbidden. Register a new version (.v%) instead of redefining an existing type.', TG_OP, OLD.schema_version + 1;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tenant_event_type_no_update ON audit.tenant_event_type;
CREATE TRIGGER tenant_event_type_no_update BEFORE UPDATE ON audit.tenant_event_type
  FOR EACH ROW EXECUTE FUNCTION audit.tenant_event_type_no_mutate();

COMMENT ON TABLE audit.tenant_event_type IS
  'Tenant-registered event types extending the platform EVENT_TYPE_REGISTRY baseline. Resolution is baseline-first, so a tenant row can never shadow a platform type. Additive-only: UPDATE is blocked by trigger.';
