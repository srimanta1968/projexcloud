/**
 * SIEM forwarder adapters for BYOK CMK use logs (Y-P8-4 / FR-BYOK-6).
 *
 * Three concrete adapters all speaking HTTP POST:
 *
 *   - Splunk HEC: POST /services/collector/event with X-Splunk-Authorization
 *   - Elastic   : POST /{index}/_doc with Authorization: ApiKey
 *   - Sumo Logic: POST {collector_url} with plain JSON
 *
 * Selection happens by inspecting the binding's siem_forwarder_endpoint
 * URL — Splunk URLs typically contain "/services/collector"; Elastic ends
 * in /_doc or carries an ?index=; Sumo uses the deterministic collector
 * host pattern. Operators can override by setting
 * BYOK_SIEM_FORWARDER_KIND={splunk|elastic|sumo}.
 *
 * Auth credentials come from env (BYOK_SIEM_TOKEN by default; vendor-
 * specific overrides like BYOK_SPLUNK_HEC_TOKEN take precedence). Each
 * adapter no-ops with a logged warning when the token is missing — we
 * never silently drop a CMK use log without leaving a breadcrumb.
 */

import type { ByokBindingRef, CmkUseLogRef } from '@projexlight/contracts';
import type { SiemForwarder } from './byokService';

export type SiemKind = 'splunk' | 'elastic' | 'sumo' | 'auto';

interface ForwardEnvelope {
  binding_id: string;
  tenant_id: string;
  provider: string;
  customer_kms_key_arn: string;
  log: CmkUseLogRef;
  emitted_at: string;
}

function buildEnvelope(binding: ByokBindingRef, log: CmkUseLogRef): ForwardEnvelope {
  return {
    binding_id: binding.binding_id,
    tenant_id: binding.tenant_id,
    provider: binding.provider,
    customer_kms_key_arn: binding.customer_kms_key_arn,
    log,
    emitted_at: new Date().toISOString(),
  };
}

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`SIEM POST ${url} failed: ${res.status} ${res.statusText}`);
  }
}

export function detectSiemKind(endpoint: string): SiemKind {
  const override = process.env.BYOK_SIEM_FORWARDER_KIND as SiemKind | undefined;
  if (override && override !== 'auto') return override;
  if (/\/services\/collector/i.test(endpoint)) return 'splunk';
  if (/_doc(\?|$)|\/_bulk/i.test(endpoint)) return 'elastic';
  if (/collectors\.sumologic\.com/i.test(endpoint)) return 'sumo';
  return 'splunk';
}

/* ============================================================
 * Splunk HEC
 * ============================================================ */

export const splunkHecForwarder: SiemForwarder = async (binding, log) => {
  if (!binding.siem_forwarder_endpoint) return;
  const token = process.env.BYOK_SPLUNK_HEC_TOKEN ?? process.env.BYOK_SIEM_TOKEN;
  if (!token) {
    console.warn('[byok:siem:splunk] BYOK_SPLUNK_HEC_TOKEN missing; dropping log', log.log_id);
    return;
  }
  const envelope = buildEnvelope(binding, log);
  await postJson(
    binding.siem_forwarder_endpoint,
    { Authorization: `Splunk ${token}` },
    {
      event: envelope,
      sourcetype: 'projexcloud:byok:cmk-use',
      source: 'sdk-vault',
      host: process.env.HOSTNAME ?? 'projexcloud-gateway',
    },
  );
};

/* ============================================================
 * Elastic
 * ============================================================ */

export const elasticForwarder: SiemForwarder = async (binding, log) => {
  if (!binding.siem_forwarder_endpoint) return;
  const apiKey = process.env.BYOK_ELASTIC_API_KEY ?? process.env.BYOK_SIEM_TOKEN;
  if (!apiKey) {
    console.warn('[byok:siem:elastic] BYOK_ELASTIC_API_KEY missing; dropping log', log.log_id);
    return;
  }
  await postJson(
    binding.siem_forwarder_endpoint,
    { Authorization: `ApiKey ${apiKey}` },
    buildEnvelope(binding, log),
  );
};

/* ============================================================
 * Sumo Logic
 * ============================================================ */

export const sumoForwarder: SiemForwarder = async (binding, log) => {
  if (!binding.siem_forwarder_endpoint) return;
  // Sumo collectors accept POST without auth — the collector URL itself is
  // the secret. We still send a custom header so the log can be tagged.
  await postJson(
    binding.siem_forwarder_endpoint,
    { 'X-Sumo-Category': 'projexcloud/byok/cmk-use' },
    buildEnvelope(binding, log),
  );
};

/* ============================================================
 * Dispatching forwarder — selects the right adapter at call time.
 * ============================================================ */

/**
 * Returns a forwarder that picks the right adapter for each binding by
 * inspecting the URL shape. Register at api-gateway boot via
 * sdk-vault.setSiemForwarder(installAutoSiemForwarder()).
 */
export function installAutoSiemForwarder(): SiemForwarder {
  return async (binding, log) => {
    if (!binding.siem_forwarder_endpoint) return;
    const kind = detectSiemKind(binding.siem_forwarder_endpoint);
    const fwd =
      kind === 'splunk' ? splunkHecForwarder :
      kind === 'elastic' ? elasticForwarder :
      sumoForwarder;
    try {
      await fwd(binding, log);
    } catch (err) {
      console.warn(`[byok:siem:${kind}] forward failed:`, (err as Error).message);
    }
  };
}
