/**
 * Email deliverability guard (EP-341 follow-up) — a mode-gated pre-send check
 * that protects platform sender reputation from bounces to non-existent
 * addresses, WITHOUT breaking the test/CI suite (which registers with
 * synthetic, non-deliverable domains like example.com / *.test).
 *
 * Mirrors the AUTH_GATE_MODE kill-switch pattern (enforce|report|off):
 *
 *   EMAIL_VALIDATION_MODE = off | soft | strict   (default: off)
 *
 *   - off    : no assessment; caller sends exactly as before. This is the
 *              dev/test/CI default so the api-test suite is UNAFFECTED — a
 *              random @example.com / @acme.test signup still "sends" (in dev no
 *              platform provider is configured, so it's a no-op log anyway).
 *   - soft   : assess + LOG the verdict, but send NO real email and block NO
 *              registration. Pure observation for the prod rollout window — zero
 *              reputation risk. Lets us measure what strict WOULD do against real
 *              UI signups before enforcing.
 *   - strict : send only to addresses that pass; skip (drop) undeliverable ones
 *              so a typo'd / dead domain never becomes a hard bounce.
 *
 * The assessment is DOMAIN-level (syntax -> disposable blocklist -> MX, with an
 * A-record fallback). It deliberately does NOT do live SMTP RCPT probing:
 * accept-all / greylisting make it unreliable and it can itself harm the
 * sending IP's reputation. Public/consumer providers (gmail, outlook, …) pass
 * naturally (they have MX); only disposable and no-MX domains are flagged.
 */

import { promises as dnsPromises } from 'node:dns';

export type EmailValidationMode = 'off' | 'soft' | 'strict';

/** Current mode from EMAIL_VALIDATION_MODE (default 'off'); unknown values -> 'off'. */
export function emailValidationMode(): EmailValidationMode {
  const m = (process.env.EMAIL_VALIDATION_MODE || 'off').trim().toLowerCase();
  return m === 'soft' || m === 'strict' ? m : 'off';
}

/** Same shape as the identity validator's EMAIL_RE — format gate only. */
const EMAIL_SYNTAX_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Known disposable / throwaway domains. Small, curated list — the common abuse
 * vectors. Extend via EMAIL_DISPOSABLE_DOMAINS (comma-separated) without a code
 * change. NOT consumer/public providers — gmail/outlook/yahoo are legitimate and
 * intentionally absent.
 */
const BUILTIN_DISPOSABLE = [
  'mailinator.com', '10minutemail.com', 'guerrillamail.com', 'guerrillamail.net',
  'tempmail.com', 'temp-mail.org', 'throwawaymail.com', 'yopmail.com', 'trashmail.com',
  'getnada.com', 'fakeinbox.com', 'sharklasers.com', 'maildrop.cc', 'dispostable.com',
  'mailnesia.com', 'mintemail.com', 'tempr.email', 'discard.email', 'mohmal.com',
];

function disposableDomains(): Set<string> {
  const extra = (process.env.EMAIL_DISPOSABLE_DOMAINS || '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  return new Set([...BUILTIN_DISPOSABLE, ...extra]);
}

export type DeliverabilityReason =
  | 'ok'
  | 'ok-a-record'
  | 'bad-syntax'
  | 'disposable-domain'
  | 'no-mx';

export interface DeliverabilityAssessment {
  deliverable: boolean;
  reason: DeliverabilityReason;
  domain: string | null;
}

/**
 * Assess whether an address is plausibly deliverable at the DOMAIN level:
 * syntax -> disposable blocklist -> MX records (A-record fallback). Never
 * throws — DNS failures resolve to a non-deliverable verdict.
 */
export async function assessEmailDeliverability(address: string): Promise<DeliverabilityAssessment> {
  const email = (address || '').trim().toLowerCase();
  if (!EMAIL_SYNTAX_RE.test(email)) {
    return { deliverable: false, reason: 'bad-syntax', domain: null };
  }
  const domain = email.slice(email.lastIndexOf('@') + 1);
  if (disposableDomains().has(domain)) {
    return { deliverable: false, reason: 'disposable-domain', domain };
  }
  try {
    const mx = await dnsPromises.resolveMx(domain);
    if (Array.isArray(mx) && mx.some((r) => r.exchange)) {
      return { deliverable: true, reason: 'ok', domain };
    }
  } catch {
    // No MX (or DNS error) — fall through to the A-record fallback. Some domains
    // accept mail on their A record with no explicit MX (RFC 5321 §5.1).
  }
  try {
    const a = await dnsPromises.resolve(domain);
    if (Array.isArray(a) && a.length > 0) {
      return { deliverable: true, reason: 'ok-a-record', domain };
    }
  } catch {
    // No A record either.
  }
  return { deliverable: false, reason: 'no-mx', domain };
}

/** Mask an address for logs: keep the first local char + full domain. */
export function maskEmail(address: string): string {
  const email = (address || '').trim();
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const head = local[0] ?? '';
  return `${head}${'*'.repeat(Math.max(1, local.length - 1))}@${domain}`;
}

export type GateDecision = 'send' | 'suppress';

/**
 * Decide whether a platform email should actually be dispatched, per the current
 * EMAIL_VALIDATION_MODE. Returns { decision, assessment } and emits ONE structured
 * log line so the soft-mode rollout is observable. Never throws.
 *
 *   off    -> always 'send', no assessment (assessment undefined).
 *   soft   -> always 'suppress' (send nothing), but log what strict would do.
 *   strict -> 'send' when deliverable, else 'suppress'.
 */
export async function gatePlatformEmail(
  address: string,
  purpose = 'platform-email',
): Promise<{ decision: GateDecision; assessment?: DeliverabilityAssessment }> {
  const mode = emailValidationMode();
  if (mode === 'off') return { decision: 'send' };

  const assessment = await assessEmailDeliverability(address);
  if (mode === 'soft') {
    // Observation only: never send, never block. Log the verdict strict WOULD act on.
    // eslint-disable-next-line no-console
    console.log(
      `[email-validation] mode=soft purpose=${purpose} action=suppress-no-send ` +
        `deliverable=${assessment.deliverable} reason=${assessment.reason} ` +
        `domain=${assessment.domain ?? ''} to=${maskEmail(address)}`,
    );
    return { decision: 'suppress', assessment };
  }

  // strict
  const decision: GateDecision = assessment.deliverable ? 'send' : 'suppress';
  // eslint-disable-next-line no-console
  console[decision === 'send' ? 'log' : 'warn'](
    `[email-validation] mode=strict purpose=${purpose} action=${decision === 'send' ? 'allow' : 'block'} ` +
      `deliverable=${assessment.deliverable} reason=${assessment.reason} ` +
      `domain=${assessment.domain ?? ''} to=${maskEmail(address)}`,
  );
  return { decision, assessment };
}
