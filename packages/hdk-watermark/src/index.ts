/**
 * @projexlight/hdk-watermark — TS facade + server anchor for the HDK module.
 *
 * P7 · Image/video watermarking for evidence integrity. Depends on
 * hdk-image-editor (renderer pipeline) and sdk-evidence (variant rows).
 * Native iOS (Swift) + Android (Kotlin) implementations live in the HDK
 * workstream and are out of scope for this initial server-side drop.
 *
 * Server anchor: hdk_watermark.application table records every watermark
 * application so chain-of-custody (FR-EVD-7) can prove which schemes
 * (visible · invisible · cryptographic) were applied to which variants.
 *
 * NB (PRD R-6): watermarking is OPTIONAL because forensic objections can
 * arise if the raw is degraded. The cryptographic hash on raw is always
 * preserved; watermarking only affects evidence.variant rows.
 */
export { migrationsDir } from './db';
export type { WatermarkApplicationRef, WatermarkScheme } from '@projexlight/contracts';

// Intake service (FR-WMK / AC-10).
export {
  recordWatermarkApplication,
  getWatermarkApplication,
  listWatermarkApplicationsForVariant,
} from './services/watermarkService';
export type { RecordWatermarkApplicationInput } from './services/watermarkService';

export * as server from './server';
