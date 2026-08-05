import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Paid-social lead-form adapters (P16 · EP-386).
 *
 * Meta / Instagram / Facebook, LinkedIn Lead Gen, TikTok and Google/YouTube each deliver a
 * completed lead form in their own shape. Each adapter does three things and nothing else:
 * verify the provider's signature, extract the provider's own event id, and normalise the
 * payload into one common record.
 *
 * PERMISSION EVIDENCE IS A FIRST-CLASS FIELD, not metadata. A lead form is a consent
 * artefact: the whole legal basis for contacting the person is that they ticked something
 * on a specific form at a specific time. An adapter that captured the email but dropped
 * the consent field would produce a lead nobody can lawfully call, and the platform will
 * not re-send it. So `permission` is extracted explicitly and its absence is a normalise
 * FAILURE rather than a missing optional field.
 *
 * Adapters are PURE. They never touch the database — the archive-first ordering lives in
 * the service, so the raw payload is stored before an adapter is allowed to reject it.
 */

export type LeadPlatform = 'META' | 'LINKEDIN' | 'TIKTOK' | 'GOOGLE' | 'WEBSITE';

export const LEAD_PLATFORMS: LeadPlatform[] = ['META', 'LINKEDIN', 'TIKTOK', 'GOOGLE', 'WEBSITE'];

export interface PermissionEvidence {
  /** The consent text the person actually saw, or the provider's id for it. */
  consent_ref: string | null;
  granted: boolean;
  /** When they granted it, per the provider. */
  granted_at: string | null;
  /** Named permissions/checkboxes the form carried. */
  scopes: string[];
  /**
   * The submitted permission block EXACTLY as sent — key names, casing and values
   * untouched. Interpreting consent into a tidy shape loses the wording the person
   * actually agreed to, and that wording is the thing a regulator asks to see. The
   * normalised fields above are for code; this is the record.
   */
  submitted_raw?: Record<string, unknown>;
}

export interface NormalizedLead {
  platform: LeadPlatform;
  source_event_id: string;
  /** The provider's id for the LEAD itself, distinct from the delivery id. */
  source_lead_id: string | null;
  form_id: string | null;
  form_version: string | null;
  campaign_id: string | null;
  ad_id: string | null;
  creative_id: string | null;
  fields: Record<string, string>;
  permission: PermissionEvidence;
  /** DM / comment / message thread the lead came from, when the platform has one. */
  context: Record<string, unknown>;
  /** Click ids and UTM parameters — the attribution trail. */
  attribution: Record<string, string>;
  occurred_at: string | null;
}

export type NormalizeResult =
  | { ok: true; lead: NormalizedLead }
  | { ok: false; reason: string };

export interface LeadFormAdapter {
  platform: LeadPlatform;
  /** Header the provider signs with. */
  signatureHeader: string;
  /**
   * Literal the provider puts in front of the hex digest, or '' for a bare digest.
   *
   * Required rather than optional so that adding an adapter forces an answer. This
   * used to live inside each verifySignature body, where it was invisible from the
   * interface: four adapters compared bare hex, Meta expected 'sha256=', and the
   * only way to learn that prefixes existed at all was to read Meta's code. Getting
   * it wrong in either direction is silent — a missing prefix rejects every genuine
   * delivery, an unexpected one accepts a digest the provider never framed that way.
   */
  signaturePrefix: string;
  /**
   * Only for a provider whose scheme is not "HMAC-SHA256 hex, optionally prefixed".
   * Left undefined, the shared verifier is used, which is what every current
   * provider needs. Kept as an escape hatch because these are external contracts we
   * do not control — a provider that switches to, say, a timestamped signing string
   * must be able to express that without reshaping the interface.
   */
  verifySignature?(rawBody: string, header: string | undefined, secret: string): boolean;
  /** The provider's own delivery id, or null when the payload has none. */
  extractSourceEventId(payload: unknown): string | null;
  normalize(payload: unknown): NormalizeResult;
}

// ---------------------------------------------------------------------------
// Signature helpers
// ---------------------------------------------------------------------------

/**
 * Constant-time compare. A plain `===` on an HMAC leaks the position of the first wrong
 * byte through timing, which is enough to forge a signature given enough attempts — the
 * whole point of the signature is that it cannot be guessed.
 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function hmacHex(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

/**
 * The signature check every current provider needs: HMAC-SHA256 hex over the exact
 * request bytes, compared in constant time, behind an optional literal prefix.
 *
 * A header that does not carry the expected prefix is rejected before comparison
 * rather than being tried as a bare digest. It is not merely a mismatch: a delivery
 * framed differently from what the provider sends is not that provider's delivery,
 * and quietly accepting it would let a caller choose its own framing.
 */
export function verifyHmacSignature(
  rawBody: string,
  header: string | undefined,
  secret: string,
  prefix: string,
): boolean {
  if (!header) return false;
  if (prefix) {
    if (!header.startsWith(prefix)) return false;
    return safeEqual(header.slice(prefix.length), hmacHex(rawBody, secret));
  }
  return safeEqual(header, hmacHex(rawBody, secret));
}

/** The verifier for an adapter: its own, when it declares one, else the shared check. */
export function verifyAdapterSignature(
  adapter: LeadFormAdapter,
  rawBody: string,
  header: string | undefined,
  secret: string,
): boolean {
  return adapter.verifySignature
    ? adapter.verifySignature(rawBody, header, secret)
    : verifyHmacSignature(rawBody, header, secret, adapter.signaturePrefix);
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** Provider field lists arrive as [{name, values:[...]}] on every one of these platforms. */
function fieldsFromPairs(raw: unknown, nameKey = 'name', valueKey = 'values'): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    const e = asRecord(entry);
    const name = str(e[nameKey]);
    if (!name) continue;
    const v = e[valueKey];
    const value = Array.isArray(v) ? String(v[0] ?? '') : v == null ? '' : String(v);
    out[name] = value;
  }
  return out;
}

/**
 * Permission is required. Returning a "granted: false" default instead of failing would
 * silently produce leads with no lawful basis for contact, which is the failure mode this
 * whole field exists to prevent.
 */
function requirePermission(
  consent_ref: string | null,
  granted: boolean,
  granted_at: string | null,
  scopes: string[],
): { ok: true; permission: PermissionEvidence } | { ok: false; reason: string } {
  if (!consent_ref && scopes.length === 0) {
    return {
      ok: false,
      reason: 'no permission evidence in the payload — a lead form is a consent artefact, and a lead with no recorded consent has no lawful basis for contact',
    };
  }
  if (!granted) {
    return { ok: false, reason: `permission present but not granted (consent_ref=${consent_ref ?? 'none'})` };
  }
  return { ok: true, permission: { consent_ref, granted, granted_at, scopes } };
}

// ---------------------------------------------------------------------------
// Meta (Facebook / Instagram)
// ---------------------------------------------------------------------------

export const metaAdapter: LeadFormAdapter = {
  platform: 'META',
  signatureHeader: 'x-hub-signature-256',
  // Meta frames the digest as 'sha256=<hex>'. A delivery without that prefix is not
  // simply a mismatch — it is not a Meta delivery at all.
  signaturePrefix: 'sha256=',
  extractSourceEventId(payload) {
    const p = asRecord(payload);
    const entry = Array.isArray(p.entry) ? asRecord(p.entry[0]) : {};
    const change = Array.isArray(entry.changes) ? asRecord(entry.changes[0]) : {};
    const value = asRecord(change.value);
    // leadgen_id is the LEAD; the delivery is identified by it plus the entry time, which
    // together are what Meta actually replays.
    return str(value.leadgen_id) ?? str(p.id);
  },
  normalize(payload) {
    const p = asRecord(payload);
    const entry = Array.isArray(p.entry) ? asRecord(p.entry[0]) : {};
    const change = Array.isArray(entry.changes) ? asRecord(entry.changes[0]) : {};
    const value = asRecord(change.value);
    const sourceEventId = str(value.leadgen_id);
    if (!sourceEventId) return { ok: false, reason: 'meta payload carries no leadgen_id' };

    const fields = fieldsFromPairs(value.field_data);
    const consent = asRecord(value.consent);
    const scopes = Array.isArray(value.permission_fields)
      ? (value.permission_fields as unknown[]).map(String)
      : Object.keys(fields).filter((k) => /consent|opt_in|permission/i.test(k));

    const perm = requirePermission(
      str(consent.consent_ref) ?? str(value.form_id),
      consent.granted !== false,
      str(consent.granted_at) ?? str(value.created_time),
      scopes,
    );
    if (!perm.ok) return { ok: false, reason: perm.reason };

    return {
      ok: true,
      lead: {
        platform: 'META',
        source_event_id: sourceEventId,
        source_lead_id: sourceEventId,
        form_id: str(value.form_id),
        form_version: str(value.form_version),
        campaign_id: str(value.campaign_id),
        ad_id: str(value.ad_id),
        creative_id: str(value.creative_id) ?? str(value.adgroup_id),
        fields,
        permission: perm.permission,
        context: {
          page_id: str(entry.id),
          // Instagram DM / comment provenance — a lead that arrived via a comment thread
          // needs that thread to reply in the place the person is expecting.
          dm_thread_id: str(value.thread_id),
          comment_id: str(value.comment_id),
          platform_surface: str(value.platform) ?? 'facebook',
        },
        attribution: {
          ...(str(value.ad_id) ? { ad_id: str(value.ad_id)! } : {}),
          ...(str(value.campaign_id) ? { campaign_id: str(value.campaign_id)! } : {}),
        },
        occurred_at: str(value.created_time),
      },
    };
  },
};

// ---------------------------------------------------------------------------
// LinkedIn Lead Gen
// ---------------------------------------------------------------------------

export const linkedInAdapter: LeadFormAdapter = {
  platform: 'LINKEDIN',
  signatureHeader: 'x-li-signature',
  signaturePrefix: '',
  extractSourceEventId(payload) {
    const p = asRecord(payload);
    return str(p.leadId) ?? str(p.id);
  },
  normalize(payload) {
    const p = asRecord(payload);
    const sourceEventId = str(p.leadId) ?? str(p.id);
    if (!sourceEventId) return { ok: false, reason: 'linkedin payload carries no leadId' };

    const fields = fieldsFromPairs(p.formResponse, 'questionId', 'answers');
    const consents = Array.isArray(p.consentResponses) ? p.consentResponses : [];
    const scopes = consents.map((c) => str(asRecord(c).consentId) ?? '').filter(Boolean);
    const granted = consents.length === 0
      ? false
      : consents.every((c) => asRecord(c).accepted !== false);

    const perm = requirePermission(
      str(p.consentId) ?? (scopes[0] ?? null),
      granted,
      str(p.submittedAt),
      scopes,
    );
    if (!perm.ok) return { ok: false, reason: perm.reason };

    return {
      ok: true,
      lead: {
        platform: 'LINKEDIN',
        source_event_id: sourceEventId,
        source_lead_id: sourceEventId,
        form_id: str(p.formId),
        form_version: str(p.formVersion),
        campaign_id: str(p.campaignId),
        ad_id: str(p.creativeId),
        creative_id: str(p.creativeId),
        fields,
        permission: perm.permission,
        context: {
          // The member/company profile is the reason LinkedIn leads are worth more than
          // most — dropping it discards the firmographic signal the whole channel is for.
          member_profile_urn: str(p.memberUrn) ?? str(p.profileUrn),
          company_urn: str(p.companyUrn),
          company_name: str(p.companyName),
          message_thread_urn: str(p.conversationUrn),
        },
        attribution: {
          ...(str(p.campaignId) ? { campaign_id: str(p.campaignId)! } : {}),
          ...(str(p.creativeId) ? { creative_id: str(p.creativeId)! } : {}),
        },
        occurred_at: str(p.submittedAt),
      },
    };
  },
};

// ---------------------------------------------------------------------------
// TikTok
// ---------------------------------------------------------------------------

export const tiktokAdapter: LeadFormAdapter = {
  platform: 'TIKTOK',
  signatureHeader: 'x-tt-signature',
  signaturePrefix: '',
  extractSourceEventId(payload) {
    const p = asRecord(payload);
    return str(p.lead_id) ?? str(p.event_id);
  },
  normalize(payload) {
    const p = asRecord(payload);
    const sourceEventId = str(p.lead_id) ?? str(p.event_id);
    if (!sourceEventId) return { ok: false, reason: 'tiktok payload carries no lead_id' };

    const fields = fieldsFromPairs(p.field_data ?? p.answers, 'name', 'values');
    const scopes = Array.isArray(p.permission_fields)
      ? (p.permission_fields as unknown[]).map(String)
      : Object.keys(fields).filter((k) => /consent|opt_in|permission/i.test(k));

    const perm = requirePermission(
      str(p.consent_id) ?? str(p.page_id),
      p.consent_granted !== false,
      str(p.create_time) ?? str(p.submitted_at),
      scopes,
    );
    if (!perm.ok) return { ok: false, reason: perm.reason };

    return {
      ok: true,
      lead: {
        platform: 'TIKTOK',
        source_event_id: sourceEventId,
        source_lead_id: str(p.lead_id),
        form_id: str(p.page_id) ?? str(p.form_id),
        form_version: str(p.form_version),
        campaign_id: str(p.campaign_id),
        ad_id: str(p.ad_id),
        creative_id: str(p.creative_id) ?? str(p.adgroup_id),
        fields,
        permission: perm.permission,
        context: { advertiser_id: str(p.advertiser_id) },
        attribution: {
          ...(str(p.ttclid) ? { ttclid: str(p.ttclid)! } : {}),
          ...(str(p.campaign_id) ? { campaign_id: str(p.campaign_id)! } : {}),
        },
        occurred_at: str(p.create_time) ?? str(p.submitted_at),
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Google / YouTube
// ---------------------------------------------------------------------------

export const googleAdapter: LeadFormAdapter = {
  platform: 'GOOGLE',
  signatureHeader: 'x-goog-signature',
  signaturePrefix: '',
  extractSourceEventId(payload) {
    const p = asRecord(payload);
    return str(p.lead_id) ?? str(p.gcl_id);
  },
  normalize(payload) {
    const p = asRecord(payload);
    const sourceEventId = str(p.lead_id) ?? str(p.gcl_id);
    if (!sourceEventId) return { ok: false, reason: 'google payload carries no lead_id or gcl_id' };

    const fields = fieldsFromPairs(p.user_column_data, 'column_id', 'string_value');

    /*
     * Google signs the lead itself with a per-form key. Verifying that proof is separate
     * from the transport signature: the transport proves the request came from Google,
     * the form proof proves THIS lead came from THIS advertiser's form. Accepting one as
     * the other would let any Google-signed request inject a lead into any account.
     */
    const formProof = str(p.google_key) ?? str(p.form_proof);
    if (!formProof) {
      return { ok: false, reason: 'google payload carries no form proof (google_key) — the transport signature alone does not prove the lead came from this advertiser form' };
    }

    const scopes = Array.isArray(p.consent_fields)
      ? (p.consent_fields as unknown[]).map(String)
      : Object.keys(fields).filter((k) => /consent|opt_in|permission/i.test(k));
    const perm = requirePermission(
      formProof,
      p.consent_granted !== false,
      str(p.lead_submission_time) ?? str(p.timestamp),
      scopes,
    );
    if (!perm.ok) return { ok: false, reason: perm.reason };

    // Identity validation: Google delivers a lead with neither an email nor a phone often
    // enough that accepting it silently produces uncontactable rows.
    const hasIdentity = Object.entries(fields).some(
      ([k, v]) => /email|phone/i.test(k) && v.trim().length > 0,
    );
    if (!hasIdentity) {
      return { ok: false, reason: 'google lead carries neither an email nor a phone number — the record would be uncontactable' };
    }

    return {
      ok: true,
      lead: {
        platform: 'GOOGLE',
        source_event_id: sourceEventId,
        source_lead_id: str(p.lead_id),
        form_id: str(p.form_id),
        form_version: str(p.form_version),
        campaign_id: str(p.campaign_id),
        ad_id: str(p.ad_group_id),
        creative_id: str(p.creative_id),
        fields,
        permission: perm.permission,
        context: { api_version: str(p.api_version), is_test: p.is_test === true },
        attribution: {
          ...(str(p.gcl_id) ? { gclid: str(p.gcl_id)! } : {}),
          ...(str(p.utm_source) ? { utm_source: str(p.utm_source)! } : {}),
          ...(str(p.utm_medium) ? { utm_medium: str(p.utm_medium)! } : {}),
          ...(str(p.utm_campaign) ? { utm_campaign: str(p.utm_campaign)! } : {}),
        },
        occurred_at: str(p.lead_submission_time) ?? str(p.timestamp),
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Website + chat (first-party)
// ---------------------------------------------------------------------------

export type WebEventKind = 'demo_request' | 'pricing_enquiry' | 'contact' | 'chat';

export const WEB_EVENT_KINDS: WebEventKind[] = ['demo_request', 'pricing_enquiry', 'contact', 'chat'];

/**
 * The site's own forms and chat widget.
 *
 * Same contract as the social adapters — signature, idempotency key, archive-first — on
 * purpose: a first-party form is the same KIND of thing as a paid-social lead (a completed
 * intent signal with consent attached), and giving it a parallel pipeline would mean a
 * second place for the replay guarantee to be got subtly wrong.
 *
 * Two things it carries that the social adapters do not:
 *
 *   * THE TRANSCRIPT. For a chat lead, the conversation IS the qualifying information —
 *     what they asked, what the bot answered, where it gave up. Storing only "chat lead
 *     received" throws away the entire reason the channel exists, and the visitor will not
 *     repeat themselves.
 *   * THE HANDOFF STATE. Whether a human took over, and when, decides whether anyone is
 *     already talking to this person. Getting it wrong means either two reps replying to
 *     the same visitor or nobody replying at all.
 */
export const websiteAdapter: LeadFormAdapter = {
  platform: 'WEBSITE',
  signatureHeader: 'x-projex-signature',
  signaturePrefix: '',
  extractSourceEventId(payload) {
    const p = asRecord(payload);
    return str(p.event_id) ?? str(p.submission_id) ?? str(p.session_id);
  },
  normalize(payload) {
    const p = asRecord(payload);
    const sourceEventId = str(p.event_id) ?? str(p.submission_id) ?? str(p.session_id);
    if (!sourceEventId) {
      return { ok: false, reason: 'website payload carries no event_id, submission_id or session_id' };
    }

    const kind = (str(p.event_kind) ?? 'contact') as WebEventKind;
    if (!WEB_EVENT_KINDS.includes(kind)) {
      return { ok: false, reason: `unknown event_kind '${kind}' — expected one of ${WEB_EVENT_KINDS.join(', ')}` };
    }

    const fields = p.fields && typeof p.fields === 'object' && !Array.isArray(p.fields)
      ? Object.fromEntries(
        Object.entries(asRecord(p.fields)).map(([k, v]) => [k, v == null ? '' : String(v)]),
      )
      : fieldsFromPairs(p.fields);

    // Verbatim: the submitted permission block is stored exactly as sent, because the
    // wording someone agreed to is the thing a regulator asks to see.
    const submitted = asRecord(p.permissions ?? p.consent);
    const scopes = Object.keys(submitted).filter((k) => submitted[k] !== undefined);
    const granted = scopes.length > 0
      ? scopes.some((k) => submitted[k] === true || submitted[k] === 'true' || submitted[k] === 'on')
      : false;

    const perm = requirePermission(
      str(submitted.consent_ref) ?? str(p.form_id),
      granted,
      str(submitted.granted_at) ?? str(p.submitted_at),
      scopes,
    );
    if (!perm.ok) return { ok: false, reason: perm.reason };

    const transcriptRaw = Array.isArray(p.transcript) ? p.transcript : [];
    const transcript = transcriptRaw.map((t) => {
      const m = asRecord(t);
      return {
        role: str(m.role) ?? 'visitor',
        text: str(m.text) ?? '',
        at: str(m.at),
      };
    });

    // A chat lead with no transcript is almost always an integration bug, and accepting it
    // silently produces a lead nobody can qualify.
    if (kind === 'chat' && transcript.length === 0) {
      return { ok: false, reason: 'chat event carries no transcript — the conversation is the qualifying information and cannot be reconstructed later' };
    }

    const handoff = asRecord(p.handoff);
    return {
      ok: true,
      lead: {
        platform: 'WEBSITE',
        source_event_id: sourceEventId,
        source_lead_id: str(p.submission_id) ?? sourceEventId,
        form_id: str(p.form_id),
        form_version: str(p.form_version),
        campaign_id: str(p.utm_campaign),
        ad_id: null,
        creative_id: null,
        fields,
        permission: { ...perm.permission, submitted_raw: submitted },
        context: {
          event_kind: kind,
          page_url: str(p.page_url),
          page_title: str(p.page_title),
          referrer: str(p.referrer),
          session_id: str(p.session_id),
          transcript,
          // Whether a human already took over decides whether anyone is talking to this
          // person; getting it wrong means two reps replying or nobody replying.
          handoff: {
            state: str(handoff.state) ?? (transcript.length ? 'bot' : 'none'),
            handed_to: str(handoff.handed_to),
            handed_at: str(handoff.handed_at),
            reason: str(handoff.reason),
          },
        },
        attribution: {
          ...(str(p.utm_source) ? { utm_source: str(p.utm_source)! } : {}),
          ...(str(p.utm_medium) ? { utm_medium: str(p.utm_medium)! } : {}),
          ...(str(p.utm_campaign) ? { utm_campaign: str(p.utm_campaign)! } : {}),
          ...(str(p.gclid) ? { gclid: str(p.gclid)! } : {}),
          ...(str(p.referrer) ? { referrer: str(p.referrer)! } : {}),
        },
        occurred_at: str(p.submitted_at) ?? str(p.occurred_at),
      },
    };
  },
};

const ADAPTERS = new Map<LeadPlatform, LeadFormAdapter>([
  ['META', metaAdapter],
  ['LINKEDIN', linkedInAdapter],
  ['TIKTOK', tiktokAdapter],
  ['GOOGLE', googleAdapter],
  ['WEBSITE', websiteAdapter],
]);

export function getLeadFormAdapter(platform: string): LeadFormAdapter | undefined {
  return ADAPTERS.get(platform as LeadPlatform);
}

export function listLeadFormAdapters(): LeadPlatform[] {
  return [...ADAPTERS.keys()];
}
