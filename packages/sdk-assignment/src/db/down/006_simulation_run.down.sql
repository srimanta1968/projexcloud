-- Rollback for 006. Drops the recorded-simulation table and its immutability trigger.
--
-- The table is dropped WITH its evidence: nothing else references simulation_id by FK,
-- so a rollback that kept the rows would leave un-citable orphans behind a schema that
-- no longer knows how to read them.

DROP TRIGGER IF EXISTS simulation_run_immutable_trg ON assignment.simulation_run;
DROP FUNCTION IF EXISTS assignment.reject_simulation_run_edit();
DROP TABLE IF EXISTS assignment.simulation_run;
