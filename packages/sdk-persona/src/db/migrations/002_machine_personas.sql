-- Migration 002: machine-kind personas for API keys (TK-4138).
-- Auto-applied by @projexlight/migration-runner. Forward-only, idempotent.
--
-- WHY THIS LIVES IN sdk-persona AND NOT sdk-api-keys
-- The constraint it ends with is on api_keys.key, so sdk-api-keys looks like the
-- natural home. It is not: services/api-gateway/src/app.ts registers
-- { sdk: 'sdk-api-keys' } BEFORE { sdk: 'sdk-persona' } in runMigrations, so on a
-- FRESH database an sdk-api-keys migration referencing persona.persona would run
-- before that table exists and abort the boot. Running here — after both 001s —
-- is the only ordering in which the reference resolves.
--
-- WHAT WAS WRONG
-- apiKeyService.issueKey did `crypto.randomUUID()` and wrote the result to
-- api_keys.key.synthetic_persona_id without ever inserting a persona row.
-- P2-Identity-Access-DataModel declares `API_KEY }o--|| PERSONA : "synthetic"`
-- with synthetic_persona_id as an FK, but the schema never implemented it, so the
-- write always succeeded and the key looked healthy. persona.role_assignment
-- DOES carry an FK, so POST /api/role-assignments failed 23503 for every key ever
-- issued. Measured on local dev before this migration: 673 keys, 0 with a persona.
--
-- THE SHAPE (P3: "Persona (L4) — typed by kind. Multiple personas allowed per
-- membership.") ONE machine person + app_identity + membership per (tenant, app),
-- and ONE PERSONA PER KEY hanging off that shared membership. Per-key personas
-- keep audit and ReBAC able to tell one key from another; the L1-L3 rows stay
-- shared, so it costs three rows per tenant+app rather than three per key.
--
-- membership_id stays NOT NULL. A nullable machine membership would put a NULL
-- mid-chain and force a null branch into the identity projector and every
-- resolveIdentityContext() caller — a conditional on the hottest path in the
-- system, on every authenticated request.

-- The machine person is DERIVED, not random: md5 over (tenant, app) gives the same
-- uuid every time, so re-running this migration or minting a key later converges on
-- one machine identity per tenant+app instead of accumulating duplicates.
CREATE OR REPLACE FUNCTION persona.machine_person_id(p_tenant_id UUID, p_app_id TEXT)
RETURNS UUID LANGUAGE sql IMMUTABLE AS $$
  SELECT md5('projexcloud:machine-person:' || p_tenant_id::text || ':' || p_app_id)::uuid;
$$;

-- Keys carry a NULLABLE application_id on purpose (sdk-command robot credentials
-- have no application), so the app_id lands on a sentinel for those. 640 of the
-- 673 rows measured locally took this path — it is the common case, not the edge.
CREATE OR REPLACE VIEW persona.machine_key_chain AS
  SELECT k.key_id,
         k.tenant_id,
         k.synthetic_persona_id,
         COALESCE(a.slug, '__machine__') AS app_id
    FROM api_keys.key k
    LEFT JOIN api_keys.application a ON a.application_id = k.application_id;

-- ---------------------------------------------------------------- L1: person
INSERT INTO identity.person (person_id, home_region, status, mdm_method)
SELECT DISTINCT persona.machine_person_id(c.tenant_id, c.app_id), 'us-east-1', 'active', 'registry'
  FROM persona.machine_key_chain c
ON CONFLICT (person_id) DO NOTHING;

-- ---------------------------------------------------------- L2: app_identity
INSERT INTO persona.app_identity (person_id, app_id, status)
SELECT DISTINCT persona.machine_person_id(c.tenant_id, c.app_id), c.app_id, 'active'
  FROM persona.machine_key_chain c
ON CONFLICT (person_id, app_id) DO NOTHING;

-- ----------------------------------------------------------- L3: membership
INSERT INTO persona.membership (app_identity_id, tenant_id, status)
SELECT DISTINCT ai.app_identity_id, c.tenant_id, 'active'
  FROM persona.machine_key_chain c
  JOIN persona.app_identity ai
    ON ai.person_id = persona.machine_person_id(c.tenant_id, c.app_id)
   AND ai.app_id = c.app_id
ON CONFLICT (app_identity_id, tenant_id) DO NOTHING;

-- ------------------------------------------------- L4: one persona PER KEY
-- persona_id is set to the key's EXISTING synthetic_persona_id rather than a fresh
-- uuid. That is what makes the backfill safe: not a single api_keys.key row is
-- rewritten, so there is no window where a key points at an id that is being
-- changed underneath it, and the FK below validates against rows that already match.
INSERT INTO persona.persona (persona_id, membership_id, kind, status)
SELECT c.synthetic_persona_id, m.membership_id, 'machine', 'active'
  FROM persona.machine_key_chain c
  JOIN persona.app_identity ai
    ON ai.person_id = persona.machine_person_id(c.tenant_id, c.app_id)
   AND ai.app_id = c.app_id
  JOIN persona.membership m
    ON m.app_identity_id = ai.app_identity_id
   AND m.tenant_id = c.tenant_id
ON CONFLICT (persona_id) DO NOTHING;

-- ------------------------------------------------------------- FAIL-FAST FK
-- ORDERING TRAP: this MUST come after the backfill above. Applied first it would
-- fail against the pre-existing rows, and skipping it is what let 673 keys drift
-- silently instead of the very first bad insert failing. With the FK in place the
-- broken state is unrepresentable.
--
-- ON DELETE RESTRICT, not CASCADE: deleting a persona must never silently take a
-- live credential with it. Revoke the key first.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'key_synthetic_persona_id_fkey'
       AND conrelid = 'api_keys.key'::regclass
  ) THEN
    ALTER TABLE api_keys.key
      ADD CONSTRAINT key_synthetic_persona_id_fkey
      FOREIGN KEY (synthetic_persona_id)
      REFERENCES persona.persona(persona_id) ON DELETE RESTRICT;
  END IF;
END $$;

-- Machine personas are excluded from DSAR/erasure scope by persona.kind. P3 defines
-- the DSAR workflow and establishes persona-kind as a filter dimension, but grants
-- NO exemption by kind — so without this index-backed marker an erasure request
-- would sweep up the personas machine auth depends on. The exclusion itself is
-- enforced in sdk-data-rights; this index is what makes it cheap to apply.
CREATE INDEX IF NOT EXISTS persona_machine_kind_idx
  ON persona.persona (kind) WHERE kind = 'machine';
