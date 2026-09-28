import { dataService } from '@projexlight/db-runtime';
import { getRequest, submitRequest } from '@projexlight/sdk-approval';
import { emitEvent } from '@projexlight/sdk-audit';
import { VoiceAgentError, conflict, notFound, validationError } from '../models/errors';

/**
 * Agents and their immutable versions (VA·E2 · TK-4470), and the publish gate
 * (TK-4471).
 *
 * An agent is a stable identity; what it says and does lives in agent_version rows,
 * which are never edited — a change is a new version_no. Exactly one version is live
 * (agent.published_version_id). A version goes live only when BOTH gates hold:
 *   1. its most recent evaluation run passed (voice_agent.eval_run), and
 *   2. an sdk-approval request whose subject is THIS version is approved.
 * Rollback re-points the agent at a version that was published before — never at one
 * that skipped the gates.
 */

export const AGENT_DIRECTIONS = ['inbound', 'outbound', 'both'] as const;
export type AgentDirection = (typeof AGENT_DIRECTIONS)[number];
export type AgentStatus = 'draft' | 'published' | 'paused' | 'archived';

/** sdk-approval subject_kind for a version awaiting publish. */
export const VERSION_APPROVAL_SUBJECT_KIND = 'voice_agent.agent_version';

export interface Agent {
  agent_id: string;
  tenant_id: string;
  app_id: string | null;
  name: string;
  direction: AgentDirection;
  acting_persona_id: string | null;
  published_version_id: string | null;
  kill_switch_flag_id: string | null;
  status: AgentStatus;
  latest_version_no: number;
  created_at: string;
  updated_at: string;
}

export interface AgentVersion {
  version_id: string;
  agent_id: string;
  tenant_id: string;
  version_no: number;
  system_prompt: string;
  greeting: string | null;
  language: string;
  stack_profile_id: string;
  tool_ids: string[];
  kb_corpus_ids: string[];
  escalation_rules: Record<string, unknown>;
  business_hours: Record<string, unknown>;
  eval_run_id: string | null;
  approval_id: string | null;
  published_at: string | null;
  is_live: boolean;
  created_at: string;
}

export interface EvalRun {
  eval_run_id: string;
  tenant_id: string;
  agent_id: string;
  version_id: string;
  suite: string;
  passed: boolean;
  score: number | null;
  metrics: Record<string, unknown>;
  created_at: string;
}

export interface CreateAgentInput {
  name: string;
  direction?: string;
  app_id?: string;
  acting_persona_id?: string;
}

export interface CreateVersionInput {
  system_prompt: string;
  greeting?: string;
  language?: string;
  stack_profile_id: string;
  tool_ids?: string[];
  kb_corpus_ids?: string[];
  escalation_rules?: Record<string, unknown>;
  business_hours?: Record<string, unknown>;
}

export interface RecordEvalRunInput {
  passed: boolean;
  score?: number;
  suite?: string;
  metrics?: Record<string, unknown>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LANGUAGE_RE = /^[a-z]{2,3}(-[A-Z]{2})?$/;
const MAX_NAME_LENGTH = 120;
const MAX_PROMPT_LENGTH = 20000;
const MAX_GREETING_LENGTH = 1000;
const MAX_SUITE_LENGTH = 64;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const PG_UNIQUE_VIOLATION = '23505';
/** A concurrent version insert can collide on (agent_id, version_no); retry this many times. */
const VERSION_INSERT_ATTEMPTS = 3;

const VOICE_AUDIT_POOL = process.env.VOICE_AGENT_AUDIT_POOL || 'admin-default';

/**
 * voice.agent.published.v1 — a version went live, by publish or by rollback.
 * emitEvent swallows failures by design, so a missing audit row never blocks going live;
 * tests assert the audit.entry row rather than trusting the 2xx.
 */
async function emitPublished(agent: Agent, version: AgentVersion, via: 'publish' | 'rollback'): Promise<void> {
  await emitEvent({
    event_type: 'voice.agent.published.v1',
    pool_index: VOICE_AUDIT_POOL,
    actor_kind: 'service',
    actor_id: 'sdk-voice-agent',
    tenant_id: agent.tenant_id,
    subject_kind: 'voice_agent.agent',
    subject_id: agent.agent_id,
    payload: {
      agent_id: agent.agent_id,
      version_id: version.version_id,
      version_no: version.version_no,
      eval_run_id: version.eval_run_id,
      approval_id: version.approval_id,
      via,
    },
  });
}

function iso(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === PG_UNIQUE_VIOLATION;
}

function optionalUuid(field: string, value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw validationError(`${field} must be a uuid`);
  return value;
}

function uuidArray(field: string, value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !UUID_RE.test(v))) {
    throw validationError(`${field} must be an array of uuids`);
  }
  return [...new Set(value as string[])];
}

function plainObject(field: string, value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw validationError(`${field} must be an object`);
  return value as Record<string, unknown>;
}

// ------------------------------------------------------------------------- agents

interface AgentRow extends Omit<Agent, 'created_at' | 'updated_at' | 'latest_version_no'> {
  latest_version_no: number | null;
  created_at: Date;
  updated_at: Date;
}

const AGENT_SELECT = `
  SELECT a.agent_id, a.tenant_id, a.app_id, a.name, a.direction, a.acting_persona_id,
         a.published_version_id, a.kill_switch_flag_id, a.status, a.created_at, a.updated_at,
         (SELECT MAX(v.version_no) FROM voice_agent.agent_version v WHERE v.agent_id = a.agent_id)::int AS latest_version_no
    FROM voice_agent.agent a`;

function toAgent(row: AgentRow): Agent {
  return {
    ...row,
    latest_version_no: row.latest_version_no ?? 0,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

/**
 * Create an agent in status draft.
 *
 * @throws VoiceAgentError 400 on bad input, 409 on a duplicate name.
 */
export async function createAgent(tenantId: string, input: CreateAgentInput): Promise<Agent> {
  if (typeof input.name !== 'string' || input.name.trim().length === 0) throw validationError('name is required');
  const name = input.name.trim();
  if (name.length > MAX_NAME_LENGTH) throw validationError(`name must be at most ${MAX_NAME_LENGTH} characters`);
  const direction = input.direction ?? 'inbound';
  if (!(AGENT_DIRECTIONS as readonly string[]).includes(direction)) {
    throw validationError('direction must be inbound, outbound or both');
  }
  const appId = optionalUuid('app_id', input.app_id);
  const personaId = optionalUuid('acting_persona_id', input.acting_persona_id);
  try {
    const row = await dataService.one<{ agent_id: string }>(
      `INSERT INTO voice_agent.agent (tenant_id, app_id, name, direction, acting_persona_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING agent_id`,
      [tenantId, appId, name, direction, personaId],
    );
    const agent = row ? await getAgent(tenantId, row.agent_id) : null;
    if (!agent) throw new Error('agent insert returned no row');
    return agent;
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('an agent with this name already exists');
    throw err;
  }
}

/** A tenant's agent, or null (another tenant's agent is also null). */
export async function getAgent(tenantId: string, agentId: string): Promise<Agent | null> {
  if (!UUID_RE.test(agentId)) return null;
  const row = await dataService.one<AgentRow>(`${AGENT_SELECT} WHERE a.tenant_id = $1 AND a.agent_id = $2`, [tenantId, agentId]);
  return row ? toAgent(row) : null;
}

/** List a tenant's agents, newest first. */
export async function listAgents(
  tenantId: string,
  opts: { status?: string; direction?: string; limit?: number; offset?: number } = {},
): Promise<{ agents: Agent[]; limit: number; offset: number }> {
  if (opts.status !== undefined && !['draft', 'published', 'paused', 'archived'].includes(opts.status)) {
    throw validationError('status must be draft, published, paused or archived');
  }
  if (opts.direction !== undefined && !(AGENT_DIRECTIONS as readonly string[]).includes(opts.direction)) {
    throw validationError('direction must be inbound, outbound or both');
  }
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? DEFAULT_PAGE_SIZE), 1), MAX_PAGE_SIZE);
  const offset = Math.max(Math.trunc(opts.offset ?? 0), 0);
  const rows = await dataService.rows<AgentRow>(
    `${AGENT_SELECT}
      WHERE a.tenant_id = $1
        AND ($2::text IS NULL OR a.status = $2)
        AND ($3::text IS NULL OR a.direction = $3)
      ORDER BY a.created_at DESC
      LIMIT $4 OFFSET $5`,
    [tenantId, opts.status ?? null, opts.direction ?? null, limit, offset],
  );
  return { agents: rows.map(toAgent), limit, offset };
}

async function requireAgent(tenantId: string, agentId: string): Promise<Agent> {
  const agent = await getAgent(tenantId, agentId);
  if (!agent) throw notFound('agent not found');
  return agent;
}

// ----------------------------------------------------------------------- versions

interface VersionRow extends Omit<AgentVersion, 'published_at' | 'created_at' | 'is_live'> {
  published_at: Date | null;
  created_at: Date;
  is_live: boolean;
}

const VERSION_COLUMNS = `v.version_id, v.agent_id, v.tenant_id, v.version_no, v.system_prompt, v.greeting, v.language,
  v.stack_profile_id, v.tool_ids, v.kb_corpus_ids, v.escalation_rules, v.business_hours,
  v.eval_run_id, v.approval_id, v.published_at, v.created_at,
  (a.published_version_id = v.version_id) AS is_live`;

function toVersion(row: VersionRow): AgentVersion {
  return {
    ...row,
    is_live: Boolean(row.is_live),
    published_at: iso(row.published_at),
    created_at: new Date(row.created_at).toISOString(),
  };
}

/** One version of a tenant's agent, or null. */
export async function getVersion(tenantId: string, agentId: string, versionId: string): Promise<AgentVersion | null> {
  if (!UUID_RE.test(agentId) || !UUID_RE.test(versionId)) return null;
  const row = await dataService.one<VersionRow>(
    `SELECT ${VERSION_COLUMNS}
       FROM voice_agent.agent_version v JOIN voice_agent.agent a ON a.agent_id = v.agent_id
      WHERE v.tenant_id = $1 AND v.agent_id = $2 AND v.version_id = $3`,
    [tenantId, agentId, versionId],
  );
  return row ? toVersion(row) : null;
}

/** All versions of an agent, newest first. */
export async function listVersions(
  tenantId: string,
  agentId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<{ versions: AgentVersion[]; limit: number; offset: number }> {
  await requireAgent(tenantId, agentId);
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? DEFAULT_PAGE_SIZE), 1), MAX_PAGE_SIZE);
  const offset = Math.max(Math.trunc(opts.offset ?? 0), 0);
  const rows = await dataService.rows<VersionRow>(
    `SELECT ${VERSION_COLUMNS}
       FROM voice_agent.agent_version v JOIN voice_agent.agent a ON a.agent_id = v.agent_id
      WHERE v.tenant_id = $1 AND v.agent_id = $2
      ORDER BY v.version_no DESC
      LIMIT $3 OFFSET $4`,
    [tenantId, agentId, limit, offset],
  );
  return { versions: rows.map(toVersion), limit, offset };
}

/**
 * Add an immutable version to an agent. version_no is the next number for the agent.
 *
 * @throws VoiceAgentError 400 (bad input, stack profile not an active profile of this
 *   tenant, tool not an enabled tool of this tenant), 404 (agent), 409 (agent archived).
 */
export async function createVersion(tenantId: string, agentId: string, input: CreateVersionInput): Promise<AgentVersion> {
  const agent = await requireAgent(tenantId, agentId);
  if (agent.status === 'archived') throw conflict('archived agents cannot get new versions');

  if (typeof input.system_prompt !== 'string' || input.system_prompt.trim().length === 0) {
    throw validationError('system_prompt and stack_profile_id are required');
  }
  if (input.system_prompt.length > MAX_PROMPT_LENGTH) {
    throw validationError(`system_prompt must be at most ${MAX_PROMPT_LENGTH} characters`);
  }
  if (input.greeting !== undefined && (typeof input.greeting !== 'string' || input.greeting.length > MAX_GREETING_LENGTH)) {
    throw validationError(`greeting must be a string of at most ${MAX_GREETING_LENGTH} characters`);
  }
  const language = input.language ?? 'en-US';
  if (typeof language !== 'string' || !LANGUAGE_RE.test(language)) throw validationError('language must be a BCP-47 tag such as en-US');
  const stackProfileId = optionalUuid('stack_profile_id', input.stack_profile_id);
  if (!stackProfileId) throw validationError('system_prompt and stack_profile_id are required');
  const toolIds = uuidArray('tool_ids', input.tool_ids);
  const kbCorpusIds = uuidArray('kb_corpus_ids', input.kb_corpus_ids);
  const escalationRules = plainObject('escalation_rules', input.escalation_rules);
  const businessHours = plainObject('business_hours', input.business_hours);

  const profile = await dataService.one<{ status: string }>(
    `SELECT status FROM voice_agent.stack_profile WHERE tenant_id = $1 AND profile_id = $2`,
    [tenantId, stackProfileId],
  );
  if (!profile || profile.status !== 'active') {
    throw validationError('stack_profile_id does not reference an active stack profile of this tenant');
  }
  if (toolIds.length > 0) {
    const found = await dataService.rows<{ tool_id: string }>(
      `SELECT tool_id FROM voice_agent.app_tool WHERE tenant_id = $1 AND enabled AND tool_id = ANY($2::uuid[])`,
      [tenantId, toolIds],
    );
    const missing = toolIds.filter((id) => !found.some((t) => t.tool_id === id));
    if (missing.length > 0) throw validationError(`tool_ids are not enabled tools of this tenant: ${missing.join(', ')}`);
  }

  for (let attempt = 1; ; attempt++) {
    try {
      const row = await dataService.one<{ version_id: string }>(
        `INSERT INTO voice_agent.agent_version
           (agent_id, tenant_id, version_no, system_prompt, greeting, language, stack_profile_id,
            tool_ids, kb_corpus_ids, escalation_rules, business_hours)
         SELECT $1, $2, COALESCE(MAX(version_no), 0) + 1, $3, $4, $5, $6, $7::uuid[], $8::uuid[], $9, $10
           FROM voice_agent.agent_version WHERE agent_id = $1
         RETURNING version_id`,
        [agentId, tenantId, input.system_prompt, input.greeting ?? null, language, stackProfileId,
          toolIds, kbCorpusIds, JSON.stringify(escalationRules), JSON.stringify(businessHours)],
      );
      const version = row ? await getVersion(tenantId, agentId, row.version_id) : null;
      if (!version) throw new Error('version insert returned no row');
      await dataService.query(`UPDATE voice_agent.agent SET updated_at = now() WHERE agent_id = $1`, [agentId]);
      return version;
    } catch (err) {
      if (isUniqueViolation(err) && attempt < VERSION_INSERT_ATTEMPTS) continue;
      throw err;
    }
  }
}

async function requireVersion(tenantId: string, agentId: string, versionId: string): Promise<AgentVersion> {
  const version = await getVersion(tenantId, agentId, versionId);
  if (!version) throw notFound('agent version not found');
  return version;
}

// ---------------------------------------------------------------------- eval runs

interface EvalRunRow extends Omit<EvalRun, 'created_at' | 'score'> {
  score: string | number | null;
  created_at: Date;
}

function toEvalRun(row: EvalRunRow): EvalRun {
  return {
    ...row,
    score: row.score === null ? null : Number(row.score),
    created_at: new Date(row.created_at).toISOString(),
  };
}

/**
 * Record an evaluation run against a version (written by the simulated-caller harness).
 *
 * @throws VoiceAgentError 400 / 404.
 */
export async function recordEvalRun(
  tenantId: string,
  agentId: string,
  versionId: string,
  input: RecordEvalRunInput,
): Promise<EvalRun> {
  await requireVersion(tenantId, agentId, versionId);
  if (typeof input.passed !== 'boolean') throw validationError('passed (boolean) is required');
  if (input.score !== undefined && (typeof input.score !== 'number' || input.score < 0 || input.score > 1)) {
    throw validationError('score must be a number between 0 and 1');
  }
  const suite = input.suite ?? 'default';
  if (typeof suite !== 'string' || suite.length === 0 || suite.length > MAX_SUITE_LENGTH) {
    throw validationError(`suite must be a non-empty string of at most ${MAX_SUITE_LENGTH} characters`);
  }
  const metrics = plainObject('metrics', input.metrics);
  const row = await dataService.one<EvalRunRow>(
    `INSERT INTO voice_agent.eval_run (tenant_id, agent_id, version_id, suite, passed, score, metrics)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING eval_run_id, tenant_id, agent_id, version_id, suite, passed, score, metrics, created_at`,
    [tenantId, agentId, versionId, suite, input.passed, input.score ?? null, JSON.stringify(metrics)],
  );
  if (!row) throw new Error('eval run insert returned no row');
  return toEvalRun(row);
}

// ------------------------------------------------------------- approval + publish

/**
 * Open (or return the already-open) sdk-approval request for publishing this version,
 * on one of the tenant's approval routes. The request id is stored on the version.
 *
 * @throws VoiceAgentError 400 (route not this tenant's), 404, 409 (already live).
 */
export async function requestPublishApproval(
  tenantId: string,
  agentId: string,
  versionId: string,
  input: { route_id?: string; initiator_persona_id?: string; reason?: string },
): Promise<{ version: AgentVersion; approval: Awaited<ReturnType<typeof submitRequest>> }> {
  const version = await requireVersion(tenantId, agentId, versionId);
  if (version.is_live) throw conflict('this version is already live');
  const routeId = optionalUuid('route_id', input.route_id);
  const initiator = optionalUuid('initiator_persona_id', input.initiator_persona_id);
  if (!routeId || !initiator) throw validationError('route_id and initiator_persona_id are required');

  // sdk-approval loads a route by id alone, so ownership is checked here: without it a
  // tenant could route its publish through another tenant's approvers.
  const route = await dataService.one<{ tenant_id: string; status: string }>(
    `SELECT tenant_id, status FROM approval.route WHERE route_id = $1`,
    [routeId],
  );
  if (!route || route.tenant_id !== tenantId || route.status !== 'active') {
    throw validationError('route_id does not reference an active approval route of this tenant');
  }

  const approval = await submitRequest({
    tenant_id: tenantId,
    route_id: routeId,
    subject_kind: VERSION_APPROVAL_SUBJECT_KIND,
    subject_id: versionId,
    initiator_persona_id: initiator,
    reason: input.reason ?? `Publish voice agent version ${version.version_no}`,
  });
  await dataService.query(
    `UPDATE voice_agent.agent_version SET approval_id = $3 WHERE tenant_id = $1 AND version_id = $2`,
    [tenantId, versionId, approval.request.request_id],
  );
  return { version: await requireVersion(tenantId, agentId, versionId), approval };
}

/**
 * Put a version live. Both gates must hold: the newest eval run for the version passed,
 * and its approval request is approved for exactly this version.
 *
 * @throws VoiceAgentError 404, 409 PublishBlocked naming the unmet gate, 409 Conflict
 *   when the agent is archived.
 */
export async function publishVersion(tenantId: string, agentId: string, versionId: string): Promise<{ agent: Agent; version: AgentVersion }> {
  const agent = await requireAgent(tenantId, agentId);
  if (agent.status === 'archived') throw conflict('archived agents cannot be published');
  const version = await requireVersion(tenantId, agentId, versionId);
  if (version.is_live) return { agent, version };

  const latestRun = await dataService.one<{ eval_run_id: string; passed: boolean }>(
    `SELECT eval_run_id, passed FROM voice_agent.eval_run
      WHERE tenant_id = $1 AND version_id = $2 ORDER BY created_at DESC LIMIT 1`,
    [tenantId, versionId],
  );
  if (!latestRun) throw new VoiceAgentError(409, 'PublishBlocked', 'no evaluation run recorded for this version');
  if (!latestRun.passed) throw new VoiceAgentError(409, 'PublishBlocked', 'the latest evaluation run for this version did not pass');

  if (!version.approval_id) throw new VoiceAgentError(409, 'PublishBlocked', 'no approval has been requested for this version');
  const approval = await getRequest(version.approval_id);
  const approved = approval
    && approval.request.tenant_id === tenantId
    && approval.request.subject_kind === VERSION_APPROVAL_SUBJECT_KIND
    && approval.request.subject_id === versionId
    && approval.request.status === 'approved';
  if (!approved) {
    throw new VoiceAgentError(409, 'PublishBlocked', `approval is ${approval?.request.status ?? 'missing'}, not approved`);
  }

  await dataService.tx(async (q) => {
    await q(
      `UPDATE voice_agent.agent_version SET published_at = COALESCE(published_at, now()), eval_run_id = $3
        WHERE tenant_id = $1 AND version_id = $2`,
      [tenantId, versionId, latestRun.eval_run_id],
    );
    await q(
      `UPDATE voice_agent.agent SET published_version_id = $3, status = 'published', updated_at = now()
        WHERE tenant_id = $1 AND agent_id = $2`,
      [tenantId, agentId, versionId],
    );
  });
  const live = { agent: await requireAgent(tenantId, agentId), version: await requireVersion(tenantId, agentId, versionId) };
  await emitPublished(live.agent, live.version, 'publish');
  return live;
}

/**
 * Re-point the agent at a version that has been published before.
 *
 * @throws VoiceAgentError 400 / 404 / 409 InvalidTransition (never published) / 409 (archived).
 */
export async function rollbackAgent(tenantId: string, agentId: string, versionIdInput: unknown): Promise<{ agent: Agent; version: AgentVersion }> {
  const versionId = optionalUuid('version_id', versionIdInput);
  if (!versionId) throw validationError('version_id is required');
  const agent = await requireAgent(tenantId, agentId);
  if (agent.status === 'archived') throw conflict('archived agents cannot be rolled back');
  const version = await requireVersion(tenantId, agentId, versionId);
  if (!version.published_at) {
    throw new VoiceAgentError(409, 'InvalidTransition', 'only a version that was published before can be rolled back to');
  }
  await dataService.query(
    `UPDATE voice_agent.agent SET published_version_id = $3, status = 'published', updated_at = now()
      WHERE tenant_id = $1 AND agent_id = $2`,
    [tenantId, agentId, versionId],
  );
  const live = { agent: await requireAgent(tenantId, agentId), version: await requireVersion(tenantId, agentId, versionId) };
  await emitPublished(live.agent, live.version, 'rollback');
  return live;
}
