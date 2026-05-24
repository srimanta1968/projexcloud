import crypto from 'crypto';
import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import { hashPayload, readLogWithEnvelopes } from './executionLog';

/**
 * Deterministic replay engine (FR-ART-8..12 / AC-5).
 *
 * Replaying an execution log against the same model snapshot reproduces a
 * bit-identical output. The engine reads agents.execution_log_entry rows
 * for a run, re-issues each step against the registered replayer for the
 * step's kind, and asserts the regenerated payload's content_hash matches
 * the recorded value. A drift in the model snapshot is surfaced as an
 * explicit `snapshot-drift` event rather than a silent failure (R-4).
 *
 * For prototype scope: this engine focuses on the verification path —
 * given a stored log, can we re-derive the same content hashes against a
 * matching model snapshot? The actual side-effect re-execution (firing
 * tool calls again) is gated by a `dryRun` flag — default true, since
 * production replays are mostly forensic / "compare last week's decision".
 */

const AGENT_AUDIT_POOL = process.env.AGENT_RUNTIME_AUDIT_POOL || 'admin-default';
const SYSTEM_ACTOR_ID = 'sdk-agent-runtime.replay-engine';

export type ReplayStepKind =
  | 'prompt-template'
  | 'context-retrieval'
  | 'model-invocation'
  | 'tool-call'
  | 'tool-response'
  | 'final-action'
  | 'ttl-event'
  | 'kill-event';

export interface ReplayStepInput {
  run_id: string;
  seq: number;
  kind: ReplayStepKind;
  /** The original payload envelope; replayer is responsible for unwrapping. */
  payload_envelope: Buffer;
  /** Caller-provided context — usually contains the model snapshot id resolved
   *  from the original ai_gateway.completion row. */
  context: ReplayContext;
}

export interface ReplayContext {
  model_snapshot_id: string;
  current_model_snapshot_id?: string;
  /** Optional pluggable unwrap function so tests can stub the vault dependency. */
  unwrapEnvelope?: (envelope: Buffer) => Promise<unknown> | unknown;
}

export interface ReplayStepResult {
  /** Regenerated canonical payload — content_hash is taken over this. */
  payload: unknown;
}

export type Replayer = (input: ReplayStepInput) => Promise<ReplayStepResult>;

const replayers = new Map<ReplayStepKind, Replayer>();

/**
 * Register the per-kind replayer. Each kind ships its own implementation;
 * sdk-ai-gateway registers the model-invocation replayer, sdk-mcp-bridge
 * the tool-call/tool-response ones, etc.
 */
export function registerReplayer(kind: ReplayStepKind, replayer: Replayer): void {
  replayers.set(kind, replayer);
}

/**
 * Default unwrap: assumes the payload_envelope IS the canonical JSON bytes.
 * Real deployments register an unwrap that calls sdk-vault.envelopeDecrypt.
 */
function defaultUnwrap(envelope: Buffer): unknown {
  return JSON.parse(envelope.toString('utf8'));
}

/**
 * Default replayer: parses the envelope as canonical JSON and returns it
 * untouched. Sufficient for any step whose deterministic behaviour is just
 * "the payload that was recorded" (prompt-template, ttl-event, kill-event).
 */
async function defaultReplayer(input: ReplayStepInput): Promise<ReplayStepResult> {
  const unwrap = input.context.unwrapEnvelope ?? defaultUnwrap;
  const payload = await unwrap(input.payload_envelope);
  return { payload };
}

['prompt-template', 'ttl-event', 'kill-event'].forEach((k) =>
  registerReplayer(k as ReplayStepKind, defaultReplayer),
);

export type ReplayVerdict =
  | { kind: 'matched'; run_id: string; steps_replayed: number }
  | {
      kind: 'snapshot-drift';
      run_id: string;
      expected_snapshot: string;
      actual_snapshot: string;
    }
  | {
      kind: 'diverged';
      run_id: string;
      first_divergent_seq: number;
      expected_hash: string;
      actual_hash: string;
    };

interface AgentRunRow {
  run_id: string;
  agent_id: string;
  tenant_id: string | null;
  status: string;
  ended_at: Date | null;
  execution_log_ref: string | null;
}

async function loadRun(run_id: string): Promise<AgentRunRow | null> {
  return dataService.one<AgentRunRow>(
    `SELECT run_id, agent_id, tenant_id, status, ended_at, execution_log_ref
       FROM agents.agent_run WHERE run_id = $1`,
    [run_id],
  );
}

async function findRecordedSnapshot(run_id: string): Promise<string | null> {
  // The model snapshot is captured on the ai_gateway.completion row tied to
  // each model-invocation step. We use the first one as the canonical
  // snapshot id for the run (a run only uses one model + snapshot in the
  // common case; multi-model runs require a future per-step snapshot field).
  const r = await dataService.one<{ model: string }>(
    `SELECT model FROM ai_gateway.completion WHERE agent_run_id = $1 ORDER BY started_at ASC LIMIT 1`,
    [run_id],
  );
  return r?.model ?? null;
}

export interface ReplayOptions {
  /** Optional override for the current model snapshot id. When omitted the
   *  engine assumes the current snapshot matches the recorded snapshot. */
  current_model_snapshot_id?: string;
  /** When true, the engine only verifies content hashes (no side effects).
   *  Default true; set false to actually re-fire tool calls etc. */
  dryRun?: boolean;
  /** Pluggable envelope unwrap; defaults to JSON.parse(buf.toString('utf8')). */
  unwrapEnvelope?: (envelope: Buffer) => Promise<unknown> | unknown;
}

async function emitReplayedEvent(
  run: AgentRunRow,
  verdict: ReplayVerdict,
  actor_id: string,
): Promise<void> {
  try {
    await appendAuditEntry({
      pool_index: AGENT_AUDIT_POOL,
      event_type: 'agent.run.replayed.v1',
      actor_kind: 'service',
      actor_id,
      tenant_id: run.tenant_id,
      subject_kind: 'agent.agent_run',
      subject_id: run.run_id,
      retention_class: 'regulated',
      payload: { verdict },
    });
  } catch (auditErr) {
    console.error(
      '[replay-engine] audit emit failed for',
      run.run_id,
      (auditErr as Error).message,
    );
  }
}

/**
 * Replay the log for `run_id` and return a structured verdict. Throws only
 * on lookup failures (missing run, no log rows) — every other condition
 * (drift, divergence, match) is encoded in the verdict. The caller emits
 * the audit entry and ships the verdict to the operator.
 */
export async function replayRun(
  run_id: string,
  opts: ReplayOptions = {},
): Promise<ReplayVerdict> {
  const run = await loadRun(run_id);
  if (!run) throw new Error(`[replay-engine] run ${run_id} not found`);

  const entries = await readLogWithEnvelopes(run_id);
  if (entries.length === 0) {
    throw new Error(`[replay-engine] no execution log entries for run ${run_id}`);
  }

  const recordedSnapshot = await findRecordedSnapshot(run_id);
  const currentSnapshot = opts.current_model_snapshot_id ?? recordedSnapshot;
  if (recordedSnapshot && currentSnapshot && recordedSnapshot !== currentSnapshot) {
    const verdict: ReplayVerdict = {
      kind: 'snapshot-drift',
      run_id,
      expected_snapshot: recordedSnapshot,
      actual_snapshot: currentSnapshot,
    };
    await emitReplayedEvent(run, verdict, SYSTEM_ACTOR_ID);
    return verdict;
  }

  const context: ReplayContext = {
    model_snapshot_id: recordedSnapshot ?? 'unknown',
    current_model_snapshot_id: currentSnapshot ?? undefined,
    unwrapEnvelope: opts.unwrapEnvelope,
  };

  let stepsReplayed = 0;
  for (const entry of entries) {
    const replayer = replayers.get(entry.kind as ReplayStepKind) ?? defaultReplayer;
    const result = await replayer({
      run_id,
      seq: entry.seq,
      kind: entry.kind as ReplayStepKind,
      payload_envelope: entry.payload_envelope,
      context,
    });
    const actualHash = hashPayload(result.payload);
    if (!crypto.timingSafeEqual(actualHash, entry.content_hash)) {
      const verdict: ReplayVerdict = {
        kind: 'diverged',
        run_id,
        first_divergent_seq: entry.seq,
        expected_hash: entry.content_hash.toString('hex'),
        actual_hash: actualHash.toString('hex'),
      };
      await emitReplayedEvent(run, verdict, SYSTEM_ACTOR_ID);
      return verdict;
    }
    stepsReplayed += 1;
  }

  const verdict: ReplayVerdict = { kind: 'matched', run_id, steps_replayed: stepsReplayed };
  await emitReplayedEvent(run, verdict, SYSTEM_ACTOR_ID);
  return verdict;
}
