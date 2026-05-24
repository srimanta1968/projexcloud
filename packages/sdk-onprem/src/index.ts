/**
 * @projexlight/sdk-onprem — public surface.
 *
 * P8 Variant C · On-Prem / Air-Gapped. Single-cluster K8s distribution
 * with: install registry, signed quarterly bundle tracking, local LLM
 * model registry for sdk-ai-gateway, internal-only billing reports
 * (no external invoicing per FR-ONP-9/10), and the in-cluster webhook
 * URL validator (FR-ONP-6).
 *
 * Federation hooks are honored as terminal in on-prem (FR-ONP-7) via the
 * pool-router's manifest reader.
 */
export { migrationsDir } from './db';
export type {
  K8sDistribution,
  AirGapMode,
  OnPremBillingMode,
  OnPremInstallRef,
  OnPremBundleApplyRef,
  LocalLlmBackend,
  LocalLlmQuantization,
  LocalLlmStatus,
  LocalLlmModelRef,
  OnPremBillingReportRef,
} from '@projexlight/contracts';

// FR-ONP-1..10 — install / bundle / local-LLM / billing / webhook services.
export {
  registerInstall,
  getInstall,
  applyBundle,
  rollbackBundle,
  registerLocalLlm,
  generateBillingReport,
  isWebhookUrlAllowed,
  setOnPremEmitter,
} from './services/installService';
export type {
  RegisterInstallInput,
  ApplyBundleInput,
  RegisterLocalLlmInput,
  GenerateBillingReportInput,
  OnPremEmitter,
} from './services/installService';

// G-P8-5 + G-P8-6 — cross-SDK boot hooks that wire on-prem semantics into
// sdk-ai-gateway (local provider preference) and sdk-webhook (URL validator).
export { installOnPremCrossSdkHooks } from './services/hooks';
export type { OnPremHooksConfig } from './services/hooks';

// Y-P8-8 — real bundle-signature verification.
export {
  verifyBundleSignature,
  verifyBundleFromDisk,
} from './services/bundleSignatureVerifier';
export type {
  VerifyBundleInput,
  VerifyBundleResult,
} from './services/bundleSignatureVerifier';

// Y-P8-9 — phone-home blocker (strict air-gap).
export {
  installPhoneHomeBlocker,
  PhoneHomeBlockedError,
  _isPhoneHomeBlockerInstalled,
} from './services/phoneHomeBlocker';
export type { PhoneHomeBlockerConfig } from './services/phoneHomeBlocker';

// Y-P8-10 — local LLM latency probe.
export { startLocalLlmProbe } from './services/localLlmProbe';
export type { LocalLlmProbeConfig, LocalLlmProbeHandle } from './services/localLlmProbe';
