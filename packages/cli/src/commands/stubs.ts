/**
 * P9 / E5 — Phase 1 stubs for commands that depend on the hosted MCP
 * (E3 Phase 2) or the blueprint library (E4). The stubs print a clear
 * "what this will do once wired" message rather than silently no-op,
 * so users + AI agents know to come back later.
 */

export interface StubOutput {
  command: string;
  phase: string;
  description: string;
  next_step: string;
}

export function loginStub(): StubOutput {
  return {
    command: 'projex login',
    phase: 'Phase 2 (E3 hosted MCP)',
    description:
      'OAuth device flow against the tenant\'s identity SDK. Will store a refresh token in OS keychain via keytar.',
    next_step:
      'Wait for E3 Phase 2 hosted MCP. Until then, the local MCP works against the in-repo catalog (no auth needed).',
  };
}

export function deployStub(): StubOutput {
  return {
    command: 'projex deploy',
    phase: 'Phase 2 (E3 hosted MCP)',
    description:
      'Package the local app, upload to the tenant\'s app pool via the hosted registry-mcp scaffold/deploy tools, run migrations under a tenant-scoped JWT, atomically roll back on migration failure.',
    next_step:
      'Wait for E3 Phase 2 hosted MCP. To preview the would-be output today: projex registry refresh && look at the catalog locally.',
  };
}

export function installStub(sdk_name: string): StubOutput {
  return {
    command: `projex install ${sdk_name}`,
    phase: 'Phase 1.5',
    description:
      `Will add ${sdk_name} to the local package.json as a workspace dep and drop a starter integration file at src/integrations/.`,
    next_step:
      `Until wired, run: \`pnpm add ${sdk_name}\` and write the integration manually. See projex_registry_get_manifest ${sdk_name} from your AI tool.`,
  };
}

export function blueprintStub(action: string, id?: string): StubOutput {
  return {
    command: `projex blueprint ${action}${id ? ' ' + id : ''}`,
    phase: 'Phase 2 (E4 blueprint library)',
    description:
      'List + apply pre-composed vertical blueprints (revops-crm, field-dispatch, claims-intake, b2b-analytics, patient-portal, prd-management). Each blueprint scaffolds a full app via getScaffold + runs migrations + seeds demo data.',
    next_step:
      'Wait for E4. For now, use `projex init <name>` for a blank skeleton and add SDKs manually.',
  };
}
