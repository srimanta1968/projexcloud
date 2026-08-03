/**
 * Broker fallback and the reservation lifecycle (P16 · EP-378 · PCF-05-2).
 *
 * The four acceptance criteria are all about money and all about lying:
 *
 *   * a no-match, a provider failure and a cache hit settle to ZERO — a tenant pays
 *     for answers, not for attempts;
 *   * the held credits come back on every one of those;
 *   * settle is idempotent, so an at-least-once caller cannot be charged twice;
 *   * the fallback is invisible — nothing a tenant can see says which vendor
 *     answered, on whose key, or what it really cost.
 *
 * The opacity check is written as a DEEP SCAN over the actual returned objects
 * rather than as a list of fields to omit: a field added to a response later is
 * exactly how this boundary gets crossed, and a test that names fields would not
 * notice. Provider keys and secret refs used in this suite are distinctive strings,
 * so a leak anywhere in the payload is found by searching for them.
 *
 *   DATA_CREDITS_IT=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/projexcloud_db \
 *     pnpm --filter @projexlight/sdk-data-credits test
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { closeAllPools, dataService, initPool } from '@projexlight/db-runtime';
import {
  clearProviderInvokers,
  loadChain,
  registerProviderInvoker,
  setSecretResolver,
} from '../src/services/brokerService';
import {
  estimate,
  execute,
  getBalance,
  grantCredits,
  InsufficientCredits,
  listLedger,
  reserve,
  SettlementConflict,
  setCacheProbe,
  settle,
  setUsageEmitter,
} from '../src/services/reservationService';

const RUN = process.env.DATA_CREDITS_IT === '1';
const suite = RUN ? describe : describe.skip;

const TENANT = randomUUID();
const STAMP = Date.now();
const KEY = `validate.phone-${STAMP}`;
/** Distinctive on purpose: the opacity scan searches returned payloads for these. */
const PRIMARY = `acme-vendor-${STAMP}`;
const SECONDARY = `globex-vendor-${STAMP}`;
const SECRET_REF = `secret://platform/${PRIMARY}-key`;
const TRUE_COST = 987654;

let capabilityId: string;

/** Everything a tenant must never be told, in the form it would leak as. */
const FORBIDDEN = [PRIMARY, SECONDARY, SECRET_REF, String(TRUE_COST), 'true_cost', 'binding_id', 'provider'];

function assertOpaque(payload: unknown, where: string): void {
  const text = JSON.stringify(payload ?? null);
  for (const needle of FORBIDDEN) {
    expect(
      text.toLowerCase().includes(needle.toLowerCase()),
      `${where} leaked '${needle}': ${text}`,
    ).toBe(false);
  }
}

suite('capability broker and reservation lifecycle', () => {
  beforeAll(async () => {
    initPool({
      connectionString:
        process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/projexcloud_db',
      max: 4,
    });
    const [cap] = await dataService.rows<{ capability_id: string }>(
      `INSERT INTO data_credits.capability (key, outcome_label, description, credit_price, category)
       VALUES ($1, 'Validate a phone number', 'Confirms the number is reachable', 2.0000, 'validation')
       RETURNING capability_id`,
      [KEY],
    );
    capabilityId = cap.capability_id;
    await dataService.query(
      `INSERT INTO data_credits.provider_binding
          (capability_id, provider_key, secret_ref, priority, true_cost_micros)
       VALUES ($1, $2, $3, 1, $5), ($1, $4, 'secret://platform/secondary-key', 2, $5)`,
      [capabilityId, PRIMARY, SECRET_REF, SECONDARY, TRUE_COST],
    );
    await grantCredits({ tenant_id: TENANT, credits: 100, reason: 'test grant' });
    setSecretResolver(async (ref) => ({ ref }));
  });

  afterEach(async () => {
    clearProviderInvokers();
    setCacheProbe(null);
    setUsageEmitter(null);
    // Health is state: a failure test would otherwise take a provider out of the
    // chain for every test that follows it.
    await dataService.query(
      `UPDATE data_credits.provider_binding
          SET health_state = 'HEALTHY', consecutive_failures = 0
        WHERE capability_id = $1`,
      [capabilityId],
    );
    setSecretResolver(async (ref) => ({ ref }));
  });

  afterAll(async () => {
    if (!RUN) return;
    clearProviderInvokers();
    setSecretResolver(null);
    // The ledger is append-only and stays; the tenant is a fresh uuid per run.
    await dataService.query(`DELETE FROM data_credits.capability_request WHERE tenant_id = $1`, [TENANT]);
    await dataService.query(`DELETE FROM data_credits.credit_account WHERE tenant_id = $1`, [TENANT]);
    await dataService.query(`DELETE FROM data_credits.capability WHERE key = $1`, [KEY]);
    await closeAllPools();
  });

  /* ------------------------------------------------------------ estimate */

  it('quotes the price and says whether it is affordable', async () => {
    const quote = await estimate(TENANT, KEY);
    expect(quote.credits).toBe(2);
    expect(quote.available).toBe(100);
    expect(quote.affordable).toBe(true);
    assertOpaque(quote, 'estimate');
  });

  /* ------------------------------------------------------------- reserve */

  it('holds the credits without spending them', async () => {
    const before = await getBalance(TENANT);
    const held = await reserve({ tenant_id: TENANT, capability_key: KEY, subject_fingerprint: 'fp-hold' });
    const after = await getBalance(TENANT);
    // Balance untouched, available down: the number in the account is true the
    // whole time, which is the entire reason for a hold.
    expect(after.balance).toBe(before.balance);
    expect(after.reserved).toBe(before.reserved + 2);
    expect(after.available).toBe(before.available - 2);
    const ledger = await listLedger({ tenant_id: TENANT, request_id: held.request_id });
    expect(ledger.map((e) => e.entry_type)).toEqual(['RESERVATION']);
    assertOpaque(held, 'reserve');
  });

  it('refuses a request it cannot cover, and holds nothing', async () => {
    const poor = randomUUID();
    await grantCredits({ tenant_id: poor, credits: 1 });
    await expect(
      reserve({ tenant_id: poor, capability_key: KEY, subject_fingerprint: 'fp-poor' }),
    ).rejects.toBeInstanceOf(InsufficientCredits);
    const balance = await getBalance(poor);
    expect(balance.reserved).toBe(0);
    const requests = await dataService.rows(
      `SELECT 1 FROM data_credits.capability_request WHERE tenant_id = $1`, [poor],
    );
    // The whole reserve is one transaction: a refused hold leaves no orphan request.
    expect(requests).toHaveLength(0);
    await dataService.query(`DELETE FROM data_credits.credit_account WHERE tenant_id = $1`, [poor]);
  });

  /* ------------------------------------------------- the fallback itself */

  it('falls back to the next provider and charges the quote once one answers', async () => {
    registerProviderInvoker(PRIMARY, async () => {
      throw Object.assign(new Error('upstream timeout'), { code: 'TIMEOUT' });
    });
    registerProviderInvoker(SECONDARY, async () => ({
      matched: true, result: { valid: true, line_type: 'mobile' }, true_cost_micros: TRUE_COST,
    }));

    const before = await getBalance(TENANT);
    const held = await reserve({ tenant_id: TENANT, capability_key: KEY, subject_fingerprint: 'fp-fallback' });
    const out = await execute({ tenant_id: TENANT, request_id: held.request_id, subject: '+15551234567' });

    expect(out.outcome).toBe('MATCHED');
    expect(out.result).toEqual({ valid: true, line_type: 'mobile' });
    expect(out.credits_charged).toBe(2);
    // Two providers were tried and the tenant is told about neither.
    assertOpaque(out, 'execute after fallback');

    const after = await getBalance(TENANT);
    expect(after.balance).toBe(before.balance - 2);
    expect(after.reserved).toBe(before.reserved);

    const attempts = await dataService.rows<{ attempt_no: number; outcome: string; error_code: string | null }>(
      `SELECT attempt_no, outcome, error_code FROM data_credits.provider_attempt
        WHERE request_id = $1 ORDER BY attempt_no`,
      [held.request_id],
    );
    // Internally the whole walk is on the record, including why the first one lost.
    expect(attempts.map((a) => a.outcome)).toEqual(['TECHNICAL_FAILURE', 'MATCHED']);
    expect(attempts[0].error_code).toBe('TIMEOUT');
  });

  it('keeps walking past a no-match instead of stopping at the first empty answer', async () => {
    // Stopping there would quietly turn a multi-provider chain into a one-provider
    // one: the second vendor may hold the record the first lacks.
    registerProviderInvoker(PRIMARY, async () => ({ matched: false }));
    registerProviderInvoker(SECONDARY, async () => ({ matched: true, result: { valid: false } }));
    const held = await reserve({ tenant_id: TENANT, capability_key: KEY, subject_fingerprint: 'fp-walk' });
    const out = await execute({ tenant_id: TENANT, request_id: held.request_id, subject: 'x' });
    expect(out.outcome).toBe('MATCHED');
    const attempts = await dataService.rows<{ outcome: string }>(
      `SELECT outcome FROM data_credits.provider_attempt WHERE request_id = $1 ORDER BY attempt_no`,
      [held.request_id],
    );
    expect(attempts.map((a) => a.outcome)).toEqual(['NO_MATCH', 'MATCHED']);
  });

  /* --------------------------------------------- the three free outcomes */

  it('settles a no-match to zero and gives the hold back', async () => {
    registerProviderInvoker(PRIMARY, async () => ({ matched: false }));
    registerProviderInvoker(SECONDARY, async () => ({ matched: false }));
    const before = await getBalance(TENANT);
    const held = await reserve({ tenant_id: TENANT, capability_key: KEY, subject_fingerprint: 'fp-nomatch' });
    const out = await execute({ tenant_id: TENANT, request_id: held.request_id, subject: 'x' });

    expect(out.outcome).toBe('NO_MATCH');
    expect(out.credits_charged).toBe(0);
    const after = await getBalance(TENANT);
    expect(after.balance).toBe(before.balance);
    expect(after.reserved).toBe(before.reserved);
    expect(after.available).toBe(before.available);

    const ledger = await listLedger({ tenant_id: TENANT, request_id: held.request_id });
    // The export can tell a no-match from a failure: the release says which.
    expect(ledger.map((e) => e.entry_type)).toEqual(['RESERVATION', 'RELEASE']);
    expect(ledger[1].reason).toMatch(/NO_MATCH/);
    assertOpaque(out, 'no-match settlement');
  });

  it('settles a total provider failure to zero, and does NOT call it a no-match', async () => {
    // Collapsing the two is how an outage gets reported to a tenant as "no results".
    registerProviderInvoker(PRIMARY, async () => { throw new Error('down'); });
    registerProviderInvoker(SECONDARY, async () => { throw new Error('down'); });
    const before = await getBalance(TENANT);
    const held = await reserve({ tenant_id: TENANT, capability_key: KEY, subject_fingerprint: 'fp-fail' });
    const out = await execute({ tenant_id: TENANT, request_id: held.request_id, subject: 'x' });

    expect(out.outcome).toBe('TECHNICAL_FAILURE');
    expect(out.credits_charged).toBe(0);
    expect(out.status).toBe('FAILED');
    const after = await getBalance(TENANT);
    expect(after.available).toBe(before.available);
    assertOpaque(out, 'failure settlement');
  });

  it('treats an unwired adapter as a failure, never as "nothing found"', async () => {
    // A tenant told "not found" about a lookup nobody performed has been lied to.
    const held = await reserve({ tenant_id: TENANT, capability_key: KEY, subject_fingerprint: 'fp-unwired' });
    const out = await execute({ tenant_id: TENANT, request_id: held.request_id, subject: 'x' });
    expect(out.outcome).toBe('TECHNICAL_FAILURE');
    const attempts = await dataService.rows<{ error_code: string }>(
      `SELECT error_code FROM data_credits.provider_attempt WHERE request_id = $1 ORDER BY attempt_no`,
      [held.request_id],
    );
    expect(attempts.map((a) => a.error_code)).toEqual(['PROVIDER_NOT_WIRED', 'PROVIDER_NOT_WIRED']);
  });

  it('treats an unwired secret resolver the same way', async () => {
    registerProviderInvoker(PRIMARY, async () => ({ matched: true, result: {} }));
    registerProviderInvoker(SECONDARY, async () => ({ matched: true, result: {} }));
    setSecretResolver(null);
    const held = await reserve({ tenant_id: TENANT, capability_key: KEY, subject_fingerprint: 'fp-nosecret' });
    const out = await execute({ tenant_id: TENANT, request_id: held.request_id, subject: 'x' });
    expect(out.outcome).toBe('TECHNICAL_FAILURE');
    const attempts = await dataService.rows<{ error_code: string }>(
      `SELECT error_code FROM data_credits.provider_attempt WHERE request_id = $1`,
      [held.request_id],
    );
    expect(attempts[0].error_code).toBe('SECRET_RESOLVER_UNWIRED');
  });

  it('serves a cache hit for free and invokes no provider at all', async () => {
    let invoked = 0;
    registerProviderInvoker(PRIMARY, async () => { invoked += 1; return { matched: true, result: {} }; });
    setCacheProbe(async () => ({ hit: true, result: { valid: true, cached: true } }));

    const before = await getBalance(TENANT);
    const held = await reserve({ tenant_id: TENANT, capability_key: KEY, subject_fingerprint: 'fp-cache' });
    const out = await execute({ tenant_id: TENANT, request_id: held.request_id, subject: 'x' });

    expect(out.outcome).toBe('CACHE_HIT');
    expect(out.served_from_cache).toBe(true);
    expect(out.credits_charged).toBe(0);
    // The cache is consulted BEFORE the chain — consulted after, it would save the
    // money and still spend the vendor call.
    expect(invoked).toBe(0);
    const after = await getBalance(TENANT);
    expect(after.available).toBe(before.available);
    const attempts = await dataService.rows(
      `SELECT 1 FROM data_credits.provider_attempt WHERE request_id = $1`, [held.request_id],
    );
    expect(attempts).toHaveLength(0);
  });

  /* ------------------------------------------------------ idempotency */

  it('charges once when the same settlement arrives twice', async () => {
    registerProviderInvoker(PRIMARY, async () => ({ matched: true, result: { valid: true } }));
    const held = await reserve({ tenant_id: TENANT, capability_key: KEY, subject_fingerprint: 'fp-retry' });
    const first = await settle({
      tenant_id: TENANT, request_id: held.request_id, outcome: 'MATCHED', result: { valid: true },
    });
    const afterFirst = await getBalance(TENANT);
    const second = await settle({
      tenant_id: TENANT, request_id: held.request_id, outcome: 'MATCHED', result: { valid: true },
    });
    const afterSecond = await getBalance(TENANT);

    expect(second.credits_charged).toBe(first.credits_charged);
    // The balance is the assertion that matters: a dropped connection and a retry
    // must not cost the tenant twice.
    expect(afterSecond.balance).toBe(afterFirst.balance);
    expect(afterSecond.reserved).toBe(afterFirst.reserved);
    const ledger = await listLedger({ tenant_id: TENANT, request_id: held.request_id });
    expect(ledger.map((e) => e.entry_type)).toEqual(['RESERVATION', 'CHARGE']);
  });

  it('refuses a retry that asserts a DIFFERENT settlement', async () => {
    // Merging them means the last retry to arrive decides what was paid.
    const held = await reserve({ tenant_id: TENANT, capability_key: KEY, subject_fingerprint: 'fp-conflict' });
    await settle({ tenant_id: TENANT, request_id: held.request_id, outcome: 'MATCHED', result: {} });
    await expect(
      settle({ tenant_id: TENANT, request_id: held.request_id, outcome: 'NO_MATCH' }),
    ).rejects.toBeInstanceOf(SettlementConflict);
  });

  /* ---------------------------------------------------------- health */

  it('demotes a provider that just failed below one that is answering', async () => {
    // Not removal — DEMOTION. One failure is a bad minute, and the cheapest correct
    // response is to stop asking it first while somebody healthy is answering.
    registerProviderInvoker(PRIMARY, async () => { throw new Error('down'); });
    registerProviderInvoker(SECONDARY, async () => ({ matched: true, result: {} }));
    const held = await reserve({ tenant_id: TENANT, capability_key: KEY, subject_fingerprint: 'fp-demote' });
    await execute({ tenant_id: TENANT, request_id: held.request_id, subject: 'x' });

    const chain = await loadChain(capabilityId);
    expect(chain.map((b) => b.provider_key)).toEqual([SECONDARY, PRIMARY]);
    expect(chain[1].health_state).toBe('DEGRADED');

    // And on the next request the healthy one answers first, so the demoted
    // provider is not even tried — which is why it takes a whole-chain outage,
    // not one bad provider, to reach UNAVAILABLE.
    const next = await reserve({ tenant_id: TENANT, capability_key: KEY, subject_fingerprint: 'fp-demote-2' });
    await execute({ tenant_id: TENANT, request_id: next.request_id, subject: 'x' });
    const attempts = await dataService.rows<{ binding_id: string }>(
      `SELECT binding_id FROM data_credits.provider_attempt WHERE request_id = $1`,
      [next.request_id],
    );
    expect(attempts).toHaveLength(1);
  });

  it('takes a provider out entirely after three consecutive failures', async () => {
    registerProviderInvoker(PRIMARY, async () => { throw new Error('down'); });
    registerProviderInvoker(SECONDARY, async () => { throw new Error('down'); });
    for (let i = 0; i < 3; i++) {
      const held = await reserve({
        tenant_id: TENANT, capability_key: KEY, subject_fingerprint: `fp-health-${i}`,
      });
      await execute({ tenant_id: TENANT, request_id: held.request_id, subject: 'x' });
    }
    expect(await loadChain(capabilityId)).toEqual([]);

    // An empty chain is OUR failure, not an answer about the subject — and it is
    // still free to the tenant.
    const held = await reserve({ tenant_id: TENANT, capability_key: KEY, subject_fingerprint: 'fp-empty' });
    const out = await execute({ tenant_id: TENANT, request_id: held.request_id, subject: 'x' });
    expect(out.outcome).toBe('TECHNICAL_FAILURE');
    expect(out.credits_charged).toBe(0);
  });

  it('re-admits an UNAVAILABLE provider after the cooldown, at the BACK of the chain', async () => {
    /*
     * Found by this suite: without a probe the chain only ever shrinks. Three
     * failures is a blip a vendor recovers from in minutes, but one that is never
     * tried again can never show that it has — so every outage permanently costs a
     * link until the capability has none left. Re-admitting it LAST makes the retry
     * free: a healthy provider still answers first.
     */
    await dataService.query(
      `UPDATE data_credits.provider_binding
          SET health_state = 'UNAVAILABLE', consecutive_failures = 3,
              health_checked_at = now() - interval '10 minutes'
        WHERE capability_id = $1 AND provider_key = $2`,
      [capabilityId, PRIMARY],
    );
    const chain = await loadChain(capabilityId);
    expect(chain.map((b) => b.provider_key)).toEqual([SECONDARY, PRIMARY]);

    // Still cooling down: not in the chain at all.
    await dataService.query(
      `UPDATE data_credits.provider_binding SET health_checked_at = now()
        WHERE capability_id = $1 AND provider_key = $2`,
      [capabilityId, PRIMARY],
    );
    expect((await loadChain(capabilityId)).map((b) => b.provider_key)).toEqual([SECONDARY]);
  });

  it('restores a provider to HEALTHY the moment it answers again', async () => {
    // A provider that answers is healthy regardless of what it did an hour ago;
    // leaving it degraded forever would slowly empty the chain.
    await dataService.query(
      `UPDATE data_credits.provider_binding SET health_state = 'DEGRADED', consecutive_failures = 2
        WHERE capability_id = $1 AND provider_key = $2`,
      [capabilityId, PRIMARY],
    );
    registerProviderInvoker(PRIMARY, async () => ({ matched: true, result: {} }));
    // SECONDARY unwired, so the demoted provider is the one that ends up answering.
    const held = await reserve({ tenant_id: TENANT, capability_key: KEY, subject_fingerprint: 'fp-recover' });
    await execute({ tenant_id: TENANT, request_id: held.request_id, subject: 'x' });
    const restored = await dataService.one<{ health_state: string; consecutive_failures: number }>(
      `SELECT health_state, consecutive_failures FROM data_credits.provider_binding
        WHERE capability_id = $1 AND provider_key = $2`,
      [capabilityId, PRIMARY],
    );
    expect(restored?.health_state).toBe('HEALTHY');
    expect(restored?.consecutive_failures).toBe(0);
  });

  /* ------------------------------------------------------------ metering */

  it('emits usage without letting a metering failure undo a settlement', async () => {
    registerProviderInvoker(PRIMARY, async () => ({ matched: true, result: {} }));
    const seen: Array<{ credits: number; outcome: string }> = [];
    setUsageEmitter(async (u) => {
      seen.push({ credits: u.credits, outcome: u.outcome });
      throw new Error('meter unreachable');
    });
    const before = await getBalance(TENANT);
    const held = await reserve({ tenant_id: TENANT, capability_key: KEY, subject_fingerprint: 'fp-meter' });
    const out = await execute({ tenant_id: TENANT, request_id: held.request_id, subject: 'x' });

    expect(out.outcome).toBe('MATCHED');
    expect(seen).toEqual([{ credits: 2, outcome: 'MATCHED' }]);
    // The balance is the record; metering is a report about it, and a broken report
    // must not roll back money that has already moved.
    const after = await getBalance(TENANT);
    expect(after.balance).toBe(before.balance - 2);
  });

  /* ------------------------------------------------- the opacity contract */

  it('leaks nothing about a vendor across the whole tenant-facing surface', async () => {
    registerProviderInvoker(PRIMARY, async () => { throw new Error('down'); });
    registerProviderInvoker(SECONDARY, async () => ({
      matched: true, result: { valid: true }, true_cost_micros: TRUE_COST,
    }));
    const held = await reserve({ tenant_id: TENANT, capability_key: KEY, subject_fingerprint: 'fp-opacity' });
    const out = await execute({ tenant_id: TENANT, request_id: held.request_id, subject: 'x' });
    const ledger = await listLedger({ tenant_id: TENANT });
    const balance = await getBalance(TENANT);
    const quote = await estimate(TENANT, KEY);

    for (const [payload, where] of [
      [out, 'execute'], [ledger, 'ledger export'], [balance, 'balance'], [quote, 'estimate'],
      [held, 'reserve'],
    ] as const) {
      assertOpaque(payload, where);
    }

    // And the error path, which is the one people forget: an error message naming
    // the vendor that failed is a leak with a stack trace attached.
    let failure: string | null = null;
    try {
      await settle({ tenant_id: TENANT, request_id: held.request_id, outcome: 'NO_MATCH' });
    } catch (err) {
      failure = (err as Error).message;
    }
    expect(failure).not.toBeNull();
    assertOpaque({ message: failure }, 'settlement conflict error');
  });
});
