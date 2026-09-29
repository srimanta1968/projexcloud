-- Migration 004: sdk-ai-gateway · route-rule change events. VA·E5 (TK-4495).
--
-- The gateway caches each tenant's active route rules in process (hot path: a warm route
-- resolution makes no database query). Rules are edited directly in this table by the
-- tenant-admin portal, so the table itself announces changes: every insert, update or
-- delete sends pg_notify('ai_gateway_route_rule', <tenant_id>), and each gateway instance
-- LISTENs and drops that tenant's cached rules. A 60 s cache TTL bounds staleness if a
-- notification is ever missed (listener reconnecting).
--
-- Idempotent; down in ../down/.

CREATE OR REPLACE FUNCTION ai_gateway.notify_route_rule_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('ai_gateway_route_rule', COALESCE(NEW.tenant_id, OLD.tenant_id)::text);
  IF TG_OP = 'UPDATE' AND NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    PERFORM pg_notify('ai_gateway_route_rule', OLD.tenant_id::text);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS route_rule_change_notify ON ai_gateway.route_rule;
CREATE TRIGGER route_rule_change_notify
  AFTER INSERT OR UPDATE OR DELETE ON ai_gateway.route_rule
  FOR EACH ROW EXECUTE FUNCTION ai_gateway.notify_route_rule_change();
