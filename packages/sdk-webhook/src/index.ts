export * as server from './server';
export * as types from './models/webhook.model';
export { migrationsDir } from './db';
export {
  registerEndpoint,
  getEndpoint,
  subscribe,
  listEndpointsForTenant,
  EndpointNotFoundError,
  UnregisteredEventTypeError,
  WebhookUrlRejectedError,
} from './services/endpointRegistry';

// P8 Variant C — webhook URL validator hook. sdk-onprem registers a
// validator at boot that refuses external URLs in air-gap-strict mode.
export {
  setExternalUrlValidator,
  validateExternalUrl,
  _resetExternalUrlValidator,
} from './services/urlValidator';
export type { ExternalUrlValidator, UrlValidationResult } from './services/urlValidator';
export { publishEvent } from './services/outboxWriter';
export {
  startDeliveryWorker,
  runWorkerTick,
} from './services/deliveryWorker';
export {
  listDlq,
  replayDelivery,
  DeliveryNotInDlqError,
  DlqWindowExpiredError,
} from './services/dlqReplay';
export {
  signRequest,
  verifySignature,
  registerHmacKeyResolver,
  createVaultHmacKeyResolver,
} from './services/hmacSigner';
export type { KeyResolver, SignedHeaders } from './services/hmacSigner';
export {
  setMtlsCertResolver,
  getMtlsCertResolver,
  resolveMtlsAgent,
  clearMtlsAgentCache,
} from './services/mtlsAgent';
export type { MtlsCertResolver, MtlsCertMaterial } from './services/mtlsAgent';
