/**
 * P9 / E3 — MCP tool definitions for the local registry-mcp.
 *
 * Tool naming follows the FR-COHAB-2 convention: every tool is prefixed
 * `projex_registry_*` so it cannot collide with the existing Projexlight
 * dev MCP (`projexlight_*` prefix) when both are loaded in one Claude
 * Code / Cursor / Windsurf config.
 *
 * Phase 1 ships READ tools only. Write tools (scaffold, deploy) land in
 * a later phase that proxies them to the hosted MCP via the tenant API key.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Registry, RegistryHit, getScaffold } from '@projexlight/sdk-registry';
import { listBlueprints, loadBlueprint } from '@projexlight/blueprints';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const READ_TOOLS: ToolDefinition[] = [
  {
    name: 'projex_registry_search_sdks',
    description:
      'Semantic search across all ProjexCloud SDKs. Returns up to top_k SDKs ranked by relevance to the natural-language intent (e.g. "I need consent management for healthcare"). Uses bge-small-en-v1.5 embeddings when available; falls back to substring matching otherwise.',
    inputSchema: {
      type: 'object',
      properties: {
        intent: {
          type: 'string',
          description: 'Natural-language description of what you want to do or what capability you need.',
        },
        top_k: {
          type: 'number',
          description: 'Maximum number of SDKs to return. Default 5.',
        },
      },
      required: ['intent'],
    },
  },
  {
    name: 'projex_registry_get_manifest',
    description:
      'Full capability manifest for a given SDK: name, version, summary, tags, endpoints, events produced + consumed, models, hooks, scenarios with example code, compliance posture, pool placement, pricing SKUs, and links.',
    inputSchema: {
      type: 'object',
      properties: {
        sdk_name: {
          type: 'string',
          description: 'Fully-qualified SDK name, e.g. "@projexlight/sdk-vault".',
        },
      },
      required: ['sdk_name'],
    },
  },
  {
    name: 'projex_registry_get_example',
    description:
      'A single runnable scenario from an SDK\'s manifest. Returns title, when-to-use, example_code, and expected_outcome. Use search_sdks first to discover scenario ids.',
    inputSchema: {
      type: 'object',
      properties: {
        sdk_name: { type: 'string', description: 'Fully-qualified SDK name.' },
        scenario_id: { type: 'string', description: 'Scenario id from the manifest.' },
      },
      required: ['sdk_name', 'scenario_id'],
    },
  },
  {
    name: 'projex_registry_list_compatible_sdks',
    description:
      'SDKs that compose naturally with the given SDK — derived from event consume/produce overlap. Returned in alphabetical order.',
    inputSchema: {
      type: 'object',
      properties: {
        sdk_name: { type: 'string', description: 'Fully-qualified SDK name.' },
      },
      required: ['sdk_name'],
    },
  },
  {
    name: 'projex_registry_list_blueprints',
    description:
      'Lists vertical blueprints (multi-SDK compositions) the developer can install via `projex blueprint apply <id>`. Optional tag filter. Returns id, title, summary, pack, sdk_count, estimated_minutes per blueprint.',
    inputSchema: {
      type: 'object',
      properties: {
        tag: { type: 'string', description: 'Optional tag filter (case-insensitive substring).' },
      },
    },
  },
  {
    name: 'projex_registry_get_blueprint',
    description:
      'Full blueprint definition: SDKs composed, clarifying questions the installer will ask, file outputs, seed data references.',
    inputSchema: {
      type: 'object',
      properties: {
        blueprint_id: { type: 'string', description: 'Blueprint id, e.g. "revops-crm".' },
      },
      required: ['blueprint_id'],
    },
  },
  {
    name: 'projex_registry_get_endpoint',
    description:
      'Get the full contract for one endpoint: method, path, kind, description, and (when the manifest declares them) request_schema / response_schema JSON Schemas + auth_scopes. Call this before hitting a ProjexCloud API so you send the correct payload instead of guessing.',
    inputSchema: {
      type: 'object',
      properties: {
        sdk_name: { type: 'string', description: 'Fully-qualified SDK name, e.g. @projexlight/sdk-billing.' },
        path: { type: 'string', description: 'Endpoint path to look up, e.g. /api/billing/invoices/generate.' },
      },
      required: ['sdk_name', 'path'],
    },
  },
  {
    name: 'projex_registry_get_ingest_targets',
    description:
      'List ingest/bulk endpoints across the catalog — where external data can be imported — with their payload schema + auth scopes. Optionally filter by an entity term (matched against the endpoint path). Use this to discover where an ETL job should push records and with what payload.',
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Optional entity term to filter ingest paths, e.g. "customer".' },
      },
    },
  },
  {
    name: 'projex_registry_scaffold',
    description:
      'Generate a starter app scaffold (package.json, tsconfig, src/integrations/* per SDK, tests, README, CLAUDE.md) that composes the given SDKs. Returns a tree of { path, contents } — caller writes the files. Unknown SDKs are filtered with warnings.',
    inputSchema: {
      type: 'object',
      properties: {
        sdk_names: {
          type: 'array',
          items: { type: 'string' },
          description: 'Fully-qualified SDK names to compose into the new app.',
        },
        app_name: {
          type: 'string',
          description: 'Name of the new app (becomes the npm package name).',
        },
      },
      required: ['sdk_names', 'app_name'],
    },
  },
];

/** MCP CallToolResult shape — content array with one or more text items. */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

function ok(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function err(message: string): ToolResult {
  return { content: [{ type: 'text', text: `error: ${message}` }], isError: true };
}

/**
 * Dispatch table: maps tool name → async handler. Handler signature is
 * stable so the same dispatcher works for both stdio (Phase 1) and
 * SSE (hosted MCP in Phase 2).
 */
export async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
  registry: Registry,
): Promise<ToolResult> {
  try {
    switch (name) {
      case 'projex_registry_search_sdks': {
        const intent = String(args.intent ?? '');
        const top_k = typeof args.top_k === 'number' ? args.top_k : 5;
        if (!intent) return err('intent is required');
        const hits: RegistryHit[] = await registry.searchByIntent(intent, top_k);
        return ok({ query: intent, top_k, hits });
      }

      case 'projex_registry_get_manifest': {
        const sdk_name = String(args.sdk_name ?? '');
        if (!sdk_name) return err('sdk_name is required');
        const entry = registry.get(sdk_name);
        if (!entry) return err(`unknown sdk: ${sdk_name}`);
        return ok(entry.manifest);
      }

      case 'projex_registry_get_example': {
        const sdk_name = String(args.sdk_name ?? '');
        const scenario_id = String(args.scenario_id ?? '');
        if (!sdk_name || !scenario_id) return err('sdk_name and scenario_id are required');
        const entry = registry.get(sdk_name);
        if (!entry) return err(`unknown sdk: ${sdk_name}`);
        const sc = entry.manifest.scenarios.find((s) => s.id === scenario_id);
        if (!sc) return err(`unknown scenario "${scenario_id}" on ${sdk_name}`);
        return ok({
          sdk_name,
          scenario_id,
          title: sc.title,
          when_to_use: sc.when_to_use,
          example_code: sc.example_code,
          expected_outcome: sc.expected_outcome,
        });
      }

      case 'projex_registry_list_compatible_sdks': {
        const sdk_name = String(args.sdk_name ?? '');
        if (!sdk_name) return err('sdk_name is required');
        if (!registry.get(sdk_name)) return err(`unknown sdk: ${sdk_name}`);
        return ok({ sdk_name, compatible: registry.findCompatibleSdks(sdk_name) });
      }

      case 'projex_registry_get_endpoint': {
        const sdk_name = String(args.sdk_name ?? '');
        const path = String(args.path ?? '');
        if (!sdk_name || !path) return err('sdk_name and path are required');
        const entry = registry.get(sdk_name);
        if (!entry) return err(`unknown sdk: ${sdk_name}`);
        const ep = entry.manifest.provides.endpoints.find((e) => e.path === path);
        if (!ep) return err(`no endpoint "${path}" on ${sdk_name}`);
        return ok({
          sdk_name,
          method: ep.method,
          path: ep.path,
          kind: ep.kind ?? 'query',
          description: ep.description ?? null,
          request_schema: ep.request_schema ?? null,
          response_schema: ep.response_schema ?? null,
          auth_scopes: ep.auth_scopes ?? [],
        });
      }

      case 'projex_registry_get_ingest_targets': {
        const entity = typeof args.entity === 'string' ? args.entity.toLowerCase() : null;
        const targets: unknown[] = [];
        for (const entry of registry.list()) {
          for (const ep of entry.manifest.provides.endpoints) {
            const kind = ep.kind ?? 'query';
            if (kind !== 'ingest' && kind !== 'bulk') continue;
            if (entity && !ep.path.toLowerCase().includes(entity)) continue;
            targets.push({
              sdk_name: entry.manifest.name,
              method: ep.method,
              path: ep.path,
              kind,
              description: ep.description ?? null,
              request_schema: ep.request_schema ?? null,
              auth_scopes: ep.auth_scopes ?? [],
            });
          }
        }
        return ok({ entity: entity ?? null, count: targets.length, targets });
      }

      case 'projex_registry_list_blueprints': {
        const root = resolveBlueprintsRoot();
        if (!root) {
          return ok({
            blueprints: [],
            note: 'No blueprints root configured. Set PROJEX_BLUEPRINTS_ROOT or PROJEX_DEV_ROOT (with a blueprints/ subdir).',
          });
        }
        const tagFilter = typeof args.tag === 'string' ? args.tag.toLowerCase() : null;
        const entries = listBlueprints(root)
          .filter((r) => !tagFilter || (r.blueprint.tags ?? []).some((t) => t.toLowerCase().includes(tagFilter)))
          .map((r) => ({
            id: r.blueprint.id,
            title: r.blueprint.title,
            summary: r.blueprint.summary,
            pack: r.blueprint.pack,
            sdk_count: r.blueprint.sdks.length,
            estimated_minutes: r.blueprint.estimated_minutes,
            tags: r.blueprint.tags ?? [],
          }));
        return ok({ root, count: entries.length, blueprints: entries });
      }

      case 'projex_registry_get_blueprint': {
        const blueprint_id = String(args.blueprint_id ?? '');
        if (!blueprint_id) return err('blueprint_id is required');
        const root = resolveBlueprintsRoot();
        if (!root) return err('No blueprints root configured. Set PROJEX_BLUEPRINTS_ROOT or PROJEX_DEV_ROOT.');
        const dir = join(root, blueprint_id);
        if (!existsSync(dir)) return err(`Blueprint "${blueprint_id}" not found under ${root}.`);
        try {
          const r = loadBlueprint({ dir });
          return ok(r.blueprint);
        } catch (e) {
          return err((e as Error).message);
        }
      }

      case 'projex_registry_scaffold': {
        const sdk_names = Array.isArray(args.sdk_names) ? (args.sdk_names as string[]) : [];
        const app_name = String(args.app_name ?? '');
        if (sdk_names.length === 0) return err('sdk_names must be a non-empty array');
        if (!app_name) return err('app_name is required');
        const tree = getScaffold(registry, sdk_names, app_name);
        return ok({
          app_name: tree.app_name,
          resolved_sdks: tree.resolved_sdks,
          warnings: tree.warnings,
          file_count: tree.files.length,
          files: tree.files,
        });
      }

      default:
        return err(`unknown tool: ${name}`);
    }
  } catch (e) {
    return err((e as Error).message);
  }
}

/** Resolve where blueprint manifests live. Env override → dev-root fallback. */
function resolveBlueprintsRoot(): string | null {
  if (process.env.PROJEX_BLUEPRINTS_ROOT) return process.env.PROJEX_BLUEPRINTS_ROOT;
  if (process.env.PROJEX_DEV_ROOT) {
    const dev = join(process.env.PROJEX_DEV_ROOT, 'blueprints');
    if (existsSync(dev)) return dev;
  }
  return null;
}
