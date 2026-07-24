-- Seeds a sanctioned cross-pool federation route so
-- GET /routes/:federation_id/:query_class resolves instead of 404 route_not_found.
--
-- resolveRoute (services/pool-federation-runtime/src/router.ts:98) reads
-- federation.route WHERE federation_id=$1 AND query_class=$2 and returns null
-- (-> 404) when absent. federation_id matches the test-config var 'fed-us-east-1';
-- query_class 'resolver' is one of the sanctioned classes. Static seed (the
-- route is not tenant-scoped), idempotent on (federation_id, query_class).

INSERT INTO federation.route (route_id, federation_id, query_class, target_pool_indexes, execution_plan)
SELECT 'qa-route-fed-us-east-1-resolver', 'fed-us-east-1', 'resolver',
       ARRAY['qa-pool-001']::text[],
       '{"strategy":"scatter-gather","fanout":1}'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM federation.route
   WHERE federation_id = 'fed-us-east-1' AND query_class = 'resolver'
);
