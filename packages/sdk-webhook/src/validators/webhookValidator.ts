import type {
  PublishInput,
  RegisterEndpointInput,
  SigningAlgo,
  SubscribeInput,
} from '../models/webhook.model';

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asString(v: unknown): string { return typeof v === 'string' ? v.trim() : ''; }

export function validateRegisterEndpoint(body: unknown): ValidationResult<RegisterEndpointInput> {
  if (!body || typeof body !== 'object') return { ok: false, errors: ['body must be an object'] };
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  const tenant_id = asString(b.tenant_id);
  const url = asString(b.url);
  const signing_key_ref = asString(b.signing_key_ref);
  const signing_algo = (asString(b.signing_algo) || 'hmac-sha256') as SigningAlgo;

  if (!UUID_RX.test(tenant_id)) errors.push('tenant_id must be a UUID');
  if (!url) errors.push('url is required');
  else if (!url.startsWith('https://')) errors.push('url must use https://');
  if (!signing_key_ref) errors.push('signing_key_ref is required');
  if (!['hmac-sha256','hmac-sha512'].includes(signing_algo)) errors.push('signing_algo must be hmac-sha256 or hmac-sha512');

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      tenant_id,
      url,
      signing_key_ref,
      signing_algo,
      mtls_client_cert_ref: typeof b.mtls_client_cert_ref === 'string' ? b.mtls_client_cert_ref : undefined,
    },
  };
}

export function validateSubscribe(body: unknown): ValidationResult<SubscribeInput> {
  if (!body || typeof body !== 'object') return { ok: false, errors: ['body must be an object'] };
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  const endpoint_id = asString(b.endpoint_id);
  const event_type = asString(b.event_type);

  if (!UUID_RX.test(endpoint_id)) errors.push('endpoint_id must be a UUID');
  if (!event_type) errors.push('event_type is required');

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      endpoint_id,
      event_type,
      filter_predicate: (b.filter_predicate && typeof b.filter_predicate === 'object')
        ? (b.filter_predicate as Record<string, unknown>) : undefined,
    },
  };
}

export function validatePublish(body: unknown): ValidationResult<PublishInput> {
  if (!body || typeof body !== 'object') return { ok: false, errors: ['body must be an object'] };
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  const tenant_id = asString(b.tenant_id);
  const event_type = asString(b.event_type);
  const event_id = asString(b.event_id);

  if (!UUID_RX.test(tenant_id)) errors.push('tenant_id must be a UUID');
  if (!event_type) errors.push('event_type is required');
  if (!event_id) errors.push('event_id is required');
  if (!b.payload || typeof b.payload !== 'object') errors.push('payload object is required');

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: { tenant_id, event_type, event_id, payload: b.payload as Record<string, unknown> },
  };
}
