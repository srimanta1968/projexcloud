-- Migration 002 (P10/E6): record WHEN a candidate link was settled.
-- Auto-applied by @projexlight/migration-runner on api-gateway startup.
--
-- WHY A NEW COLUMN RATHER THAN REUSING updated_at
-- -----------------------------------------------
-- Adjudication latency is created_at -> the decision that settles the case, and
-- updated_at cannot serve as that second point: it is also bumped by
-- enqueueStewardReview (which writes steward_request_id) and by unmergeRecords
-- (which returns a merged link to 'open'). Measuring against it would silently
-- mix "queued for review" and "reopened after an unmerge" into a number reported
-- as review time, and the error is invisible in the output — the metric would
-- look plausible and be wrong.
--
-- decided_at is written once, by the transition that resolves the case, and is
-- cleared again if an unmerge reopens the link so a reopened case is not counted
-- as settled twice.
ALTER TABLE empi.candidate_link
  ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ;

-- DELIBERATELY NO BACKFILL.
--
-- Stamping decided_at = updated_at for already-settled links looks like free
-- history and is not: for those rows updated_at records whatever touched them
-- last, which for fixture and imported data bears no relation to a steward
-- decision. Tried on a database with existing links, it produced a p90 review
-- time of 34 DAYS from a single legacy row — a number that is plausible enough
-- to be believed, wrong, and impossible to distinguish from a real backlog once
-- it is in the aggregate.
--
-- The consumer asking for this metric explicitly refused a derivable-but-wrong
-- substitute (median age of open cases) for the same reason; importing one here
-- through the back door would defeat that. So the series starts empty and fills
-- from real adjudications: getReviewLatency returns null medians until something
-- is genuinely decided, and callers render "not measured".

-- Serves the latency aggregate: bounded-window scans over settled links only.
CREATE INDEX IF NOT EXISTS candidate_link_decided_idx
  ON empi.candidate_link (decided_at DESC)
  WHERE decided_at IS NOT NULL;

COMMENT ON COLUMN empi.candidate_link.decided_at IS
  'When adjudication settled this link (merged/rejected). NULL while open. Cleared by an unmerge that reopens the link. Source for review-latency metrics.';
