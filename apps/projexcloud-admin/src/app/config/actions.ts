'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { SESSION_COOKIE } from '@projexlight/design-system/auth';
import { requirePlatformOperator } from '../../lib/session';

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL;

/** Payload shape ConfigForm hands to onSave: a non-secret JSON value OR a secret_ref. */
export interface ConfigPayload {
  value?: Record<string, unknown>;
  secret_ref?: string;
}

export interface ConfigActionResult {
  ok: boolean;
  error?: string;
}

/**
 * Platform-scope config write. PLATFORM-OPERATOR-ONLY — the guard runs before the
 * server-held ADMIN_OPS_TOKEN is presented. Platform-scope writes require BOTH the
 * operator's tenant JWT (Bearer, passes requireAuth) AND the admin ops-token header
 * (the config plane accepts it as the platform-operator authorization), so both are
 * sent. scope_id is '' for platform (global).
 */
export async function saveConfigAction(
  key: string,
  payload: ConfigPayload,
): Promise<ConfigActionResult> {
  await requirePlatformOperator();
  const jwt = cookies().get(SESSION_COOKIE)?.value ?? '';
  try {
    const res = await fetch(`${GATEWAY}/api/config`, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${jwt}`,
        'x-admin-ops-token': process.env.ADMIN_OPS_TOKEN ?? '',
      },
      body: JSON.stringify({ scope: 'platform', scope_id: '', key, ...payload }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: body?.details?.[0] || body?.error || `Save failed (${res.status})` };
    }
    revalidatePath('/config');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Revoke (soft-delete) a platform-scope config value. PLATFORM-OPERATOR-ONLY. */
export async function revokeConfigAction(key: string): Promise<ConfigActionResult> {
  await requirePlatformOperator();
  const jwt = cookies().get(SESSION_COOKIE)?.value ?? '';
  try {
    const res = await fetch(`${GATEWAY}/api/config/revoke`, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${jwt}`,
        'x-admin-ops-token': process.env.ADMIN_OPS_TOKEN ?? '',
      },
      body: JSON.stringify({ scope: 'platform', scope_id: '', key }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: body?.details?.[0] || body?.error || `Remove failed (${res.status})` };
    }
    revalidatePath('/config');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
