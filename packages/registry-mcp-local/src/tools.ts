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

import { Registry, RegistryHit, getScaffold } from '@projexlight/sdk-registry';

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
      'Lists vertical blueprints (multi-SDK compositions) available to install. Optional tag filter. Returns blueprint id, title, summary, pack, and estimated install minutes.',
    inputSchema: {
      type: 'object',
      properties: {
        tag: { type: 'string', description: 'Optional tag filter (e.g. "healthcare").' },
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

      case 'projex_registry_list_blueprints': {
        // E4 blueprint library lands in a later commit. Return a stable empty
        // shape with a note so AI clients see a real response (not an error)
        // when they ask about blueprints early in the build.
        return ok({
          blueprints: [],
          note: 'Blueprint library (E4) is not yet wired. This tool will return real entries once the blueprints/ package is loaded.',
        });
      }

      case 'projex_registry_get_blueprint': {
        const blueprint_id = String(args.blueprint_id ?? '');
        if (!blueprint_id) return err('blueprint_id is required');
        return err(
          `Blueprint "${blueprint_id}" not found. The blueprint library (E4) is not yet wired.`,
        );
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
