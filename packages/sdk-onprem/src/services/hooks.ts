import { getPool } from '@projexlight/db-runtime';
import { setLocalProviderResolver } from '@projexlight/sdk-ai-gateway';
import { setExternalUrlValidator } from '@projexlight/sdk-webhook';
import { isWebhookUrlAllowed, getInstall } from './installService';
import type { LocalLlmStatus, ProviderId } from '@projexlight/contracts';

/**
 * Cross-SDK boot hooks for on-prem deployments (G-P8-5 + G-P8-6).
 *
 * Wire from api-gateway boot:
 *   installOnPremCrossSdkHooks({ default_install_id: process.env.ONPREM_INSTALL_ID });
 *
 * On a cloud deployment this is a no-op (the hooks return null/allow, and
 * the registered providers/validators fall through to platform defaults).
 * On an on-prem deployment, every AI Gateway completion call routes to the
 * locally registered model; every webhook endpoint is validated against
 * the install's air_gap_mode.
 */

export interface OnPremHooksConfig {
  /** Install id this gateway process is bound to (the on-prem cluster's
   *  own install id). Required when there is exactly one install per
   *  process (the typical on-prem case). */
  default_install_id?: string;
}

interface LocalLlmRow {
  model_id: string;
  backend: string;
  endpoint_url: string;
  status: LocalLlmStatus;
}

async function pickReadyLocalLlm(installId: string, modelHint?: string): Promise<LocalLlmRow | null> {
  try {
    const pool = getPool();
    if (modelHint) {
      const { rows } = await pool.query<LocalLlmRow>(
        `SELECT model_id, backend, endpoint_url, status
           FROM onprem.local_llm_model
          WHERE install_id = $1 AND model_id = $2 AND status = 'ready'
          LIMIT 1`,
        [installId, modelHint],
      );
      if (rows[0]) return rows[0];
    }
    const { rows } = await pool.query<LocalLlmRow>(
      `SELECT model_id, backend, endpoint_url, status
         FROM onprem.local_llm_model
        WHERE install_id = $1 AND status = 'ready'
        ORDER BY model_id LIMIT 1`,
      [installId],
    );
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

export function installOnPremCrossSdkHooks(cfg: OnPremHooksConfig = {}): void {
  const installId = cfg.default_install_id ?? process.env.ONPREM_INSTALL_ID;

  // ---- AI Gateway local-provider resolver (G-P8-5 / FR-ONP-5) ----
  // Returns null when no on-prem install is configured (cloud deploy) or
  // no ready local model exists. ai-gateway then falls through to the
  // platform's cloud route, which is the correct cloud-deploy behavior.
  if (installId) {
    setLocalProviderResolver(async (_ctx, request) => {
      const hit = await pickReadyLocalLlm(installId, request.model);
      if (!hit) return null;
      // Map the local model_id to the canonical ProviderId. The model_id
      // string typically encodes the family ('llama-3.1-70b' → local-llama;
      // 'mistral-7b' → local-mistral); operators register the actual
      // backend adapter under that ProviderId via sdk-ai-gateway.registerProvider().
      const providerId: ProviderId = hit.model_id.toLowerCase().includes('mistral')
        ? 'local-mistral'
        : 'local-llama';
      return { provider_id: providerId, model: hit.model_id };
    });
  } else {
    setLocalProviderResolver(null);
  }

  // ---- Webhook URL validator (G-P8-6 / FR-ONP-6) ----
  // For each tenant_id, look up the bound install (if any) and check that
  // URLs comply with the air_gap_mode. We assume the gateway process has
  // a single install id; multi-install gateways override default_install_id
  // per request via a custom validator wired post-boot.
  if (installId) {
    setExternalUrlValidator(async ({ tenant_id, url }) => {
      const install = await getInstall(installId);
      if (!install) return { allowed: true };
      // air_gap_mode=strict → only in-cluster URLs allowed.
      const result = await isWebhookUrlAllowed(installId, url, install.air_gap_mode === 'strict');
      if (!result.allowed) {
        return {
          allowed: false,
          reason: `${result.reason} (install=${installId} mode=${install.air_gap_mode} tenant=${tenant_id})`,
        };
      }
      return { allowed: true };
    });
  } else {
    setExternalUrlValidator(null);
  }
}
