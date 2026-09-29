import { dataService } from '@projexlight/db-runtime';
import { checkConsent } from '@projexlight/sdk-consent';
import { quietHoursState } from '@projexlight/sdk-notification';
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
 *
 * TK-4507 — the window is evaluated with sdk-notification's quiet-hours engine rather than
 * a private clock: a calling window of 08:00-21:00 is the recipient's quiet hours
 * 21:00-08:00 on every weekday, in their own zone. The same code that keeps a notification
 * out of a persona's night keeps an AI call out of the recipient's, and "when may we call"
 * is that engine's next_open_at, taken across every candidate zone.
 */

const DEFAULT_WINDOW = {
  start: process.env.DIALER_DEFAULT_WINDOW_START || '08:00',
  end: process.env.DIALER_DEFAULT_WINDOW_END || '21:00',
};
const MAX_SEARCH_MS = 8 * 24 * 60 * 60 * 1000;
const MAX_HOPS = 32;
/** Largest DST shift in use (Lord Howe is 30 min, everywhere else 60) plus margin. */
const DST_BACKTRACK_MIN = 120;

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

type QuietRecord = NonNullable<Parameters<typeof quietHoursState>[0]>;

/**
 * The calling window as sdk-notification quiet hours for one zone: the complement of
 * start-end on every weekday (so 08:00-21:00 is quiet 21:00-08:00, crossing midnight).
 */
function windowAsQuietHours(tz: string, start: string, end: string): QuietRecord {
  return {
    persona_id: 'recipient',
    dnd: false,
    updated_at: new Date(0),
    windows: [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow, start: end, end: start, tz })),
  };
}

export interface CallingWindowState {
  /** True when `at` is inside the window in every zone. */
  open: boolean;
  /** When the window next opens in every zone at once; null when open now or never within 8 days. */
  next_open_at: Date | null;
  /** Zones where `at` falls in the recipient's quiet hours. */
  closed_zones: string[];
  /** Recipient-local HH:MM at `at`, per zone. */
  local_times: Record<string, string>;
}

/**
 * Whether `at` is inside the calling window in every zone and, when not, the earliest
 * instant it is. Jumping to the LATEST reopening among the closed zones never skips a
 * valid time: a closed zone stays closed until its own reopening, so no instant before
 * the latest one can have every zone open. Zones whose windows never line up (a country
 * spanning more hours than the window) exhaust the bounded search and return null.
 */
export function callingWindowState(at: Date, zones: string[], start: string, end: string): CallingWindowState {
  const local_times = Object.fromEntries(zones.map((tz) => [tz, localHHMM(at, tz)]));
  const records = zones.map((tz) => ({ tz, record: windowAsQuietHours(tz, start, end) }));
  let cursor = at;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const closed = records
      .map(({ tz, record }) => ({ tz, state: quietHoursState(record, cursor) }))
      .filter((z) => z.state.quiet);
    if (closed.length === 0) {
      return hop === 0
        ? { open: true, next_open_at: null, closed_zones: [], local_times }
        : { open: false, next_open_at: earliestOpen(records, at, cursor), closed_zones: closedAt(records, at), local_times };
    }
    const reopenings = closed.map((z) => z.state.next_open_at);
    if (reopenings.some((d) => d === null)) break;
    cursor = new Date(Math.max(...reopenings.map((d) => (d as Date).getTime())));
    if (cursor.getTime() - at.getTime() > MAX_SEARCH_MS) break;
  }
  return { open: false, next_open_at: null, closed_zones: closedAt(records, at), local_times };
}

/**
 * quietHoursState measures a window's end with the UTC offset in force at the instant it
 * is asked (its documented DST caveat), so a reopening across a clock change can come out
 * up to the shift LATE — never early, since every candidate is re-checked above. Step back
 * minute by minute (at most DST_BACKTRACK_MIN) while the window is still open in every
 * zone, so the answer is the true first open minute.
 */
function earliestOpen(records: { tz: string; record: QuietRecord }[], at: Date, candidate: Date): Date {
  const allOpen = (t: Date) => records.every(({ record }) => !quietHoursState(record, t).quiet);
  let t = candidate;
  for (let i = 0; i < DST_BACKTRACK_MIN; i++) {
    const prev = new Date(t.getTime() - 60_000);
    if (prev.getTime() <= at.getTime() || !allOpen(prev)) break;
    t = prev;
  }
  return t;
}

function closedAt(records: { tz: string; record: QuietRecord }[], at: Date): string[] {
  return records.filter(({ record }) => quietHoursState(record, at).quiet).map(({ tz }) => tz);
}

/** When the window next opens in every zone at or after `from` (`from` itself when open), or null. */
export function nextWindowOpening(from: Date, zones: string[], start: string, end: string): Date | null {
  const s = callingWindowState(from, zones, start, end);
  return s.open ? from : s.next_open_at;
}

/** Where the recipient is, in timezones, and how we know it. */
export function recipientZones(explicitTz: string | null, toNumber: string): { zones: string[]; source: string } {
  if (explicitTz) return { zones: [explicitTz], source: 'recipient' };
  const country = countryOfNumber(toNumber);
  if (country && COUNTRY_ZONES[country]) return { zones: COUNTRY_ZONES[country], source: `country:${country}` };
  return { zones: [process.env.DIALER_DEFAULT_TIMEZONE || 'UTC'], source: 'default' };
}

async function windowFor(ctx: Pick<GateContext, 'tenant_id' | 'source' | 'campaign_id'>): Promise<{ start: string; end: string; tz: string | null }> {
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

export interface CallingWindowCheck {
  allowed: boolean;
  reason: 'inside_calling_window' | 'outside_calling_window' | 'calling_window_unreachable';
  window_start: string;
  window_end: string;
  timezones: string[];
  timezone_source: string;
  local_times: Record<string, string>;
  closed_timezones: string[];
  next_open_at: string | null;
}

/**
 * The calling-window verdict for a recipient, exactly as the calling_window gate decides
 * it: the campaign's window (or the default), in the recipient's local time zone(s).
 */
export async function checkCallingWindow(input: {
  tenant_id: string;
  to_number: string;
  timezone?: string | null;
  campaign_id?: string | null;
  at?: Date;
}): Promise<CallingWindowCheck> {
  const w = await windowFor({
    tenant_id: input.tenant_id,
    source: input.campaign_id ? 'campaign' : 'api',
    campaign_id: input.campaign_id ?? null,
  });
  // A contact without its own timezone uses the campaign's default — an explicit choice
  // the campaign owner made — before falling back to the strict per-country rule.
  const { zones, source } = recipientZones(input.timezone ?? (input.campaign_id ? w.tz : null), input.to_number);
  const at = input.at ?? new Date();
  const s = callingWindowState(at, zones, w.start, w.end);
  return {
    allowed: s.open,
    reason: s.open ? 'inside_calling_window' : s.next_open_at ? 'outside_calling_window' : 'calling_window_unreachable',
    window_start: w.start,
    window_end: w.end,
    timezones: zones,
    timezone_source: source,
    local_times: s.local_times,
    closed_timezones: s.closed_zones,
    next_open_at: s.next_open_at ? s.next_open_at.toISOString() : null,
  };
}

registerGate('calling_window', 50, async (ctx) => {
  const w = await windowFor(ctx);
  // A contact without its own timezone uses the campaign's default — an explicit choice
  // the campaign owner made — before falling back to the strict per-country rule.
  const { zones, source } = recipientZones(ctx.timezone ?? (ctx.source === 'campaign' ? w.tz : null), ctx.to_number);
  const detail = { window_start: w.start, window_end: w.end, timezones: zones, timezone_source: source };
  const state = callingWindowState(ctx.now, zones, w.start, w.end);
  if (state.open) return { result: 'pass', detail };
  const next = state.next_open_at;
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
