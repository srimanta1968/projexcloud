/**
 * P9 / E3 — hosted-MCP write tools (FR-MCP-2).
 *
 * These tools exist only on the hosted MCP — they require tenant context
 * (module_subscriptions, pack membership) and emit audit + meter side
 * effects. The local MCP proxies these calls to the hosted MCP via the
 * tenant's API key (FR-MCP-L4).
 *
 * Wiring uses callbacks injected at startup so this module has zero direct
 * dependencies on sdk-tenant / sdk-approval / sdk-policy. The deployer
 * (startServer in index.ts) is responsible for wiring real implementations
 * once DB pools are available.
 */

import type { Registry } from '@projexlight/sdk-registry';
import { getScaffold } from '@projexlight/sdk-registry';
import type { ToolDefinition, ToolResult } from '@projexlight/registry-mcp-local/dist/tools';
import type { TenantContext } from './auth';

/** Tenant subscription view used by guardrails — caller fetches from sdk-tenant. */
export interface TenantSubscriptionView {
  module_subscriptions: string[];
  pack?: 'general' | 'healthcare' | 'finserv' | 'public-sector';
}

/** Pack-restricted SDKs by name → required pack. */
const PACK_GATED_SDKS: Record<string, 'healthcare' | 'finserv' | 'public-sector'> = {
  '@projexlight/sdk-phi-vault': 'healthcare',
  '@projexlight/sdk-fhir-bridge': 'healthcare',
  '@projexlight/sdk-finserv-aml': 'finserv',
  '@projexlight/sdk-fedramp-evidence': 'public-sector',
};

/**
 * Look up a tenant's effective view. Provided by index.ts at startup so this
 * module never imports sdk-tenant directly. When unset, behaves as a no-op
 * (all SDKs visible, no pack guardrails) — useful for dev mode.
 */
export interface WriteToolDeps {
  fetchTenantView?: (tenant_id: string) => Promise<TenantSubscriptionView | null>;
  createApprovalRequest?: (input: {
    tenant_id: string;
    actor_id: string;
    request_type: 'pack_upgrade';
    payload: Record<string, unknown>;
  }) => Promise<{ approval_id: string; status: string }>;
  /** Real deploy hands the scaffold to the tenant's app-pool deploy pipeline. */
  initiateDeploy?: (input: {
    tenant_id: string;
    actor_id: string;
    app_name: string;
    sdk_names: string[];
    env: 'trial' | 'staging' | 'prod';
  }) => Promise<{ deploy_id: string; status: 'queued' | 'started'; url?: string }>;
}

export const WRITE_TOOLS: ToolDefinition[] = [
  {
    name: 'projex_registry_list_my_sdks',
    description:
      "Tenant-scoped: lists only the SDKs the caller's tenant has in module_subscriptions. Use this instead of the global search when you want to suggest only SDKs the user has paid for.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'projex_registry_list_my_blueprints',
    description:
      "Tenant-scoped: blueprints filtered by the caller's tenant pack (general/healthcare/finserv/public-sector). Healthcare blueprints with PHI SDKs are excluded for tenants outside the healthcare pack.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'projex_registry_request_pack_upgrade',
    description:
      'Open an approval request for the tenant admin to upgrade to a compliance pack (e.g. healthcare). Returns the approval_id so the caller can show the user a pending-status URL.',
    inputSchema: {
      type: 'object',
      properties: {
        target_pack: {
          type: 'string',
          enum: ['healthcare', 'finserv', 'public-sector'],
          description: 'Pack the tenant wants to upgrade to.',
        },
        reason: {
          type: 'string',
          description: 'Brief justification shown to the approving admin.',
        },
      },
      required: ['target_pack'],
    },
  },
  {
    name: 'projex_registry_deploy',
    description:
      "Server-side deploy: stages a scaffold into the tenant's app pool, runs migrations, returns a deploy_id + URL. Rolls back atomically on migration failure (AC-10). Pack guardrails enforced server-side — a request that includes a pack-gated SDK without the matching tenant pack returns 403 with a policy citation.",
    inputSchema: {
      type: 'object',
      properties: {
        app_name: { type: 'string', description: 'Name of the app to deploy.' },
        sdk_names: {
          type: 'array',
          items: { type: 'string' },
          description: 'SDKs composed into the deploy.',
        },
        env: {
          type: 'string',
          enum: ['trial', 'staging', 'prod'],
          description: "Target env. Defaults to 'trial'.",
        },
      },
      required: ['app_name', 'sdk_names'],
    },
  },
];

function ok(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function err(message: string, code?: string): ToolResult {
  const body = code ? { error: message, code } : { error: message };
  return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], isError: true };
}

/**
 * FR-MCP-7 — pack guardrail. Refuse to scaffold/deploy any pack-gated SDK
 * unless the tenant is enrolled in the matching pack. Returns the offending
 * SDK + required pack so the caller can render a clear upgrade prompt.
 */
export function checkPackGuardrails(
  sdk_names: string[],
  tenantView: TenantSubscriptionView | null,
): { ok: true } | { ok: false; sdk: string; required_pack: string; current_pack: string } {
  const currentPack = tenantView?.pack ?? 'general';
  for (const sdk of sdk_names) {
    const required = PACK_GATED_SDKS[sdk];
    if (required && currentPack !== required) {
      return { ok: false, sdk, required_pack: required, current_pack: currentPack };
    }
  }
  return { ok: true };
}

export async function dispatchWriteTool(
  name: string,
  args: Record<string, unknown>,
  registry: Registry,
  tenant: TenantContext,
  deps: WriteToolDeps,
): Promise<ToolResult> {
  if (!tenant.tenant_id) {
    return err('write tools require a tenant-scoped token (tenant_id missing in claims)', 'NO_TENANT');
  }
  const tenantView = deps.fetchTenantView ? await deps.fetchTenantView(tenant.tenant_id) : null;

  try {
    switch (name) {
      case 'projex_registry_list_my_sdks': {
        const all = registry.list();
        const subscribed = new Set(tenantView?.module_subscriptions ?? []);
        const filtered = tenantView
          ? all.filter((e) => subscribed.has(e.manifest.name))
          : all;
        return ok({
          tenant_id: tenant.tenant_id,
          pack: tenantView?.pack ?? 'general',
          count: filtered.length,
          sdks: filtered.map((e) => ({ name: e.manifest.name, version: e.manifest.version, summary: e.manifest.summary })),
          note: tenantView ? undefined : 'tenant view unavailable — showing global catalog',
        });
      }

      case 'projex_registry_list_my_blueprints': {
        // Blueprint listing requires the local blueprint loader; defer to read-tool
        // path by returning a pointer (real blueprint surface lives on the local MCP
        // since it walks the on-disk blueprints/ root).
        return ok({
          tenant_id: tenant.tenant_id,
          pack: tenantView?.pack ?? 'general',
          note: 'Use projex_registry_list_blueprints from the local MCP; the hosted MCP returns the tenant-pack filter only.',
          allowed_packs: tenantView?.pack ? [tenantView.pack, 'general'] : ['general'],
        });
      }

      case 'projex_registry_request_pack_upgrade': {
        const target_pack = String(args.target_pack ?? '');
        const reason = String(args.reason ?? '');
        if (!['healthcare', 'finserv', 'public-sector'].includes(target_pack)) {
          return err('target_pack must be one of: healthcare | finserv | public-sector');
        }
        if (!deps.createApprovalRequest) {
          return ok({
            status: 'queued',
            note: 'createApprovalRequest not wired in this deployment; request recorded in audit only.',
            target_pack,
            reason,
          });
        }
        const result = await deps.createApprovalRequest({
          tenant_id: tenant.tenant_id,
          actor_id: tenant.sub,
          request_type: 'pack_upgrade',
          payload: { target_pack, reason, current_pack: tenantView?.pack ?? 'general' },
        });
        return ok({
          approval_id: result.approval_id,
          status: result.status,
          target_pack,
        });
      }

      case 'projex_registry_deploy': {
        const app_name = String(args.app_name ?? '');
        const sdk_names = Array.isArray(args.sdk_names) ? (args.sdk_names as string[]) : [];
        const env = (args.env as 'trial' | 'staging' | 'prod' | undefined) ?? 'trial';
        if (!app_name) return err('app_name is required');
        if (sdk_names.length === 0) return err('sdk_names must be a non-empty array');

        const guard = checkPackGuardrails(sdk_names, tenantView);
        if (!guard.ok) {
          return err(
            `PolicyViolation: SDK "${guard.sdk}" requires the "${guard.required_pack}" pack; tenant is on "${guard.current_pack}". Run projex_registry_request_pack_upgrade to request access.`,
            'PACK_GATED',
          );
        }

        if (!deps.initiateDeploy) {
          // Dev-mode: return a stub deploy_id derived from the scaffold tree
          const tree = getScaffold(registry, sdk_names, app_name);
          return ok({
            deploy_id: `dev-${Date.now().toString(36)}`,
            status: 'queued',
            env,
            app_name,
            resolved_sdks: tree.resolved_sdks,
            file_count: tree.files.length,
            note: 'initiateDeploy not wired in this deployment; returning dev-stub deploy_id. Real deploys land via the CLI projex deploy command which talks to the tenant pool runner.',
          });
        }
        const r = await deps.initiateDeploy({
          tenant_id: tenant.tenant_id,
          actor_id: tenant.sub,
          app_name,
          sdk_names,
          env,
        });
        return ok({ deploy_id: r.deploy_id, status: r.status, url: r.url, env });
      }

      default:
        return err(`unknown write tool: ${name}`);
    }
  } catch (e) {
    return err((e as Error).message);
  }
}
