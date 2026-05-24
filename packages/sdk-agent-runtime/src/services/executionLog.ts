import crypto from 'crypto';
import { dataService } from '@projexlight/db-runtime';

/**
 * Append-only execution log writer (FR-ART-8..12).
 *
 * Every step the agent runtime takes — prompt template fill, context
 * retrieval, model invocation, tool call, tool response, final action,
 * TTL event, kill event — is appended to agents.execution_log_entry as
 * a content-addressed row. The replay engine reads these rows in seq
 * order and re-executes against the captured model snapshot id to
 * reproduce the run bit-identically (AC-5).
 *
 * Payloads are stored in vault-wrapped envelopes (the caller wraps the
 * payload via sdk-vault before passing to appendLogEntry). The hash is
 * computed over the *canonicalised* unwrapped payload so it's stable
 * across vault key rotations.
 */

export type ExecutionLogKind =
  | 'prompt-template'
  | 'context-retrieval'
  | 'model-invocation'
  | 'tool-call'
  | 'tool-response'
  | 'final-action'
  | 'ttl-event'
  | 'kill-event';

export interface AppendLogEntryInput {
  run_id: string;
  kind: ExecutionLogKind;
  /** Canonical-JSON-stable payload (everything needed to replay this step). */
  payload: unknown;
  /** Vault-wrapped bytes — what gets persisted; callers wrap before calling. */
  payload_envelope: Buffer;
}

export interface LogEntry {
  entry_id: string;
  run_id: string;
  seq: number;
  kind: ExecutionLogKind;
  content_hash: Buffer;
  recorded_at: Date;
}

function canonicalise(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalise).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalise(obj[k])).join(',') + '}';
}

export function hashPayload(payload: unknown): Buffer {
  return crypto.createHash('sha256').update(canonicalise(payload), 'utf8').digest();
}

/**
 * Appends one entry to the log. Seq is computed atomically — a parallel
 * append into the same run gets a higher seq number, never duplicates the
 * unique (run_id, seq) constraint. The retry-on-conflict path covers the
 * tiny race window between SELECT MAX(seq) and INSERT.
 */
export async function appendLogEntry(input: AppendLogEntryInput): Promise<LogEntry> {
  const hash = hashPayload(input.payload);

  const r = await dataService.one<LogEntry>(
    `INSERT INTO agents.execution_log_entry (run_id, seq, kind, content_hash, payload_envelope)
     VALUES (
       $1,
       COALESCE(
         (SELECT MAX(seq) + 1 FROM agents.execution_log_entry WHERE run_id = $1),
         0
       ),
       $2, $3, $4
     )
     RETURNING entry_id, run_id, seq, kind, content_hash, recorded_at`,
    [input.run_id, input.kind, hash, input.payload_envelope],
  );
  if (!r) throw new Error('[execution-log] append failed');
  return r;
}

/**
 * Reads the full log for a run in seq order. Used by the replay engine
 * (TK-3278 REST endpoint) and by any auditor reproducing a past decision.
 */
export async function readLog(run_id: string): Promise<LogEntry[]> {
  const r = await dataService.query<LogEntry>(
    `SELECT entry_id, run_id, seq, kind, content_hash, recorded_at
       FROM agents.execution_log_entry
      WHERE run_id = $1
      ORDER BY seq ASC`,
    [run_id],
  );
  return r.rows;
}

interface LogEntryWithEnvelope extends LogEntry {
  payload_envelope: Buffer;
}

export async function readLogWithEnvelopes(run_id: string): Promise<LogEntryWithEnvelope[]> {
  const r = await dataService.query<LogEntryWithEnvelope>(
    `SELECT entry_id, run_id, seq, kind, content_hash, payload_envelope, recorded_at
       FROM agents.execution_log_entry
      WHERE run_id = $1
      ORDER BY seq ASC`,
    [run_id],
  );
  return r.rows;
}
