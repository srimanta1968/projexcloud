/**
 * @projexlight/sdk-evidence — public surface.
 *
 * P7 · The chain-of-custody linchpin. LAST domain SDK to ship — depends on
 * every encryption tier (sdk-vault), audit chain (sdk-audit), media blob
 * store (sdk-media), device attestation (sdk-device), consent receipt
 * (sdk-consent), and encounter lifecycle (sdk-engagement).
 *
 * Provenance-stamped captures (GPS · IMU · device_uuid · timestamp ·
 * consent_ref); raw + edited retention (edits never overwrite raw);
 * chain-of-custody hash linked to Audit chain; legal-export API per
 * jurisdiction (US courts / EU GDPR / India IT Act); every capture
 * stamped with encounter_id; sealing encounter blocks new captures;
 * per-encounter retention shreds the right blobs at expiry.
 *
 * Initial drop: Postgres migration + public-surface re-exports. Capture
 * intake + chain-of-custody hash chain + legal-export bundle generator
 * land in follow-up tasks under feat_p7_evidence.
 */
export { migrationsDir } from './db';
export type {
  EvidenceCaptureRef,
  EvidenceVariantRef,
  ChainOfCustodyEntry,
  EvidenceLegalExportRef,
  EvidenceCaptureStatus,
  EvidenceVariantKind,
  ChainOfCustodyAction,
  LegalExportJurisdiction,
} from '@projexlight/contracts';

// P7 FR-EVD-5 / AC-11 — encounter seal guard.
export {
  getEncounterSealStatus,
  assertEncounterNotSealed,
  EncounterSealedError,
} from './services/sealGuard';
export type { EncounterSealStatus, EncounterSealState } from './services/sealGuard';

// P7 FR-EVD-3 / AC-9 — chain-of-custody verifier.
export {
  verifyChain,
  verifyChains,
  computeEntryHash,
} from './services/chainVerifier';
export type { ChainVerifyReport, ChainFailureReason } from './services/chainVerifier';

// P7 FR-EVD-3 producer — chain-of-custody append helper.
export { appendChainEntry, setChainAppendEmitter } from './services/chainAppender';
export type {
  AppendChainEntryInput,
  AppendChainEntryResult,
  ChainAppendEventEmitter,
} from './services/chainAppender';

// P7 FR-EVD-4 / AC-9 — legal-export bundle generator + jurisdiction templates.
export {
  generateLegalExport,
  verifyLegalExportBundle,
  registerLegalExportUploader,
} from './services/legalExportGenerator';
export type { GenerateLegalExportInput, UploadAdapter } from './services/legalExportGenerator';
export {
  getJurisdictionTemplate,
  registerJurisdictionTemplate,
  listJurisdictionTemplates,
} from './services/legalExportTemplates';
export type { JurisdictionTemplate } from './services/legalExportTemplates';

// P7 FR-EVD-6 / AC-12 — retention shredder worker.
export {
  startRetentionShredder,
  drainOnce as drainRetentionOnce,
  setShredEmitter,
  DEFAULT_SHREDDER_CONFIG,
} from './services/retentionShredder';
export type {
  ShredderConfig,
  ShredderHandle,
  ShredderStats,
  ShredEventEmitter,
} from './services/retentionShredder';
