'use server';

import { revalidatePath } from 'next/cache';
import { requirePlatformOperator } from '../../../lib/session';

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL;
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'welcome@projexlight.com';
const FROM_NAME = process.env.FROM_NAME || 'Projexlight';

export interface MintResult {
  ok: boolean;
  token?: string;
  label?: string;
  expires_at?: string | null;
  /** Human-readable validity window, e.g. "8 hours" or "no expiry". */
  durationLabel?: string;
  error?: string;
  /** Set when the token was emailed to a QA user. */
  emailedTo?: string;
  /** Set when delivery was requested but failed (token still minted + shown). */
  emailError?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Friendly "valid for" label from a whole/fractional number of hours. */
function humanizeHours(hours: number): string {
  if (hours % 24 === 0) {
    const d = hours / 24;
    return d === 1 ? '1 day' : `${d} days`;
  }
  if (Number.isInteger(hours)) {
    return hours === 1 ? '1 hour' : `${hours} hours`;
  }
  const mins = Math.round(hours * 60);
  return `${mins} minutes`;
}

/**
 * Emails a freshly-minted token to a QA user via the SendGrid HTTP API (no SDK
 * dependency). Throws on misconfiguration or a non-2xx response so the caller
 * can surface it — the token is still shown in the UI regardless.
 */
async function emailToken(
  to: string,
  token: string,
  label: string,
  durationLabel: string,
  expiresAt: string | null,
): Promise<void> {
  if (!SENDGRID_API_KEY) {
    throw new Error('email delivery not configured (SENDGRID_API_KEY unset on the console)');
  }
  const validityLine = expiresAt
    ? `Valid for: ${durationLabel} (expires ${new Date(expiresAt).toISOString()}).`
    : 'Valid until revoked (no expiry).';
  const body = [
    `You have been issued a ProjexCloud admin API test token ("${label}").`,
    '',
    'Use it as the request header when testing the /admin/* API:',
    '',
    `    x-admin-ops-token: ${token}`,
    '',
    validityLine,
    '',
    'Treat this token as a secret — it grants platform admin API access. Do not',
    'share or commit it. It can be revoked at any time by a platform operator.',
  ].join('\n');

  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SENDGRID_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: FROM_EMAIL, name: FROM_NAME },
      subject: `Your ProjexCloud admin API test token (${label}) — valid ${durationLabel}`,
      content: [{ type: 'text/plain', value: body }],
    }),
  });
  if (!res.ok) {
    throw new Error(`SendGrid ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
}

/**
 * Mints a new admin ops token via the gateway. PLATFORM-OPERATOR-ONLY — the
 * guard runs before ADMIN_OPS_TOKEN is presented. Returns the plaintext token
 * ONCE for display; it is never stored in the portal. If a QA email is given,
 * the token is also emailed there with its validity window.
 */
export async function mintOpsTokenAction(
  _prev: MintResult | null,
  formData: FormData,
): Promise<MintResult> {
  const operator = await requirePlatformOperator();

  const label = String(formData.get('label') ?? '').trim();
  if (!label) return { ok: false, error: 'Label is required' };

  // Validity is entered as hours (blank = no expiry) and converted to seconds.
  const hoursRaw = String(formData.get('valid_hours') ?? '').trim();
  let ttl_seconds: number | undefined;
  let durationLabel = 'no expiry';
  if (hoursRaw) {
    const hours = Number(hoursRaw);
    if (!Number.isFinite(hours) || hours <= 0) {
      return { ok: false, error: 'Valid-for must be a positive number of hours (or blank for no expiry)' };
    }
    ttl_seconds = Math.round(hours * 3600);
    durationLabel = humanizeHours(hours);
  }

  const reason = String(formData.get('reason') ?? '').trim() || undefined;
  const deliverTo = String(formData.get('deliver_to') ?? '').trim();
  if (deliverTo && !EMAIL_RE.test(deliverTo)) {
    return { ok: false, error: 'QA email is not a valid email address' };
  }

  try {
    const res = await fetch(`${GATEWAY}/admin/security/ops-tokens`, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        'x-admin-ops-token': process.env.ADMIN_OPS_TOKEN ?? '',
      },
      body: JSON.stringify({ label, ttl_seconds, reason, created_by: operator.email }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: body?.error || `Mint failed (${res.status})` };

    const token: string = body.data?.token;
    const result: MintResult = {
      ok: true,
      token,
      label: body.data?.label,
      expires_at: body.data?.expires_at ?? null,
      durationLabel,
    };

    if (deliverTo) {
      try {
        await emailToken(deliverTo, token, result.label ?? label, durationLabel, result.expires_at ?? null);
        result.emailedTo = deliverTo;
      } catch (e) {
        // Non-fatal: the token is minted and shown in the UI regardless.
        result.emailError = (e as Error).message;
      }
    }

    revalidatePath('/security/ops-tokens');
    return result;
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Revokes an ops token by id. PLATFORM-OPERATOR-ONLY. */
export async function revokeOpsTokenAction(formData: FormData): Promise<void> {
  await requirePlatformOperator();
  const id = String(formData.get('id') ?? '').trim();
  if (!id) return;
  await fetch(`${GATEWAY}/admin/security/ops-tokens/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    cache: 'no-store',
    headers: { 'x-admin-ops-token': process.env.ADMIN_OPS_TOKEN ?? '' },
  });
  revalidatePath('/security/ops-tokens');
}
