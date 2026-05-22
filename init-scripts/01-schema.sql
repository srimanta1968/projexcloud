-- Initial DB bootstrap. Application tables are created by the SDK migrator
-- on server startup (see server/src/db/migrator.ts).
-- This script intentionally only ensures required extensions and the
-- schema-version tracker exist. Per-SDK tables live in migrations.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS _schema_version (
    id SERIAL PRIMARY KEY,
    schema_hash VARCHAR(64) NOT NULL,
    version INTEGER DEFAULT 1,
    applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    source VARCHAR(50) DEFAULT 'init'
);
