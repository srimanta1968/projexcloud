/**
 * data_credits schema contract (P16 · EP-378 · PCF-05-1).
 *
 * The four acceptance criteria are all schema-level promises, so they are asserted
 * against a REAL database rather than against the service layer that will be built
 * on top of it next:
 *
 *   1. provider_binding is unreachable from any tenant-scoped query path.
 *   2. credit_ledger is append-only — no update and no delete path.
 *   3. the reservation outcome enum covers all four settlement cases, and the three
 *      free ones cannot be charged for.
 *   4. migrations are idempotent and additive.
 *
 * Criterion 1 is the interesting one to test mechanically. "Unreachable" is enforced
 * structurally: the internal tables carry NO tenant_id column, so they cannot appear
 * in a `WHERE tenant_id = $1` query, and no tenant-visible table holds a foreign key
 * into them. Both halves are asserted from the catalog rather than by reading code,
 * because the code that would break this has not been written yet.
 *
 * Opt-in, like every other P16 integration suite:
 *
 *   DATA_CREDITS_IT=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/projexcloud_db \
 *     pnpm --filter @projexlight/sdk-data-credits test
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { closeAllPools, dataService, initPool } from '@projexlight/db-runtime';

const RUN = process.env.DATA_CREDITS_IT === '1';
const suite = RUN ? describe : describe.skip;

const TENANT = randomUUID();
const OTHER_TENANT = randomUUID();
const PLATFORM_KEY = `validate.phone-${Date.now()}`;

/** Fails the test unless the statement is refused with a message matching `matcher`. */
async function refuses(sql: string, params: unknown[], matcher: RegExp): Promise<void> {
  let message: string | null = null;
  try {
    await dataService.query(sql, params);
  } catch (err) {
    message = (err as Error).message;
  }
  expect(message, `statement was ACCEPTED but should have been refused: ${sql}`).not.toBeNull();
  expect(message as string).toMatch(matcher);
}

suite('data_credits schema', () => {
  let platformCapability: string;
  let tenantCapability: string;
  let requestId: string;

  beforeAll(async () => {
    initPool({
      connectionString:
        process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/projexcloud_db',
      max: 4,
    });
    const [cap] = await dataService.rows<{ capability_id: string }>(
      `INSERT INTO data_credits.capability (key, outcome_label, description, credit_price, category)
       VALUES ($1, 'Validate a phone number', 'Confirms the number is reachable', 1.0000, 'validation')
       RETURNING capability_id`,
      [PLATFORM_KEY],
    );
    platformCapability = cap.capability_id;
  });

  afterAll(async () => {
    if (!RUN) return;
    /*
     * The ledger is NOT cleaned up, because it cannot be: append-only means
     * append-only for the test suite too, and a teardown that could delete its rows
     * would prove the trigger was decorative. The tenants are fresh random UUIDs per
     * run, so the entries interfere with nothing; the request rows they point at are
     * removed and the FK is ON DELETE SET NULL.
     */
    for (const t of ['result_cache', 'budget_policy', 'credit_account']) {
      await dataService.query(`DELETE FROM data_credits.${t} WHERE tenant_id = ANY($1::uuid[])`, [
        [TENANT, OTHER_TENANT],
      ]);
    }
    // capability_request cascades to reservation and provider_attempt; capability
    // cascades to provider_binding.
    await dataService.query(
      `DELETE FROM data_credits.capability_request WHERE tenant_id = ANY($1::uuid[])`,
      [[TENANT, OTHER_TENANT]],
    );
    await dataService.query(`DELETE FROM data_credits.capability WHERE key LIKE $1`, [
      `%${PLATFORM_KEY.split('-').pop()}%`,
    ]);
    await closeAllPools();
  });

  /* ------------------------------------------- criterion 1: vendor opacity */

  describe('provider_binding is unreachable from a tenant-scoped query path', () => {
    it('carries no tenant_id column at all — on either internal table', async () => {
      // This is the whole mechanism. Every tenant-scoped read in this SDK is
      // `WHERE tenant_id = $1`; a table with no such column cannot be in one, so a
      // leak has to be a deliberate untenanted join rather than an oversight.
      const rows = await dataService.rows<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name
           FROM information_schema.columns
          WHERE table_schema = 'data_credits'
            AND column_name = 'tenant_id'
            AND table_name IN ('provider_binding', 'provider_attempt')`,
      );
      expect(rows).toEqual([]);
    });

    it('every tenant-facing table DOES carry tenant_id', async () => {
      // The other half: if a tenant-facing table lost its tenant_id, the check above
      // would still pass while the boundary had moved.
      const rows = await dataService.rows<{ table_name: string }>(
        `SELECT c.relname AS table_name
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'data_credits' AND c.relkind = 'r'
            AND c.relname NOT IN ('provider_binding', 'provider_attempt')
            AND NOT EXISTS (
              SELECT 1 FROM information_schema.columns col
               WHERE col.table_schema = 'data_credits'
                 AND col.table_name = c.relname
                 AND col.column_name = 'tenant_id')`,
      );
      expect(rows.map((r) => r.table_name)).toEqual([]);
    });

    it('no tenant-visible table holds a foreign key into the internal ones', async () => {
      // A binding_id column on capability_request or reservation would put the
      // vendor one careless `SELECT *` away from a tenant response.
      const rows = await dataService.rows<{ child: string; parent: string }>(
        `SELECT child.relname AS child, parent.relname AS parent
           FROM pg_constraint con
           JOIN pg_class child ON child.oid = con.conrelid
           JOIN pg_class parent ON parent.oid = con.confrelid
           JOIN pg_namespace n ON n.oid = child.relnamespace
          WHERE con.contype = 'f' AND n.nspname = 'data_credits'
            AND parent.relname IN ('provider_binding', 'provider_attempt')
            AND child.relname NOT IN ('provider_binding', 'provider_attempt')`,
      );
      expect(rows).toEqual([]);
    });

    it('stores a credentials REFERENCE, never a credential', async () => {
      const [binding] = await dataService.rows<{ binding_id: string }>(
        `INSERT INTO data_credits.provider_binding
            (capability_id, provider_key, secret_ref, priority, true_cost_micros)
         VALUES ($1, 'provider-a', 'secret://platform/provider-a', 1, 4200)
         RETURNING binding_id`,
        [platformCapability],
      );
      expect(binding.binding_id).toBeTruthy();

      // A raw key pasted into the column fails at write time rather than sitting in
      // a table nobody re-reads.
      await refuses(
        `INSERT INTO data_credits.provider_binding (capability_id, provider_key, secret_ref)
         VALUES ($1, 'provider-b', 'AC0123456789abcdef')`,
        [platformCapability],
        /provider_binding_secret_is_a_reference/,
      );
    });

    it('refuses two bindings for the same provider on one capability', async () => {
      await refuses(
        `INSERT INTO data_credits.provider_binding (capability_id, provider_key, secret_ref)
         VALUES ($1, 'provider-a', 'secret://platform/provider-a-dup')`,
        [platformCapability],
        /provider_binding_capability_provider_idx/,
      );
    });

    it('orders the fallback chain by priority, filtered by health', async () => {
      await dataService.query(
        `INSERT INTO data_credits.provider_binding
            (capability_id, provider_key, secret_ref, priority, health_state)
         VALUES ($1, 'provider-b', 'secret://platform/provider-b', 2, 'DEGRADED'),
                ($1, 'provider-c', 'secret://platform/provider-c', 3, 'UNAVAILABLE')`,
        [platformCapability],
      );
      const chain = await dataService.rows<{ provider_key: string }>(
        `SELECT provider_key FROM data_credits.provider_binding
          WHERE capability_id = $1 AND is_active AND health_state <> 'UNAVAILABLE'
          ORDER BY priority ASC, binding_id ASC`,
        [platformCapability],
      );
      expect(chain.map((c) => c.provider_key)).toEqual(['provider-a', 'provider-b']);
    });
  });

  /* --------------------------------------------------- the outcome catalog */

  describe('capability catalog', () => {
    it('lets a tenant price override the platform default for the same key', async () => {
      const [row] = await dataService.rows<{ capability_id: string }>(
        `INSERT INTO data_credits.capability (tenant_id, key, outcome_label, credit_price)
         VALUES ($1, $2, 'Validate a phone number', 0.5000)
         RETURNING capability_id`,
        [TENANT, PLATFORM_KEY],
      );
      tenantCapability = row.capability_id;
      expect(tenantCapability).not.toBe(platformCapability);
    });

    it('refuses a second platform row for the same key', async () => {
      // NULLs are distinct in a unique index, so a naive UNIQUE(tenant_id, key)
      // would allow two platform defaults and the resolver would pick whichever the
      // planner returned first. The COALESCE index is what closes that.
      await refuses(
        `INSERT INTO data_credits.capability (key, outcome_label, credit_price)
         VALUES ($1, 'Duplicate platform default', 9.0000)`,
        [PLATFORM_KEY],
        /capability_scope_key_idx/,
      );
    });

    it('refuses a second row for the same tenant and key', async () => {
      await refuses(
        `INSERT INTO data_credits.capability (tenant_id, key, outcome_label, credit_price)
         VALUES ($1, $2, 'Duplicate tenant override', 9.0000)`,
        [TENANT, PLATFORM_KEY],
        /capability_scope_key_idx/,
      );
    });

    it('refuses a key that names a vendor instead of an outcome', async () => {
      // The naming IS the abstraction: "validate.phone" survives changing vendor
      // three times, "twilio_lookup" breaks every integration the day it is retired.
      for (const key of ['twilio_lookup', 'Validate.Phone', 'phone', 'validate.', '.phone']) {
        await refuses(
          `INSERT INTO data_credits.capability (key, outcome_label, credit_price)
           VALUES ($1, 'Bad key', 1.0000)`,
          [key],
          /capability_key_is_outcome_named/,
        );
      }
    });

    it('accepts the outcome-named forms the catalog actually uses', async () => {
      const keys = ['find.contact-points', 'find.profiles', 'validate.email', 'enrich.company.firmographics'];
      for (const key of keys) {
        await dataService.query(
          `INSERT INTO data_credits.capability (key, outcome_label, credit_price)
           VALUES ($1, $2, 1.0000)`,
          [`${key}-${PLATFORM_KEY.split('-').pop()}`, key],
        );
      }
      const rows = await dataService.rows<{ n: string }>(
        `SELECT count(*)::text AS n FROM data_credits.capability WHERE key LIKE $1`,
        [`%${PLATFORM_KEY.split('-').pop()}%`],
      );
      expect(Number(rows[0].n)).toBe(2 + keys.length);
    });

    it('refuses a negative price', async () => {
      await refuses(
        `INSERT INTO data_credits.capability (key, outcome_label, credit_price)
         VALUES ('validate.fax', 'Negative', -1.0000)`,
        [],
        /credit_price/,
      );
    });
  });

  /* ------------------------------------------------------- credit account */

  describe('credit_account', () => {
    it('accepts a reservation held inside the balance', async () => {
      await dataService.query(
        `INSERT INTO data_credits.credit_account (tenant_id, balance, reserved)
         VALUES ($1, 100.0000, 10.0000)`,
        [TENANT],
      );
      const [row] = await dataService.rows<{ available: string }>(
        `SELECT (balance - reserved)::text AS available FROM data_credits.credit_account
          WHERE tenant_id = $1`,
        [TENANT],
      );
      // Available is a subtraction, deliberately not a third stored column.
      expect(Number(row.available)).toBe(90);
    });

    it('refuses reserving more than the balance', async () => {
      // The failure this prevents only shows up under concurrency, weeks later, as a
      // balance that went negative with no single request to blame.
      await refuses(
        `UPDATE data_credits.credit_account SET reserved = 150.0000 WHERE tenant_id = $1`,
        [TENANT],
        /credit_account_reserved_within_balance/,
      );
    });

    it('refuses a second account for the same tenant', async () => {
      await refuses(
        `INSERT INTO data_credits.credit_account (tenant_id, balance) VALUES ($1, 5.0000)`,
        [TENANT],
        /credit_account_tenant_idx/,
      );
    });
  });

  /* ---------------------------------------- criterion 3: the four outcomes */

  describe('reservation settlement', () => {
    beforeAll(async () => {
      const [req] = await dataService.rows<{ request_id: string }>(
        `INSERT INTO data_credits.capability_request
            (tenant_id, capability_id, role_ref, subject_fingerprint)
         VALUES ($1, $2, 'analyst', 'fp-primary')
         RETURNING request_id`,
        [TENANT, tenantCapability],
      );
      requestId = req.request_id;
    });

    it('covers exactly the four settlement cases', async () => {
      const rows = await dataService.rows<{ label: string }>(
        `SELECT e.enumlabel AS label
           FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
           JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname = 'data_credits' AND t.typname = 'settlement_outcome'
          ORDER BY e.enumsortorder`,
      );
      expect(rows.map((r) => r.label)).toEqual([
        'MATCHED', 'NO_MATCH', 'TECHNICAL_FAILURE', 'CACHE_HIT',
      ]);
    });

    it('refuses charging for a no-match, a failure or a cache hit', async () => {
      // The promise is that the tenant pays for ANSWERS, not for attempts — so any
      // code path that tries to charge for one of these fails at the write.
      const [res] = await dataService.rows<{ reservation_id: string }>(
        `INSERT INTO data_credits.reservation (tenant_id, request_id, estimated_credits)
         VALUES ($1, $2, 5.0000) RETURNING reservation_id`,
        [TENANT, requestId],
      );
      for (const outcome of ['NO_MATCH', 'TECHNICAL_FAILURE', 'CACHE_HIT']) {
        await refuses(
          `UPDATE data_credits.reservation
              SET outcome = $2::data_credits.settlement_outcome,
                  settled_credits = 5.0000, settled_at = now()
            WHERE reservation_id = $1`,
          [res.reservation_id, outcome],
          /reservation_zero_settlement_outcomes/,
        );
      }
      // …and the free settlement itself is accepted, releasing the hold.
      await dataService.query(
        `UPDATE data_credits.reservation
            SET outcome = 'NO_MATCH', settled_credits = 0, settled_at = now()
          WHERE reservation_id = $1`,
        [res.reservation_id],
      );
      const [settled] = await dataService.rows<{ settled_credits: string; outcome: string }>(
        `SELECT settled_credits::text, outcome FROM data_credits.reservation
          WHERE reservation_id = $1`,
        [res.reservation_id],
      );
      expect(Number(settled.settled_credits)).toBe(0);
      expect(settled.outcome).toBe('NO_MATCH');
    });

    it('refuses a second reservation against the same request', async () => {
      await refuses(
        `INSERT INTO data_credits.reservation (tenant_id, request_id, estimated_credits)
         VALUES ($1, $2, 1.0000)`,
        [TENANT, requestId],
        /reservation_request_idx/,
      );
    });

    it('refuses a half-settled row', async () => {
      const { reservation } = await freshReservation(3);
      await refuses(
        `UPDATE data_credits.reservation SET outcome = 'MATCHED' WHERE reservation_id = $1`,
        [reservation],
        /reservation_settlement_shape/,
      );
      await refuses(
        `UPDATE data_credits.reservation SET settled_credits = 3.0000, settled_at = now()
          WHERE reservation_id = $1`,
        [reservation],
        /reservation_settlement_shape/,
      );
    });

    it('refuses charging more than was quoted', async () => {
      const { reservation } = await freshReservation(2);
      await refuses(
        `UPDATE data_credits.reservation
            SET outcome = 'MATCHED', settled_credits = 2.5000, settled_at = now()
          WHERE reservation_id = $1`,
        [reservation],
        /reservation_never_exceeds_quote/,
      );
    });

    it('lets the same settlement arrive twice and keeps the first timestamp', async () => {
      // What makes the service's settle idempotent under an at-least-once caller.
      const { reservation } = await freshReservation(4);
      await dataService.query(
        `UPDATE data_credits.reservation
            SET outcome = 'MATCHED', settled_credits = 4.0000, settled_at = now()
          WHERE reservation_id = $1`,
        [reservation],
      );
      const [first] = await dataService.rows<{ settled_at: string }>(
        `SELECT settled_at FROM data_credits.reservation WHERE reservation_id = $1`,
        [reservation],
      );
      await dataService.query(
        `UPDATE data_credits.reservation
            SET outcome = 'MATCHED', settled_credits = 4.0000, settled_at = now() + interval '1 hour'
          WHERE reservation_id = $1`,
        [reservation],
      );
      const [second] = await dataService.rows<{ settled_at: string }>(
        `SELECT settled_at FROM data_credits.reservation WHERE reservation_id = $1`,
        [reservation],
      );
      expect(new Date(second.settled_at).getTime()).toBe(new Date(first.settled_at).getTime());
    });

    it('refuses a DIFFERENT settlement after the first one', async () => {
      // Otherwise the last retry to arrive decides what the tenant paid.
      const { reservation } = await freshReservation(6);
      await dataService.query(
        `UPDATE data_credits.reservation
            SET outcome = 'MATCHED', settled_credits = 6.0000, settled_at = now()
          WHERE reservation_id = $1`,
        [reservation],
      );
      await refuses(
        `UPDATE data_credits.reservation SET outcome = 'NO_MATCH', settled_credits = 0
          WHERE reservation_id = $1`,
        [reservation],
        /already settled/,
      );
      await refuses(
        `UPDATE data_credits.reservation SET settled_credits = 1.0000 WHERE reservation_id = $1`,
        [reservation],
        /already settled/,
      );
    });
  });

  /* ------------------------------------------------- request, cache, budget */

  describe('capability_request', () => {
    it('refuses a COMPLETED request with no outcome or no execution time', async () => {
      const [req] = await dataService.rows<{ request_id: string }>(
        `INSERT INTO data_credits.capability_request
            (tenant_id, capability_id, subject_fingerprint)
         VALUES ($1, $2, 'fp-shape') RETURNING request_id`,
        [TENANT, tenantCapability],
      );
      await refuses(
        `UPDATE data_credits.capability_request SET status = 'COMPLETED' WHERE request_id = $1`,
        [req.request_id],
        /capability_request_completed_shape/,
      );
    });

    it('refuses a cache-served request whose outcome is not CACHE_HIT', async () => {
      await refuses(
        `INSERT INTO data_credits.capability_request
            (tenant_id, capability_id, subject_fingerprint, served_from_cache, outcome, status, executed_at)
         VALUES ($1, $2, 'fp-liar', true, 'MATCHED', 'COMPLETED', now())`,
        [TENANT, tenantCapability],
        /capability_request_cache_outcome/,
      );
    });
  });

  describe('result_cache', () => {
    it('derives expires_at from the TTL rather than trusting the writer', async () => {
      const [row] = await dataService.rows<{ delta: string }>(
        `INSERT INTO data_credits.result_cache
            (tenant_id, capability_id, subject_fingerprint, result, ttl_seconds, expires_at)
         VALUES ($1, $2, 'fp-cache', '{"valid":true}'::jsonb, 3600, now() - interval '10 years')
         RETURNING EXTRACT(EPOCH FROM (expires_at - fetched_at))::text AS delta`,
        [TENANT, tenantCapability],
      );
      // The writer supplied a date ten years in the past and it was overwritten:
      // one derivation means the two can never disagree.
      expect(Number(row.delta)).toBe(3600);
    });

    it('refuses a zero or negative TTL', async () => {
      await refuses(
        `INSERT INTO data_credits.result_cache
            (tenant_id, capability_id, subject_fingerprint, result, ttl_seconds, expires_at)
         VALUES ($1, $2, 'fp-zero', '{}'::jsonb, 0, now())`,
        [TENANT, tenantCapability],
        /ttl_seconds/,
      );
    });

    it('lets reuse_count rise and refuses it falling', async () => {
      await dataService.query(
        `UPDATE data_credits.result_cache
            SET reuse_count = reuse_count + 1, last_reused_at = now()
          WHERE tenant_id = $1 AND subject_fingerprint = 'fp-cache'`,
        [TENANT],
      );
      await refuses(
        `UPDATE data_credits.result_cache SET reuse_count = 0
          WHERE tenant_id = $1 AND subject_fingerprint = 'fp-cache'`,
        [TENANT],
        /reuse_count cannot decrease/,
      );
    });

    it('keeps one tenant’s paid-for result out of another tenant’s cache', async () => {
      // Same capability, same fingerprint, different tenant: a separate row, because
      // a result one tenant paid for is not another tenant's to reuse.
      await dataService.query(
        `INSERT INTO data_credits.result_cache
            (tenant_id, capability_id, subject_fingerprint, result, ttl_seconds, expires_at)
         VALUES ($1, $2, 'fp-cache', '{"valid":true}'::jsonb, 60, now())`,
        [OTHER_TENANT, tenantCapability],
      );
      await refuses(
        `INSERT INTO data_credits.result_cache
            (tenant_id, capability_id, subject_fingerprint, result, ttl_seconds, expires_at)
         VALUES ($1, $2, 'fp-cache', '{}'::jsonb, 60, now())`,
        [OTHER_TENANT, tenantCapability],
        /result_cache_subject_idx/,
      );
    });
  });

  describe('budget_policy', () => {
    it('refuses a DAILY_CAP policy with no cap', async () => {
      // An unenforceable policy that reads as a limit is worse than no policy.
      await refuses(
        `INSERT INTO data_credits.budget_policy (tenant_id, role_ref, mode)
         VALUES ($1, 'analyst', 'DAILY_CAP')`,
        [TENANT],
        /budget_policy_daily_cap_present/,
      );
    });

    it('upserts one policy per role through ON CONFLICT', async () => {
      // The index is TOTAL rather than partial-on-is_active precisely so this
      // inference works: a partial unique index makes ON CONFLICT fail at runtime
      // with "no unique or exclusion constraint matching the specification".
      for (const [mode, cap] of [['REQUEST_ONLY', null], ['DAILY_CAP', 50]] as const) {
        await dataService.query(
          `INSERT INTO data_credits.budget_policy (tenant_id, role_ref, mode, daily_cap)
           VALUES ($1, 'analyst', $2::data_credits.budget_mode, $3)
           ON CONFLICT (tenant_id, role_ref)
           DO UPDATE SET mode = EXCLUDED.mode, daily_cap = EXCLUDED.daily_cap`,
          [TENANT, mode, cap],
        );
      }
      const rows = await dataService.rows<{ mode: string; daily_cap: string }>(
        `SELECT mode, daily_cap::text FROM data_credits.budget_policy
          WHERE tenant_id = $1 AND role_ref = 'analyst'`,
        [TENANT],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].mode).toBe('DAILY_CAP');
      expect(Number(rows[0].daily_cap)).toBe(50);
    });
  });

  /* ------------------------------------------ criterion 2: append-only ledger */

  describe('credit_ledger', () => {
    it('records the quote and the charge as separate movements', async () => {
      await dataService.query(
        `INSERT INTO data_credits.credit_ledger
            (tenant_id, entry_type, request_id, reserved_delta, balance_after, reserved_after, reason)
         VALUES ($1, 'RESERVATION', $2, 5.0000, 100.0000, 5.0000, 'held for request')`,
        [TENANT, requestId],
      );
      await dataService.query(
        `INSERT INTO data_credits.credit_ledger
            (tenant_id, entry_type, request_id, balance_delta, reserved_delta, balance_after, reserved_after, reason)
         VALUES ($1, 'CHARGE', $2, -5.0000, -5.0000, 95.0000, 0, 'matched')`,
        [TENANT, requestId],
      );
      const rows = await dataService.rows<{ entry_type: string; entry_no: string }>(
        `SELECT entry_type, entry_no::text FROM data_credits.credit_ledger
          WHERE tenant_id = $1 ORDER BY entry_no ASC`,
        [TENANT],
      );
      // The export can show "quoted 5, charged 5" rather than one net number that
      // hides the quote — which is the question a disputed invoice asks.
      expect(rows.map((r) => r.entry_type)).toEqual(['RESERVATION', 'CHARGE']);
      expect(Number(rows[1].entry_no)).toBeGreaterThan(Number(rows[0].entry_no));
    });

    it('cannot be updated', async () => {
      await refuses(
        `UPDATE data_credits.credit_ledger SET balance_delta = 0 WHERE tenant_id = $1`,
        [TENANT],
        /append-only/,
      );
    });

    it('cannot be deleted', async () => {
      await refuses(
        `DELETE FROM data_credits.credit_ledger WHERE tenant_id = $1`,
        [TENANT],
        /append-only/,
      );
    });

    it('outlives the request it describes', async () => {
      /*
       * Found the hard way: a FK with ON DELETE SET NULL makes Postgres issue an
       * UPDATE against the ledger when the request is removed, and the append-only
       * trigger refuses it — so a request became undeletable the moment it was
       * billed. The refs are loose on purpose. A request may be purged for privacy
       * or retention; the entry saying what the tenant paid must not move.
       */
      const [req] = await dataService.rows<{ request_id: string }>(
        `INSERT INTO data_credits.capability_request
            (tenant_id, capability_id, subject_fingerprint)
         VALUES ($1, $2, $3) RETURNING request_id`,
        [OTHER_TENANT, tenantCapability, `fp-${randomUUID()}`],
      );
      await dataService.query(
        `INSERT INTO data_credits.credit_ledger
            (tenant_id, entry_type, request_id, balance_delta, balance_after, reserved_after, reason)
         VALUES ($1, 'CHARGE', $2, -1.0000, 9.0000, 0, 'matched')`,
        [OTHER_TENANT, req.request_id],
      );
      await dataService.query(
        `DELETE FROM data_credits.capability_request WHERE request_id = $1`,
        [req.request_id],
      );
      const [entry] = await dataService.rows<{ request_id: string }>(
        `SELECT request_id FROM data_credits.credit_ledger
          WHERE tenant_id = $1 ORDER BY entry_no DESC LIMIT 1`,
        [OTHER_TENANT],
      );
      // Still pointing at the purged request: the reference is a fact about what
      // happened, not a live join.
      expect(entry.request_id).toBe(req.request_id);
    });

    it('refuses an entry that moves nothing', async () => {
      await refuses(
        `INSERT INTO data_credits.credit_ledger
            (tenant_id, entry_type, balance_after, reserved_after)
         VALUES ($1, 'ADJUSTMENT', 95.0000, 0)`,
        [TENANT],
        /credit_ledger_moves_something/,
      );
    });
  });

  /* ------------------------------------------------ the internal attempt trace */

  describe('provider_attempt', () => {
    it('records the fallback chain in order and refuses a duplicate position', async () => {
      const bindings = await dataService.rows<{ binding_id: string }>(
        `SELECT binding_id FROM data_credits.provider_binding
          WHERE capability_id = $1 ORDER BY priority ASC`,
        [platformCapability],
      );
      await dataService.query(
        `INSERT INTO data_credits.provider_attempt
            (request_id, binding_id, attempt_no, outcome, latency_ms, true_cost_micros, error_code)
         VALUES ($1, $2, 1, 'TECHNICAL_FAILURE', 2000, 0, 'TIMEOUT'),
                ($1, $3, 2, 'MATCHED', 180, 3100, NULL)`,
        [requestId, bindings[0].binding_id, bindings[1].binding_id],
      );
      await refuses(
        `INSERT INTO data_credits.provider_attempt (request_id, binding_id, attempt_no, outcome)
         VALUES ($1, $2, 2, 'MATCHED')`,
        [requestId, bindings[0].binding_id],
        /provider_attempt_order_idx/,
      );
      const attempts = await dataService.rows<{ attempt_no: number; outcome: string }>(
        `SELECT attempt_no, outcome FROM data_credits.provider_attempt
          WHERE request_id = $1 ORDER BY attempt_no`,
        [requestId],
      );
      // Two providers tried, the second answered — debuggable internally, invisible
      // to the tenant, whose request records only the outcome and the credits.
      expect(attempts.map((a) => a.outcome)).toEqual(['TECHNICAL_FAILURE', 'MATCHED']);
    });
  });

  /* -------------------------------------------- criterion 4: additive migration */

  it('is additive — every CREATE in the migration is IF NOT EXISTS or guarded', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const sql = fs.readFileSync(
      path.resolve(__dirname, '..', 'src', 'db', 'migrations', '001_init_data_credits.sql'),
      'utf8',
    );
    const creates = [...sql.matchAll(/^CREATE\s+(?:UNIQUE\s+)?(SCHEMA|TABLE|INDEX)\s+(?!IF NOT EXISTS)/gim)];
    expect(
      creates.map((m) => m[0].trim()).join('\n'),
      'every CREATE SCHEMA/TABLE/INDEX must be IF NOT EXISTS so a re-run at boot is safe',
    ).toBe('');
    // Types are guarded by DO blocks instead (Postgres has no CREATE TYPE IF NOT
    // EXISTS), and triggers by DROP TRIGGER IF EXISTS immediately before.
    const types = [...sql.matchAll(/CREATE TYPE/g)].length;
    const guarded = [...sql.matchAll(/EXCEPTION WHEN duplicate_object THEN NULL/g)].length;
    expect(guarded).toBe(types);
    const triggers = [...sql.matchAll(/^CREATE TRIGGER/gim)].length;
    const dropped = [...sql.matchAll(/^DROP TRIGGER IF EXISTS/gim)].length;
    expect(dropped).toBe(triggers);
  });

  /** A reservation on its own request, so settlement tests never fight each other. */
  async function freshReservation(estimate: number): Promise<{ reservation: string }> {
    const [req] = await dataService.rows<{ request_id: string }>(
      `INSERT INTO data_credits.capability_request
          (tenant_id, capability_id, subject_fingerprint)
       VALUES ($1, $2, $3) RETURNING request_id`,
      [TENANT, tenantCapability, `fp-${randomUUID()}`],
    );
    const [res] = await dataService.rows<{ reservation_id: string }>(
      `INSERT INTO data_credits.reservation (tenant_id, request_id, estimated_credits)
       VALUES ($1, $2, $3) RETURNING reservation_id`,
      [TENANT, req.request_id, estimate],
    );
    return { reservation: res.reservation_id };
  }
});
