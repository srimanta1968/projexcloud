import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID, createHmac } from 'crypto';
import { initPool, dataService, closeAllPools } from '@projexlight/db-runtime';
import {
  verifyAdapterSignature,
  metaAdapter, linkedInAdapter, tiktokAdapter, googleAdapter,
  getLeadFormAdapter, listLeadFormAdapters,
} from '../src/adapters/leadFormAdapters';

const PG = {
  host: process.env.TEST_PGHOST || 'localhost',
  port: Number(process.env.TEST_PGPORT || 5432),
  database: process.env.TEST_PGDATABASE || 'projexcloud_db',
  user: process.env.TEST_PGUSER || 'postgres',
  password: process.env.TEST_PGPASSWORD || 'postgres',
};

const SECRET = 'test-signing-secret';
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

const sign = (body: string) => createHmac('sha256', SECRET).update(body, 'utf8').digest('hex');

function metaPayload(leadgenId: string) {
  return {
    entry: [{
      id: 'page-1',
      changes: [{
        value: {
          leadgen_id: leadgenId, form_id: 'form-9', form_version: 'v2',
          campaign_id: 'camp-1', ad_id: 'ad-2', creative_id: 'cr-3',
          created_time: '2026-08-01T09:00:00Z', platform: 'instagram',
          thread_id: 'dm-77', comment_id: 'cm-88',
          consent: { consent_ref: 'consent-abc', granted: true, granted_at: '2026-08-01T09:00:00Z' },
          permission_fields: ['marketing_opt_in'],
          field_data: [
            { name: 'email', values: ['jane@acme.test'] },
            { name: 'full_name', values: ['Jane Okonkwo'] },
          ],
        },
      }],
    }],
  };
}

describe('every adapter captures its full field set including permission evidence (AC1)', () => {
  it('the four social platforms are registered (WEBSITE is added by the web/chat task)', () => {
    expect(listLeadFormAdapters().sort()).toEqual(['GOOGLE', 'LINKEDIN', 'META', 'TIKTOK', 'WEBSITE']);
  });

  it('META captures form, campaign, creative, DM/comment context and permission', () => {
    const r = metaAdapter.normalize(metaPayload('lead-1'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lead.form_id).toBe('form-9');
    expect(r.lead.form_version).toBe('v2');
    expect(r.lead.campaign_id).toBe('camp-1');
    expect(r.lead.creative_id).toBe('cr-3');
    expect(r.lead.fields.email).toBe('jane@acme.test');
    // DM/comment provenance — needed to reply where the person expects.
    expect(r.lead.context.dm_thread_id).toBe('dm-77');
    expect(r.lead.context.comment_id).toBe('cm-88');
    expect(r.lead.permission.granted).toBe(true);
    expect(r.lead.permission.consent_ref).toBe('consent-abc');
    expect(r.lead.permission.scopes).toContain('marketing_opt_in');
  });

  it('LINKEDIN captures company and profile context', () => {
    const r = linkedInAdapter.normalize({
      leadId: 'li-1', formId: 'f-1', campaignId: 'c-1', creativeId: 'cr-1',
      submittedAt: '2026-08-01T09:00:00Z',
      memberUrn: 'urn:li:person:123', companyUrn: 'urn:li:org:456', companyName: 'Acme Ltd',
      conversationUrn: 'urn:li:conv:9',
      consentResponses: [{ consentId: 'li-consent-1', accepted: true }],
      formResponse: [{ questionId: 'email', answers: ['jane@acme.test'] }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The firmographic signal is the whole reason this channel is worth more.
    expect(r.lead.context.company_name).toBe('Acme Ltd');
    expect(r.lead.context.member_profile_urn).toBe('urn:li:person:123');
    expect(r.lead.permission.scopes).toContain('li-consent-1');
  });

  it('TIKTOK captures click id and campaign attribution', () => {
    const r = tiktokAdapter.normalize({
      lead_id: 'tt-1', page_id: 'p-1', campaign_id: 'c-1', ad_id: 'a-1',
      ttclid: 'ttclid-xyz', create_time: '2026-08-01T09:00:00Z',
      consent_id: 'tt-consent', consent_granted: true,
      permission_fields: ['sms_opt_in'],
      field_data: [{ name: 'phone', values: ['+15550100'] }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lead.attribution.ttclid).toBe('ttclid-xyz');
    expect(r.lead.permission.scopes).toContain('sms_opt_in');
  });

  it('GOOGLE captures gclid, UTM and form proof', () => {
    const r = googleAdapter.normalize({
      lead_id: 'g-1', form_id: 'gf-1', campaign_id: 'gc-1', gcl_id: 'gclid-1',
      google_key: 'form-proof-abc', lead_submission_time: '2026-08-01T09:00:00Z',
      utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'brand',
      consent_fields: ['lead_consent'],
      user_column_data: [{ column_id: 'EMAIL', string_value: 'jane@acme.test' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lead.attribution.gclid).toBe('gclid-1');
    expect(r.lead.attribution.utm_medium).toBe('cpc');
    expect(r.lead.permission.consent_ref).toBe('form-proof-abc');
  });

  it('a payload with NO permission evidence is refused, not defaulted', () => {
    const p = metaPayload('lead-noperm') as Record<string, never>;
    const value = (p.entry as never as Array<Record<string, never>>)[0].changes[0].value;
    delete (value as Record<string, unknown>).consent;
    delete (value as Record<string, unknown>).permission_fields;
    (value as Record<string, unknown>).field_data = [{ name: 'email', values: ['x@y.test'] }];
    (value as Record<string, unknown>).form_id = null;
    const r = metaAdapter.normalize(p);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // A lead with no recorded consent has no lawful basis for contact.
    expect(r.reason).toMatch(/no lawful basis for contact/);
  });

  it('permission present but NOT granted is refused', () => {
    const p = metaPayload('lead-declined');
    (p.entry[0].changes[0].value.consent as Record<string, unknown>).granted = false;
    const r = metaAdapter.normalize(p);
    expect(r.ok).toBe(false);
  });

  it('GOOGLE without a form proof is refused even though the transport was signed', () => {
    const r = googleAdapter.normalize({
      lead_id: 'g-2', consent_fields: ['c'],
      user_column_data: [{ column_id: 'EMAIL', string_value: 'a@b.test' }],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // Transport signature proves it came from Google; the form proof proves it came from
    // THIS advertiser's form. Accepting one as the other allows cross-account injection.
    expect(r.reason).toMatch(/form proof/);
  });

  it('GOOGLE without an email or phone is refused as uncontactable', () => {
    const r = googleAdapter.normalize({
      lead_id: 'g-3', google_key: 'proof', consent_fields: ['c'],
      user_column_data: [{ column_id: 'CITY', string_value: 'Leeds' }],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/uncontactable/);
  });
});

describe('signature verification rejects unsigned or wrongly-signed payloads (AC2)', () => {
  const body = JSON.stringify({ hello: 'world' });

  it('accepts a correct signature and rejects a wrong or missing one', () => {
    expect(verifyAdapterSignature(metaAdapter, body, `sha256=${sign(body)}`, SECRET)).toBe(true);
    expect(verifyAdapterSignature(metaAdapter, body, `sha256=${sign('tampered')}`, SECRET)).toBe(false);
    expect(verifyAdapterSignature(metaAdapter, body, undefined, SECRET)).toBe(false);
    // Meta always prefixes sha256=; a bare hex header is not a Meta delivery.
    expect(verifyAdapterSignature(metaAdapter, body, sign(body), SECRET)).toBe(false);
  });

  it('rejects a signature computed with a different secret', () => {
    const foreign = createHmac('sha256', 'someone-elses-secret').update(body).digest('hex');
    expect(verifyAdapterSignature(linkedInAdapter, body, foreign, SECRET)).toBe(false);
    expect(verifyAdapterSignature(tiktokAdapter, body, foreign, SECRET)).toBe(false);
    expect(verifyAdapterSignature(googleAdapter, body, foreign, SECRET)).toBe(false);
  });

  it('a signature of a different length is rejected without throwing', () => {
    // timingSafeEqual throws on length mismatch unless guarded.
    expect(() => verifyAdapterSignature(linkedInAdapter, body, 'short', SECRET)).not.toThrow();
    expect(verifyAdapterSignature(linkedInAdapter, body, 'short', SECRET)).toBe(false);
  });

  maybe('an unsigned delivery stores NOTHING', async () => {
    const before = await dataService.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM connectors.lead_form_event WHERE tenant_id = $1::uuid`, [TENANT],
    );
    const r = await ingest.ingestLeadForm({
      tenant_id: TENANT, platform: 'META',
      raw_body: JSON.stringify(metaPayload('unsigned-1')),
      signature_header: undefined, signing_secret: SECRET,
    });
    expect(r.outcome).toBe('rejected');
    // Deliberately NOT archived — otherwise anyone could fill the tenant's archive.
    expect(r.archived).toBe(false);
    const after = await dataService.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM connectors.lead_form_event WHERE tenant_id = $1::uuid`, [TENANT],
    );
    expect(after!.n).toBe(before!.n);
  });
});

describe('a replayed delivery is a no-op (AC3)', () => {
  maybe('the second and third deliveries of the same event create nothing new', async () => {
    const payload = metaPayload('replay-lead-1');
    const raw = JSON.stringify(payload);
    const args = {
      tenant_id: TENANT, platform: 'META', raw_body: raw,
      signature_header: `sha256=${sign(raw)}`, signing_secret: SECRET, parsed: payload,
    };

    const first = await ingest.ingestLeadForm(args);
    const second = await ingest.ingestLeadForm(args);
    const third = await ingest.ingestLeadForm(args);

    expect(first.outcome).toBe('accepted');
    expect(second.outcome).toBe('duplicate');
    expect(third.outcome).toBe('duplicate');
    expect(second.event_id).toBe(first.event_id);

    const rows = await dataService.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM connectors.lead_form_event
        WHERE tenant_id = $1::uuid AND source_event_id = 'replay-lead-1'`, [TENANT],
    );
    expect(rows!.n).toBe('1');
  });

  maybe('CONCURRENT deliveries of one event yield exactly one accepted row', async () => {
    const payload = metaPayload('race-lead-1');
    const raw = JSON.stringify(payload);
    const args = {
      tenant_id: TENANT, platform: 'META', raw_body: raw,
      signature_header: `sha256=${sign(raw)}`, signing_secret: SECRET, parsed: payload,
    };
    // Providers deliver to several workers at once; a read-then-write check would let
    // more than one of these create a lead from a single form submission.
    const results = await Promise.all(Array.from({ length: 6 }, () => ingest.ingestLeadForm(args)));
    expect(results.filter((r) => r.outcome === 'accepted')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'duplicate')).toHaveLength(5);
  });
});

describe('raw payload is archived even on downstream rejection (AC4)', () => {
  maybe('a normalisation failure still stores the verbatim payload', async () => {
    // Signed correctly, but with no permission evidence — rejected downstream.
    const payload = metaPayload('reject-lead-1') as Record<string, never>;
    const value = (payload.entry as never as Array<Record<string, never>>)[0].changes[0].value as Record<string, unknown>;
    delete value.consent;
    delete value.permission_fields;
    value.form_id = null;
    value.field_data = [{ name: 'email', values: ['x@y.test'] }];
    const raw = JSON.stringify(payload);

    const r = await ingest.ingestLeadForm({
      tenant_id: TENANT, platform: 'META', raw_body: raw,
      signature_header: `sha256=${sign(raw)}`, signing_secret: SECRET, parsed: payload,
    });

    expect(r.outcome).toBe('rejected');
    // The lead form is the only record the person filled it in; the platform will not
    // re-send it, so losing the payload on a mapping bug would lose the lead itself.
    expect(r.archived).toBe(true);

    const row = await dataService.one<{ raw_payload: Record<string, unknown>; raw_body: string; rejection_reason: string; outcome: string }>(
      `SELECT raw_payload, raw_body, rejection_reason, outcome FROM connectors.lead_form_event
        WHERE tenant_id = $1::uuid AND source_event_id = 'reject-lead-1'`, [TENANT],
    );
    expect(row).not.toBeNull();
    expect(row!.outcome).toBe('rejected');
    expect(row!.rejection_reason).toMatch(/lawful basis/);

    // raw_body is BYTE-EXACT. This is the stronger assertion and the one that matters:
    // an HMAC is over bytes, so only this column could ever let the signature be
    // re-verified later. jsonb cannot — it reorders keys, which is exactly what this
    // test discovered when it compared the jsonb round-trip instead.
    expect(row!.raw_body).toBe(raw);

    // raw_payload preserves the same CONTENT for querying, key order aside.
    expect(row!.raw_payload).toEqual(payload);
  });

  maybe('the archived bytes still verify against the original signature', async () => {
    const row = await dataService.one<{ raw_body: string }>(
      `SELECT raw_body FROM connectors.lead_form_event
        WHERE tenant_id = $1::uuid AND source_event_id = 'reject-lead-1'`, [TENANT],
    );
    // The point of storing bytes: months later, the archive can still prove the provider
    // really sent this. Re-serialising from jsonb would fail this check.
    expect(verifyAdapterSignature(metaAdapter, row!.raw_body, `sha256=${sign(row!.raw_body)}`, SECRET)).toBe(true);
  });

  maybe('a rejected delivery can be re-processed once the payload is fixable', async () => {
    const row = await dataService.one<{ event_id: string }>(
      `SELECT event_id::text FROM connectors.lead_form_event
        WHERE tenant_id = $1::uuid AND source_event_id = 'reject-lead-1'`, [TENANT],
    );
    // Repair the archived payload the way a corrected mapping would read it.
    await dataService.query(
      `UPDATE connectors.lead_form_event
          SET raw_payload = jsonb_set(raw_payload,
                '{entry,0,changes,0,value,consent}',
                '{"consent_ref":"recovered","granted":true}'::jsonb, true)
        WHERE event_id = $1::uuid`,
      [row!.event_id],
    );
    const again = await ingest.reprocessLeadFormEvent({ tenant_id: TENANT, event_id: row!.event_id });
    // This recovery is only possible BECAUSE the raw payload was archived on rejection.
    expect(again.outcome).toBe('accepted');
    expect(again.lead?.permission.consent_ref).toBe('recovered');
  });

  maybe('rejected events are listable so they can be triaged', async () => {
    const rejected = await ingest.listLeadFormEvents({ tenant_id: TENANT, outcome: 'rejected' });
    for (const e of rejected) expect(e.has_raw).toBe(true);
  });

  maybe('an unknown platform is refused rather than silently dropped', async () => {
    await expect(ingest.ingestLeadForm({
      tenant_id: TENANT, platform: 'MYSPACE', raw_body: '{}',
      signature_header: 'x', signing_secret: SECRET,
    })).rejects.toThrow(/no lead-form adapter/);
  });

  it('getLeadFormAdapter returns undefined for an unknown platform', () => {
    expect(getLeadFormAdapter('MYSPACE')).toBeUndefined();
  });
});
