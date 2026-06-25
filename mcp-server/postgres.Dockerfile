# ProjexLight dev Postgres — STABLE PostGIS 3.6 on PostgreSQL 18, + pgvector.
#
# Replaces postgis/postgis:18-master (a nightly/dev build that segfaulted under
# parallel test load). Same PG major (18), so the existing data directory is
# reused as-is — no re-migrate. pgvector is baked in so it survives container
# recreates (the platform's SDK migrations CREATE EXTENSION vector + postgis).
FROM postgis/postgis:18-3.6
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-18-pgvector \
 && rm -rf /var/lib/apt/lists/*
