import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID, createHmac } from 'crypto';
import { initPool, dataService, closeAllPools } from '@projexlight/db-runtime';
import { websiteAdapter, getLeadFormAdapter, LEAD_PLATFORMS } from '../src/adapters/leadFormAdapters';

const PG = {
  host: process.env.TEST_PGHOST || 'localhost',
  port: Number(process.env.TEST_PGPORT || 5432),
  database: process.env.TEST_PGDATABASE || 'projexcloud_db',
  user: process.env.TEST_PGUSER || 'postgres',
  password: process.env.TEST_PGPASSWORD || 'postgres',
};

const SECRET = 'web-signing-secret';
const TENANT = randomUUID();
// Explicit opt-out. Unset (the CI default) means an unreachable database FAILS the
// suite rather than quietly passing it.
const SKIP_DB_TESTS = process.env.SKIP_DB_TESTS === '1';
let dbUp = false;
let ingest: typeof import('../src/services/leadFormIngest');

beforeAll(async () => {
  try {
    initPool({ primary: PG });
    await dataService.query('SELECT 1 FROM connectors.lead_form_event LIMIT 1');
    dbUp = true;
  } catch (err) {
    dbUp = false;
    // FAIL LOUD. A suite that cannot reach its schema has verified nothing, and a run
    // that reports green having verified nothing is worse than a red one — it is a
    // false all-clear that no one investigates. Skipping is still available, but it
    // must be asked for explicitly (SKIP_DB_TESTS=1) and it shows up as SKIPPED.
    if (!SKIP_DB_TESTS) {
      throw new Error(
        `[db-gate] database or schema unavailable, so this suite cannot verify anything: `
        + `${(err as Error).message}
`
        + `  Apply migrations first (MIGRATE_ONLY=1 on the gateway), or set `
        + `SKIP_DB_TESTS=1 to skip these cases visibly instead of passing them silently.`,
      );
    }
    return;
  }
  ingest = await import('../src/services/leadFormIngest');
}, 30_000);

afterAll(async () => {
  if (!dbUp) return;
  await dataService.query(`DELETE FROM connectors.lead_form_event WHERE tenant_id = $1::uuid`, [TENANT]);
  await closeAllPools();
});

const maybe = (name: string, fn: () => Promise<void>) =>
  it(name, async (ctx) => {
    // ctx.skip() marks the case SKIPPED in the reporter. A bare `return` marks it
    // PASSED, which is indistinguishable from the assertions having actually run.
    if (!dbUp) { ctx.skip(); return; }
    await fn();
  });

const sign = (b: string) => createHmac('sha256', SECRET).update(b, 'utf8').digest('hex');

function chatPayload(eventId: string) {
  return {
    event_id: eventId,
    event_kind: 'chat',
    session_id: 'sess-1',
    page_url: 'https://acme.test/pricing',
    page_title: 'Pricing',
    referrer: 'https://google.test/search?q=crm',
    form_id: 'chat-widget-v3',
    form_version: '3.1',
    submitted_at: '2026-08-01T09:00:00Z',
    utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'brand',
    fields: { email: 'jane@acme.test', company: 'Acme Ltd' },
    // Deliberately odd key casing and a string 'true' — the verbatim test depends on it.
    permissions: { Marketing_Opt_In: 'true', consent_ref: 'web-consent-1', wording: 'I agree to be contacted about my enquiry' },
    transcript: [
      { role: 'visitor', text: 'Do you support SSO?', at: '2026-08-01T08:58:00Z' },
      { role: 'bot', text: 'Yes, SAML and OIDC.', at: '2026-08-01T08:58:10Z' },
      { role: 'visitor', text: 'Can I talk to sales?', at: '2026-08-01T08:59:00Z' },
    ],
    handoff: { state: 'human', handed_to: 'agent-7', handed_at: '2026-08-01T08:59:30Z', reason: 'visitor asked for sales' },
  };
}

describe('the website/chat adapter shares the social contract', () => {
  it('is registered as a platform', () => {
    expect(LEAD_PLATFORMS).toContain('WEBSITE');
    expect(getLeadFormAdapter('WEBSITE')).toBeDefined();
  });

  it('verifies signatures exactly as the social adapters do', () => {
    const body = JSON.stringify({ a: 1 });
    expect(websiteAdapter.verifySignature(body, sign(body), SECRET)).toBe(true);
    expect(websiteAdapter.verifySignature(body, sign('other'), SECRET)).toBe(false);
    expect(websiteAdapter.verifySignature(body, undefined, SECRET)).toBe(false);
    expect(() => websiteAdapter.verifySignature(body, 'short', SECRET)).not.toThrow();
  });
});

describe('transcript and handoff state are captured (AC1)', () => {
  it('keeps every turn in order with roles and timestamps', () => {
    const r = websiteAdapter.normalize(chatPayload('web-1'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const transcript = r.lead.context.transcript as Array<{ role: string; text: string }>;
    // The conversation IS the qualifying information; the visitor will not repeat it.
    expect(transcript).toHaveLength(3);
    expect(transcript[0].role).toBe('visitor');
    expect(transcript[2].text).toBe('Can I talk to sales?');
  });

  it('records who took over and when', () => {
    const r = websiteAdapter.normalize(chatPayload('web-2'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const handoff = r.lead.context.handoff as Record<string, string>;
    // Getting this wrong means two reps replying, or nobody.
    expect(handoff.state).toBe('human');
    expect(handoff.handed_to).toBe('agent-7');
    expect(handoff.reason).toBe('visitor asked for sales');
  });

  it('a chat event with NO transcript is refused rather than half-accepted', () => {
    const p = chatPayload('web-3') as Record<string, unknown>;
    p.transcript = [];
    const r = websiteAdapter.normalize(p);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/cannot be reconstructed later/);
  });

  it('a plain form event needs no transcript and defaults handoff to none', () => {
    const r = websiteAdapter.normalize({
      event_id: 'form-1', event_kind: 'demo_request', form_id: 'demo-form',
      fields: { email: 'a@b.test' }, permissions: { opt_in: true },
      page_url: 'https://acme.test/demo', submitted_at: '2026-08-01T09:00:00Z',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.lead.context.handoff as Record<string, string>).state).toBe('none');
  });

  it('captures page, referrer and session context', () => {
    const r = websiteAdapter.normalize(chatPayload('web-4'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lead.context.page_url).toBe('https://acme.test/pricing');
    expect(r.lead.context.referrer).toContain('google.test');
    expect(r.lead.context.session_id).toBe('sess-1');
    expect(r.lead.form_version).toBe('3.1');
    expect(r.lead.attribution.utm_medium).toBe('cpc');
  });

  it('rejects an unknown event kind rather than guessing', () => {
    const p = chatPayload('web-5') as Record<string, unknown>;
    p.event_kind = 'telepathy';
    const r = websiteAdapter.normalize(p);
    expect(r.ok).toBe(false);
  });
});

describe('submitted permission fields are preserved verbatim (AC2)', () => {
  it('keeps the exact keys, casing and values that were submitted', () => {
    const r = websiteAdapter.normalize(chatPayload('web-6'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const raw = r.lead.permission.submitted_raw!;
    // Untouched: odd casing survives, 'true' stays a string, and the wording the person
    // actually agreed to is retained — that wording is what a regulator asks to see.
    expect(raw.Marketing_Opt_In).toBe('true');
    expect(raw.wording).toBe('I agree to be contacted about my enquiry');
    expect(Object.keys(raw)).toEqual(['Marketing_Opt_In', 'consent_ref', 'wording']);
  });

  it('still derives the normalised view for code to use', () => {
    const r = websiteAdapter.normalize(chatPayload('web-7'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lead.permission.granted).toBe(true);
    expect(r.lead.permission.consent_ref).toBe('web-consent-1');
    expect(r.lead.permission.scopes).toContain('Marketing_Opt_In');
  });

  it('a permission block with nothing granted is refused', () => {
    const p = chatPayload('web-8') as Record<string, unknown>;
    p.permissions = { marketing_opt_in: false, consent_ref: 'c' };
    const r = websiteAdapter.normalize(p);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/not granted/);
  });

  it('no permission block at all is refused', () => {
    const p = chatPayload('web-9') as Record<string, unknown>;
    delete p.permissions;
    delete p.form_id;
    const r = websiteAdapter.normalize(p);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/no lawful basis for contact/);
  });
});

describe('idempotency and archiving match the social contract (AC3, AC4)', () => {
  maybe('a repeated delivery is a no-op', async () => {
    const payload = chatPayload('web-replay-1');
    const raw = JSON.stringify(payload);
    const args = {
      tenant_id: TENANT, platform: 'WEBSITE', raw_body: raw,
      signature_header: sign(raw), signing_secret: SECRET, parsed: payload,
    };
    const first = await ingest.ingestLeadForm(args);
    const second = await ingest.ingestLeadForm(args);
    expect(first.outcome).toBe('accepted');
    expect(second.outcome).toBe('duplicate');
    expect(second.event_id).toBe(first.event_id);
  });

  maybe('concurrent deliveries yield exactly one accepted row', async () => {
    const payload = chatPayload('web-race-1');
    const raw = JSON.stringify(payload);
    const args = {
      tenant_id: TENANT, platform: 'WEBSITE', raw_body: raw,
      signature_header: sign(raw), signing_secret: SECRET, parsed: payload,
    };
    const results = await Promise.all(Array.from({ length: 5 }, () => ingest.ingestLeadForm(args)));
    expect(results.filter((r) => r.outcome === 'accepted')).toHaveLength(1);
  });

  maybe('an unsigned website delivery stores nothing', async () => {
    const payload = chatPayload('web-unsigned-1');
    const r = await ingest.ingestLeadForm({
      tenant_id: TENANT, platform: 'WEBSITE', raw_body: JSON.stringify(payload),
      signature_header: undefined, signing_secret: SECRET, parsed: payload,
    });
    expect(r.outcome).toBe('rejected');
    expect(r.archived).toBe(false);
  });

  maybe('a rejected chat event is archived with its bytes intact', async () => {
    const payload = chatPayload('web-reject-1') as Record<string, unknown>;
    payload.transcript = []; // rejected downstream
    const raw = JSON.stringify(payload);

    const r = await ingest.ingestLeadForm({
      tenant_id: TENANT, platform: 'WEBSITE', raw_body: raw,
      signature_header: sign(raw), signing_secret: SECRET, parsed: payload,
    });
    expect(r.outcome).toBe('rejected');
    expect(r.archived).toBe(true);

    const row = await dataService.one<{ raw_body: string; outcome: string; rejection_reason: string }>(
      `SELECT raw_body, outcome, rejection_reason FROM connectors.lead_form_event
        WHERE tenant_id = $1::uuid AND source_event_id = 'web-reject-1'`, [TENANT],
    );
    expect(row!.outcome).toBe('rejected');
    // Byte-exact, so the signature remains re-verifiable for audit.
    expect(row!.raw_body).toBe(raw);
    expect(websiteAdapter.verifySignature(row!.raw_body, sign(row!.raw_body), SECRET)).toBe(true);
  });

  maybe('the archived permission block survives verbatim through the round trip', async () => {
    const payload = chatPayload('web-verbatim-1');
    const raw = JSON.stringify(payload);
    await ingest.ingestLeadForm({
      tenant_id: TENANT, platform: 'WEBSITE', raw_body: raw,
      signature_header: sign(raw), signing_secret: SECRET, parsed: payload,
    });
    const row = await dataService.one<{ normalized: { permission: { submitted_raw: Record<string, unknown> } } }>(
      `SELECT normalized FROM connectors.lead_form_event
        WHERE tenant_id = $1::uuid AND source_event_id = 'web-verbatim-1'`, [TENANT],
    );
    expect(row!.normalized.permission.submitted_raw.Marketing_Opt_In).toBe('true');
    expect(row!.normalized.permission.submitted_raw.wording).toBe('I agree to be contacted about my enquiry');
  });
});
