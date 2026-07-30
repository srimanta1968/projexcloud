import { cookies } from 'next/headers';
import { SESSION_COOKIE } from '@projexlight/design-system/auth';

/**
 * Authenticated calls from the tenant portal to the gateway.
 *
 * WHY THIS EXISTS
 * ---------------
 * Portal pages were calling the gateway with a bare `fetch` and no
 * `Authorization` header at all. Against the default-deny gate every one of
 * those requests is a 401 — and because the pages swallowed the failure and
 * returned `[]`, the result rendered as an empty table rather than an error. A
 * page that has never worked looks identical to a tenant who has no data.
 *
 * Everything here sends the session cookie as a bearer token and surfaces a
 * failure as a failure.
 */

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ||
  process.env.NEXT_PUBLIC_GATEWAY_URL ||
  `http://localhost:${process.env.GATEWAY_PORT || 4000}`;

export class GatewayError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

function authHeaders(): Record<string, string> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    cache: 'no-store',
    headers: {
      'content-type': 'application/json',
      ...authHeaders(),
      ...(init?.headers as Record<string, string> | undefined),
    },
  });

  const text = await res.text();
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};

  if (!res.ok) {
    // Prefer the gateway's own words. A scope or tenant refusal explains itself
    // far better than "request failed", and the operator is the person who can
    // act on it.
    const details = Array.isArray(body.details) ? (body.details as string[]).join('; ') : '';
    throw new GatewayError(
      res.status,
      details || (body.error as string) || `Gateway returned ${res.status}`,
    );
  }
  return (body.data ?? body) as T;
}

export const gateway = {
  get: <T>(path: string): Promise<T> => request<T>(path),
  post: <T>(path: string, body?: unknown): Promise<T> =>
    request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown): Promise<T> =>
    request<T>(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined }),
};

export interface ApplicationRow {
  application_id: string;
  tenant_id: string;
  name: string;
  slug: string;
  description: string | null;
  environment: 'live' | 'test';
  status: 'active' | 'disabled';
  created_at: string;
  disabled_at: string | null;
}

export interface KeyRow {
  key_id: string;
  application_id: string | null;
  name: string | null;
  prefix: string;
  scopes: string[];
  environment: 'live' | 'test' | null;
  status: 'active' | 'rotating' | 'revoked' | 'expired';
  rate_limit_rpm: number | null;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
  rotated_from_key_id: string | null;
}

/** How long a rotated key keeps working. Mirrors FR-APK-4. */
export const GRACE_WINDOW_HOURS = 24;

/**
 * Time left on a rotating key's grace window.
 *
 * Measured from the SUCCESSOR's creation, not from this key's own `created_at`:
 * the grace window opens when the rotation happens, and a key that has been in
 * service for six months would otherwise report a window that closed long ago
 * and prompt an operator to revoke a credential their traffic is still using.
 * The successor is the key whose `rotated_from_key_id` points here.
 */
export function graceRemaining(key: KeyRow, successor?: KeyRow): string | null {
  if (key.status !== 'rotating') return null;
  if (!successor) return 'rotated - revoke once traffic has moved';
  const endsAt = new Date(successor.created_at).getTime() + GRACE_WINDOW_HOURS * 3600_000;
  const ms = endsAt - Date.now();
  if (ms <= 0) return 'grace window has ended - revoke it now';
  const hours = Math.floor(ms / 3600_000);
  const minutes = Math.floor((ms % 3600_000) / 60_000);
  return hours > 0 ? `${hours}h ${minutes}m left` : `${minutes}m left`;
}

/** Maps each rotating key to the key that replaced it. */
export function successorOf(keys: KeyRow[]): Map<string, KeyRow> {
  const map = new Map<string, KeyRow>();
  for (const k of keys) {
    if (k.rotated_from_key_id) map.set(k.rotated_from_key_id, k);
  }
  return map;
}
