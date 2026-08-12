-- Migration 003 (P10/E6): tenant-scope the EMPI review surface.
-- Auto-applied by @projexlight/migration-runner on api-gateway startup.
--
-- THE GAP
-- -------
-- empi.candidate_link and empi.merge_event carried no tenant column, while
-- GET /api/empi/candidate-links and /api/empi/metrics are tenant-facing reads.
-- Any authenticated tenant therefore saw every tenant's candidate links —
-- person ids paired with the field-level provenance explaining why they were
-- thought to be the same human — and platform-wide merge counts. EMPI was the
-- outlier: sdk-approval, sdk-billing, sdk-media, sdk-notification, sdk-payment,
-- sdk-search, sdk-webhook and sdk-workflow all carry tenant_id + the OC-8 RLS
-- policy already.
--
-- WHY THE COLUMN MEANS SOMETHING DIFFERENT ON EACH TABLE
-- -----------------------------------------------------
-- candidate_link.tenant_id is OWNERSHIP. A candidate link is produced by one
-- tenant's matching run over its own population, and only that tenant's stewards
-- should see or adjudicate it. If the same two people are also members of another
-- tenant, that tenant gets its OWN link and adjudicates independently — which is
-- correct, because consent, purpose and retention differ per tenant.
--
-- merge_event.tenant_id is ATTRIBUTION, NOT ISOLATION, and this must not be
-- misread. A merge acts on identity.person, which is L1 and deliberately global:
-- persons are shared across tenants by design (person -> app_identity ->
-- membership(tenant) -> persona). So a merge decided by tenant A changes a person
-- that tenant B may also see. The column records WHO DECIDED so the act is
-- attributable and reversible; it does NOT make the effect tenant-local, and no
-- amount of filtering here would. Whether one tenant may merge persons visible to
-- another is a product decision that this migration deliberately does not make.
--
-- NO BACKFILL — the tenant of an existing row cannot be inferred.
-- A candidate link is a probabilistic assertion about two people; guessing which
-- tenant raised it from the persons' memberships would be wrong precisely when
-- the people are multi-tenant, which is the case the column exists for. Legacy
-- rows keep tenant_id NULL and the tenant-scoped reads below EXCLUDE NULL rather
-- than treating it as a wildcard, so unattributable history fails closed: it stays
-- readable to platform/ops queries and invisible to tenants.
ALTER TABLE empi.candidate_link ADD COLUMN IF NOT EXISTS tenant_id UUID;
ALTER TABLE empi.merge_event    ADD COLUMN IF NOT EXISTS tenant_id UUID;

-- The review queue reads (tenant, status, confidence); the metrics read (tenant).
CREATE INDEX IF NOT EXISTS candidate_link_tenant_idx
  ON empi.candidate_link (tenant_id, status, confidence DESC);
CREATE INDEX IF NOT EXISTS merge_event_tenant_idx
  ON empi.merge_event (tenant_id, kind, created_at DESC);

COMMENT ON COLUMN empi.candidate_link.tenant_id IS
  'Owning tenant: whose matching run raised this link and whose stewards may adjudicate it. NULL = pre-migration row, excluded from tenant-scoped reads.';
COMMENT ON COLUMN empi.merge_event.tenant_id IS
  'Deciding tenant (attribution). NOT isolation: a merge acts on the global L1 person and is visible to every tenant that shares it.';
