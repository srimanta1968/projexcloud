/**
 * @projexlight/sdk-source-record — the provenance kernel (P16 · EP-374).
 *
 * Immutable source captures, bitemporal assertions, a progressive trust ladder
 * (P0 captured -> P4 direct) and signed source-rights attestation, under
 * link-over-merge semantics: no assertion is ever destroyed, so conflicting values
 * from different origins coexist and stay auditable. Resolving which value to
 * DISPLAY is sdk-projection's job, deliberately not this SDK's.
 *
 * Vertical-neutral by contract: no vertical, stage, role or business rule appears
 * anywhere in this package.
 */
export { migrationsDir } from './db';
export * as server from './server';
export * from './models/sourceRecord.model';
export * from './services/sourceRecordService';
export * from './services/assertionService';
export * from './services/attestationService';
