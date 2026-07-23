/**
 * Recording-consent gate for connector-twilio-voice (P15·E4, TK-3654).
 *
 * Recording a call is PII processing, so it is gated on an sdk-consent decision.
 * The connector does not import sdk-consent directly — the host app injects the
 * checker via setRecordingConsentChecker, the same provider-hook pattern used
 * for the Twilio client itself.
 *
 * The gate FAILS CLOSED by design. The requirement is "no recording stored
 * without a consent decision", so the ABSENCE of a decision ('unknown' — no
 * checker wired, no receipt on file, or the consent lookup failed) withholds the
 * recording exactly like an explicit denial. Only an affirmative 'granted'
 * permits the recording pointer to be stored.
 */

export type ConsentDecision = 'granted' | 'denied' | 'unknown';

export interface RecordingConsentContext {
  tenant_id: string;
  /** The person whose voice would be recorded (the call subject). */
  subject_persona_id: string | null;
  to_number: string;
  from_number: string;
}

export interface RecordingConsentResult {
  decision: ConsentDecision;
  /** The sdk-consent receipt that authorised recording, when granted. */
  receipt_id?: string | null;
}

export type RecordingConsentChecker = (ctx: RecordingConsentContext) => Promise<RecordingConsentResult>;

// Default: no decision available. Deliberately NOT 'granted' — an unconfigured
// deployment must not silently record people.
const defaultChecker: RecordingConsentChecker = async () => ({ decision: 'unknown', receipt_id: null });

let _checker: RecordingConsentChecker = defaultChecker;

/** Wire the real sdk-consent lookup (host app does this at boot). */
export function setRecordingConsentChecker(checker: RecordingConsentChecker): void {
  _checker = checker;
}
export function _resetRecordingConsentChecker(): void {
  _checker = defaultChecker;
}

/**
 * Resolve the recording-consent decision for a call.
 *
 * A checker that throws is treated as 'unknown' rather than propagating: a
 * consent-service outage must degrade to withholding the recording, never to
 * recording without a decision and never to failing the call itself.
 */
export async function resolveRecordingConsent(ctx: RecordingConsentContext): Promise<RecordingConsentResult> {
  try {
    const result = await _checker(ctx);
    if (result.decision === 'granted') return { decision: 'granted', receipt_id: result.receipt_id ?? null };
    if (result.decision === 'denied') return { decision: 'denied', receipt_id: null };
    return { decision: 'unknown', receipt_id: null };
  } catch (err) {
    console.warn('[connector-twilio-voice] recording-consent check failed, withholding recording:', (err as Error).message);
    return { decision: 'unknown', receipt_id: null };
  }
}

/** True only for an affirmative grant. */
export function mayRecord(decision: ConsentDecision): boolean {
  return decision === 'granted';
}

/** Map a non-granting decision onto the withheld_reason column vocabulary. */
export function withheldReason(decision: ConsentDecision): 'consent_denied' | 'consent_unknown' | null {
  if (decision === 'denied') return 'consent_denied';
  if (decision === 'unknown') return 'consent_unknown';
  return null;
}
