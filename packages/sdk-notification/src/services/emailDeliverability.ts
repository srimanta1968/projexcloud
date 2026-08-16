import {
  verifyAddress,
  sendDecision,
  maskAddress,
  validationMode,
  type AddressVerification,
} from '@projexlight/sdk-deliverability';

/**
 * The platform-email gate — now a thin adapter over the shared checker in
 * sdk-deliverability (services/addressVerification.ts).
 *
 * WHY IT MOVED. This file used to hold its own assessment: a one-line syntax
 * regex, a disposable list and an MX lookup. It was consulted on exactly ONE
 * path — sendPlatformEmail — so every TENANT send went out unchecked, and the
 * portals had no way to ask the question at all. The logic now lives in
 * sdk-deliverability, which owns deliverability, is called by the gateway's
 * pre-send guard for tenant sends, and is exposed over HTTP for the portals.
 * One implementation, so the three answers cannot drift apart.
 *
 * WHAT IS PRESERVED, deliberately and exactly:
 *   - EMAIL_VALIDATION_MODE = off | soft | strict, including soft's unusual
 *     meaning on THIS path (assess, log, and send nothing — the observation
 *     window). That is a deployed rollout stance, not an accident, so it is
 *     kept rather than quietly redefined.
 *   - Every exported name and shape below. Callers compile unchanged.
 *
 * WHAT CHANGED, and it is worth knowing:
 *   - A DNS FAILURE NO LONGER SUPPRESSES MAIL. The old code returned `no-mx`
 *     when the resolver timed out, which in strict mode is indistinguishable
 *     from "this domain cannot receive mail" — so a blip on our side silently
 *     dropped real messages to real customers. The checker reports that as
 *     `unknown` and the gate sends.
 *   - Reserved domains (RFC 2606/6761: example.com, *.test, *.invalid) are now
 *     named as such rather than passing on their A record.
 *   - Placeholder locals (test@, demo@) and likely typos are reported.
 */

export type EmailValidationMode = 'off' | 'soft' | 'strict';

/** Current mode from EMAIL_VALIDATION_MODE (default 'off'); unknown -> 'off'. */
export function emailValidationMode(): EmailValidationMode {
  return validationMode();
}

/**
 * The reason vocabulary.
 *
 * ADDITIVE. The five original values keep their meaning so anything switching
 * on them still works; the new ones name cases the old assessment could not
 * distinguish — most importantly `dns-unavailable`, which used to masquerade as
 * `no-mx`.
 */
export type DeliverabilityReason =
  | 'ok'
  | 'ok-a-record'
  | 'bad-syntax'
  | 'disposable-domain'
  | 'no-mx'
  | 'no-domain'
  | 'null-mx'
  | 'reserved-domain'
  | 'placeholder-address'
  | 'role-address'
  | 'likely-typo'
  | 'catch-all'
  | 'mailbox-not-found'
  | 'dns-unavailable';

export interface DeliverabilityAssessment {
  /**
   * FALSE MEANS PROVEN UNDELIVERABLE, not merely unconfirmed.
   *
   * The distinction is the point of the rewrite: `unknown` (a resolver that did
   * not answer) reports `true` here with reason `dns-unavailable`, because the
   * alternative — the old behaviour — was to drop mail whenever our own DNS
   * hiccuped. Read `reason` when the difference matters.
   */
  deliverable: boolean;
  reason: DeliverabilityReason;
  domain: string | null;
  /** The full verdict, for callers that want more than a boolean. */
  verification?: AddressVerification;
}

function toReason(v: AddressVerification): DeliverabilityReason {
  switch (v.code) {
    case 'SYNTAX_INVALID': return 'bad-syntax';
    case 'RESERVED_DOMAIN': return 'reserved-domain';
    case 'DOMAIN_NOT_FOUND': return 'no-domain';
    case 'NULL_MX': return 'null-mx';
    case 'NO_MAIL_EXCHANGER': return 'no-mx';
    case 'MAILBOX_NOT_FOUND': return 'mailbox-not-found';
    case 'DISPOSABLE_DOMAIN': return 'disposable-domain';
    case 'PLACEHOLDER_ADDRESS': return 'placeholder-address';
    case 'ROLE_ADDRESS': return 'role-address';
    case 'LIKELY_TYPO': return 'likely-typo';
    case 'CATCH_ALL_DOMAIN': return 'catch-all';
    case 'DNS_UNAVAILABLE':
    case 'CHECK_DISABLED': return 'dns-unavailable';
    default:
      // An implicit exchanger is a domain answering on its own A record, which
      // the previous implementation reported distinctly and some dashboards read.
      return v.mail_exchangers.length === 1 && v.mail_exchangers[0] === v.domain
        ? 'ok-a-record'
        : 'ok';
  }
}

/**
 * Assess an address at the domain level: syntax, policy, MX (A-record fallback).
 *
 * ASSESSES REGARDLESS OF MODE, as it always has — `force` keeps that true even
 * where EMAIL_VALIDATION_MODE is `off`. The mode decides whether a verdict may
 * stop a send, not whether a caller may ask for one. Never throws.
 */
export async function assessEmailDeliverability(address: string): Promise<DeliverabilityAssessment> {
  const verification = await verifyAddress(address, { force: true });
  return {
    deliverable: verification.verdict !== 'undeliverable',
    reason: toReason(verification),
    domain: verification.domain || null,
    verification,
  };
}

/** Mask an address for logs: first local character, then the full domain. */
export function maskEmail(address: string): string {
  return maskAddress(address);
}

export type GateDecision = 'send' | 'suppress';

/**
 * Decide whether a PLATFORM email should be dispatched.
 *
 *   off    -> always 'send', no assessment.
 *   soft   -> always 'suppress' (send nothing), but log what strict would do.
 *   strict -> 'send' unless the address is refused by the shared send policy.
 *
 * The soft behaviour is unchanged and intentionally severe on this path: it is
 * the observation window for the platform's own transactional mail, where the
 * cost of a wrong send is reputation on the shared sending domain. Tenant sends
 * are gated separately, in the gateway's pre-send guard, where soft observes
 * without suppressing.
 *
 * Never throws.
 */
export async function gatePlatformEmail(
  address: string,
  purpose = 'platform-email',
): Promise<{ decision: GateDecision; assessment?: DeliverabilityAssessment }> {
  const mode = emailValidationMode();
  if (mode === 'off') return { decision: 'send' };

  const assessment = await assessEmailDeliverability(address);
  const verification = assessment.verification;

  if (mode === 'soft') {
    // eslint-disable-next-line no-console
    console.log(
      `[email-validation] mode=soft purpose=${purpose} action=suppress-no-send ` +
        `verdict=${verification?.verdict ?? 'unknown'} reason=${assessment.reason} ` +
        `domain=${assessment.domain ?? ''} to=${maskEmail(address)}`,
    );
    return { decision: 'suppress', assessment };
  }

  /* strict — the SHARED policy decides, so this path and the tenant guard
     refuse exactly the same addresses. A `risky` verdict blocks only where the
     deployment has opted into it (placeholder/disposable by default, role not). */
  const allowed = verification ? sendDecision(verification).allowed : true;
  const decision: GateDecision = allowed ? 'send' : 'suppress';
  // eslint-disable-next-line no-console
  console[decision === 'send' ? 'log' : 'warn'](
    `[email-validation] mode=strict purpose=${purpose} action=${decision === 'send' ? 'allow' : 'block'} ` +
      `verdict=${verification?.verdict ?? 'unknown'} reason=${assessment.reason} ` +
      `domain=${assessment.domain ?? ''} to=${maskEmail(address)}`,
  );
  return { decision, assessment };
}
