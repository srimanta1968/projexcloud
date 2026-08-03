-- Rollback for 003_routing_rules.sql (sdk-assignment). NOT auto-applied — forward-only.
DROP TABLE IF EXISTS assignment.routing_decision;
DROP TABLE IF EXISTS assignment.routing_rule_set;
DROP FUNCTION IF EXISTS assignment.reject_rule_set_edit();
