/**
 * Lightweight fetch wrapper for the api-gateway. Stores the auth token in
 * localStorage so the workspace shell can attach it to subsequent requests.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:3500';
const TOKEN_KEY = 'projexlight.auth.token';
// Mirrors the token into a cookie so Next middleware (edge, no localStorage)
// can gate authenticated routes. Must match SESSION_COOKIE in
// @projexlight/design-system/auth.
const SESSION_COOKIE = 'projexlight.session';
const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 days, matches JWT_EXPIRES_IN default

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (typeof window === 'undefined') return;
  if (token) {
    window.localStorage.setItem(TOKEN_KEY, token);
    document.cookie = `${SESSION_COOKIE}=${token}; path=/; SameSite=Lax; max-age=${SESSION_MAX_AGE}`;
  } else {
    window.localStorage.removeItem(TOKEN_KEY);
    document.cookie = `${SESSION_COOKIE}=; path=/; SameSite=Lax; max-age=0`;
  }
}

export interface ApiError {
  status: number;
  error: string;
  details?: string[];
}

/**
 * POSTs JSON to the api-gateway and returns the parsed `data` envelope.
 * Throws a structured ApiError on non-2xx.
 */
export async function apiPost<TResp>(path: string, body: unknown): Promise<TResp> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }

  if (!res.ok) {
    const p = (payload as { error?: string; details?: string[] }) ?? {};
    const err: ApiError = {
      status: res.status,
      error: p.error || `HTTP_${res.status}`,
      details: p.details,
    };
    throw err;
  }
  return (payload as { data: TResp }).data;
}
