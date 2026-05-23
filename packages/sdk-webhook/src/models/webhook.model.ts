/**
 * TypeScript models mirroring webhook.* tables per P4-Operational-Billing-DataModel §10.
 */

export type EndpointStatus = 'active' | 'paused' | 'circuit-open';
export type SigningAlgo = 'hmac-sha256' | 'hmac-sha512';
export type DeliveryStatus = 'pending' | 'delivering' | 'succeeded' | 'failed' | 'dlq';

export interface EndpointRecord {
  endpoint_id: string;
  tenant_id: string;
  url: string;
  signing_key_ref: string;
  signing_algo: SigningAlgo;
  mtls_client_cert_ref: string | null;
  status: EndpointStatus;
  failure_streak: number;
  last_success_at: Date | null;
  last_failure_at: Date | null;
  created_at: Date;
}

export interface SubscriptionRecord {
  subscription_id: string;
  endpoint_id: string;
  event_type: string;
  filter_predicate: Record<string, unknown> | null;
  active: boolean;
  created_at: Date;
}

export interface DeliveryRecord {
  delivery_id: string;
  subscription_id: string;
  event_id: string;
  payload: Record<string, unknown>;
  status: DeliveryStatus;
  attempts: number;
  next_attempt_at: Date;
  last_attempt_at: Date | null;
  dlq_until: Date | null;
  created_at: Date;
}

export interface DeliveryAttemptRecord {
  attempt_id: string;
  delivery_id: string;
  http_status: number | null;
  response_excerpt: string | null;
  latency_ms: number | null;
  attempted_at: Date;
}

/* ----------------------------------------------------------- DTOs */

export interface RegisterEndpointInput {
  tenant_id: string;
  url: string;
  signing_key_ref: string;
  signing_algo?: SigningAlgo;
  mtls_client_cert_ref?: string;
}

export interface SubscribeInput {
  endpoint_id: string;
  event_type: string;
  filter_predicate?: Record<string, unknown>;
}

export interface PublishInput {
  tenant_id: string;
  event_type: string;
  event_id: string;
  payload: Record<string, unknown>;
}

export interface PublishResult {
  deliveries_enqueued: number;
  delivery_ids: string[];
}
