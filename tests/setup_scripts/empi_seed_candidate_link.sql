-- Seeds the EMPI steward-review fixture: an open candidate link to adjudicate,
-- two already-settled links so the review-latency and per-band precision
-- aggregates have real samples, and the sdk-approval route that gates a steward
-- decision.
--
-- WHY THIS EXISTS
-- ---------------
-- Candidate links are only ever raised inside the probabilistic matcher
-- (empiService.matchAndLink). There is no HTTP write path that creates one, so a
-- fresh database has an empty queue and GET /api/empi/candidate-links returns []
-- in every environment. A consumer building a steward-review screen therefore
-- cannot open it at all — not to test, not to demo — and the reasonable but wrong
-- conclusion is that the endpoint is broken.
--
-- Idempotent on fixed ids, so re-running is a no-op (matching the other seeds in
-- this directory). QA fixture data — see apply-qa-seeds.sh on why this must not
-- be applied to a customer-facing database.
--
-- Requires migrations 002_empi_review_latency.sql (decided_at) and
-- 003_empi_tenant_scope.sql (tenant_id). Rows are stamped with LeadFlow's tenant
-- because the tenant-scoped reads exclude NULL — an unstamped fixture would be
-- invisible to every caller and look like the seed had not run.

-- ── The reviewable case: open, high-confidence, populated provenance ────────
-- Confidence 0.93 puts it in the 'high' band, so it is returned by the query the
-- review queue actually makes: ?band=high&status=open.
INSERT INTO empi.candidate_link
  (link_id, tenant_id, person_id_a, person_id_b, confidence, match_type, provenance, status, created_at, updated_at)
SELECT '0e3b1a70-0000-4000-8000-00000000e001', 'e22662dc-7e65-472a-a6da-41d59163714a',
       '0e3b1a70-0000-4000-8000-00000000a001',
       '0e3b1a70-0000-4000-8000-00000000a002',
       0.9300, 'POSSIBLY_SAME',
       -- Field-level provenance in the shape scoreMatch() emits: per-field
       -- contribution, so an evidence table can render real weights rather than
       -- the sample data from a mockup.
       '{"email": 0.0, "phone": 0.34, "family_name": 0.28, "given_name": 0.19,
         "birth_date": 0.12, "postal_code": 0.0,
         "note": "QA fixture — same phone + name, differing email domain"}'::jsonb,
       'open', now() - interval '3 hours', now() - interval '3 hours'
WHERE NOT EXISTS (
  SELECT 1 FROM empi.candidate_link WHERE link_id = '0e3b1a70-0000-4000-8000-00000000e001'
);

-- Calibration sample for the open case. actual_match stays NULL — it is the
-- steward's adjudication that labels it, and pre-labelling would make the queue
-- look already-reviewed.
INSERT INTO empi.match_outcome (outcome_id, link_id, predicted_confidence)
SELECT '0e3b1a70-0000-4000-8000-00000000c001',
       '0e3b1a70-0000-4000-8000-00000000e001', 0.9300
WHERE NOT EXISTS (
  SELECT 1 FROM empi.match_outcome WHERE outcome_id = '0e3b1a70-0000-4000-8000-00000000c001'
);

-- ── Settled case 1: high-confidence, approved → merged in 12 minutes ────────
INSERT INTO empi.candidate_link
  (link_id, tenant_id, person_id_a, person_id_b, confidence, match_type, provenance, status,
   created_at, updated_at, decided_at)
SELECT '0e3b1a70-0000-4000-8000-00000000e002', 'e22662dc-7e65-472a-a6da-41d59163714a',
       '0e3b1a70-0000-4000-8000-00000000a003',
       '0e3b1a70-0000-4000-8000-00000000a004',
       0.9500, 'POSSIBLY_SAME',
       '{"email": 0.40, "phone": 0.31, "family_name": 0.24,
         "note": "QA fixture — confirmed same person"}'::jsonb,
       'merged',
       now() - interval '2 days',
       now() - interval '2 days' + interval '12 minutes',
       now() - interval '2 days' + interval '12 minutes'
WHERE NOT EXISTS (
  SELECT 1 FROM empi.candidate_link WHERE link_id = '0e3b1a70-0000-4000-8000-00000000e002'
);

INSERT INTO empi.match_outcome (outcome_id, link_id, predicted_confidence, actual_match)
SELECT '0e3b1a70-0000-4000-8000-00000000c002',
       '0e3b1a70-0000-4000-8000-00000000e002', 0.9500, TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM empi.match_outcome WHERE outcome_id = '0e3b1a70-0000-4000-8000-00000000c002'
);

-- The merge_event for that approval. Reversible by
-- POST /api/empi/merges/:merge_id/unmerge, which is what makes this row the
-- fixture for the link-retraction flow as well.
INSERT INTO empi.merge_event
  (merge_id, tenant_id, link_id, surviving_person_id, merged_person_id, kind, decided_by, reason, created_at)
SELECT '0e3b1a70-0000-4000-8000-00000000d001', 'e22662dc-7e65-472a-a6da-41d59163714a',
       '0e3b1a70-0000-4000-8000-00000000e002',
       '0e3b1a70-0000-4000-8000-00000000a003',
       '0e3b1a70-0000-4000-8000-00000000a004',
       'merge', 'qa-steward', 'QA fixture — steward confirmed same person',
       now() - interval '2 days' + interval '12 minutes'
WHERE NOT EXISTS (
  SELECT 1 FROM empi.merge_event WHERE merge_id = '0e3b1a70-0000-4000-8000-00000000d001'
);

-- ── Settled case 2: medium-confidence, rejected after 26 minutes ────────────
-- Kept separate rather than merged, so band_outcomes shows a genuine contrast:
-- high band precision 1.0, medium band 0.0. A fixture where every sample is a
-- true positive makes a precision metric look correct while proving nothing.
INSERT INTO empi.candidate_link
  (link_id, tenant_id, person_id_a, person_id_b, confidence, match_type, provenance, status,
   created_at, updated_at, decided_at)
SELECT '0e3b1a70-0000-4000-8000-00000000e003', 'e22662dc-7e65-472a-a6da-41d59163714a',
       '0e3b1a70-0000-4000-8000-00000000a005',
       '0e3b1a70-0000-4000-8000-00000000a006',
       0.7400, 'POSSIBLY_SAME',
       '{"family_name": 0.41, "postal_code": 0.33,
         "note": "QA fixture — same household, different people"}'::jsonb,
       'rejected',
       now() - interval '1 day',
       now() - interval '1 day' + interval '26 minutes',
       now() - interval '1 day' + interval '26 minutes'
WHERE NOT EXISTS (
  SELECT 1 FROM empi.candidate_link WHERE link_id = '0e3b1a70-0000-4000-8000-00000000e003'
);

INSERT INTO empi.match_outcome (outcome_id, link_id, predicted_confidence, actual_match)
SELECT '0e3b1a70-0000-4000-8000-00000000c003',
       '0e3b1a70-0000-4000-8000-00000000e003', 0.7400, FALSE
WHERE NOT EXISTS (
  SELECT 1 FROM empi.match_outcome WHERE outcome_id = '0e3b1a70-0000-4000-8000-00000000c003'
);

-- ── The steward approval route (PROJEXCLOUD_STEWARD_ROUTE_ID) ───────────────
-- adjudicateCandidate needs a step_id, which only enqueueStewardReview produces,
-- which needs an approval route. Without one, no steward decision can be recorded
-- at all.
--
-- THE APPROVER PERSONA IS THE CONSTRAINT WORTH KNOWING. approvalService.decide()
-- rejects a decision whose acting persona is not the step's approver
-- (NotYourStepError), and the acting persona is taken from the CALLER'S
-- credential (routes.ts personaOf → req.auth.primary_persona_id). So this route's
-- approver must be the persona the adjudicating caller actually presents.
--
-- A 'role'-kind step is the shape that would avoid pinning a specific persona,
-- but createStepsForIndex requires a resolveRoleTemplate callback that
-- empiService.enqueueStewardReview does not pass — so a role-kind route would
-- throw. m-of-n with m=1 is used instead: it behaves as a single approver today
-- and additional steward personas can be appended to the array without changing
-- the step kind.
--
-- To repoint at a different steward (e.g. after rotating the API key that backs
-- the machine persona):
--   UPDATE approval.route
--      SET steps = jsonb_set(steps, '{0,approvers}', '["<persona_id>"]'::jsonb)
--    WHERE route_id = '0e3b1a70-0000-4000-8000-00000000f001';
INSERT INTO approval.route
  (route_id, tenant_id, name, description, kind_pattern, steps, status)
SELECT '0e3b1a70-0000-4000-8000-00000000f001',
       'e22662dc-7e65-472a-a6da-41d59163714a',
       'EMPI steward review',
       'Gates a steward verdict on a POSSIBLY_SAME candidate link (subject_kind empi_candidate).',
       'empi_candidate',
       '[{"name": "Steward verdict", "kind": "m-of-n", "m": 1,
          "approvers": ["7c0eacba-065f-47a2-a135-5b2e22d41ec9"],
          "sla_minutes": 15}]'::jsonb,
       'active'
WHERE NOT EXISTS (
  SELECT 1 FROM approval.route WHERE route_id = '0e3b1a70-0000-4000-8000-00000000f001'
);
