import { dataService } from '@projexlight/db-runtime';
import { emitEvent } from '@projexlight/sdk-audit';
import { conflict, notFound, validationError, VoiceAgentError } from '../models/errors';
import { requireVersion } from './agentService';

/**
 * Evaluation runs as jobs (VA·E10 · TK-4517 / TK-4518).
 *
 * A tenant starts a run against an agent version; a voice-runtime worker claims it, plays each
 * scenario as a simulated caller over loopback media (no phone line, no LiveKit room), and
 * finishes it with per-scenario results and aggregate metrics.
 *
 *   sandbox     fake media + a SCRIPTED agent LLM (the scenario says which app tools the agent
 *               calls, with which arguments). Free and needs no provider keys — it proves the
 *               app's tool endpoints and the call plumbing end to end, so consumer apps
 *               (LeadFlow, projex_crm) can run it in CI. It NEVER unlocks publish.
 *   evaluation  fake media, the tenant's real LLM keys and real app tools; scripted or
 *               LLM-driven callers; scored against latency / barge-in / expectation thresholds.
 *               A passing evaluation run is what the publish gate requires.
 *
 * Why fake media for evaluation too: it scores the agent (prompt, model, tools, turn-taking),
 * which is what a version changes. Speech-provider accuracy over phone audio is a property of
 * the provider, measured by catalog certification (TK-4519), not by every agent version.
 */

export const EVAL_MODES = ['sandbox', 'evaluation'] as const;
export type EvalMode = (typeof EVAL_MODES)[number];

export interface ScenarioToolCall { name: string; args?: Record<string, unknown> }
export interface ScenarioTurn {
  /** What the simulated caller says. */
  say: string;
  /** Say it while the agent is still talking (a barge-in probe). */
  interrupt?: boolean;
  /** Sandbox only: what the scripted agent does in answer to this line. */
  agent?: { reply?: string; tool_calls?: ScenarioToolCall[] };
}
export interface EvalScenario {
  name: string;
  /** Evaluation mode, no `turns`: an LLM plays the caller with this persona and goal. */
  caller?: { persona?: string; goal?: string };
  turns?: ScenarioTurn[];
  /** Cap for an LLM-driven caller. */
  max_turns?: number;
  expect?: {
    tools_called?: string[];
    tools_not_called?: string[];
    transfer?: boolean;
    says_any?: string[];
    says_none?: string[];
  };
}

export interface EvalRunJob {
  eval_run_id: string;
  tenant_id: string;
  agent_id: string;
  version_id: string;
  suite: string;
  mode: 'reported' | EvalMode;
  status: 'queued' | 'running' | 'completed' | 'error';
  passed: boolean | null;
  score: number | null;
  scenarios: EvalScenario[];
  results: unknown[];
  metrics: Record<string, unknown>;
  error: string | null;
  requested_by: string | null;
  claimed_by: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

const MAX_SCENARIOS = 10;
const MAX_TURNS = 20;
const MAX_LLM_TURNS = 12;
const MAX_TEXT = 500;
const MAX_NAME = 80;
const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEASE_MS = Number(process.env.VOICE_EVAL_LEASE_MS ?? 10 * 60 * 1000);
const AUDIT_POOL = process.env.VOICE_AGENT_AUDIT_POOL || 'admin-default';
const COLUMNS = `eval_run_id, tenant_id, agent_id, version_id, suite, mode, status, passed, score, scenarios, results,
  metrics, error, requested_by, claimed_by, started_at, finished_at, created_at`;

/** Used when a run is started without scenarios. */
export function defaultScenarios(mode: EvalMode): EvalScenario[] {
  if (mode === 'sandbox') {
    return [{ name: 'smoke', turns: [{ say: 'Hello, is anyone there?' }, { say: 'Thanks, that is all. Goodbye.' }] }];
  }
  return [
    {
      name: 'open-question',
      caller: { persona: 'a first-time caller who is polite and brief', goal: 'find out what the business can help with, then say goodbye' },
      max_turns: 4,
    },
    {
      name: 'barge-in',
      turns: [
        { say: 'Can you explain in detail everything you can help me with?' },
        { say: 'Sorry to interrupt, I just have one quick question.', interrupt: true },
        { say: 'Never mind, thank you. Goodbye.' },
      ],
    },
  ];
}

const str = (v: unknown, field: string, max = MAX_TEXT): string => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw validationError(`${field} must be a non-empty string of at most ${max} characters`);
  return v.trim();
};
const strList = (v: unknown, field: string): string[] | undefined => {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.length > 20) throw validationError(`${field} must be an array of at most 20 strings`);
  return v.map((x, i) => str(x, `${field}[${i}]`, 200));
};
const plain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validates and normalises the scenarios of a run. Exported for the unit test. */
export function validateScenarios(raw: unknown, mode: EvalMode): EvalScenario[] {
  if (raw === undefined || raw === null) return defaultScenarios(mode);
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_SCENARIOS) {
    throw validationError(`scenarios must be an array of 1 to ${MAX_SCENARIOS} scenarios`);
  }
  const names = new Set<string>();
  return raw.map((s, i): EvalScenario => {
    const at = `scenarios[${i}]`;
    if (!plain(s)) throw validationError(`${at} must be an object`);
    const name = str(s.name, `${at}.name`, MAX_NAME);
    if (names.has(name)) throw validationError(`${at}.name "${name}" is duplicated`);
    names.add(name);
    const out: EvalScenario = { name };
    if (s.turns !== undefined) {
      if (!Array.isArray(s.turns) || s.turns.length === 0 || s.turns.length > MAX_TURNS) {
        throw validationError(`${at}.turns must be an array of 1 to ${MAX_TURNS} caller lines`);
      }
      out.turns = s.turns.map((t: unknown, j: number): ScenarioTurn => {
        const tat = `${at}.turns[${j}]`;
        if (!plain(t)) throw validationError(`${tat} must be an object`);
        const turn: ScenarioTurn = { say: str(t.say, `${tat}.say`) };
        if (t.interrupt !== undefined) {
          if (typeof t.interrupt !== 'boolean') throw validationError(`${tat}.interrupt must be a boolean`);
          if (t.interrupt && j === 0) throw validationError(`${tat}.interrupt needs an earlier line for the agent to be answering`);
          turn.interrupt = t.interrupt;
        }
        if (t.agent !== undefined) {
          if (mode !== 'sandbox') throw validationError(`${tat}.agent scripts the agent and is only allowed in sandbox mode`);
          if (!plain(t.agent)) throw validationError(`${tat}.agent must be an object`);
          const agent: NonNullable<ScenarioTurn['agent']> = {};
          if (t.agent.reply !== undefined) agent.reply = str(t.agent.reply, `${tat}.agent.reply`);
          if (t.agent.tool_calls !== undefined) {
            if (!Array.isArray(t.agent.tool_calls) || t.agent.tool_calls.length > 5) throw validationError(`${tat}.agent.tool_calls must be an array of at most 5`);
            agent.tool_calls = t.agent.tool_calls.map((c: unknown, k: number): ScenarioToolCall => {
              if (!plain(c)) throw validationError(`${tat}.agent.tool_calls[${k}] must be an object`);
              const tname = str(c.name, `${tat}.agent.tool_calls[${k}].name`, 64);
              if (!NAME_RE.test(tname)) throw validationError(`${tat}.agent.tool_calls[${k}].name is not a tool name`);
              if (c.args !== undefined && !plain(c.args)) throw validationError(`${tat}.agent.tool_calls[${k}].args must be an object`);
              return c.args === undefined ? { name: tname } : { name: tname, args: c.args };
            });
          }
          turn.agent = agent;
        }
        return turn;
      });
    }
    if (s.caller !== undefined) {
      if (!plain(s.caller)) throw validationError(`${at}.caller must be an object`);
      out.caller = {};
      if (s.caller.persona !== undefined) out.caller.persona = str(s.caller.persona, `${at}.caller.persona`);
      if (s.caller.goal !== undefined) out.caller.goal = str(s.caller.goal, `${at}.caller.goal`);
    }
    if (!out.turns) {
      // No script: an LLM plays the caller — that needs a real model, so not in sandbox.
      if (mode === 'sandbox') throw validationError(`${at}.turns is required in sandbox mode (a scripted caller)`);
      if (!out.caller?.goal) throw validationError(`${at} needs either turns (a scripted caller) or caller.goal (an LLM-driven caller)`);
    }
    if (s.max_turns !== undefined) {
      if (!Number.isInteger(s.max_turns) || (s.max_turns as number) < 1 || (s.max_turns as number) > MAX_LLM_TURNS) {
        throw validationError(`${at}.max_turns must be an integer from 1 to ${MAX_LLM_TURNS}`);
      }
      out.max_turns = s.max_turns as number;
    }
    if (s.expect !== undefined) {
      if (!plain(s.expect)) throw validationError(`${at}.expect must be an object`);
      const e = s.expect;
      out.expect = {};
      const tc = strList(e.tools_called, `${at}.expect.tools_called`);
      const tn = strList(e.tools_not_called, `${at}.expect.tools_not_called`);
      const sa = strList(e.says_any, `${at}.expect.says_any`);
      const sn = strList(e.says_none, `${at}.expect.says_none`);
      if (tc) out.expect.tools_called = tc;
      if (tn) out.expect.tools_not_called = tn;
      if (sa) out.expect.says_any = sa;
      if (sn) out.expect.says_none = sn;
      if (e.transfer !== undefined) {
        if (typeof e.transfer !== 'boolean') throw validationError(`${at}.expect.transfer must be a boolean`);
        out.expect.transfer = e.transfer;
      }
    }
    return out;
  });
}

interface Row extends Omit<EvalRunJob, 'score' | 'started_at' | 'finished_at' | 'created_at'> {
  score: string | number | null;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
}
const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null);
function toJob(r: Row): EvalRunJob {
  return { ...r, score: r.score === null ? null : Number(r.score), started_at: iso(r.started_at), finished_at: iso(r.finished_at), created_at: iso(r.created_at)! };
}

/**
 * Queues a run for a version. 201 with the queued run; a worker picks it up within seconds.
 *
 * @throws VoiceAgentError 400 bad input, 404 unknown agent/version, 409 the version's stack
 *   profile is not active.
 */
export async function startEvalRun(
  tenantId: string, agentId: string, versionId: string,
  input: { mode?: unknown; scenarios?: unknown; suite?: unknown }, requestedBy: string,
): Promise<EvalRunJob> {
  const mode = input.mode ?? 'evaluation';
  if (!(EVAL_MODES as readonly unknown[]).includes(mode)) throw validationError(`mode must be one of ${EVAL_MODES.join(', ')}`);
  const scenarios = validateScenarios(input.scenarios, mode as EvalMode);
  const suite = input.suite === undefined ? (input.scenarios === undefined ? 'default' : 'custom') : str(input.suite, 'suite', 64);
  const version = await requireVersion(tenantId, agentId, versionId);
  const profile = await dataService.one<{ status: string }>(
    `SELECT status FROM voice_agent.stack_profile WHERE tenant_id = $1 AND profile_id = $2`,
    [tenantId, version.stack_profile_id],
  );
  if (profile?.status !== 'active') throw conflict("the version's stack profile is not active");
  const row = await dataService.one<Row>(
    `INSERT INTO voice_agent.eval_run (tenant_id, agent_id, version_id, suite, mode, status, passed, scenarios, requested_by)
     VALUES ($1, $2, $3, $4, $5, 'queued', NULL, $6::jsonb, $7)
     RETURNING ${COLUMNS}`,
    [tenantId, agentId, versionId, suite, mode, JSON.stringify(scenarios), requestedBy],
  );
  if (!row) throw new Error('[sdk-voice-agent] eval run insert returned no row');
  return toJob(row);
}

/** @throws VoiceAgentError 404. */
export async function getEvalRun(tenantId: string, evalRunId: string): Promise<EvalRunJob> {
  if (!UUID_RE.test(evalRunId)) throw notFound('evaluation run not found');
  const row = await dataService.one<Row>(`SELECT ${COLUMNS} FROM voice_agent.eval_run WHERE tenant_id = $1 AND eval_run_id = $2`, [tenantId, evalRunId]);
  if (!row) throw notFound('evaluation run not found');
  return toJob(row);
}

/** Newest first. @throws VoiceAgentError 404 unknown agent/version. */
export async function listEvalRuns(
  tenantId: string, agentId: string, versionId: string, page: { limit?: number; offset?: number } = {},
): Promise<{ eval_runs: EvalRunJob[]; total: number; limit: number; offset: number }> {
  await requireVersion(tenantId, agentId, versionId);
  const limit = Math.min(Math.max(page.limit ?? 20, 1), 100);
  const offset = Math.max(page.offset ?? 0, 0);
  const rows = await dataService.rows<Row & { total: string }>(
    `SELECT ${COLUMNS}, count(*) OVER () AS total FROM voice_agent.eval_run
      WHERE tenant_id = $1 AND version_id = $2 ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
    [tenantId, versionId, limit, offset],
  );
  return { eval_runs: rows.map(({ total: _t, ...r }) => toJob(r)), total: rows.length ? Number(rows[0].total) : 0, limit, offset };
}

// ------------------------------------------------------------------------------------------
// Runtime side (operator routes; the voice runtime is the only caller).

/**
 * The oldest queued run — or a running one whose worker's lease lapsed — now leased to
 * `worker`. Null when there is nothing to do.
 */
export async function claimEvalRun(worker: unknown): Promise<EvalRunJob | null> {
  const w = str(worker, 'worker', 200);
  const row = await dataService.one<Row>(
    `UPDATE voice_agent.eval_run SET status = 'running', claimed_by = $1,
            lease_until = now() + ($2::bigint * interval '1 millisecond'), started_at = COALESCE(started_at, now())
      WHERE eval_run_id = (
        SELECT eval_run_id FROM voice_agent.eval_run
         WHERE status = 'queued' OR (status = 'running' AND lease_until < now())
         ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING ${COLUMNS}`,
    [w, LEASE_MS],
  );
  return row ? toJob(row) : null;
}

async function requireLease(evalRunId: string, worker: string): Promise<Row> {
  if (!UUID_RE.test(evalRunId)) throw notFound('evaluation run not found');
  const row = await dataService.one<Row>(`SELECT ${COLUMNS} FROM voice_agent.eval_run WHERE eval_run_id = $1`, [evalRunId]);
  if (!row) throw notFound('evaluation run not found');
  if (row.status !== 'running' || row.claimed_by !== worker) throw conflict('this worker does not hold the evaluation run');
  return row;
}

/**
 * A test call for one scenario of a run the worker holds. Its context marks it as an
 * evaluation call — and, in sandbox mode, as a SANDBOX call: the only kind of call the
 * runtime will run on fake providers, and the only kind bootstrap lets run without keys.
 * Also renews the lease.
 *
 * @throws VoiceAgentError 400 / 404 / 409 not this worker's run.
 */
export async function createEvalCall(evalRunId: string, input: { worker?: unknown; scenario_index?: unknown }): Promise<{ call_id: string; tenant_id: string }> {
  const worker = str(input.worker, 'worker', 200);
  const run = await requireLease(evalRunId, worker);
  const idx = input.scenario_index;
  if (!Number.isInteger(idx) || (idx as number) < 0 || (idx as number) >= run.scenarios.length) throw validationError('scenario_index is out of range');
  const scenario = run.scenarios[idx as number];
  const call = await dataService.one<{ call_id: string }>(
    `INSERT INTO voice_agent.call (tenant_id, agent_id, agent_version_id, direction, is_test, requested_by, context)
     VALUES ($1, $2, $3, 'inbound', true, $4, $5::jsonb)
     RETURNING call_id`,
    [run.tenant_id, run.agent_id, run.version_id, `eval:${evalRunId}`,
      JSON.stringify({ eval_run_id: evalRunId, eval_mode: run.mode, scenario: scenario.name, sandbox: run.mode === 'sandbox' })],
  );
  if (!call) throw new Error('[sdk-voice-agent] eval call insert returned no row');
  await dataService.query(
    `UPDATE voice_agent.eval_run SET lease_until = now() + ($2::bigint * interval '1 millisecond') WHERE eval_run_id = $1`,
    [evalRunId, LEASE_MS],
  );
  return { call_id: call.call_id, tenant_id: run.tenant_id };
}

/**
 * Records the outcome and releases the run. `error` = the harness could not run it (no
 * verdict); otherwise `passed` + score + per-scenario results.
 *
 * @throws VoiceAgentError 400 / 404 / 409 not this worker's run.
 */
export async function finishEvalRun(evalRunId: string, input: {
  worker?: unknown; status?: unknown; passed?: unknown; score?: unknown; metrics?: unknown; results?: unknown; error?: unknown;
}): Promise<EvalRunJob> {
  const worker = str(input.worker, 'worker', 200);
  await requireLease(evalRunId, worker);
  const status = input.status ?? 'completed';
  if (status !== 'completed' && status !== 'error') throw validationError('status must be completed or error');
  let passed: boolean | null = null;
  let score: number | null = null;
  if (status === 'completed') {
    if (typeof input.passed !== 'boolean') throw validationError('passed (boolean) is required for a completed run');
    passed = input.passed;
    if (input.score !== undefined && input.score !== null) {
      if (typeof input.score !== 'number' || input.score < 0 || input.score > 1) throw validationError('score must be a number between 0 and 1');
      score = input.score;
    }
  }
  if (input.metrics !== undefined && !plain(input.metrics)) throw validationError('metrics must be an object');
  if (input.results !== undefined && (!Array.isArray(input.results) || input.results.length > MAX_SCENARIOS)) throw validationError('results must be an array');
  const error = status === 'error' ? (typeof input.error === 'string' && input.error ? input.error.slice(0, 1000) : 'the evaluation could not run') : null;
  const row = await dataService.one<Row>(
    `UPDATE voice_agent.eval_run SET status = $2, passed = $3, score = $4, metrics = $5::jsonb, results = $6::jsonb,
            error = $7, finished_at = now(), lease_until = NULL
      WHERE eval_run_id = $1 RETURNING ${COLUMNS}`,
    [evalRunId, status, passed, score, JSON.stringify(input.metrics ?? {}), JSON.stringify(input.results ?? []), error],
  );
  if (!row) throw new VoiceAgentError(404, 'NotFound', 'evaluation run not found');
  const job = toJob(row);
  await emitEvent({
    event_type: 'voice.eval_run.completed.v1',
    pool_index: AUDIT_POOL,
    actor_kind: 'agent',
    actor_id: 'voice-runtime',
    tenant_id: job.tenant_id,
    subject_kind: 'voice_agent.eval_run',
    subject_id: job.eval_run_id,
    payload: { eval_run_id: job.eval_run_id, agent_id: job.agent_id, version_id: job.version_id, mode: job.mode, status: job.status, passed: job.passed, score: job.score },
  });
  return job;
}
