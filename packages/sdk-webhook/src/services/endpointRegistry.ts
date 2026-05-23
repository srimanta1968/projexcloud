import { dataService } from '@projexlight/db-runtime';
import { assertRegisteredEventType } from '@projexlight/contracts';
import type {
  EndpointRecord,
  RegisterEndpointInput,
  SubscribeInput,
  SubscriptionRecord,
} from '../models/webhook.model';

export class EndpointNotFoundError extends Error {
  readonly code = 'EndpointNotFound';
  constructor(id: string) { super(`Endpoint ${id} not found`); }
}

export class UnregisteredEventTypeError extends Error {
  readonly code = 'UnregisteredEventType';
  constructor(t: string) {
    super(`event_type '${t}' is not in EVENT_TYPE_REGISTRY (OC-2 mirror)`);
  }
}

/**
 * Register a new endpoint (FR-WHK-1). Enforces HTTPS at the application
 * layer in addition to the DB CHECK so we surface a clearer error.
 */
export async function registerEndpoint(input: RegisterEndpointInput): Promise<EndpointRecord> {
  if (!input.url.startsWith('https://')) {
    throw new Error('endpoint url must be https://');
  }
  const rows = await dataService.rows<EndpointRecord>(
    `INSERT INTO webhook.endpoint (
       tenant_id, url, signing_key_ref, signing_algo, mtls_client_cert_ref, status
     ) VALUES ($1, $2, $3, $4, $5, 'active')
     RETURNING endpoint_id, tenant_id, url, signing_key_ref, signing_algo,
               mtls_client_cert_ref, status, failure_streak,
               last_success_at, last_failure_at, created_at`,
    [
      input.tenant_id,
      input.url,
      input.signing_key_ref,
      input.signing_algo ?? 'hmac-sha256',
      input.mtls_client_cert_ref ?? null,
    ],
  );
  return rows[0];
}

export async function getEndpoint(endpoint_id: string): Promise<EndpointRecord | null> {
  return dataService.one<EndpointRecord>(
    `SELECT endpoint_id, tenant_id, url, signing_key_ref, signing_algo,
            mtls_client_cert_ref, status, failure_streak,
            last_success_at, last_failure_at, created_at
       FROM webhook.endpoint WHERE endpoint_id = $1`,
    [endpoint_id],
  );
}

export async function subscribe(input: SubscribeInput): Promise<SubscriptionRecord> {
  // OC-2 producer-side mirror: refuse subscriptions to event types that
  // aren't in the canonical registry. Prevents typos that would silently
  // drop deliveries.
  try {
    assertRegisteredEventType(input.event_type);
  } catch {
    throw new UnregisteredEventTypeError(input.event_type);
  }

  const endpoint = await getEndpoint(input.endpoint_id);
  if (!endpoint) throw new EndpointNotFoundError(input.endpoint_id);

  const rows = await dataService.rows<SubscriptionRecord>(
    `INSERT INTO webhook.subscription (endpoint_id, event_type, filter_predicate, active)
     VALUES ($1, $2, $3::jsonb, TRUE)
     ON CONFLICT (endpoint_id, event_type) DO UPDATE
       SET filter_predicate = EXCLUDED.filter_predicate,
           active           = TRUE
     RETURNING subscription_id, endpoint_id, event_type, filter_predicate,
               active, created_at`,
    [
      input.endpoint_id,
      input.event_type,
      input.filter_predicate ? JSON.stringify(input.filter_predicate) : null,
    ],
  );
  return rows[0];
}

export async function listEndpointsForTenant(tenant_id: string): Promise<EndpointRecord[]> {
  return dataService.rows<EndpointRecord>(
    `SELECT endpoint_id, tenant_id, url, signing_key_ref, signing_algo,
            mtls_client_cert_ref, status, failure_streak,
            last_success_at, last_failure_at, created_at
       FROM webhook.endpoint WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [tenant_id],
  );
}
