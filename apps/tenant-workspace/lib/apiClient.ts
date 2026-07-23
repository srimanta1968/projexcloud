/**
 * Lightweight fetch wrapper for the api-gateway. Stores the auth token in
 * localStorage so the workspace shell can attach it to subsequent requests.
 */

/**
 * Gateway base URL, resolved for the BROWSER (this module is client-side).
 *
 * The previous default was `http://localhost:3500`, but the api-gateway listens
 * on 4000 (GATEWAY_PORT in .env) and NEXT_PUBLIC_API_BASE was never set — so
 * every sign-in POSTed to a dead port, got ERR_CONNECTION_REFUSED, and the form
 * showed a generic "Sign-in failed. Please try again." Nothing surfaced the
 * port, so it read as bad credentials.
 *
 * Deriving the host from window.location (rather than hardcoding "localhost")
 * matters because the browser is not always on the dev machine: automated UI
 * tests drive a browser INSIDE the Test MCP container, where the app is reached
 * as host.docker.internal:3000 and "localhost" would mean the container itself.
 * Same-host + gateway port works for both, and any deployment that terminates
 * elsewhere sets NEXT_PUBLIC_API_BASE explicitly.
 */
const GATEWAY_PORT = process.env.NEXT_PUBLIC_GATEWAY_PORT || '4000';
const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ||
  (typeof window !== 'undefined'
    ? `${window.location.protocol}//${window.location.hostname}:${GATEWAY_PORT}`
    : `http://localhost:${GATEWAY_PORT}`);
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

/** GETs from the api-gateway and returns the parsed `data` envelope. */
export async function apiGet<TResp>(path: string): Promise<TResp> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, { method: 'GET', headers });

  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }

  if (!res.ok) {
    const p = (payload as { error?: string; details?: string[] }) ?? {};
    throw { status: res.status, error: p.error || `HTTP_${res.status}`, details: p.details } as ApiError;
  }
  return (payload as { data: TResp }).data;
}

/** PUTs JSON to the api-gateway and returns the parsed `data` envelope. */
export async function apiPut<TResp>(path: string, body: unknown): Promise<TResp> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, {
    method: 'PUT',
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
    throw { status: res.status, error: p.error || `HTTP_${res.status}`, details: p.details } as ApiError;
  }
  return (payload as { data: TResp }).data;
}
