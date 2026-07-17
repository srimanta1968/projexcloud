-- Down for 003_guards. Drops the guard engine tables. (Forward-only runner;
-- for manual rollback / local resets.)

DROP TABLE IF EXISTS sequence.guard_log;
DROP TABLE IF EXISTS sequence.circuit_breaker;
DROP TABLE IF EXISTS sequence.guard_config;
