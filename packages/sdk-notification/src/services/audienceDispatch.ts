import { unifiedDispatch } from './dispatchService';
import type { NotificationChannel } from '../models/notification.model';

/**
 * Send by REFERENCE, not by address (P17).
 *
 * WHY THIS EXISTS. /send and /dispatch are point-to-point: the caller must
 * already know who the recipient is and how to reach them. That is the wrong
 * shape for the notification most apps actually send, which is audience-shaped —
 * "tell whoever holds this role that an SLA breached". A consuming app cannot
 * synthesise that: it does not hold persona ids, and the addresses belong to the
 * platform. So the audience is resolved HERE and the caller never learns an
 * address.
 *
 * NO ADDRESS CROSSES THE BOUNDARY, IN EITHER DIRECTION. The request names an
 * audience, never a destination; the response reports per-recipient status keyed
 * by persona_id, never the destination that was used. That is not politeness —
 * it is what stops every consuming app inheriting an erasure surface. Anything we
 * hand back, an app may persist, and then a DSAR has to reach it there too. A
 * destination resolved here is used within the request and discarded.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not read identity.alias. Persona →
 * destination is a seam (setPersonaDestinationResolver) that is UNWIRED by
 * default, exactly like setPreSendGuard and setSequenceDestinationResolver. An
 * unwired platform reports `no_destination` for every recipient rather than
 * inventing one, which is the honest answer and is distinguishable from failure —
 * see RecipientStatus.
 */

/** How the caller names the people to reach. Never an address for the role/persona kinds. */
export type Audience =
  | { kind: 'persona'; persona_ids: string[] }
  | { kind: 'role'; role_template_id: string; include_primary?: boolean };

/**
 * Who decided this send was allowed.
 *
 * THREE MODES BECAUSE APPS DIFFER, AND THE DIFFERENCE IS ARCHITECTURAL. An app
 * with its own consent/policy engine has already decided and must not have the
 * decision re-litigated; an app without one needs the platform to decide; and an
 * internal notification has no lawful-basis question at all but still must record
 * WHY it was exempt. Modelling only the middle case would force the first kind of
 * app to fabricate a purpose and the third to skip the ledger.
 */
export type Authorization =
  /** The platform decides: consent for `purpose`, plus the guards unifiedDispatch already applies. */
  | { mode: 'platform'; purpose: string }
  /** The app decided. We record the reference and re-check only what we own. */
  | { mode: 'delegated'; decision_ref: string; expires_at: string }
  /** No lawful-basis question (e.g. telling a colleague). Recorded as a decision, never skipped. */
  | { mode: 'exempt'; basis: string; justification: string };

/**
 * Per-recipient outcome.
 *
 * `no_destination` IS NOT A FAILURE AND IS NOT AN ATTEMPT. Three outcomes look
 * adjacent and are not, and collapsing them is how a truthful send gets recorded
 * as a false one:
 *
 *   failed          a provider was called and refused        → retryable
 *   no_provider     no provider configured for the channel   → fix configuration
 *   no_destination  provider fine, decision fine, nobody reachable → retry returns the same answer
 *
 * `attempted` carries the distinction as a BOOLEAN rather than leaving a caller to
 * infer it from the status string, because a caller's retry ledger keying on a
 * string breaks silently the day a status is renamed. A consumer counting
 * attempts must not burn its retry budget — or mark an escalation `failed` — for a
 * recipient nobody could ever have reached.
 */
export interface RecipientResult {
  persona_id: string;
  channel: NotificationChannel;
  status: 'sent' | 'deferred' | 'suppressed' | 'failed' | 'no_provider' | 'no_destination';
  /** False for outcomes where no provider was called. Retry ledgers should key on THIS. */
  attempted: boolean;
  reason?: string;
}

export interface SendToAudienceInput {
  tenant_id: string;
  audience: Audience;
  channels: NotificationChannel[];
  body: string;
  subject?: string;
  respect_quiet_hours?: boolean;
  authorization: Authorization;
  metadata?: Record<string, unknown>;
}

export interface SendToAudienceResult {
  results: RecipientResult[];
  recipient_count: number;
  /** Echoed so an audit can tie the send to the decision that permitted it. */
  authorization_mode: Authorization['mode'];
  decision_ref?: string;
}

/** Raised for a well-formed request the authorization envelope forbids. */
export class AudienceAuthorizationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AudienceAuthorizationError';
  }
}

/* ------------------------------------------------------------------ seams */

/**
 * Resolves an audience to persona ids. Wired at gateway boot to sdk-persona's
 * listRoleHolders — a seam rather than a package dependency, so sdk-notification
 * does not have to know the persona schema exists, and an app with a different
 * role model can wire its own.
 */
export type RoleHolderResolver = (args: {
  tenant_id: string;
  role_template_id: string;
  include_primary: boolean;
}) => Promise<Array<{ persona_id: string }>>;
const defaultRoleResolver: RoleHolderResolver = async () => [];
let _roleResolver: RoleHolderResolver = defaultRoleResolver;
export function setRoleHolderResolver(r: RoleHolderResolver): void { _roleResolver = r; }
export function _resetRoleHolderResolver(): void { _roleResolver = defaultRoleResolver; }

/**
 * Resolves one persona to a destination on one channel. UNWIRED BY DEFAULT and
 * deliberately so: wiring it is a decision to read PII on the send path, and it
 * should be made explicitly at boot rather than inherited by importing this file.
 * Returning null is a first-class answer meaning "nobody reachable on this
 * channel", not an error.
 */
export type PersonaDestinationResolver = (args: {
  tenant_id: string;
  persona_id: string;
  channel: NotificationChannel;
}) => Promise<string | null>;
const defaultDestResolver: PersonaDestinationResolver = async () => null;
let _destResolver: PersonaDestinationResolver = defaultDestResolver;
export function setPersonaDestinationResolver(r: PersonaDestinationResolver): void { _destResolver = r; }
export function _resetPersonaDestinationResolver(): void { _destResolver = defaultDestResolver; }

/* ------------------------------------------------------------- authorization */

/**
 * THE MONOTONICITY INVARIANT — the single most important property here.
 *
 *   A delegated decision may only ever be NARROWED by the platform.
 *
 * We may downgrade the app's `send` to `suppressed` or `deferred`; we may NEVER
 * upgrade a denial, and never produce a send the app's decision did not already
 * permit. The reason it is stated as an invariant rather than left to the
 * implementation is that the failure mode is invisible: widening looks exactly
 * like working, so no test written against the happy path catches it. It is
 * enforced structurally — this function can only ever throw or return, and the
 * per-recipient guards downstream can only ever subtract.
 *
 * Delegated decisions EXPIRE, and an expired one is refused rather than honoured.
 * Between an app deciding and us dispatching, a consent can be revoked or an
 * address suppressed — every change runs in the restrictive direction, so an
 * unexpired decision is INHERITED, not TRUSTED, and an expired one has inherited
 * nothing.
 */
function assertAuthorized(auth: Authorization, now: Date): void {
  if (auth.mode === 'delegated') {
    if (!auth.decision_ref) {
      throw new AudienceAuthorizationError('DecisionRefRequired', 'delegated authorization requires decision_ref');
    }
    const expires = new Date(auth.expires_at);
    if (Number.isNaN(expires.getTime())) {
      throw new AudienceAuthorizationError('DecisionExpiryInvalid', 'expires_at is not a valid timestamp');
    }
    if (expires.getTime() <= now.getTime()) {
      throw new AudienceAuthorizationError(
        'DecisionExpired',
        `delegated decision ${auth.decision_ref} expired at ${expires.toISOString()}; re-decide rather than re-send`,
      );
    }
    return;
  }
  if (auth.mode === 'platform') {
    // Required and never defaulted: a resolver with an optional purpose cannot be
    // called safely on a path that reaches a customer. Purposes are tenant-registered
    // (POST /api/consents/purposes), so the platform holds no fixed list of its own.
    if (!auth.purpose) {
      throw new AudienceAuthorizationError('PurposeRequired', 'platform authorization requires a registered purpose');
    }
    return;
  }
  if (!auth.basis || !auth.justification) {
    throw new AudienceAuthorizationError(
      'ExemptionUnjustified',
      'exempt authorization requires both basis and justification — an exemption is recorded, not skipped',
    );
  }
}

/* ------------------------------------------------------------------- send */

export async function sendToAudience(input: SendToAudienceInput): Promise<SendToAudienceResult> {
  assertAuthorized(input.authorization, new Date());

  const persona_ids =
    input.audience.kind === 'persona'
      ? input.audience.persona_ids
      : (
          await _roleResolver({
            tenant_id: input.tenant_id,
            role_template_id: input.audience.role_template_id,
            include_primary: input.audience.include_primary ?? true,
          })
        ).map((h) => h.persona_id);

  // The resolver already returns one row per persona, but an explicit persona list
  // is caller-supplied and may repeat. De-duplicating here means no caller can make
  // us send twice, rather than every caller having to remember not to.
  const unique = [...new Set(persona_ids)];

  const results: RecipientResult[] = [];
  for (const persona_id of unique) {
    for (const channel of input.channels) {
      const destination = await _destResolver({ tenant_id: input.tenant_id, persona_id, channel }).catch(() => null);
      if (!destination) {
        // Not a failure, and not an attempt — see RecipientResult.
        results.push({
          persona_id,
          channel,
          status: 'no_destination',
          attempted: false,
          reason: 'no destination resolved for this persona on this channel',
        });
        continue;
      }
      const outcome = await unifiedDispatch({
        tenant_id: input.tenant_id,
        channel,
        destination,
        body: input.body,
        subject: input.subject,
        subject_persona_id: persona_id,
        respect_quiet_hours: input.respect_quiet_hours,
        metadata: input.metadata,
        // Frequency caps and consent purpose apply only where the PLATFORM is the
        // decider. Applying them to a delegated decision would re-litigate an answer
        // the app already gave — and could only ever narrow it, which the guards
        // inside unifiedDispatch do anyway.
        ...(input.authorization.mode === 'platform'
          ? { purpose: input.authorization.purpose, respect_frequency_cap: true }
          : {}),
      });
      results.push({
        persona_id,
        channel,
        status: outcome.status,
        // Only a 'sent' or 'failed' outcome means a provider was actually called;
        // deferred and suppressed were stopped before it.
        attempted: outcome.status === 'sent' || outcome.status === 'failed',
        reason: outcome.reason,
      });
    }
  }

  return {
    results,
    recipient_count: unique.length,
    authorization_mode: input.authorization.mode,
    decision_ref: input.authorization.mode === 'delegated' ? input.authorization.decision_ref : undefined,
  };
}
