-- Seeds a fixed pool of eligible personas in assignment.workload so
-- POST /api/assignment/assign-by-task has candidates to rotate through
-- (EP-335 round-robin strategy). assignment.workload.persona_id is a bare
-- UUID PRIMARY KEY (no FK, no tenant column — see 001_init_assignment.sql),
-- so these three fixed UUIDs are legitimately real seeded rows, not fake
-- FK references. There is no HTTP CRUD for workload, hence the setupScript.
--
-- open_tasks is reset to 0 every run so the capacity ceiling (capacity_per_day)
-- is never exhausted by prior runs; all three carry the 'plumbing' skill and a
-- NULL availability window (always available), so the skill + availability
-- gates pass and only the rotation cursor decides the winner.

INSERT INTO assignment.workload (persona_id, open_tasks, capacity_per_day, skills, available_from, available_to)
VALUES
  ('a1111111-1111-4111-8111-111111111111', 0, 1000, ARRAY['plumbing'], NULL, NULL),
  ('a2222222-2222-4222-8222-222222222222', 0, 1000, ARRAY['plumbing'], NULL, NULL),
  ('a3333333-3333-4333-8333-333333333333', 0, 1000, ARRAY['plumbing'], NULL, NULL)
ON CONFLICT (persona_id) DO UPDATE
  SET open_tasks = 0,
      capacity_per_day = 1000,
      skills = ARRAY['plumbing'],
      available_from = NULL,
      available_to = NULL;
