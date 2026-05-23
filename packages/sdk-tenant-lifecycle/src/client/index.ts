/**
 * Thin HTTP client wrappers for the sdk-tenant-lifecycle server surface.
 * Used by admin portals + integration tests. Production callers compose
 * their own fetch with auth headers; these helpers just shape the request.
 */
import type { TenantLifecycleStateRecord, TenantLifecycleSandboxRecord } from '../models/tenantLifecycle.model';

export interface ClientOptions {
  baseUrl: string;
  bearerToken: string;
  fetchImpl?: typeof fetch;
}

function authHeaders(opts: ClientOptions): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${opts.bearerToken}`,
  };
}

async function postJson<T>(opts: ClientOptions, path: string, body: unknown): Promise<T> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`${opts.baseUrl}${path}`, {
    method: 'POST',
    headers: authHeaders(opts),
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}`);
  return (await res.json()) as T;
}

async function getJson<T>(opts: ClientOptions, path: string): Promise<T> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`${opts.baseUrl}${path}`, { method: 'GET', headers: authHeaders(opts) });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return (await res.json()) as T;
}

export async function suspend(
  opts: ClientOptions, tenant_id: string, reason: string,
): Promise<{ data: { state: TenantLifecycleStateRecord } }> {
  return postJson(opts, `/api/tenant-lifecycle/${tenant_id}/suspend`, { reason });
}

export async function reinstate(
  opts: ClientOptions, tenant_id: string,
): Promise<{ data: { state: TenantLifecycleStateRecord } }> {
  return postJson(opts, `/api/tenant-lifecycle/${tenant_id}/reinstate`, {});
}

export async function offboard(
  opts: ClientOptions, tenant_id: string, deadline_at?: Date,
): Promise<{ data: { state: TenantLifecycleStateRecord } }> {
  return postJson(opts, `/api/tenant-lifecycle/${tenant_id}/offboard`, {
    deadline_at: deadline_at?.toISOString(),
  });
}

export async function createSandbox(
  opts: ClientOptions, body: { expires_at?: Date; sanitization_policy?: string } = {},
): Promise<{ data: { sandbox: TenantLifecycleSandboxRecord } }> {
  return postJson(opts, `/api/tenant-lifecycle/sandbox`, {
    expires_at: body.expires_at?.toISOString(),
    sanitization_policy: body.sanitization_policy,
  });
}

export async function getStateRemote(
  opts: ClientOptions, tenant_id: string,
): Promise<{ data: { state: TenantLifecycleStateRecord } }> {
  return getJson(opts, `/api/tenant-lifecycle/${tenant_id}/state`);
}
