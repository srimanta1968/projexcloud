import { dataService } from '@projexlight/db-runtime';
import { checkConsent } from '@projexlight/sdk-consent';
import { CALL_RECORDING_PURPOSE, consentJurisdiction, countryOfNumber } from './complianceGates';
import { registerGate, type GateContext } from './gateChain';

/**
 * Calling-window and recording-jurisdiction gates (VA·E5 · TK-4482), on the shared chain.
 *
 *   calling_window (50)  the recipient's LOCAL time must be inside the window — the
 *                        campaign's for a contact, DIALER_DEFAULT_WINDOW (08:00-21:00) for
 *                        an API call. Outside it the call is DEFERRED with next_attempt_at
 *                        set to when the window next opens.
 *   recording (60)       decides whether this call may be recorded; it never blocks the
 *                        call. The verdict is stored on the call as recording_consent.
 *
 * The recipient's timezone is the call's own (API call) or the contact's, else the
 * campaign default. When none is known the gate is STRICT: the local time must be inside
 * the window in EVERY timezone of the number's country, so a US number with no timezone
 * is only dialled when it is within the window from New York to Honolulu.
 */

const DEFAULT_WINDOW = {
  start: process.env.DIALER_DEFAULT_WINDOW_START || '08:00',
  end: process.env.DIALER_DEFAULT_WINDOW_END || '21:00',
};
const STEP_MS = 15 * 60 * 1000;
const MAX_SEARCH_MS = 8 * 24 * 60 * 60 * 1000;

/** Timezones of a country, used when the recipient's own timezone is unknown. */
const COUNTRY_ZONES: Record<string, string[]> = {
  US: ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu'],
  CA: ['America/St_Johns', 'America/Halifax', 'America/Toronto', 'America/Winnipeg', 'America/Edmonton', 'America/Vancouver'],
  AU: ['Australia/Perth', 'Australia/Darwin', 'Australia/Adelaide', 'Australia/Brisbane', 'Australia/Sydney'],
  BR: ['America/Sao_Paulo', 'America/Manaus', 'America/Rio_Branco'],
  MX: ['America/Cancun', 'America/Mexico_City', 'America/Mazatlan', 'America/Tijuana'],
  RU: ['Europe/Kaliningrad', 'Europe/Moscow', 'Asia/Yekaterinburg', 'Asia/Novosibirsk', 'Asia/Irkutsk', 'Asia/Vladivostok', 'Asia/Kamchatka'],
  ID: ['Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura'],
  GB: ['Europe/London'], IE: ['Europe/Dublin'], IN: ['Asia/Kolkata'], DE: ['Europe/Berlin'], FR: ['Europe/Paris'],
  ES: ['Europe/Madrid'], IT: ['Europe/Rome'], NL: ['Europe/Amsterdam'], BE: ['Europe/Brussels'], CH: ['Europe/Zurich'],
  AT: ['Europe/Vienna'], SE: ['Europe/Stockholm'], NO: ['Europe/Oslo'], DK: ['Europe/Copenhagen'], FI: ['Europe/Helsinki'],
  PL: ['Europe/Warsaw'], PT: ['Europe/Lisbon'], GR: ['Europe/Athens'], CZ: ['Europe/Prague'], HU: ['Europe/Budapest'],
  RO: ['Europe/Bucharest'], TR: ['Europe/Istanbul'], IL: ['Asia/Jerusalem'], AE: ['Asia/Dubai'], SA: ['Asia/Riyadh'],
  EG: ['Africa/Cairo'], ZA: ['Africa/Johannesburg'], NG: ['Africa/Lagos'], KE: ['Africa/Nairobi'], PK: ['Asia/Karachi'],
  SG: ['Asia/Singapore'], MY: ['Asia/Kuala_Lumpur'], TH: ['Asia/Bangkok'], VN: ['Asia/Ho_Chi_Minh'], PH: ['Asia/Manila'],
  HK: ['Asia/Hong_Kong'], TW: ['Asia/Taipei'], CN: ['Asia/Shanghai'], JP: ['Asia/Tokyo'], KR: ['Asia/Seoul'],
  NZ: ['Pacific/Auckland'], AR: ['America/Argentina/Buenos_Aires'], CL: ['America/Santiago'], CO: ['America/Bogota'], PE: ['America/Lima'],
};

/** HH:MM in `tz` at instant `at` (24h). */
export function localHHMM(at: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const h = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const m = parts.find((p) => p.type === 'minute')?.value ?? '00';
  return `${h}:${m}`;
}

const inWindow = (at: Date, zones: string[], start: string, end: string): boolean =>
  zones.every((tz) => { const t = localHHMM(at, tz); return t >= start && t < end; });

/** The first quarter-hour at or after `from` when every zone is inside the window, or null. */
export function nextWindowOpening(from: Date, zones: string[], start: string, end: string): Date | null {
  const first = new Date(Math.ceil(from.getTime() / STEP_MS) * STEP_MS);
  for (let t = first.getTime(); t - from.getTime() <= MAX_SEARCH_MS; t += STEP_MS) {
    if (inWindow(new Date(t), zones, start, end)) return new Date(t);
  }
  return null;
}

/** Where the recipient is, in timezones, and how we know it. */
function recipientZones(explicitTz: string | null, toNumber: string): { zones: string[]; source: string } {
  if (explicitTz) return { zones: [explicitTz], source: 'recipient' };
  const country = countryOfNumber(toNumber);
  if (country && COUNTRY_ZONES[country]) return { zones: COUNTRY_ZONES[country], source: `country:${country}` };
  return { zones: [process.env.DIALER_DEFAULT_TIMEZONE || 'UTC'], source: 'default' };
}

async function windowFor(ctx: GateContext): Promise<{ start: string; end: string; tz: string | null }> {
  if (ctx.source === 'campaign' && ctx.campaign_id) {
    const c = await dataService.one<{ start: string; end: string; tz: string }>(
      `SELECT to_char(window_start, 'HH24:MI') AS start, to_char(window_end, 'HH24:MI') AS "end", default_timezone AS tz
         FROM dialer.campaign WHERE tenant_id = $1 AND campaign_id = $2`,
      [ctx.tenant_id, ctx.campaign_id],
    );
    if (c) return c;
  }
  return { ...DEFAULT_WINDOW, tz: null };
}

registerGate('calling_window', 50, async (ctx) => {
  const w = await windowFor(ctx);
  // A contact without its own timezone uses the campaign's default — an explicit choice
  // the campaign owner made — before falling back to the strict per-country rule.
  const { zones, source } = recipientZones(ctx.timezone ?? (ctx.source === 'campaign' ? w.tz : null), ctx.to_number);
  const detail = { window_start: w.start, window_end: w.end, timezones: zones, timezone_source: source };
  if (inWindow(ctx.now, zones, w.start, w.end)) return { result: 'pass', detail };
  const next = nextWindowOpening(ctx.now, zones, w.start, w.end);
  if (!next) {
    // Every zone never lines up (e.g. a country spanning more hours than the window).
    return { result: 'refuse', reason: 'calling_window_unreachable', detail };
  }
  return { result: 'defer', reason: 'outside_calling_window', next_attempt_at: next.toISOString(), detail };
});

// ---------------------------------------------------------------------------------------------

export type RecordingRule = 'one_party' | 'all_party' | 'prohibited';

/**
 * The recording rule for a jurisdiction. Exact match first (US-CA); a region with no row
 * of its own inherits its country only when the country's rule does NOT vary by region.
 * Anything else — unknown jurisdiction, or a varies_by_region country with no region —
 * gets the strict all_party rule.
 */
export async function recordingRuleFor(jurisdiction: string | null): Promise<{ rule: RecordingRule; basis: string; jurisdiction: string | null }> {
  if (!jurisdiction) return { rule: 'all_party', basis: 'strict_unknown', jurisdiction };
  const exact = await dataService.one<{ rule: RecordingRule; varies_by_region: boolean }>(
    `SELECT rule, varies_by_region FROM dialer.recording_jurisdiction WHERE jurisdiction = $1`,
    [jurisdiction],
  );
  if (exact && !exact.varies_by_region) return { rule: exact.rule, basis: 'registry', jurisdiction };
  if (exact && exact.varies_by_region) return { rule: 'all_party', basis: 'strict_region_unknown', jurisdiction };
  const country = jurisdiction.split('-')[0];
  if (country !== jurisdiction) {
    const parent = await dataService.one<{ rule: RecordingRule; varies_by_region: boolean }>(
      `SELECT rule, varies_by_region FROM dialer.recording_jurisdiction WHERE jurisdiction = $1`,
      [country],
    );
    if (parent && !parent.varies_by_region) return { rule: parent.rule, basis: 'registry_country', jurisdiction };
    // A region of a varies_by_region country that has no row of its own is governed by
    // the country's (permissive) baseline — federal one-party law in the US.
    if (parent && parent.varies_by_region) return { rule: parent.rule, basis: 'registry_country_baseline', jurisdiction };
  }
  return { rule: 'all_party', basis: 'strict_unknown', jurisdiction };
}

registerGate('recording', 60, async (ctx) => {
  const jurisdiction = ctx.jurisdiction ?? countryOfNumber(ctx.to_number);
  const r = await recordingRuleFor(jurisdiction);
  if (r.rule === 'prohibited') return { result: 'pass', detail: { recording_permitted: false, ...r } };
  if (r.rule === 'one_party') return { result: 'pass', detail: { recording_permitted: true, ...r } };
  // all_party: the recipient must have consented to recording.
  const consentJur = consentJurisdiction(ctx.jurisdiction, ctx.to_number);
  if (!ctx.person_id || !consentJur) {
    return { result: 'pass', detail: { recording_permitted: false, ...r, why: 'all-party rule and no recording consent could be checked' } };
  }
  const c = await checkConsent({ person_id: ctx.person_id, purpose_id: CALL_RECORDING_PURPOSE, processor: 'tenant', jurisdiction: consentJur });
  return {
    result: 'pass',
    detail: { recording_permitted: c.granted, ...r, recording_consent_receipt_id: c.granted ? c.receipt_id : null },
  };
});
