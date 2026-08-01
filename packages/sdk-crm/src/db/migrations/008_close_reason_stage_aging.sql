-- Migration 008: close-reason taxonomy and stage aging (P16 · EP-380 · PCF-07-3).
--
--   close_reason_type  — the tenant's OWN taxonomy, not ours
--   subject_close      — what actually happened, in the subject's words
--   stage_entry        — when a subject entered a stage, so aging is measurable
--
-- WHY THE TAXONOMY IS DATA. A hard-coded close-reason list is a claim that every
-- business loses deals the same way. It is also unfalsifiable: whatever the list says,
-- people pick the closest option and the report reads back exactly the categories that
-- were shipped. A tenant that sells to hospitals and one that sells to builders need
-- different words, and neither should wait on a release to add one.
--
-- WHY THE SUBJECT'S OWN WORDING IS A COLUMN. The code is for counting; the sentence is
-- for learning. "Price" as a code hides whether it was too expensive, badly structured,
-- or fine but not budgeted this quarter — three different problems with three different
-- fixes, all filed under one bar on a chart.
--
-- Idempotent + additive; rollback in ../down/008_close_reason_stage_aging.down.sql.

CREATE TABLE IF NOT EXISTS crm.close_reason_type (
  close_reason_type_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  code         TEXT NOT NULL CHECK (length(btrim(code)) > 0),
  label        TEXT NOT NULL CHECK (length(btrim(label)) > 0),
  -- Won, lost or neither: a "paused" close is not a loss, and counting it as one makes
  -- a pipeline look worse than it is.
  outcome_class TEXT NOT NULL DEFAULT 'lost'
    CHECK (outcome_class IN ('won', 'lost', 'disqualified', 'paused')),
  /*
   * Whether a subject closed for this reason may come back, and after how long.
   * "Lost on price this quarter" and "not a real buyer" are both losses and only one of
   * them is worth calling again; a taxonomy that cannot say which produces either a
   * do-not-call list that swallows winnable business, or a re-approach that annoys
   * people who already said never.
   */
  reactivation_allowed BOOLEAN NOT NULL DEFAULT true,
  reactivation_after_days INTEGER
    CHECK (reactivation_after_days IS NULL OR reactivation_after_days >= 0),
  requires_competitor  BOOLEAN NOT NULL DEFAULT false,
  requires_learning_note BOOLEAN NOT NULL DEFAULT false,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  sort_order   INTEGER NOT NULL DEFAULT 100,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT close_reason_reactivation_shape CHECK (
    reactivation_allowed OR reactivation_after_days IS NULL
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS close_reason_type_code_idx
  ON crm.close_reason_type (tenant_id, code);

CREATE TABLE IF NOT EXISTS crm.subject_close (
  close_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  subject_ref  TEXT NOT NULL,
  subject_kind TEXT,
  close_reason_type_id UUID NOT NULL
    REFERENCES crm.close_reason_type (close_reason_type_id),
  -- The words the subject actually used. See the header.
  subject_wording TEXT,
  -- Which offer or contract version was on the table when it closed. Without it,
  -- "we lose on price" cannot be traced to the price list that was quoted.
  offer_version   TEXT,
  contract_version TEXT,
  competitor      TEXT,
  learning_note   TEXT,
  stage_at_close  TEXT,
  closed_by       TEXT,
  closed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  reactivate_after TIMESTAMPTZ,
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS subject_close_subject_idx
  ON crm.subject_close (tenant_id, subject_ref, closed_at DESC);
CREATE INDEX IF NOT EXISTS subject_close_reason_idx
  ON crm.subject_close (tenant_id, close_reason_type_id, closed_at DESC);
-- Which closed subjects are eligible to be approached again, and when.
CREATE INDEX IF NOT EXISTS subject_close_reactivation_idx
  ON crm.subject_close (tenant_id, reactivate_after)
  WHERE reactivate_after IS NOT NULL;

/*
 * When a subject entered a stage. Aging cannot be computed without it: a stage column
 * on the subject says where it is, never how long it has been there, and "days in
 * stage" derived from updated_at resets every time somebody edits a phone number.
 */
CREATE TABLE IF NOT EXISTS crm.stage_entry (
  stage_entry_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  subject_ref  TEXT NOT NULL,
  subject_kind TEXT,
  stage        TEXT NOT NULL,
  owner_persona_id UUID,
  entered_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  exited_at    TIMESTAMPTZ,
  /*
   * The last time something MEANINGFUL happened — a call, a reply, a document — not the
   * last time a row was touched. Aging is about silence, and an edit is not contact.
   */
  last_activity_at TIMESTAMPTZ,
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT stage_entry_exit_after_entry CHECK (exited_at IS NULL OR exited_at >= entered_at)
);

CREATE INDEX IF NOT EXISTS stage_entry_subject_idx
  ON crm.stage_entry (tenant_id, subject_ref, entered_at DESC);
-- One OPEN stage per subject: being in two stages at once is not a state anybody can
-- report on.
CREATE UNIQUE INDEX IF NOT EXISTS stage_entry_open_idx
  ON crm.stage_entry (tenant_id, subject_ref)
  WHERE exited_at IS NULL;
CREATE INDEX IF NOT EXISTS stage_entry_aging_idx
  ON crm.stage_entry (tenant_id, stage, owner_persona_id)
  WHERE exited_at IS NULL;
