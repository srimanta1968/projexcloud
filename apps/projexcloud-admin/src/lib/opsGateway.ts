/**
 * Server-side calls from the operator console to the gateway's operator routes, with the
 * ADMIN_OPS_TOKEN header. Failures surface as errors with the gateway's own message rather
 * than as an empty page (a page that has never worked must not look like "no data").
 */

const API_BASE = process.env.NEXT_PUBLIC_GATEWAY_URL || `http://localhost:${process.env.GATEWAY_PORT || 4000}`;

export class OpsGatewayError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'OpsGatewayError';
  }
}

async function request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: init.method ?? 'GET',
    cache: 'no-store',
    headers: {
      'x-admin-ops-token': process.env.ADMIN_OPS_TOKEN ?? '',
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) {
    const details = Array.isArray(body.details) ? (body.details as string[]).join('; ') : '';
    throw new OpsGatewayError(res.status, details || (body.error as string) || `Gateway returned ${res.status}`);
  }
  return (body.data ?? body) as T;
}

export const opsGateway = {
  get: <T>(path: string) => request<T>(path),
  patch: <T>(path: string, body: unknown) => request<T>(path, { method: 'PATCH', body }),
};
