'use server';

import { revalidatePath } from 'next/cache';
import { requirePlatformOperator } from '../../../lib/session';

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL;

export interface MintResult {
  ok: boolean;
  token?: string;
  label?: string;
  expires_at?: string | null;
  error?: string;
}

/**
 * Mints a new admin ops token via the gateway. PLATFORM-OPERATOR-ONLY — the
 * guard runs before ADMIN_OPS_TOKEN is presented. Returns the plaintext token
 * ONCE for display; it is never stored in the portal.
 */
export async function mintOpsTokenAction(
  _prev: MintResult | null,
  formData: FormData,
): Promise<MintResult> {
  const operator = await requirePlatformOperator();

  const label = String(formData.get('label') ?? '').trim();
  if (!label) return { ok: false, error: 'Label is required' };
  const ttlRaw = String(formData.get('ttl_seconds') ?? '').trim();
  const ttl_seconds = ttlRaw ? Number(ttlRaw) : undefined;
  if (ttl_seconds !== undefined && (!Number.isFinite(ttl_seconds) || ttl_seconds <= 0)) {
    return { ok: false, error: 'TTL must be a positive number of seconds (or blank for no expiry)' };
  }
  const reason = String(formData.get('reason') ?? '').trim() || undefined;

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
    revalidatePath('/security/ops-tokens');
    return {
      ok: true,
      token: body.data?.token,
      label: body.data?.label,
      expires_at: body.data?.expires_at ?? null,
    };
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
