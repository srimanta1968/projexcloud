import { dataService } from '@projexlight/db-runtime';
import {
  getLeadFormAdapter,
  verifyAdapterSignature,
  type LeadPlatform,
  type NormalizedLead,
} from '../adapters/leadFormAdapters';

/**
 * Lead-form ingestion (P16 · EP-386).
 *
 * The ORDER of the four steps is the whole design, and each boundary is deliberate:
 *
 *   1. VERIFY SIGNATURE — before anything is stored. An unsigned or wrongly-signed
 *      delivery is not a rejected lead, it is not a lead at all; archiving it would let
 *      anyone fill the tenant's table with junk they would then have to triage.
 *   2. RESERVE the (tenant, platform, source_event_id) row. The INSERT is the replay
 *      check: if it inserts nothing, this delivery has already been handled.
 *   3. ARCHIVE the raw payload as part of that same insert — BEFORE normalisation is
 *      allowed to have an opinion about it.
 *   4. NORMALISE, and record the outcome against the row that already exists.
 *
 * Step 3 before step 4 is what makes "raw archived even on downstream rejection" true by
 * construction rather than by remembering to catch an exception. A lead form is the only
 * record that the person filled it in and the platform will not re-send it, so a mapping
 * bug must cost a re-process, not the lead.
 */

export type IngestOutcome = 'accepted' | 'rejected' | 'duplicate';

export interface IngestResult {
  outcome: IngestOutcome;
  event_id: string | null;
  platform: LeadPlatform;
  source_event_id: string | null;
  lead?: NormalizedLead;
  reason?: string;
  /** True whenever the raw payload is safely stored — including on rejection. */
  archived: boolean;
}

export interface IngestLeadFormInput {
  tenant_id: string;
  platform: string;
  /** The EXACT bytes the provider signed. Re-serialising JSON breaks the HMAC. */
  raw_body: string;
  signature_header: string | undefined;
  signing_secret: string;
  parsed?: unknown;
}

export async function ingestLeadForm(input: IngestLeadFormInput): Promise<IngestResult> {
  const adapter = getLeadFormAdapter(input.platform);
  if (!adapter) {
    throw new Error(
      `[sdk-connectors] no lead-form adapter for platform '${input.platform}'`,
    );
  }
  const platform = adapter.platform;

  // ---- 1. Signature: the trust boundary. Nothing is stored before it passes. ----
  if (!input.signing_secret) {
    return {
      outcome: 'rejected', event_id: null, platform, source_event_id: null,
      reason: 'no signing secret configured for this tenant/platform',
      archived: false,
    };
  }
  const verified = verifyAdapterSignature(
    adapter,
    input.raw_body,
    input.signature_header,
    input.signing_secret,
  );
  if (!verified) {
    return {
      outcome: 'rejected', event_id: null, platform, source_event_id: null,
      reason: `invalid or missing ${adapter.signatureHeader} signature`,
      // Deliberately NOT archived: an unsigned payload is not a lead, and storing it
      // would let anyone fill the tenant's archive with material to triage.
      archived: false,
    };
  }

  let payload: unknown = input.parsed;
  if (payload === undefined) {
    try {
      payload = JSON.parse(input.raw_body);
    } catch {
      return {
        outcome: 'rejected', event_id: null, platform, source_event_id: null,
        reason: 'signed body is not valid JSON', archived: false,
      };
    }
  }

  const source_event_id = adapter.extractSourceEventId(payload);
  if (!source_event_id) {
    return {
      outcome: 'rejected', event_id: null, platform, source_event_id: null,
      reason: 'payload carries no provider event id, so the delivery cannot be de-duplicated',
      archived: false,
    };
  }

  // ---- 2 + 3. Reserve and archive in ONE statement. ----
  const inserted = await dataService.one<{ event_id: string }>(
    `INSERT INTO connectors.lead_form_event
       (tenant_id, platform, source_event_id, raw_payload, raw_body, signature_verified, outcome)
     VALUES ($1::uuid, $2, $3, $4::jsonb, $5, TRUE, 'accepted')
     ON CONFLICT (tenant_id, platform, source_event_id) DO NOTHING
     RETURNING event_id::text`,
    // raw_body is the signed bytes verbatim; raw_payload is the queryable parse of them.
    [input.tenant_id, platform, source_event_id, JSON.stringify(payload), input.raw_body],
  );

  if (!inserted) {
    // A replay. Returning the ORIGINAL outcome rather than re-processing is what makes
    // this a no-op: re-normalising could produce a second downstream record from one
    // form submission, which is precisely what the provider's retries would cause.
    const existing = await dataService.one<{ event_id: string; outcome: string; normalized: NormalizedLead | null }>(
      `SELECT event_id::text, outcome, normalized
         FROM connectors.lead_form_event
        WHERE tenant_id = $1::uuid AND platform = $2 AND source_event_id = $3`,
      [input.tenant_id, platform, source_event_id],
    );
    return {
      outcome: 'duplicate',
      event_id: existing?.event_id ?? null,
      platform,
      source_event_id,
      lead: existing?.normalized ?? undefined,
      reason: `already ingested (original outcome: ${existing?.outcome ?? 'unknown'})`,
      archived: true,
    };
  }

  // ---- 4. Normalise. The raw payload is already safe whatever happens here. ----
  const normalized = adapter.normalize(payload);
  if (!normalized.ok) {
    await dataService.query(
      `UPDATE connectors.lead_form_event
          SET outcome = 'rejected', rejection_reason = $2, processed_at = now()
        WHERE event_id = $1::uuid`,
      [inserted.event_id, normalized.reason],
    );
    return {
      outcome: 'rejected',
      event_id: inserted.event_id,
      platform,
      source_event_id,
      reason: normalized.reason,
      // The point of the ordering: rejected, but the evidence survives and the row can be
      // re-processed once the mapping is fixed.
      archived: true,
    };
  }

  await dataService.query(
    `UPDATE connectors.lead_form_event
        SET normalized = $2::jsonb, form_id = $3, campaign_id = $4,
            outcome = 'accepted', processed_at = now()
      WHERE event_id = $1::uuid`,
    [
      inserted.event_id,
      JSON.stringify(normalized.lead),
      normalized.lead.form_id,
      normalized.lead.campaign_id,
    ],
  );

  return {
    outcome: 'accepted',
    event_id: inserted.event_id,
    platform,
    source_event_id,
    lead: normalized.lead,
    archived: true,
  };
}

export async function listLeadFormEvents(input: {
  tenant_id: string;
  platform?: string;
  outcome?: IngestOutcome;
  limit?: number;
}): Promise<Array<{
  event_id: string;
  platform: string;
  source_event_id: string;
  outcome: string;
  rejection_reason: string | null;
  form_id: string | null;
  campaign_id: string | null;
  received_at: string;
  has_raw: boolean;
}>> {
  const res = await dataService.query<{
    event_id: string; platform: string; source_event_id: string; outcome: string;
    rejection_reason: string | null; form_id: string | null; campaign_id: string | null;
    received_at: Date; has_raw: boolean;
  }>(
    `SELECT event_id::text, platform, source_event_id, outcome, rejection_reason,
            form_id, campaign_id, received_at,
            (raw_payload IS NOT NULL) AS has_raw
       FROM connectors.lead_form_event
      WHERE tenant_id = $1::uuid
        AND ($2::text IS NULL OR platform = $2)
        AND ($3::text IS NULL OR outcome = $3)
      ORDER BY received_at DESC
      LIMIT $4`,
    [
      input.tenant_id,
      input.platform ?? null,
      input.outcome ?? null,
      Math.min(Math.max(input.limit ?? 100, 1), 500),
    ],
  );
  return res.rows.map((r) => ({ ...r, received_at: r.received_at.toISOString() }));
}

/**
 * Re-run normalisation over a previously rejected delivery.
 *
 * This is the payoff for archiving raw: a mapping fixed today can recover leads rejected
 * last week, which would be impossible had the payload been discarded on rejection.
 */
export async function reprocessLeadFormEvent(input: {
  tenant_id: string;
  event_id: string;
}): Promise<IngestResult> {
  const row = await dataService.one<{ platform: string; source_event_id: string; raw_payload: unknown }>(
    `SELECT platform, source_event_id, raw_payload
       FROM connectors.lead_form_event
      WHERE tenant_id = $1::uuid AND event_id = $2::uuid`,
    [input.tenant_id, input.event_id],
  );
  if (!row) throw new Error(`[sdk-connectors] lead-form event ${input.event_id} not found`);

  const adapter = getLeadFormAdapter(row.platform);
  if (!adapter) throw new Error(`[sdk-connectors] no adapter for platform '${row.platform}'`);

  const normalized = adapter.normalize(row.raw_payload);
  if (!normalized.ok) {
    await dataService.query(
      `UPDATE connectors.lead_form_event
          SET outcome = 'rejected', rejection_reason = $2, processed_at = now()
        WHERE event_id = $1::uuid`,
      [input.event_id, normalized.reason],
    );
    return {
      outcome: 'rejected', event_id: input.event_id, platform: row.platform as LeadPlatform,
      source_event_id: row.source_event_id, reason: normalized.reason, archived: true,
    };
  }

  await dataService.query(
    `UPDATE connectors.lead_form_event
        SET normalized = $2::jsonb, form_id = $3, campaign_id = $4,
            outcome = 'accepted', rejection_reason = NULL, processed_at = now()
      WHERE event_id = $1::uuid`,
    [input.event_id, JSON.stringify(normalized.lead), normalized.lead.form_id, normalized.lead.campaign_id],
  );
  return {
    outcome: 'accepted', event_id: input.event_id, platform: row.platform as LeadPlatform,
    source_event_id: row.source_event_id, lead: normalized.lead, archived: true,
  };
}
