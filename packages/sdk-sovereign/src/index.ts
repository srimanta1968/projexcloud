/**
 * @projexlight/sdk-sovereign — public surface.
 *
 * P8 Variant B · Sovereign Cloud. Isolated regions for FedRAMP-High, IL5,
 * China PIPL, EU sovereign, UAE TRD. SDK estate identical; topology +
 * operator differ. SDK ships region registry, signed-bundle release
 * tracker, per-region attestation log, and leak-monitor alert ingest.
 *
 * Pool Router federation manifest reads terminal_federation from
 * sovereign.region_config to refuse cross-region routing automatically.
 */
export { migrationsDir } from './db';
export type {
  SovereignRegime,
  SovereignAttestationState,
  SovereignRegionConfigRef,
  SovereignBundleReleaseRef,
  SovereignAttestationRef,
  LeakAlertKind,
  LeakAlertSeverity,
  LeakMonitorAlertRef,
} from '@projexlight/contracts';

// FR-SOV-1..8 — registry + bundle + attestation + leak monitor services.
export {
  registerRegion,
  listRegions,
  shipBundle,
  markBundleApplied,
  recordAttestation,
  ingestLeakAlert,
  resolveLeakAlert,
  setSovereignEmitter,
} from './services/regionService';
export type {
  RegisterRegionInput,
  ShipBundleInput,
  RecordAttestationInput,
  IngestLeakAlertInput,
  SovereignEmitter,
} from './services/regionService';

// Y-P8-5 — attestation expiry watcher.
export { startAttestationExpiryWatcher } from './services/attestationExpiryWatcher';
export type { ExpiryWatcherConfig, ExpiryWatcherHandle } from './services/attestationExpiryWatcher';

// Y-P8-6 — leak detector pluggable interface + synthetic detector.
export {
  setLeakDetector,
  getLeakDetector,
  startLeakDetector,
  stopLeakDetector,
  recordCandidate as recordLeakCandidate,
  SyntheticLeakDetector,
} from './services/leakDetector';
export type { LeakDetector, AlertCandidate } from './services/leakDetector';
