import crypto from 'crypto';
import { getPool } from '@projexlight/db-runtime';
import type {
  SovereignRegime,
  SovereignAttestationState,
  SovereignRegionConfigRef,
  SovereignBundleReleaseRef,
  SovereignAttestationRef,
  LeakAlertKind,
  LeakAlertSeverity,
  LeakMonitorAlertRef,
} from '@projexlight/contracts';

/**
 * Sovereign region registry + bundle release tracker + attestation log
 * + leak alert ingest (P8 Variant B · FR-SOV-1..8).
 *
 * Pluggable emitter so api-gateway can ship events to the regulated topic.
 */

export interface SovereignEmitter {
  (event: {
    event_type:
      | 'sovereign.bundle.shipped.v1'
      | 'sovereign.bundle.applied.v1'
      | 'sovereign.attestation.issued.v1'
      | 'sovereign.leak.alert.v1';
    region_id: string;
    payload: Record<string, unknown>;
    occurred_at: string;
  }): Promise<void> | void;
}

let _emitter: SovereignEmitter = (event) => {
  console.log(`[sovereign] would emit ${event.event_type} region=${event.region_id} (no emitter)`);
};

export function setSovereignEmitter(emitter: SovereignEmitter): void {
  _emitter = emitter;
}

export interface RegisterRegionInput {
  region_id: string;
  regime: SovereignRegime;
  operator_partner: string;
  terminal_federation?: boolean;
  kms_provider: string;
  operator_id: string;
}

export async function registerRegion(input: RegisterRegionInput): Promise<SovereignRegionConfigRef> {
  const pool = getPool();
  const { rows } = await pool.query<{
    region_id: string;
    regime: string;
    operator_partner: string;
    terminal_federation: boolean;
    kms_provider: string;
    activated_at: Date;
    attestation_state: string;
  }>(
    `INSERT INTO sovereign.region_config
       (region_id, regime, operator_partner, terminal_federation, kms_provider)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (region_id) DO UPDATE
       SET regime = EXCLUDED.regime,
           operator_partner = EXCLUDED.operator_partner,
           terminal_federation = EXCLUDED.terminal_federation,
           kms_provider = EXCLUDED.kms_provider
     RETURNING region_id, regime, operator_partner, terminal_federation,
               kms_provider, activated_at, attestation_state`,
    [input.region_id, input.regime, input.operator_partner, input.terminal_federation ?? true, input.kms_provider],
  );
  const row = rows[0];
  return {
    region_id: row.region_id,
    regime: row.regime as SovereignRegime,
    operator_partner: row.operator_partner,
    terminal_federation: row.terminal_federation,
    kms_provider: row.kms_provider,
    activated_at: row.activated_at.toISOString(),
    attestation_state: row.attestation_state as SovereignAttestationState,
  };
}

export async function listRegions(): Promise<SovereignRegionConfigRef[]> {
  const pool = getPool();
  const { rows } = await pool.query<{
    region_id: string;
    regime: string;
    operator_partner: string;
    terminal_federation: boolean;
    kms_provider: string;
    activated_at: Date;
    attestation_state: string;
  }>(
    `SELECT region_id, regime, operator_partner, terminal_federation,
            kms_provider, activated_at, attestation_state
       FROM sovereign.region_config
       ORDER BY activated_at DESC`,
  );
  return rows.map((row) => ({
    region_id: row.region_id,
    regime: row.regime as SovereignRegime,
    operator_partner: row.operator_partner,
    terminal_federation: row.terminal_federation,
    kms_provider: row.kms_provider,
    activated_at: row.activated_at.toISOString(),
    attestation_state: row.attestation_state as SovereignAttestationState,
  }));
}

export interface ShipBundleInput {
  region_id: string;
  version: string;
  bundle_artifact_ref: string;
  signature: Buffer;
  rollback_to_release_id?: string | null;
}

export async function shipBundle(input: ShipBundleInput): Promise<SovereignBundleReleaseRef> {
  const releaseId = `sbr_${crypto.randomBytes(10).toString('hex')}`;
  const pool = getPool();
  const { rows } = await pool.query<{
    shipped_at: Date;
  }>(
    `INSERT INTO sovereign.bundle_release
       (release_id, region_id, version, bundle_artifact_ref, signature, rollback_to_release_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING shipped_at`,
    [
      releaseId,
      input.region_id,
      input.version,
      input.bundle_artifact_ref,
      input.signature,
      input.rollback_to_release_id ?? null,
    ],
  );
  const release: SovereignBundleReleaseRef = {
    release_id: releaseId,
    region_id: input.region_id,
    version: input.version,
    bundle_artifact_ref: input.bundle_artifact_ref,
    signature: input.signature.toString('hex'),
    shipped_at: rows[0].shipped_at.toISOString(),
    applied_at: null,
    rollback_to_release_id: input.rollback_to_release_id ?? null,
  };
  await _emitter({
    event_type: 'sovereign.bundle.shipped.v1',
    region_id: input.region_id,
    payload: { release_id: releaseId, version: input.version },
    occurred_at: release.shipped_at,
  });
  return release;
}

export async function markBundleApplied(releaseId: string): Promise<SovereignBundleReleaseRef | null> {
  const pool = getPool();
  const { rows } = await pool.query<{
    region_id: string;
    version: string;
    bundle_artifact_ref: string;
    signature: Buffer;
    shipped_at: Date;
    applied_at: Date | null;
    rollback_to_release_id: string | null;
  }>(
    `UPDATE sovereign.bundle_release
        SET applied_at = now()
      WHERE release_id = $1
      RETURNING region_id, version, bundle_artifact_ref, signature,
                shipped_at, applied_at, rollback_to_release_id`,
    [releaseId],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  await _emitter({
    event_type: 'sovereign.bundle.applied.v1',
    region_id: row.region_id,
    payload: { release_id: releaseId, version: row.version },
    occurred_at: (row.applied_at ?? new Date()).toISOString(),
  });
  return {
    release_id: releaseId,
    region_id: row.region_id,
    version: row.version,
    bundle_artifact_ref: row.bundle_artifact_ref,
    signature: row.signature.toString('hex'),
    shipped_at: row.shipped_at.toISOString(),
    applied_at: row.applied_at ? row.applied_at.toISOString() : null,
    rollback_to_release_id: row.rollback_to_release_id,
  };
}

export interface RecordAttestationInput {
  region_id: string;
  regime: SovereignRegime;
  auditor_id: string;
  issued_at: string;
  expires_at: string;
  artifact_ref: string;
}

export async function recordAttestation(input: RecordAttestationInput): Promise<SovereignAttestationRef> {
  const attestationId = `att_${crypto.randomBytes(10).toString('hex')}`;
  const pool = getPool();
  await pool.query(
    `INSERT INTO sovereign.attestation
       (attestation_id, region_id, regime, auditor_id, issued_at, expires_at, artifact_ref)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      attestationId,
      input.region_id,
      input.regime,
      input.auditor_id,
      input.issued_at,
      input.expires_at,
      input.artifact_ref,
    ],
  );
  // Flip the region's attestation_state to 'attested' on successful issue.
  await pool.query(
    `UPDATE sovereign.region_config SET attestation_state = 'attested' WHERE region_id = $1`,
    [input.region_id],
  );
  await _emitter({
    event_type: 'sovereign.attestation.issued.v1',
    region_id: input.region_id,
    payload: { attestation_id: attestationId, regime: input.regime, auditor_id: input.auditor_id },
    occurred_at: new Date().toISOString(),
  });
  return {
    attestation_id: attestationId,
    region_id: input.region_id,
    regime: input.regime,
    auditor_id: input.auditor_id,
    issued_at: input.issued_at,
    expires_at: input.expires_at,
    artifact_ref: input.artifact_ref,
  };
}

export interface IngestLeakAlertInput {
  region_id: string;
  kind: LeakAlertKind;
  severity: LeakAlertSeverity;
  incident_ref?: string | null;
}

export async function ingestLeakAlert(input: IngestLeakAlertInput): Promise<LeakMonitorAlertRef> {
  const alertId = `alt_${crypto.randomBytes(10).toString('hex')}`;
  const pool = getPool();
  const { rows } = await pool.query<{ raised_at: Date }>(
    `INSERT INTO sovereign.leak_monitor_alert
       (alert_id, region_id, kind, severity, incident_ref)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING raised_at`,
    [alertId, input.region_id, input.kind, input.severity, input.incident_ref ?? null],
  );
  const alert: LeakMonitorAlertRef = {
    alert_id: alertId,
    region_id: input.region_id,
    kind: input.kind,
    severity: input.severity,
    raised_at: rows[0].raised_at.toISOString(),
    resolved_at: null,
    incident_ref: input.incident_ref ?? null,
  };
  await _emitter({
    event_type: 'sovereign.leak.alert.v1',
    region_id: input.region_id,
    payload: { alert_id: alertId, kind: input.kind, severity: input.severity },
    occurred_at: alert.raised_at,
  });
  return alert;
}

export async function resolveLeakAlert(alertId: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE sovereign.leak_monitor_alert SET resolved_at = now() WHERE alert_id = $1 AND resolved_at IS NULL`,
    [alertId],
  );
}
