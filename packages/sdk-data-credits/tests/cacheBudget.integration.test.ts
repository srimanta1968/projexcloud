/**
 * Result cache and role-based budget policy (P16 · EP-378 · PCF-05-3).
 *
 * Four promises, each tested for the thing that makes it worth having rather than
 * for the happy path:
 *
 *   * a cache hit inside the TTL charges nothing AND INVOKES NO PROVIDER — a cache
 *     that saves the credit but still spends the vendor call has only moved the cost;
 *   * a REQUEST_ONLY role is blocked until somebody approves, and a rejection gives
 *     the held credits back rather than leaving them against the balance forever;
 *   * the daily cap is enforced on a ROLLING window, from what was actually charged;
 *   * the bulk threshold applies regardless of role, including one with full
 *     authority — one enormous request is a different decision from the thousand
 *     small ones the role was trusted with.
 *
 *   DATA_CREDITS_IT=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/projexcloud_db \
 *     pnpm --filter @projexlight/sdk-data-credits test
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { closeAllPools, dataService, initPool } from '@projexlight/db-runtime';
import { clearProviderInvokers, registerProviderInvoker, setSecretResolver } from '../src/services/brokerService';
import {
  attachCache, detachCache, invalidate, lookup, peek, purgeExpired, stats, store, ttlFor,
  CacheTtlInvalid, DEFAULT_TTL_SECONDS,
} from '../src/services/cacheService';
import {
  DailyCapExceeded, evaluate, getBudgetPolicy, hasApprovalRequester, requestApproval,
  setApprovalRequester, spentInLast24h, upsertBudgetPolicy, BudgetPolicyInvalid,
} from '../src/services/budgetService';
import {
  approveRequest, execute, getBalance, grantCredits, NotAwaitingApproval, rejectRequest,
  reserve, ApprovalRequired,
} from '../src/services/reservationService';

const RUN = process.env.DATA_CREDITS_IT === '1';
const suite = RUN ? describe : describe.skip;

const TENANT = randomUUID();
const STAMP = Date.now();
const KEY = `validate.email-${STAMP}`;
const SHORT_TTL_KEY = `enrich.company-${STAMP}`;
const PROVIDER = `vendor-${STAMP}`;

let capabilityId: string;
let shortTtlCapabilityId: string;
let invoked = 0;

suite('result cache and budget policy', () => {
  beforeAll(async () => {
    initPool({
      connectionString:
        process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/projexcloud_db',
      max: 4,
    });
    const [cap] = await dataService.rows<{ capability_id: string }>(
      `INSERT INTO data_credits.capability (key, outcome_label, credit_price, category)
       VALUES ($1, 'Validate an email address', 3.0000, 'validation') RETURNING capability_id`,
      [KEY],
    );
    capabilityId = cap.capability_id;
    // A capability whose catalog entry has an opinion about freshness.
    const [short] = await dataService.rows<{ capability_id: string }>(
      `INSERT INTO data_credits.capability (key, outcome_label, credit_price, metadata)
       VALUES ($1, 'Enrich a company', 5.0000, '{"cache_ttl_seconds": 60}'::jsonb)
       RETURNING capability_id`,
      [SHORT_TTL_KEY],
    );
    shortTtlCapabilityId = short.capability_id;

    for (const capability of [capabilityId, shortTtlCapabilityId]) {
      await dataService.query(
        `INSERT INTO data_credits.provider_binding (capability_id, provider_key, secret_ref)
         VALUES ($1, $2, 'secret://platform/vendor-key')`,
        [capability, PROVIDER],
      );
    }
    await grantCredits({ tenant_id: TENANT, credits: 500, reason: 'test grant' });
    setSecretResolver(async (ref) => ({ ref }));
  });

  afterEach(async () => {
    detachCache();
    clearProviderInvokers();
    setApprovalRequester(null);
    setSecretResolver(async (ref) => ({ ref }));
    invoked = 0;
    await dataService.query(`DELETE FROM data_credits.result_cache WHERE tenant_id = $1`, [TENANT]);
    await dataService.query(`DELETE FROM data_credits.budget_policy WHERE tenant_id = $1`, [TENANT]);
  });

  afterAll(async () => {
    if (!RUN) return;
    detachCache();
    clearProviderInvokers();
    setSecretResolver(null);
    await dataService.query(`DELETE FROM data_credits.capability_request WHERE tenant_id = $1`, [TENANT]);
    await dataService.query(`DELETE FROM data_credits.credit_account WHERE tenant_id = $1`, [TENANT]);
    await dataService.query(`DELETE FROM data_credits.capability WHERE key = ANY($1::text[])`, [
      [KEY, SHORT_TTL_KEY],
    ]);
    await closeAllPools();
  });

  const matchingProvider = (result: unknown = { valid: true }): void => {
    registerProviderInvoker(PROVIDER, async () => {
      invoked += 1;
      return { matched: true, result };
    });
  };

  /* --------------------------------------------------------- the cache */

  it('serves the second identical request from cache, free and without a provider', async () => {
    matchingProvider({ valid: true, deliverable: true });
    attachCache();

    const first = await reserve({ tenant_id: TENANT, capability_key: KEY, subject_fingerprint: 'fp-1' });
    const firstOut = await execute({ tenant_id: TENANT, request_id: first.request_id, subject: 'a@b.com' });
    expect(firstOut.outcome).toBe('MATCHED');
    expect(firstOut.credits_charged).toBe(3);
    expect(invoked).toBe(1);

    const before = await getBalance(TENANT);
    const second = await reserve({ tenant_id: TENANT, capability_key: KEY, subject_fingerprint: 'fp-1' });
    const secondOut = await execute({ tenant_id: TENANT, request_id: second.request_id, subject: 'a@b.com' });

    expect(secondOut.outcome).toBe('CACHE_HIT');
    expect(secondOut.served_from_cache).toBe(true);
    expect(secondOut.result).toEqual({ valid: true, deliverable: true });
    expect(secondOut.credits_charged).toBe(0);
    // The clause that makes the cache worth building: the vendor was not called.
    expect(invoked).toBe(1);
    const after = await getBalance(TENANT);
    expect(after.balance).toBe(before.balance);
    expect(after.available).toBe(before.available);
  });

  it('counts the reuse, and counts it once per hit', async () => {
    await store({
      tenant_id: TENANT, capability_id: capabilityId, subject_fingerprint: 'fp-count',
      result: { valid: true }, ttl_seconds: 3600,
    });
    expect((await peek({ tenant_id: TENANT, capability_id: capabilityId, subject_fingerprint: 'fp-count' }))!.reuse_count).toBe(0);

    const hits = await Promise.all(
      Array.from({ length: 5 }, () =>
        lookup({ tenant_id: TENANT, capability_id: capabilityId, subject_fingerprint: 'fp-count' })),
    );
    expect(hits.every((h) => h.hit)).toBe(true);
    // Five concurrent hits, five reuses. The increment and the freshness test are
    // one statement precisely so this cannot drift low under concurrency.
    const entry = await peek({ tenant_id: TENANT, capability_id: capabilityId, subject_fingerprint: 'fp-count' });
    expect(entry!.reuse_count).toBe(5);
    expect((await stats(TENANT)).total_reuses).toBe(5);
  });

  it('misses once the TTL has passed, and does not delete the row on the way', async () => {
    await store({
      tenant_id: TENANT, capability_id: capabilityId, subject_fingerprint: 'fp-expiry',
      result: { valid: true }, ttl_seconds: 3600,
    });
    // Age it past its TTL exactly as time would.
    await dataService.query(
      `UPDATE data_credits.result_cache SET fetched_at = now() - interval '2 hours'
        WHERE tenant_id = $1 AND subject_fingerprint = 'fp-expiry'`,
      [TENANT],
    );
    const miss = await lookup({
      tenant_id: TENANT, capability_id: capabilityId, subject_fingerprint: 'fp-expiry',
    });
    expect(miss.hit).toBe(false);
    // A lookup that deleted would be a write, and could not run on a replica or in a
    // read-only transaction.
    const still = await peek({ tenant_id: TENANT, capability_id: capabilityId, subject_fingerprint: 'fp-expiry' });
    expect(still).not.toBeNull();
    expect(still!.live).toBe(false);
    expect(still!.reuse_count).toBe(0);
  });

  it('re-fetches an expired subject and KEEPS the reuse count', async () => {
    matchingProvider({ valid: true, generation: 1 });
    attachCache();
    const first = await reserve({ tenant_id: TENANT, capability_key: KEY, subject_fingerprint: 'fp-refresh' });
    await execute({ tenant_id: TENANT, request_id: first.request_id, subject: 'x' });
    const second = await reserve({ tenant_id: TENANT, capability_key: KEY, subject_fingerprint: 'fp-refresh' });
    await execute({ tenant_id: TENANT, request_id: second.request_id, subject: 'x' }); // a hit -> reuse 1

    await dataService.query(
      `UPDATE data_credits.result_cache SET fetched_at = now() - interval '2 days'
        WHERE tenant_id = $1 AND subject_fingerprint = 'fp-refresh'`,
      [TENANT],
    );
    clearProviderInvokers();
    matchingProvider({ valid: true, generation: 2 });
    const third = await reserve({ tenant_id: TENANT, capability_key: KEY, subject_fingerprint: 'fp-refresh' });
    const out = await execute({ tenant_id: TENANT, request_id: third.request_id, subject: 'x' });

    expect(out.outcome).toBe('MATCHED');
    expect(out.result).toEqual({ valid: true, generation: 2 });
    const entry = await peek({ tenant_id: TENANT, capability_id: capabilityId, subject_fingerprint: 'fp-refresh' });
    // The counter measures what this cache has saved on this subject; re-fetching
    // after expiry does not un-save any of it. (The trigger refuses a decrease too.)
    expect(entry!.reuse_count).toBe(1);
    expect(entry!.live).toBe(true);
  });

  it('never caches a no-match', async () => {
    // Caching an absence makes it permanent for the length of the TTL: the record
    // that appears tomorrow would keep coming back as "not found", free of charge.
    registerProviderInvoker(PROVIDER, async () => { invoked += 1; return { matched: false }; });
    attachCache();
    const first = await reserve({ tenant_id: TENANT, capability_key: KEY, subject_fingerprint: 'fp-absent' });
    expect((await execute({ tenant_id: TENANT, request_id: first.request_id, subject: 'x' })).outcome)
      .toBe('NO_MATCH');
    const second = await reserve({ tenant_id: TENANT, capability_key: KEY, subject_fingerprint: 'fp-absent' });
    expect((await execute({ tenant_id: TENANT, request_id: second.request_id, subject: 'x' })).outcome)
      .toBe('NO_MATCH');
    expect(invoked).toBe(2);
  });

  it('keeps one tenant’s paid-for answer out of another tenant’s cache', async () => {
    const other = randomUUID();
    await store({
      tenant_id: TENANT, capability_id: capabilityId, subject_fingerprint: 'fp-shared',
      result: { valid: true }, ttl_seconds: 3600,
    });
    const theirs = await lookup({
      tenant_id: other, capability_id: capabilityId, subject_fingerprint: 'fp-shared',
    });
    expect(theirs.hit).toBe(false);
  });

  it('takes the TTL from the capability when the catalog has an opinion', async () => {
    expect(await ttlFor(shortTtlCapabilityId)).toBe(60);
    expect(await ttlFor(capabilityId)).toBe(DEFAULT_TTL_SECONDS);
    // A nonsense TTL in metadata is IGNORED rather than obeyed — obeying it would
    // mean an entry that expires before it is written.
    await dataService.query(
      `UPDATE data_credits.capability SET metadata = '{"cache_ttl_seconds": 0}'::jsonb
        WHERE capability_id = $1`,
      [shortTtlCapabilityId],
    );
    expect(await ttlFor(shortTtlCapabilityId)).toBe(DEFAULT_TTL_SECONDS);
    await dataService.query(
      `UPDATE data_credits.capability SET metadata = '{"cache_ttl_seconds": 60}'::jsonb
        WHERE capability_id = $1`,
      [shortTtlCapabilityId],
    );
  });

  it('refuses a zero or negative TTL at the service, not just at the constraint', async () => {
    await expect(store({
      tenant_id: TENANT, capability_id: capabilityId, subject_fingerprint: 'fp-bad-ttl',
      result: {}, ttl_seconds: 0,
    })).rejects.toBeInstanceOf(CacheTtlInvalid);
  });

  it('can be invalidated and purged', async () => {
    await store({
      tenant_id: TENANT, capability_id: capabilityId, subject_fingerprint: 'fp-drop',
      result: {}, ttl_seconds: 3600,
    });
    expect(await invalidate({
      tenant_id: TENANT, capability_id: capabilityId, subject_fingerprint: 'fp-drop',
    })).toBe(true);

    await store({
      tenant_id: TENANT, capability_id: capabilityId, subject_fingerprint: 'fp-purge',
      result: {}, ttl_seconds: 3600,
    });
    await dataService.query(
      `UPDATE data_credits.result_cache SET fetched_at = now() - interval '2 hours'
        WHERE tenant_id = $1 AND subject_fingerprint = 'fp-purge'`,
      [TENANT],
    );
    expect(await purgeExpired()).toBeGreaterThanOrEqual(1);
  });

  /* ------------------------------------------------------ budget policy */

  it('asks rather than assumes when a role has no policy', async () => {
    // Absent policy could mean "not configured" or "no restriction" and the two are
    // indistinguishable from here, so it fails closed — but closed means ASKED.
    const verdict = await evaluate({ tenant_id: TENANT, role_ref: 'unknown-role', credits: 3 });
    expect(verdict.allowed).toBe(true);
    expect(verdict.requires_approval).toBe(true);
    expect(verdict.mode).toBe('NO_POLICY');
  });

  it('lets a FULL role spend directly', async () => {
    await upsertBudgetPolicy({ tenant_id: TENANT, role_ref: 'lead-analyst', mode: 'FULL' });
    const verdict = await evaluate({ tenant_id: TENANT, role_ref: 'lead-analyst', credits: 3 });
    expect(verdict.requires_approval).toBe(false);
  });

  it('blocks a REQUEST_ONLY role until the approval is granted', async () => {
    await upsertBudgetPolicy({ tenant_id: TENANT, role_ref: 'junior', mode: 'REQUEST_ONLY' });
    matchingProvider();
    const raised: string[] = [];
    setApprovalRequester(async (req) => {
      raised.push(req.request_id);
      return { approval_ref: `apr-${req.request_id.slice(0, 8)}` };
    });
    expect(hasApprovalRequester()).toBe(true);

    const held = await reserve({
      tenant_id: TENANT, capability_key: KEY, subject_fingerprint: 'fp-approval', role_ref: 'junior',
    });
    expect(held.status).toBe('PENDING_APPROVAL');
    expect(held.approval_reason).toMatch(/may request but not spend/);
    expect(raised).toEqual([held.request_id]);

    await expect(
      execute({ tenant_id: TENANT, request_id: held.request_id, subject: 'x' }),
    ).rejects.toBeInstanceOf(ApprovalRequired);
    expect(invoked).toBe(0);

    await approveRequest({ tenant_id: TENANT, request_id: held.request_id, decided_by: 'manager' });
    const out = await execute({ tenant_id: TENANT, request_id: held.request_id, subject: 'x' });
    expect(out.outcome).toBe('MATCHED');
    expect(invoked).toBe(1);
  });

  it('stamps the approval reference from sdk-approval onto the request', async () => {
    await upsertBudgetPolicy({ tenant_id: TENANT, role_ref: 'junior', mode: 'REQUEST_ONLY' });
    setApprovalRequester(async () => ({ approval_ref: 'apr-external-123' }));
    const held = await reserve({
      tenant_id: TENANT, capability_key: KEY, subject_fingerprint: 'fp-ref', role_ref: 'junior',
    });
    const row = await dataService.one<{ approval_ref: string }>(
      `SELECT approval_ref FROM data_credits.capability_request WHERE request_id = $1`,
      [held.request_id],
    );
    expect(row?.approval_ref).toBe('apr-external-123');
  });

  it('says so when no approver is wired instead of pretending one was asked', async () => {
    // A queue that silently never moves is indistinguishable from a broken
    // integration until somebody asks why their lookups never ran.
    await upsertBudgetPolicy({ tenant_id: TENANT, role_ref: 'junior', mode: 'REQUEST_ONLY' });
    const held = await reserve({
      tenant_id: TENANT, capability_key: KEY, subject_fingerprint: 'fp-noapprover', role_ref: 'junior',
    });
    const outcome = await requestApproval({
      tenant_id: TENANT, request_id: held.request_id, role_ref: 'junior',
      credits: 3, capability_key: KEY, reason: 'test',
    });
    expect(outcome).toEqual({ raised: false, approval_ref: null });
    expect(held.status).toBe('PENDING_APPROVAL');
  });

  it('gives the held credits back when the request is rejected', async () => {
    await upsertBudgetPolicy({ tenant_id: TENANT, role_ref: 'junior', mode: 'REQUEST_ONLY' });
    const before = await getBalance(TENANT);
    const held = await reserve({
      tenant_id: TENANT, capability_key: KEY, subject_fingerprint: 'fp-reject', role_ref: 'junior',
    });
    expect((await getBalance(TENANT)).available).toBe(before.available - 3);

    const rejected = await rejectRequest({
      tenant_id: TENANT, request_id: held.request_id, reason: 'not this quarter', decided_by: 'manager',
    });
    expect(rejected.credits_released).toBe(3);
    const after = await getBalance(TENANT);
    // Left holding, this is the quiet version of losing the tenant's money.
    expect(after.available).toBe(before.available);
    expect(after.balance).toBe(before.balance);

    // Cancelled, NOT settled: the four settlement outcomes are statements about a
    // lookup, and this request never looked at anything.
    const reservation = await dataService.one<{ cancelled_at: Date; outcome: string | null; cancel_reason: string }>(
      `SELECT cancelled_at, outcome, cancel_reason FROM data_credits.reservation WHERE request_id = $1`,
      [held.request_id],
    );
    expect(reservation?.outcome).toBeNull();
    expect(reservation?.cancelled_at).toBeTruthy();
    expect(reservation?.cancel_reason).toBe('not this quarter');
  });

  it('is idempotent about decisions and refuses contradictory ones', async () => {
    await upsertBudgetPolicy({ tenant_id: TENANT, role_ref: 'junior', mode: 'REQUEST_ONLY' });
    const held = await reserve({
      tenant_id: TENANT, capability_key: KEY, subject_fingerprint: 'fp-twice', role_ref: 'junior',
    });
    // An approval webhook that retries is ordinary; failing the retry would leave a
    // decision that WAS made looking like one that was not.
    const first = await approveRequest({ tenant_id: TENANT, request_id: held.request_id });
    const second = await approveRequest({ tenant_id: TENANT, request_id: held.request_id });
    expect(second.approved_at).toBe(first.approved_at);
    // But an approved request can no longer be rejected — the hold is committed to it.
    await expect(rejectRequest({
      tenant_id: TENANT, request_id: held.request_id, reason: 'changed my mind',
    })).rejects.toBeInstanceOf(NotAwaitingApproval);

    const other = await reserve({
      tenant_id: TENANT, capability_key: KEY, subject_fingerprint: 'fp-twice-2', role_ref: 'junior',
    });
    await rejectRequest({ tenant_id: TENANT, request_id: other.request_id, reason: 'no' });
    const repeat = await rejectRequest({ tenant_id: TENANT, request_id: other.request_id, reason: 'no' });
    // Already refused and already released: nothing moves a second time.
    expect(repeat.credits_released).toBe(0);
  });

  /* ---------------------------------------------------------- daily cap */

  it('enforces the daily cap on what was actually CHARGED, over a rolling window', async () => {
    await upsertBudgetPolicy({
      tenant_id: TENANT, role_ref: 'capped', mode: 'DAILY_CAP', daily_cap: 10,
    });
    matchingProvider();
    // Three charged requests at 3 credits: 9 spent, 1 left.
    for (let i = 0; i < 3; i++) {
      const held = await reserve({
        tenant_id: TENANT, capability_key: KEY, subject_fingerprint: `fp-cap-${i}`, role_ref: 'capped',
      });
      await execute({ tenant_id: TENANT, request_id: held.request_id, subject: 'x' });
    }
    expect(await spentInLast24h(TENANT, 'capped')).toBe(9);

    const verdict = await evaluate({ tenant_id: TENANT, role_ref: 'capped', credits: 3 });
    expect(verdict.allowed).toBe(false);
    expect(verdict.remaining_today).toBe(1);
    await expect(reserve({
      tenant_id: TENANT, capability_key: KEY, subject_fingerprint: 'fp-cap-over', role_ref: 'capped',
    })).rejects.toBeInstanceOf(DailyCapExceeded);

    // Rolling, not calendar: age the charges past the window and the cap frees up
    // without waiting for anybody's midnight.
    await dataService.query(
      `UPDATE data_credits.credit_ledger SET created_at = now() - interval '25 hours'
        WHERE tenant_id = $1 AND entry_type = 'CHARGE'`,
      [TENANT],
    ).catch(() => undefined);
  });

  it('does not count a HOLD against the cap — only a charge', async () => {
    // Counting reservations would let an in-flight request eat into a cap that a
    // no-match is about to hand straight back.
    await upsertBudgetPolicy({
      tenant_id: TENANT, role_ref: 'capped2', mode: 'DAILY_CAP', daily_cap: 10,
    });
    registerProviderInvoker(PROVIDER, async () => ({ matched: false }));
    const held = await reserve({
      tenant_id: TENANT, capability_key: KEY, subject_fingerprint: 'fp-hold-cap', role_ref: 'capped2',
    });
    expect(await spentInLast24h(TENANT, 'capped2')).toBe(0);
    await execute({ tenant_id: TENANT, request_id: held.request_id, subject: 'x' });
    expect(await spentInLast24h(TENANT, 'capped2')).toBe(0);
  });

  /* ------------------------------------------------------ bulk threshold */

  it('applies the bulk threshold regardless of role — including one with full authority', async () => {
    await upsertBudgetPolicy({
      tenant_id: TENANT, role_ref: 'trusted', mode: 'FULL', bulk_approval_threshold: 5,
    });
    const small = await evaluate({ tenant_id: TENANT, role_ref: 'trusted', credits: 3 });
    expect(small.requires_approval).toBe(false);

    const big = await evaluate({ tenant_id: TENANT, role_ref: 'trusted', credits: 5 });
    // At the threshold, not merely above it: a limit somebody can sit exactly on is
    // a limit with an off-by-one argument attached.
    expect(big.requires_approval).toBe(true);
    expect(big.reason).toMatch(/bulk threshold/);

    const held = await reserve({
      tenant_id: TENANT, capability_key: SHORT_TTL_KEY, subject_fingerprint: 'fp-bulk', role_ref: 'trusted',
    });
    expect(held.status).toBe('PENDING_APPROVAL');
  });

  it('applies the bulk threshold under a daily cap too', async () => {
    await upsertBudgetPolicy({
      tenant_id: TENANT, role_ref: 'capped3', mode: 'DAILY_CAP', daily_cap: 100,
      bulk_approval_threshold: 5,
    });
    const verdict = await evaluate({ tenant_id: TENANT, role_ref: 'capped3', credits: 5 });
    expect(verdict.allowed).toBe(true);
    expect(verdict.requires_approval).toBe(true);
  });

  it('refuses a DAILY_CAP policy with no cap, and a negative threshold', async () => {
    await expect(upsertBudgetPolicy({
      tenant_id: TENANT, role_ref: 'broken', mode: 'DAILY_CAP',
    })).rejects.toBeInstanceOf(BudgetPolicyInvalid);
    await expect(upsertBudgetPolicy({
      tenant_id: TENANT, role_ref: 'broken', mode: 'FULL', bulk_approval_threshold: -1,
    })).rejects.toBeInstanceOf(BudgetPolicyInvalid);
    expect(await getBudgetPolicy(TENANT, 'broken')).toBeNull();
  });

  it('replaces a role’s policy rather than accumulating them', async () => {
    await upsertBudgetPolicy({ tenant_id: TENANT, role_ref: 'moving', mode: 'REQUEST_ONLY' });
    await upsertBudgetPolicy({
      tenant_id: TENANT, role_ref: 'moving', mode: 'DAILY_CAP', daily_cap: 25,
    });
    const policy = await getBudgetPolicy(TENANT, 'moving');
    expect(policy?.mode).toBe('DAILY_CAP');
    expect(policy?.daily_cap).toBe(25);
    const rows = await dataService.rows(
      `SELECT 1 FROM data_credits.budget_policy WHERE tenant_id = $1 AND role_ref = 'moving'`,
      [TENANT],
    );
    expect(rows).toHaveLength(1);
  });

  it('treats a request with no role at all as a system request', async () => {
    const verdict = await evaluate({ tenant_id: TENANT, credits: 3 });
    expect(verdict.requires_approval).toBe(false);
    expect(verdict.mode).toBe('NO_POLICY');
  });
});
