import { dataService } from '@projexlight/db-runtime';
import { checkConsent, registerPurpose } from '@projexlight/sdk-consent';
import { suppressionService } from '@projexlight/sdk-deliverability';
import { registerGate } from './gateChain';

/**
 * Consent and do-not-call gates (VA·E5 · TK-4481), registered on the shared gate chain,
 * so API calls and campaign contacts are held to exactly the same rules.
 *
 *   dnc (order 30)      the called number is on the tenant's or the global suppression
 *                       list under voice, sms or all (TCPA DNC covers calls AND texts, so
 *                       an SMS opt-out also stops calls)            -> refuse "dnc"
 *   consent (order 40)  no active sdk-consent receipt for ai_voice_outbound for the call's
 *                       person_id in its jurisdiction               -> refuse "consent_missing"
 *
 * Both fail closed: a call with no person_id, or whose jurisdiction cannot be resolved,
 * has no consent that could be checked and is refused rather than dialled.
 */

export const VOICE_CONSENT_PURPOSE = process.env.VOICE_CONSENT_PURPOSE || 'ai_voice_outbound';
export const CALL_RECORDING_PURPOSE = process.env.CALL_RECORDING_PURPOSE || 'call_recording';
/** sdk-consent processor for tenant-run processing — the convention sdk-notification uses. */
const CONSENT_PROCESSOR = 'tenant';

/**
 * Country of an E.164 number by longest calling-code prefix, as an ISO 3166-1 alpha-2.
 * NANP (+1) resolves to US: Canada and the Caribbean share it, so a Canadian recipient's
 * consent must be recorded with an explicit jurisdiction on the call.
 */
const CALLING_CODES: Record<string, string> = {
  '1': 'US', '7': 'RU', '20': 'EG', '27': 'ZA', '30': 'GR', '31': 'NL', '32': 'BE', '33': 'FR', '34': 'ES',
  '36': 'HU', '39': 'IT', '40': 'RO', '41': 'CH', '43': 'AT', '44': 'GB', '45': 'DK', '46': 'SE', '47': 'NO',
  '48': 'PL', '49': 'DE', '51': 'PE', '52': 'MX', '54': 'AR', '55': 'BR', '56': 'CL', '57': 'CO', '60': 'MY',
  '61': 'AU', '62': 'ID', '63': 'PH', '64': 'NZ', '65': 'SG', '66': 'TH', '81': 'JP', '82': 'KR', '84': 'VN',
  '86': 'CN', '90': 'TR', '91': 'IN', '92': 'PK', '234': 'NG', '254': 'KE', '351': 'PT', '353': 'IE',
  '358': 'FI', '420': 'CZ', '852': 'HK', '886': 'TW', '966': 'SA', '971': 'AE', '972': 'IL',
};

export function countryOfNumber(e164: string): string | null {
  const digits = e164.replace(/^\+/, '');
  for (let len = 3; len >= 1; len--) {
    const cc = CALLING_CODES[digits.slice(0, len)];
    if (cc) return cc;
  }
  return null;
}

/** The consent jurisdiction for a call: explicit on the call, else the number's country, else DEFAULT_JURISDICTION. */
export function consentJurisdiction(explicit: string | null, toNumber: string): string | null {
  return explicit ?? countryOfNumber(toNumber) ?? process.env.DEFAULT_JURISDICTION ?? null;
}

registerGate('dnc', 30, async (ctx) => {
  const channels = ['voice', 'sms', 'all'] as const;
  const hashes = channels.map((ch) => suppressionService.hashAddress(ch, ctx.to_number));
  const hit = await dataService.one<{ channel: string; reason: string; scope: string }>(
    `SELECT channel, reason, scope
       FROM deliverability.suppression
      WHERE ((channel = 'voice' AND address_hash = $1) OR (channel = 'sms' AND address_hash = $2) OR (channel = 'all' AND address_hash = $3))
        AND (scope = 'global' OR tenant_id = $4)
        AND (expires_at IS NULL OR expires_at > now())
      ORDER BY (scope = 'global') DESC
      LIMIT 1`,
    [...hashes, ctx.tenant_id],
  );
  if (!hit) return { result: 'pass' };
  return { result: 'refuse', reason: 'dnc', detail: { channel: hit.channel, suppression_reason: hit.reason, scope: hit.scope } };
});

registerGate('consent', 40, async (ctx) => {
  if (!ctx.person_id) {
    return { result: 'refuse', reason: 'consent_missing', detail: { purpose: VOICE_CONSENT_PURPOSE, why: 'the call names no person_id whose consent could be checked' } };
  }
  const jurisdiction = consentJurisdiction(ctx.jurisdiction, ctx.to_number);
  if (!jurisdiction) {
    return { result: 'refuse', reason: 'consent_missing', detail: { purpose: VOICE_CONSENT_PURPOSE, why: 'jurisdiction could not be resolved' } };
  }
  const res = await checkConsent({ person_id: ctx.person_id, purpose_id: VOICE_CONSENT_PURPOSE, processor: CONSENT_PROCESSOR, jurisdiction });
  if (!res.granted) {
    return {
      result: 'refuse',
      reason: 'consent_missing',
      detail: { purpose: VOICE_CONSENT_PURPOSE, jurisdiction, revoked: !!res.revoked_at, expired: !!res.expires_at && !res.revoked_at },
    };
  }
  return { result: 'pass', detail: { purpose: VOICE_CONSENT_PURPOSE, jurisdiction, receipt_id: res.receipt_id } };
});

/**
 * Registers the voice consent purposes in sdk-consent's (platform-wide) registry. Receipts
 * reference a purpose by FK, so a tenant cannot record ai_voice_outbound consent until it
 * exists. Idempotent: an existing purpose is left as is. Called by the api-gateway at boot.
 */
export async function ensureVoiceConsentPurposes(): Promise<string[]> {
  const created: string[] = [];
  const purposes = [
    { purpose_id: VOICE_CONSENT_PURPOSE, description: 'Receive outbound phone calls placed by an AI voice agent.' },
    { purpose_id: CALL_RECORDING_PURPOSE, description: 'Have phone calls with an AI voice agent recorded.' },
  ];
  for (const p of purposes) {
    const exists = await dataService.one(`SELECT 1 FROM consent.purpose WHERE purpose_id = $1`, [p.purpose_id]);
    if (exists) continue;
    try {
      await registerPurpose({ ...p, app_id: 'projexcloud-voice', legal_basis: 'consent', category: 'general' });
      created.push(p.purpose_id);
    } catch (err) {
      if ((err as { code?: string }).code !== '23505') throw err; // another replica won the race
    }
  }
  return created;
}
