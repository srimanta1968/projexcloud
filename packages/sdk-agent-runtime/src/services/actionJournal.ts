import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';

/**
 * Action journal + rollback engine (AC-8 / FR-ART-20).
 *
 * Every state-changing agent action writes a row to agents.action_journal
 * (table from migration 003). The rollback engine reads those rows in
 * reverse step_seq order down to `to_seq`, invokes the registered
 * compensation handler for each, and marks the journal entry rolled_back_at.
 *
 * Compensation handlers are pluggable per action_type so sdk-payment,
 * sdk-crm, sdk-mcp-bridge etc. can register their own undo logic. The
 * engine emits agent.run.rolled-back.v1 (regulated retention) with the
 * full summary.
 */

const AGENT_AUDIT_POOL = process.env.AGENT_RUNTIME_AUDIT_POOL || 'admin-default';

export interface JournalAppendInput {
  run_id: string;
  step_seq: number;
  action_type: string;
  args_envelope: Buffer;
  undo_payload: Buffer;
  compensation_step_id?: string;
}

export interface JournalEntry {
  entry_id: string;
  run_id: string;
  step_seq: number;
  action_type: string;
  args_envelope: Buffer;
  undo_payload: Buffer;
  compensation_step_id: string | null;
  rolled_back_at: Date | null;
  recorded_at: Date;
}

export async function appendJournalEntry(input: JournalAppendInput): Promise<JournalEntry> {
  const r = await dataService.one<JournalEntry>(
    `INSERT INTO agents.action_journal
       (run_id, step_seq, action_type, args_envelope, undo_payload, compensation_step_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING entry_id, run_id, step_seq, action_type, args_envelope, undo_payload,
               compensation_step_id, rolled_back_at, recorded_at`,
    [
      input.run_id,
      input.step_seq,
      input.action_type,
      input.args_envelope,
      input.undo_payload,
      input.compensation_step_id ?? null,
    ],
  );
  if (!r) throw new Error('[action-journal] append failed');
  return r;
}

export interface CompensationContext {
  run_id: string;
  entry_id: string;
  step_seq: number;
  action_type: string;
  undo_payload: Buffer;
  compensation_step_id: string | null;
}

export type CompensationHandler = (ctx: CompensationContext) => Promise<void>;

const handlers = new Map<string, CompensationHandler>();

/**
 * Register a per-action_type compensation handler. The rollback engine
 * looks up by exact match; missing handlers cause the rollback to skip
 * the entry (with a warning) rather than fail the whole rollback —
 * a partial undo is better than no undo when forensic replay is the goal.
 */
export function registerCompensationHandler(
  action_type: string,
  handler: CompensationHandler,
): void {
  handlers.set(action_type, handler);
}

export function unregisterCompensationHandler(action_type: string): void {
  handlers.delete(action_type);
}

export interface RollbackStepResult {
  entry_id: string;
  step_seq: number;
  action_type: string;
  outcome: 'rolled_back' | 'skipped_no_handler' | 'failed';
  error?: string;
}

export interface RollbackSummary {
  run_id: string;
  to_seq: number;
  attempted: number;
  rolled_back: number;
  skipped: number;
  failed: number;
  steps: RollbackStepResult[];
}

export interface RollbackInput {
  run_id: string;
  /** Rollback every entry with step_seq > to_seq. Default -1 (everything). */
  to_seq?: number;
  /** Who initiated the rollback; written to action_journal.rolled_back_by. */
  actor_id: string;
}

/**
 * Replay the journal in reverse from latest down to `to_seq`, invoking
 * each compensation handler. The full per-step result is returned for
 * forensics + UI. Emits agent.run.rolled-back.v1 audit with the summary.
 */
export async function rollbackRun(input: RollbackInput): Promise<RollbackSummary> {
  const toSeq = input.to_seq ?? -1;

  const entries = await dataService.query<JournalEntry>(
    `SELECT entry_id, run_id, step_seq, action_type, args_envelope, undo_payload,
            compensation_step_id, rolled_back_at, recorded_at
       FROM agents.action_journal
      WHERE run_id = $1
        AND step_seq > $2
        AND rolled_back_at IS NULL
      ORDER BY step_seq DESC`,
    [input.run_id, toSeq],
  );

  const summary: RollbackSummary = {
    run_id: input.run_id,
    to_seq: toSeq,
    attempted: entries.rows.length,
    rolled_back: 0,
    skipped: 0,
    failed: 0,
    steps: [],
  };

  for (const entry of entries.rows) {
    const handler = handlers.get(entry.action_type);
    if (!handler) {
      summary.steps.push({
        entry_id: entry.entry_id,
        step_seq: entry.step_seq,
        action_type: entry.action_type,
        outcome: 'skipped_no_handler',
      });
      summary.skipped += 1;
      continue;
    }
    try {
      await handler({
        run_id: entry.run_id,
        entry_id: entry.entry_id,
        step_seq: entry.step_seq,
        action_type: entry.action_type,
        undo_payload: entry.undo_payload,
        compensation_step_id: entry.compensation_step_id,
      });
      await dataService.query(
        `UPDATE agents.action_journal
            SET rolled_back_at = now(), rolled_back_by = $2
          WHERE entry_id = $1`,
        [entry.entry_id, input.actor_id],
      );
      summary.steps.push({
        entry_id: entry.entry_id,
        step_seq: entry.step_seq,
        action_type: entry.action_type,
        outcome: 'rolled_back',
      });
      summary.rolled_back += 1;
    } catch (handlerErr) {
      summary.steps.push({
        entry_id: entry.entry_id,
        step_seq: entry.step_seq,
        action_type: entry.action_type,
        outcome: 'failed',
        error: (handlerErr as Error).message,
      });
      summary.failed += 1;
      // Continue the loop — partial rollback is allowed; the audit summary
      // captures every per-step outcome for forensics.
    }
  }

  try {
    const runOwner = await dataService.one<{ tenant_id: string | null }>(
      `SELECT tenant_id FROM agents.agent_run WHERE run_id = $1`,
      [input.run_id],
    );
    await appendAuditEntry({
      pool_index: AGENT_AUDIT_POOL,
      event_type: 'agent.run.rolled-back.v1',
      actor_kind: 'human',
      actor_id: input.actor_id,
      tenant_id: runOwner?.tenant_id ?? null,
      subject_kind: 'agent.agent_run',
      subject_id: input.run_id,
      retention_class: 'regulated',
      payload: {
        to_seq: toSeq,
        attempted: summary.attempted,
        rolled_back: summary.rolled_back,
        skipped: summary.skipped,
        failed: summary.failed,
      },
    });
  } catch (auditErr) {
    console.error(
      '[action-journal] audit emit failed for rollback of run',
      input.run_id,
      (auditErr as Error).message,
    );
  }

  return summary;
}
