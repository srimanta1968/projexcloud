import crypto from 'crypto';
import { dataService } from '@projexlight/db-runtime';
import { assertRegisteredEventType } from '@projexlight/contracts';

export type ActorKind = 'human' | 'service' | 'agent';
export type RetentionClass = 'transient' | 'operational' | 'regulated';

export interface AppendInput {
  pool_index: string;
  event_type: string;
  payload: unknown;
  occurred_at?: Date;
  actor_kind?: ActorKind;
  actor_id: string;
  tenant_id?: string | null;
  org_id?: string | null;
  app_id?: string | null;
  bu_id?: string | null;
  subject_kind?: string | null;
  subject_id?: string | null;
  retention_class?: RetentionClass;
}

export interface LedgerEntry {
  entry_id: string;
  pool_index: string;
  seq: number;
  event_type: string;
  occurred_at: Date;
  recorded_at: Date;
  actor_kind: ActorKind;
  actor_id: string;
  tenant_id: string | null;
  org_id: string | null;
  app_id: string | null;
  bu_id: string | null;
  subject_kind: string | null;
  subject_id: string | null;
  payload: unknown;
  prev_hash: Buffer | null;
  entry_hash: Buffer;
  retention_class: RetentionClass;
  expires_at: Date | null;
  archived_to_s3: boolean;
}

const RETENTION_DAYS: Record<RetentionClass, number | null> = {
  transient: 7,
  operational: 90,
  regulated: 365 * 7,
};

function computeExpiresAt(retention_class: RetentionClass, occurred_at: Date): Date | null {
  const days = RETENTION_DAYS[retention_class];
  if (days == null) return null;
  return new Date(occurred_at.getTime() + days * 86_400_000);
}

function hashEntry(parts: {
  prev_hash: Buffer | null;
  pool_index: string;
  seq: number;
  event_type: string;
  payload: unknown;
  actor_kind: ActorKind;
  actor_id: string;
  tenant_id: string | null;
  occurred_at: Date;
}): Buffer {
  const canonical = JSON.stringify({
    prev_hash: parts.prev_hash ? parts.prev_hash.toString('hex') : null,
    pool_index: parts.pool_index,
    seq: parts.seq,
    event_type: parts.event_type,
    payload: parts.payload,
    actor_kind: parts.actor_kind,
    actor_id: parts.actor_id,
    tenant_id: parts.tenant_id,
    occurred_at: parts.occurred_at.toISOString(),
  });
  return crypto.createHash('sha256').update(canonical).digest();
}

/**
 * Appends a new entry to the per-pool chain. Updates `audit.chain_head` in the
 * same transaction. Per P1-Foundation-Spine §7.
 */
export async function appendAuditEntry(input: AppendInput): Promise<LedgerEntry> {
  // FR-AUD-5 / AC-16: producer-side EventTypeRegistry enforcement.
  // Throws UnregisteredEventTypeError before any write hits the chain.
  assertRegisteredEventType(input.event_type);

  const occurred_at = input.occurred_at ?? new Date();
  const retention_class: RetentionClass = input.retention_class ?? 'operational';
  const actor_kind: ActorKind = input.actor_kind ?? 'service';
  const expires_at = computeExpiresAt(retention_class, occurred_at);

  try {
    const head = await dataService.one<{ head_seq: string; head_hash: Buffer | null }>(
      `SELECT head_seq, head_hash FROM audit.chain_head WHERE pool_index = $1 FOR UPDATE`,
      [input.pool_index],
    );
    const prevSeq = head ? Number(head.head_seq) : 0;
    const seq = prevSeq + 1;
    const prevHash: Buffer | null = head?.head_hash ?? null;

    const entryHash = hashEntry({
      prev_hash: prevHash,
      pool_index: input.pool_index,
      seq,
      event_type: input.event_type,
      payload: input.payload,
      actor_kind,
      actor_id: input.actor_id,
      tenant_id: input.tenant_id ?? null,
      occurred_at,
    });

    const rows = await dataService.rows<LedgerEntry>(
      `INSERT INTO audit.entry (
         pool_index, seq, event_type, occurred_at, actor_kind, actor_id,
         tenant_id, org_id, app_id, bu_id, subject_kind, subject_id,
         payload, prev_hash, entry_hash, retention_class, expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17)
       RETURNING entry_id, pool_index, seq, event_type, occurred_at, recorded_at,
                 actor_kind, actor_id, tenant_id, org_id, app_id, bu_id,
                 subject_kind, subject_id, payload, prev_hash, entry_hash,
                 retention_class, expires_at, archived_to_s3`,
      [
        input.pool_index, seq, input.event_type, occurred_at, actor_kind, input.actor_id,
        input.tenant_id ?? null, input.org_id ?? null, input.app_id ?? null, input.bu_id ?? null,
        input.subject_kind ?? null, input.subject_id ?? null,
        JSON.stringify(input.payload ?? {}), prevHash, entryHash,
        retention_class, expires_at,
      ],
    );
    const entry = rows[0];

    await dataService.query(
      `INSERT INTO audit.chain_head (pool_index, head_entry_id, head_seq, head_hash)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (pool_index) DO UPDATE
         SET head_entry_id = EXCLUDED.head_entry_id,
             head_seq = EXCLUDED.head_seq,
             head_hash = EXCLUDED.head_hash`,
      [input.pool_index, entry.entry_id, seq, entryHash],
    );

    return entry;
  } catch (err) {
    throw err;
  }
}
