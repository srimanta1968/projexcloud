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

export * as server from './server';
