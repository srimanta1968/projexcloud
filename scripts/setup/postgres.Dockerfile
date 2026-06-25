# ProjexCloud Postgres — PostGIS + pgvector in one image.
#
# The platform needs BOTH extensions at migrate time:
#   - pgvector  → sdk-agent-runtime vector namespaces (004_pgvector_extension.sql)
#   - PostGIS   → sdk-geo (001_init_geo.sql)
# No official image bundles both, so we extend the PostGIS image (Debian, pgdg
# repo) and add the version-matched pgvector package. Used by the bundled dev and
# prod-selfhosted Compose stacks; managed Postgres (RDS / DO) enables these via
# their own extension mechanisms instead.
FROM postgis/postgis:16-3.5
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-16-pgvector \
 && rm -rf /var/lib/apt/lists/*
