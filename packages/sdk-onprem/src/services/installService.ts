import crypto from 'crypto';
import { getPool } from '@projexlight/db-runtime';
import type {
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

/**
 * sdk-onprem services (P8 Variant C · FR-ONP-1..10).
 *
 * Owns install / bundle-apply / local-LLM-model / billing-report data flow.
 * Bundle signature verification + actual k8s migration execution happen at
 * the platform tooling layer; this module records what happened so the
 * customer can audit + the support team can troubleshoot.
 */

export interface OnPremEmitter {
  (event: {
    event_type:
      | 'onprem.bundle.applied.v1'
      | 'onprem.bundle.rolled-back.v1'
      | 'onprem.local-llm.loaded.v1';
    install_id: string;
    payload: Record<string, unknown>;
    occurred_at: string;
  }): Promise<void> | void;
}

let _emitter: OnPremEmitter = (event) => {
  console.log(`[onprem] would emit ${event.event_type} install=${event.install_id} (no emitter)`);
};

export function setOnPremEmitter(emitter: OnPremEmitter): void {
  _emitter = emitter;
}

export interface RegisterInstallInput {
  customer_id: string;
  cluster_name: string;
  k8s_distribution: K8sDistribution;
  installed_version: string;
  air_gap_mode?: AirGapMode;
  billing_mode?: OnPremBillingMode;
}

export async function registerInstall(input: RegisterInstallInput): Promise<OnPremInstallRef> {
  const installId = `opr_${crypto.randomBytes(10).toString('hex')}`;
  const pool = getPool();
  const { rows } = await pool.query<{
    install_id: string;
    customer_id: string;
    cluster_name: string;
    k8s_distribution: string;
    installed_version: string;
    installed_at: Date;
    last_updated_at: Date | null;
    air_gap_mode: string;
    phone_home: boolean;
    billing_mode: string;
  }>(
    `INSERT INTO onprem.install
       (install_id, customer_id, cluster_name, k8s_distribution,
        installed_version, air_gap_mode, billing_mode)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING install_id, customer_id, cluster_name, k8s_distribution,
               installed_version, installed_at, last_updated_at,
               air_gap_mode, phone_home, billing_mode`,
    [
      installId,
      input.customer_id,
      input.cluster_name,
      input.k8s_distribution,
      input.installed_version,
      input.air_gap_mode ?? 'strict',
      input.billing_mode ?? 'internal-report-only',
    ],
  );
  const row = rows[0];
  return {
    install_id: row.install_id,
    customer_id: row.customer_id,
    cluster_name: row.cluster_name,
    k8s_distribution: row.k8s_distribution as K8sDistribution,
    installed_version: row.installed_version,
    installed_at: row.installed_at.toISOString(),
    last_updated_at: row.last_updated_at ? row.last_updated_at.toISOString() : null,
    air_gap_mode: row.air_gap_mode as AirGapMode,
    phone_home: row.phone_home,
    billing_mode: row.billing_mode as OnPremBillingMode,
  };
}

export async function getInstall(installId: string): Promise<OnPremInstallRef | null> {
  const pool = getPool();
  const { rows } = await pool.query<{
    install_id: string;
    customer_id: string;
    cluster_name: string;
    k8s_distribution: string;
    installed_version: string;
    installed_at: Date;
    last_updated_at: Date | null;
    air_gap_mode: string;
    phone_home: boolean;
    billing_mode: string;
  }>(
    `SELECT install_id, customer_id, cluster_name, k8s_distribution,
            installed_version, installed_at, last_updated_at,
            air_gap_mode, phone_home, billing_mode
       FROM onprem.install WHERE install_id = $1`,
    [installId],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    install_id: row.install_id,
    customer_id: row.customer_id,
    cluster_name: row.cluster_name,
    k8s_distribution: row.k8s_distribution as K8sDistribution,
    installed_version: row.installed_version,
    installed_at: row.installed_at.toISOString(),
    last_updated_at: row.last_updated_at ? row.last_updated_at.toISOString() : null,
    air_gap_mode: row.air_gap_mode as AirGapMode,
    phone_home: row.phone_home,
    billing_mode: row.billing_mode as OnPremBillingMode,
  };
}

export interface ApplyBundleInput {
  install_id: string;
  bundle_version: string;
  signature_verified: boolean;
  migrations_applied?: Array<{ sdk: string; filename: string }>;
}

export interface ApplyBundleVerifiedInput extends ApplyBundleInput {
  /** Optional path inputs — when supplied, we re-verify the signature
   *  before recording the apply. Belt-and-braces with the caller's flag. */
  bundle_path?: string;
  signature_path?: string;
}

export async function applyBundle(input: ApplyBundleVerifiedInput): Promise<OnPremBundleApplyRef> {
  // Y-P8-8 — when paths are provided, re-verify cryptographically so the
  // recorded signature_verified flag matches the actual signature state.
  if (input.bundle_path && input.signature_path) {
    const { verifyBundleFromDisk } = await import('./bundleSignatureVerifier');
    const verdict = await verifyBundleFromDisk(input.bundle_path, input.signature_path);
    if (!verdict.verified) {
      throw new Error(`[onprem] bundle signature verification failed: ${verdict.reason}`);
    }
    input.signature_verified = true;
  }
  if (!input.signature_verified) {
    // Refuse to record an apply that bypassed signature check.
    throw new Error('[onprem] bundle signature must be verified before apply is recorded');
  }
  const applyId = `apl_${crypto.randomBytes(10).toString('hex')}`;
  const pool = getPool();
  const { rows } = await pool.query<{ started_at: Date }>(
    `INSERT INTO onprem.bundle_apply
       (apply_id, install_id, bundle_version, signature_verified, migrations_applied)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     RETURNING started_at`,
    [
      applyId,
      input.install_id,
      input.bundle_version,
      input.signature_verified,
      JSON.stringify(input.migrations_applied ?? []),
    ],
  );

  // Mark as completed (the apply is the recording — the actual k8s work is
  // done by tooling before this is called).
  const { rows: done } = await pool.query<{ completed_at: Date }>(
    `UPDATE onprem.bundle_apply SET completed_at = now() WHERE apply_id = $1
     RETURNING completed_at`,
    [applyId],
  );

  // Update the install's installed_version + last_updated_at.
  await pool.query(
    `UPDATE onprem.install
        SET installed_version = $2, last_updated_at = now()
      WHERE install_id = $1`,
    [input.install_id, input.bundle_version],
  );

  await _emitter({
    event_type: 'onprem.bundle.applied.v1',
    install_id: input.install_id,
    payload: { apply_id: applyId, version: input.bundle_version },
    occurred_at: done[0].completed_at.toISOString(),
  });

  return {
    apply_id: applyId,
    install_id: input.install_id,
    bundle_version: input.bundle_version,
    signature_verified: input.signature_verified,
    migrations_applied: input.migrations_applied ?? [],
    started_at: rows[0].started_at.toISOString(),
    completed_at: done[0].completed_at.toISOString(),
    rollback_to_version: null,
  };
}

export async function rollbackBundle(applyId: string, toVersion: string): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query<{ install_id: string }>(
    `UPDATE onprem.bundle_apply
        SET rollback_to_version = $2
      WHERE apply_id = $1
      RETURNING install_id`,
    [applyId, toVersion],
  );
  if (rows.length === 0) return;
  // Reflect the rollback on the install row.
  await pool.query(
    `UPDATE onprem.install SET installed_version = $2, last_updated_at = now()
      WHERE install_id = $1`,
    [rows[0].install_id, toVersion],
  );
  await _emitter({
    event_type: 'onprem.bundle.rolled-back.v1',
    install_id: rows[0].install_id,
    payload: { apply_id: applyId, rolled_back_to: toVersion },
    occurred_at: new Date().toISOString(),
  });
}

export interface RegisterLocalLlmInput {
  install_id: string;
  model_id: string;
  backend: LocalLlmBackend;
  endpoint_url: string;
  quantization: LocalLlmQuantization;
  status?: LocalLlmStatus;
}

export async function registerLocalLlm(input: RegisterLocalLlmInput): Promise<LocalLlmModelRef> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO onprem.local_llm_model
       (model_id, install_id, backend, endpoint_url, quantization, status)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (install_id, model_id) DO UPDATE
       SET backend = EXCLUDED.backend,
           endpoint_url = EXCLUDED.endpoint_url,
           quantization = EXCLUDED.quantization,
           status = EXCLUDED.status`,
    [
      input.model_id,
      input.install_id,
      input.backend,
      input.endpoint_url,
      input.quantization,
      input.status ?? 'loading',
    ],
  );
  await _emitter({
    event_type: 'onprem.local-llm.loaded.v1',
    install_id: input.install_id,
    payload: { model_id: input.model_id, backend: input.backend },
    occurred_at: new Date().toISOString(),
  });
  return {
    model_id: input.model_id,
    install_id: input.install_id,
    backend: input.backend,
    endpoint_url: input.endpoint_url,
    quantization: input.quantization,
    status: input.status ?? 'loading',
  };
}

/**
 * Generate an internal-only billing report. Pulls per-SKU rollups from
 * meter.usage_event for [period_start, period_end). Path is on-cluster
 * so a customer can grab it from a mounted volume or via in-cluster GUI.
 */
export interface GenerateBillingReportInput {
  install_id: string;
  period_start: string;
  period_end: string;
  artifact_local_path: string;
}

export async function generateBillingReport(input: GenerateBillingReportInput): Promise<OnPremBillingReportRef> {
  const pool = getPool();
  let usage_summary: Record<string, { units: number; cost: number }> = {};
  try {
    const { rows } = await pool.query<{ sku: string; units: string }>(
      `SELECT sku, SUM(units)::text AS units
         FROM meter.usage_event
        WHERE occurred_at >= $1::date AND occurred_at < $2::date
        GROUP BY sku
        ORDER BY sku`,
      [input.period_start, input.period_end],
    );
    usage_summary = Object.fromEntries(
      rows.map((r) => [r.sku, { units: parseFloat(r.units), cost: 0 }]),
    );
  } catch (err) {
    console.warn('[onprem] usage rollup failed; emitting empty report:', (err as Error).message);
  }

  const reportId = `obr_${crypto.randomBytes(10).toString('hex')}`;
  await pool.query(
    `INSERT INTO onprem.billing_report
       (report_id, install_id, period_start, period_end, usage_summary, artifact_local_path)
     VALUES ($1, $2, $3::date, $4::date, $5::jsonb, $6)`,
    [
      reportId,
      input.install_id,
      input.period_start,
      input.period_end,
      JSON.stringify(usage_summary),
      input.artifact_local_path,
    ],
  );

  return {
    report_id: reportId,
    install_id: input.install_id,
    period_start: input.period_start,
    period_end: input.period_end,
    usage_summary,
    artifact_local_path: input.artifact_local_path,
  };
}

/**
 * Webhook validator — refuses external URLs when the install is in
 * strict air-gap mode. Wired into the sdk-webhook intake path by
 * api-gateway when an on-prem install is detected.
 */
export async function isWebhookUrlAllowed(
  installId: string,
  url: string,
  inClusterOnly: boolean,
): Promise<{ allowed: boolean; reason?: string }> {
  if (!inClusterOnly) {
    const install = await getInstall(installId);
    if (install?.air_gap_mode === 'strict') {
      return {
        allowed: false,
        reason: 'install.air_gap_mode=strict; only in-cluster webhook endpoints permitted',
      };
    }
  }
  // In-cluster URLs match *.svc.cluster.local, *.svc, or 10.x/172.16+/192.168.x ranges.
  const inCluster =
    /\.svc(\.cluster\.local)?(:\d+)?(\/|$)/.test(url) ||
    /^https?:\/\/(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)/.test(url) ||
    /^https?:\/\/localhost(:\d+)?(\/|$)/.test(url);
  if (inClusterOnly && !inCluster) {
    return { allowed: false, reason: 'endpoint not in-cluster' };
  }
  return { allowed: true };
}
