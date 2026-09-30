import crypto from 'node:crypto';
import { dataService } from '@projexlight/db-runtime';
import { emitEvent } from '@projexlight/sdk-audit';
import { parseRef } from '@projexlight/sdk-secrets';
import { VoiceAgentError, conflict, notFound, validationError } from '../models/errors';

/**
 * App-registered tools (VA·E2 · TK-4473).
 *
 * A consumer app (LeadFlow, projex_crm, …) registers an HTTPS endpoint the agent may call
 * mid-conversation — that is how app business logic enters a call while the SDK stays
 * customer-agnostic. The JSON schema describes the tool's arguments to the LLM; the
 * signing secret is held ONLY as an sdk-secrets reference (secret://scope/id), never the
 * secret itself. A disabled tool drops out of every version's effective tool set, so new
 * calls stop offering it without a new agent version.
 */

export interface AppTool {
  tool_id: string;
  tenant_id: string;
  app_id: string | null;
  name: string;
  description: string | null;
  json_schema: Record<string, unknown>;
  url: string;
  signing_secret_ref: string;
  timeout_ms: number;
  idempotent: boolean;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface RegisterToolInput {
  name: string;
  description?: string;
  json_schema: Record<string, unknown>;
  url: string;
  signing_secret_ref: string;
  timeout_ms?: number;
  idempotent?: boolean;
  app_id?: string;
}

export type UpdateToolInput = Partial<Omit<RegisterToolInput, 'name' | 'app_id'>> & { enabled?: boolean };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_RE = /^[a-z][a-z0-9_]{1,63}$/;
const APP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_DESCRIPTION_LENGTH = 1000;
/** A tool schema is sent to the LLM on every turn; keep it small. */
const MAX_SCHEMA_BYTES = 16384;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 10000;
const DEFAULT_TIMEOUT_MS = 1500;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const PG_UNIQUE_VIOLATION = '23505';
const JSON_SCHEMA_TYPES = ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'];

interface ToolRow extends Omit<AppTool, 'created_at' | 'updated_at'> {
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `tool_id, tenant_id, app_id, name, description, json_schema, url, signing_secret_ref,
                 timeout_ms, idempotent, enabled, created_at, updated_at`;

function toTool(row: ToolRow): AppTool {
  return { ...row, created_at: new Date(row.created_at).toISOString(), updated_at: new Date(row.updated_at).toISOString() };
}

/**
 * A tool's argument schema must be a JSON-Schema OBJECT with typed properties — the
 * shape every LLM tool-calling API accepts. Checked structurally so a malformed schema
 * fails here, at registration, instead of on a live call.
 */
function assertToolSchema(schema: unknown): Record<string, unknown> {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw validationError('json_schema must be a JSON Schema object');
  }
  const s = schema as Record<string, unknown>;
  if (JSON.stringify(s).length > MAX_SCHEMA_BYTES) throw validationError(`json_schema must be at most ${MAX_SCHEMA_BYTES} bytes`);
  if (s.type !== 'object') throw validationError('json_schema.type must be "object"');
  const props = s.properties;
  if (props === null || typeof props !== 'object' || Array.isArray(props)) {
    throw validationError('json_schema.properties must be an object');
  }
  for (const [key, def] of Object.entries(props as Record<string, unknown>)) {
    const type = (def as { type?: unknown } | null)?.type;
    const types = Array.isArray(type) ? type : [type];
    if (!def || typeof def !== 'object' || types.some((t) => typeof t !== 'string' || !JSON_SCHEMA_TYPES.includes(t))) {
      throw validationError(`json_schema.properties.${key} needs a valid JSON Schema "type"`);
    }
  }
  if (s.required !== undefined) {
    if (!Array.isArray(s.required) || s.required.some((r) => typeof r !== 'string' || !(r in (props as object)))) {
      throw validationError('json_schema.required must list property names that exist in properties');
    }
  }
  return s;
}

function assertHttpsUrl(url: unknown): string {
  if (typeof url !== 'string') throw validationError('url must be an https:// URL');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw validationError('url must be an https:// URL');
  }
  if (parsed.protocol !== 'https:') throw validationError('url must be an https:// URL');
  if (parsed.username || parsed.password) throw validationError('url must not embed credentials');
  return url;
}

function assertSecretRef(ref: unknown): string {
  if (typeof ref !== 'string') throw validationError('signing_secret_ref must be an sdk-secrets reference (secret://{app|pool|tenant}/{id})');
  try {
    parseRef(ref);
  } catch {
    throw validationError('signing_secret_ref must be an sdk-secrets reference (secret://{app|pool|tenant}/{id}), never the secret itself');
  }
  return ref;
}

function assertTimeout(value: unknown): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    throw validationError(`timeout_ms must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`);
  }
  return value;
}

function assertDescription(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > MAX_DESCRIPTION_LENGTH) {
    throw validationError(`description must be a string of at most ${MAX_DESCRIPTION_LENGTH} characters`);
  }
  return value;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === PG_UNIQUE_VIOLATION;
}

/**
 * Register a tool.
 *
 * @throws VoiceAgentError 400 on bad input, 409 when the (app, name) is already registered.
 */
export async function registerTool(tenantId: string, input: RegisterToolInput): Promise<AppTool> {
  if (typeof input.name !== 'string' || !NAME_RE.test(input.name)) {
    throw validationError('name must be snake_case: a lowercase letter then letters, digits or _ (2-64 chars)');
  }
  const appId = input.app_id === undefined || input.app_id === null || input.app_id === '' ? null : input.app_id;
  if (appId !== null && (typeof appId !== 'string' || !APP_ID_RE.test(appId))) throw validationError('app_id must be an app identifier');
  const schema = assertToolSchema(input.json_schema);
  const url = assertHttpsUrl(input.url);
  const secretRef = assertSecretRef(input.signing_secret_ref);
  const timeout = assertTimeout(input.timeout_ms);
  const description = assertDescription(input.description);
  if (input.idempotent !== undefined && typeof input.idempotent !== 'boolean') throw validationError('idempotent must be a boolean');
  try {
    const row = await dataService.one<ToolRow>(
      `INSERT INTO voice_agent.app_tool (tenant_id, app_id, name, description, json_schema, url, signing_secret_ref, timeout_ms, idempotent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${COLUMNS}`,
      [tenantId, appId, input.name, description, JSON.stringify(schema), url, secretRef, timeout, input.idempotent ?? false],
    );
    if (!row) throw new Error('tool insert returned no row');
    return toTool(row);
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('a tool with this name is already registered for this app');
    throw err;
  }
}

/** List a tenant's tools, optionally by app and enabled state. */
export async function listTools(
  tenantId: string,
  opts: { app_id?: string; enabled?: string; limit?: number; offset?: number } = {},
): Promise<{ tools: AppTool[]; limit: number; offset: number }> {
  if (opts.enabled !== undefined && opts.enabled !== 'true' && opts.enabled !== 'false') {
    throw validationError('enabled must be true or false');
  }
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? DEFAULT_PAGE_SIZE), 1), MAX_PAGE_SIZE);
  const offset = Math.max(Math.trunc(opts.offset ?? 0), 0);
  const rows = await dataService.rows<ToolRow>(
    `SELECT ${COLUMNS} FROM voice_agent.app_tool
      WHERE tenant_id = $1
        AND ($2::text IS NULL OR app_id = $2)
        AND ($3::boolean IS NULL OR enabled = $3)
      ORDER BY name ASC
      LIMIT $4 OFFSET $5`,
    [tenantId, opts.app_id ?? null, opts.enabled === undefined ? null : opts.enabled === 'true', limit, offset],
  );
  return { tools: rows.map(toTool), limit, offset };
}

/** One tool, or null (another tenant's tool is also null). */
export async function getTool(tenantId: string, toolId: string): Promise<AppTool | null> {
  if (!UUID_RE.test(toolId)) return null;
  const row = await dataService.one<ToolRow>(`SELECT ${COLUMNS} FROM voice_agent.app_tool WHERE tenant_id = $1 AND tool_id = $2`, [tenantId, toolId]);
  return row ? toTool(row) : null;
}

/**
 * Update a tool: schema, url, secret reference, timeout, idempotency, description, and
 * enabled (disabling is how a tool is withdrawn). The name and app are immutable — a
 * renamed tool is a different tool as far as prompts and transcripts are concerned.
 *
 * @throws VoiceAgentError 400 / 404.
 */
export async function updateTool(tenantId: string, toolId: string, input: UpdateToolInput & { name?: unknown; app_id?: unknown }): Promise<AppTool> {
  if (input.name !== undefined || input.app_id !== undefined) throw validationError('name and app_id cannot be changed; register a new tool');
  const current = await getTool(tenantId, toolId);
  if (!current) throw notFound('tool not found');
  const schema = input.json_schema === undefined ? current.json_schema : assertToolSchema(input.json_schema);
  const url = input.url === undefined ? current.url : assertHttpsUrl(input.url);
  const secretRef = input.signing_secret_ref === undefined ? current.signing_secret_ref : assertSecretRef(input.signing_secret_ref);
  const timeout = input.timeout_ms === undefined ? current.timeout_ms : assertTimeout(input.timeout_ms);
  const description = input.description === undefined ? current.description : assertDescription(input.description);
  if (input.idempotent !== undefined && typeof input.idempotent !== 'boolean') throw validationError('idempotent must be a boolean');
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw validationError('enabled must be a boolean');
  const row = await dataService.one<ToolRow>(
    `UPDATE voice_agent.app_tool
        SET description = $3, json_schema = $4, url = $5, signing_secret_ref = $6, timeout_ms = $7,
            idempotent = $8, enabled = $9, updated_at = now()
      WHERE tenant_id = $1 AND tool_id = $2
      RETURNING ${COLUMNS}`,
    [tenantId, toolId, description, JSON.stringify(schema), url, secretRef, timeout,
      input.idempotent ?? current.idempotent, input.enabled ?? current.enabled],
  );
  if (!row) throw notFound('tool not found');
  return toTool(row);
}

/**
 * The tools a NEW call on this version is offered: the version's tool_ids that are still
 * enabled. The runtime bootstrap reads this, so disabling a tool withdraws it from new
 * calls immediately without publishing a new version.
 */
export async function effectiveTools(tenantId: string, versionId: string): Promise<AppTool[]> {
  if (!UUID_RE.test(versionId)) return [];
  const rows = await dataService.rows<ToolRow>(
    `SELECT ${COLUMNS.split(',').map((c) => 't.' + c.trim()).join(', ')}
       FROM voice_agent.agent_version v
       JOIN voice_agent.app_tool t ON t.tool_id = ANY(v.tool_ids) AND t.tenant_id = v.tenant_id
      WHERE v.tenant_id = $1 AND v.version_id = $2 AND t.enabled
      ORDER BY t.name ASC`,
    [tenantId, versionId],
  );
  return rows.map(toTool);
}

/** Call statuses in which a session capability token may still be issued (TK-4508). */
const TOKEN_ELIGIBLE_STATUSES = ['queued', 'dialing', 'ringing', 'in_progress', 'transferred'];

export interface CallSessionContext {
  call_id: string;
  tenant_id: string;
  agent_id: string;
  agent_version_id: string | null;
  acting_persona_id: string | null;
  status: string;
  /** Names of the tools this call may invoke: its agent version's enabled tools. */
  allowed_tools: string[];
  /** The session_ref a call's capability token is bound to. */
  session_ref: string;
}

/**
 * What a call's session capability token must cover (VA·E7 · TK-4508): the tenant, the
 * agent and the exact version the call runs, and that version's enabled tools.
 *
 * @throws VoiceAgentError 404 unknown call; 409 the call already ended (no new token).
 */
export async function callSessionContext(callId: string): Promise<CallSessionContext> {
  if (!UUID_RE.test(callId)) throw notFound('call not found');
  const call = await dataService.one<{ tenant_id: string; agent_id: string; agent_version_id: string | null; status: string; acting_persona_id: string | null }>(
    `SELECT c.tenant_id, c.agent_id, c.agent_version_id, c.status, a.acting_persona_id
       FROM voice_agent.call c
       JOIN voice_agent.agent a ON a.agent_id = c.agent_id AND a.tenant_id = c.tenant_id
      WHERE c.call_id = $1`,
    [callId],
  );
  if (!call) throw notFound('call not found');
  if (!TOKEN_ELIGIBLE_STATUSES.includes(call.status)) throw conflict(`call is ${call.status}; a session token is only issued for a call that has not ended`);
  const tools = call.agent_version_id ? await effectiveTools(call.tenant_id, call.agent_version_id) : [];
  return {
    call_id: callId,
    tenant_id: call.tenant_id,
    agent_id: call.agent_id,
    agent_version_id: call.agent_version_id,
    acting_persona_id: call.acting_persona_id,
    status: call.status,
    allowed_tools: tools.map((t) => t.name),
    session_ref: `voice_agent.call:${callId}`,
  };
}

/* ------------------------- tool request signing (VA·E1) ------------------------- */

const DEV_TOOL_SIGNING_KEY = 'projex-dev-voice-tool-signing-key';

/**
 * The HMAC key the runtime signs a tool's requests with and the app verifies them with.
 *
 * sdk-secrets keeps only reference metadata, never a secret's value, so the key is derived
 * on the platform: HMAC-SHA256(VOICE_TOOL_SIGNING_KEY, "voice-tool:v1:{tenant}:{tool}:{ref}").
 * The tool's signing_secret_ref names the key version — changing the ref (PATCH the tool)
 * rotates it. The runtime receives it in the call bootstrap; the tenant's app gets it from
 * POST /api/voice-agent/tools/:tool_id/signing-secret (revealToolSigningSecret).
 *
 * @throws VoiceAgentError 503 in production when VOICE_TOOL_SIGNING_KEY is unset.
 */
export function toolSigningSecret(tool: Pick<AppTool, 'tenant_id' | 'tool_id' | 'signing_secret_ref'>): string {
  let master = process.env.VOICE_TOOL_SIGNING_KEY;
  if (!master) {
    if (process.env.NODE_ENV === 'production') {
      throw new VoiceAgentError(503, 'ToolSigningNotConfigured', 'VOICE_TOOL_SIGNING_KEY is not set on this deployment');
    }
    master = DEV_TOOL_SIGNING_KEY;
  }
  return crypto
    .createHmac('sha256', master)
    .update(`voice-tool:v1:${tool.tenant_id}:${tool.tool_id}:${tool.signing_secret_ref}`)
    .digest('base64url');
}

/** How the voice runtime signs every app-tool request (verify with @projexlight/voice-client verifyToolRequest). */
export const TOOL_SIGNATURE_SCHEME = {
  algorithm: 'hmac-sha256',
  signature_header: 'X-Projexcloud-Signature',
  signature_format: 't=<unix seconds>,v1=<hex HMAC>',
  signed_payload: '<t>.<Idempotency-Key>.<raw request body>',
  idempotency_key: '<call_id>:<turn_index>:<tool name>',
  tolerance_seconds: 300,
} as const;

/**
 * The tool's current request-signing secret, for the tenant to configure its tool endpoint
 * with (VA·E1 · TK-4462). Tenant-scoped; audited as voice.tool.secret_revealed.v1 (who and
 * which tool — never the value).
 *
 * @throws VoiceAgentError 404 unknown tool (or another tenant's), 503 no signing key in production.
 */
export async function revealToolSigningSecret(tenantId: string, toolId: string, actor: string): Promise<{
  tool_id: string;
  name: string;
  signing_secret_ref: string;
  signing_secret: string;
  scheme: typeof TOOL_SIGNATURE_SCHEME;
}> {
  const tool = await getTool(tenantId, toolId);
  if (!tool) throw notFound('tool not found');
  const secret = toolSigningSecret(tool);
  await emitEvent({
    event_type: 'voice.tool.secret_revealed.v1',
    pool_index: process.env.VOICE_AGENT_AUDIT_POOL || 'admin-default',
    actor_kind: 'human',
    actor_id: actor,
    tenant_id: tenantId,
    subject_kind: 'voice_agent.app_tool',
    subject_id: tool.tool_id,
    payload: { tool_id: tool.tool_id, name: tool.name, signing_secret_ref: tool.signing_secret_ref },
  });
  return { tool_id: tool.tool_id, name: tool.name, signing_secret_ref: tool.signing_secret_ref, signing_secret: secret, scheme: TOOL_SIGNATURE_SCHEME };
}
