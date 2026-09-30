/**
 * @projexlight/sdk-speech — the voice provider catalog and speech BYOK (VA·E4).
 *
 * Holds the STT/TTS/LLM-for-voice/realtime catalog with list prices and certification,
 * which presets and stack profiles reference by catalog_key.
 * See docs/v3.1/voiceagent/VoiceAgent-Architecture-v3.1.html §8.
 */
export { migrationsDir } from './db';

export { SpeechError } from './models/errors';

export {
  CATALOG_LAYERS,
  PRICE_UNITS,
  CERTIFICATION_STATUSES,
  listCatalog,
  getCatalogEntry,
  findCatalogEntries,
  catalogKey,
  updateCatalogEntry,
} from './services/catalogService';
export type {
  CatalogEntry,
  CatalogEntryChange,
  CatalogEntryPatch,
  CatalogFilter,
  CatalogLayer,
  CatalogVoice,
  CertificationStatus,
  PriceUnit,
} from './services/catalogService';

export { validateCredential } from './services/keyValidationService';
export type { KeyValidation } from './services/keyValidationService';

export { DEFAULT_USAGE_PROFILE, parseUsageProfile, estimateCostPerMinute } from './services/costService';
export type { UsageProfile, PricedLayerInput, CostLine, CostEstimate } from './services/costService';

export { MAX_PREVIEW_CHARS, previewVoice } from './services/voicePreviewService';
export type { PreviewInput, VoicePreview } from './services/voicePreviewService';

export * as server from './server';

export {
  CERT_SCOPES,
  certificationThresholds,
  startCertificationRun,
  getCertificationRun,
  listCertificationRuns,
  findTenantCertifications,
  claimCertificationRun,
  finishCertificationRun,
} from './services/certificationService';
export type { CertScope, CertificationRun, CertificationJob, StartCertificationInput } from './services/certificationService';
