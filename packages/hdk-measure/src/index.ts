/**
 * @projexlight/hdk-measure — TS facade + server anchor for the HDK module.
 *
 * P7 · AR-based measurement (ARCore/ARKit). Depends on hdk-camera. Native
 * iOS (Swift) + Android (Kotlin) implementations live in the HDK workstream
 * and are out of scope for this initial server-side drop.
 *
 * Server anchor: hdk_measure.measurement table records every measurement
 * persisted from a device so it can be cross-referenced with the
 * underlying evidence.capture and replayed for legal export.
 *
 * NFR (PRD §6): measurement accuracy ±5% for areas ≤ 100m².
 */
export { migrationsDir } from './db';
export type { MeasurementRef, MeasurementKind, MeasurementAccuracyClass } from '@projexlight/contracts';
