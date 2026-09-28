-- Rollback for 002_eval_run.sql (VA·E2, TK-4471). NOT auto-applied. Idempotent.
DROP TABLE IF EXISTS voice_agent.eval_run CASCADE;
