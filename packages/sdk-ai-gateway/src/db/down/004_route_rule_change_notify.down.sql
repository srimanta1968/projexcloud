-- Rollback for 004_route_rule_change_notify.sql. NOT auto-applied.
DROP TRIGGER IF EXISTS route_rule_change_notify ON ai_gateway.route_rule;
DROP FUNCTION IF EXISTS ai_gateway.notify_route_rule_change();
