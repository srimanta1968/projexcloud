import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import type { KeyAlgorithm, KeyRecord, KeyTier } from '../models/keyHierarchy.model';

const VAULT_AUDIT_POOL = process.env.VAULT_AUDIT_POOL || 'admin-default';
const VAULT_AUDIT_TENANT = process.env.VAULT_AUDIT_TENANT || null;

export interface IssueKeyInput {
  tier: KeyTier;
  scope_id?: string | null;
  parent_key_id?: string | null;
  kms_ref: string;
  algorithm?: KeyAlgorithm;
  tenant_id?: string | null;
  region: string;
}

export interface OperatorContext {
  kind: 'human' | 'service' | 'agent';
  id: string;
}

const OP_TO_EVENT_TYPE: Record<'issue' | 'rotate' | 'shred', string> = {
  issue: 'vault.key.issued.v1',
  rotate: 'vault.key.rotated.v1',
  shred: 'vault.key.shredded.v1',
};

async function logOperation(
  key_id: string,
  op: 'issue' | 'rotate' | 'shred' | 'encrypt' | 'decrypt',
  operator: OperatorContext,
  reason?: string | null,
): Promise<void> {
  try {
    // FR-SEC-5 + P1 §6.4: every key op is recorded twice — locally in
    // vault.key_operation for fast tier history, and globally in audit.entry
    // for the tamper-evident chain (only for issue/rotate/shred — the high-value
    // ops that go in the registered event registry).
    const opResult = await dataService.one<{ op_id: string }>(
      `INSERT INTO vault.key_operation (key_id, op, operator_kind, operator_id, reason)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING op_id`,
      [key_id, op, operator.kind, operator.id, reason ?? null],
    );

    if (op === 'issue' || op === 'rotate' || op === 'shred') {
      try {
        const entry = await appendAuditEntry({
          pool_index: VAULT_AUDIT_POOL,
          event_type: OP_TO_EVENT_TYPE[op],
          actor_kind: operator.kind === 'service' ? 'service' : operator.kind === 'agent' ? 'agent' : 'human',
          actor_id: operator.id,
          tenant_id: VAULT_AUDIT_TENANT,
          subject_kind: 'vault.key',
          subject_id: key_id,
          retention_class: 'regulated',
          payload: { op, reason: reason ?? null },
        });
        // Backfill the cross-reference for verifier joins.
        if (opResult?.op_id) {
          await dataService.query(
            `UPDATE vault.key_operation SET audit_entry_id = $1 WHERE op_id = $2`,
            [entry.entry_id, opResult.op_id],
          );
        }
      } catch (auditErr) {
        // Audit failure does not roll back the key op — vault.key_operation is
        // the local source of truth and audit chain is a separate concern.
        console.error('[vault] audit emit failed for key op', op, key_id, (auditErr as Error).message);
      }
    }
  } catch (err) {
    throw err;
  }
}

/**
 * Issues a new key at the given tier. Per P1-Foundation-Spine §6: writes the
 * vault.key row and an `issue` row in vault.key_operation. Parent-tier validity
 * is enforced by the DB trigger; this layer surfaces the resulting error.
 */
export async function issueKey(input: IssueKeyInput, operator: OperatorContext): Promise<KeyRecord> {
  try {
    const rows = await dataService.rows<KeyRecord>(
      `INSERT INTO vault.key (tier, scope_id, parent_key_id, kms_ref, algorithm, tenant_id, region, state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
       RETURNING key_id, tier, scope_id, parent_key_id, kms_ref, state, algorithm,
                 issued_at, rotated_at, shredded_at, tenant_id, region`,
      [
        input.tier,
        input.scope_id ?? null,
        input.parent_key_id ?? null,
        input.kms_ref,
        input.algorithm ?? 'AES-256-GCM',
        input.tenant_id ?? null,
        input.region,
      ],
    );
    const key = rows[0];
    await logOperation(key.key_id, 'issue', operator);
    return key;
  } catch (err) {
    throw err;
  }
}

/** kms_ref of the canonical platform root, created by migration 004. */
const PLATFORM_ROOT_KMS_REF = 'platform-root-v1';

/**
 * Returns the tenant's active tenant-tier key, creating it if it does not exist.
 *
 * WHY THIS LIVES IN VAULT, and why it is create-on-demand rather than a hook on
 * tenant creation:
 *
 *  - The row is vault's, under vault's tier hierarchy and its parent-tier trigger.
 *    Having identity create it would push vault's domain rules into the foundation
 *    identity SDK.
 *  - A `tenant.created` event hook cannot carry the guarantee: emitEvent SWALLOWS
 *    failures by design, so a dropped provisioning would turn a universal
 *    VaultKeyMissing into an intermittent one — strictly harder to diagnose.
 *  - Existing tenants need a backfill regardless (migration 004). Calling the same
 *    function lazily covers new tenants too, so ONE mechanism serves both instead of
 *    two that must agree.
 *  - It cannot miss a tenant-creation path. signup-tenant is one way a tenant comes
 *    into existence; admin creation and SCIM provisioning are others, and any future
 *    path is covered without being told about this.
 *
 * CONCURRENCY is handled by the database, not a lock: migration 004 adds a unique
 * partial index on (scope_id) WHERE tier='tenant' AND state='active', so two racing
 * first-uploads cannot both win — the loser's insert conflicts and it re-reads the
 * winner's row.
 *
 * Creation is AUDITED. A vault that mints key material with no operation row is not
 * auditable, so this goes through the same logOperation path as an explicit issue.
 */
export async function ensureTenantKey(
  tenant_id: string,
  region: string,
  operator: OperatorContext = { kind: 'service', id: 'sdk-vault.ensureTenantKey' },
): Promise<KeyRecord> {
  const existing = await dataService.one<KeyRecord>(
    `SELECT key_id, tier, scope_id, parent_key_id, kms_ref, state, algorithm,
            issued_at, rotated_at, shredded_at, tenant_id, region
       FROM vault.key
      WHERE tier = 'tenant' AND scope_id = $1 AND state = 'active'
      LIMIT 1`,
    [tenant_id],
  );
  if (existing) return existing;

  // The parent must be a strictly higher tier (key_check_parent_tier) and a
  // non-root key cannot be parentless (key_nonroot_parent). Migration 004 creates
  // this root; recreate it here so a tenant provisioned before that migration on a
  // fresh install still resolves a parent rather than failing the constraint.
  const root = await dataService.one<{ key_id: string }>(
    `INSERT INTO vault.key (tier, kms_ref, region, state, algorithm)
     SELECT 'root', $1, $2, 'active', 'AES-256-GCM'
      WHERE NOT EXISTS (SELECT 1 FROM vault.key WHERE tier = 'root' AND kms_ref = $1)
     RETURNING key_id`,
    [PLATFORM_ROOT_KMS_REF, region],
  );
  const rootId = root?.key_id ?? (
    await dataService.one<{ key_id: string }>(
      `SELECT key_id FROM vault.key WHERE tier = 'root' AND kms_ref = $1
        ORDER BY issued_at LIMIT 1`,
      [PLATFORM_ROOT_KMS_REF],
    )
  )?.key_id;
  if (!rootId) {
    throw new Error('[sdk-vault] no platform root key available to parent the tenant key');
  }

  const inserted = await dataService.one<KeyRecord>(
    `INSERT INTO vault.key (tier, scope_id, parent_key_id, kms_ref, region, state, algorithm, tenant_id)
     VALUES ('tenant', $1, $2, $3, $4, 'active', 'AES-256-GCM', $1::uuid)
     ON CONFLICT DO NOTHING
     RETURNING key_id, tier, scope_id, parent_key_id, kms_ref, state, algorithm,
               issued_at, rotated_at, shredded_at, tenant_id, region`,
    [tenant_id, rootId, `platform-tenant-${tenant_id}`, region],
  );

  if (inserted) {
    await logOperation(inserted.key_id, 'issue', operator, 'auto-provisioned on first use');
    return inserted;
  }

  // ON CONFLICT fired: a concurrent caller won the unique index. Its row is the
  // one every envelope will be written under, so return that rather than retrying.
  const winner = await dataService.one<KeyRecord>(
    `SELECT key_id, tier, scope_id, parent_key_id, kms_ref, state, algorithm,
            issued_at, rotated_at, shredded_at, tenant_id, region
       FROM vault.key
      WHERE tier = 'tenant' AND scope_id = $1 AND state = 'active'
      LIMIT 1`,
    [tenant_id],
  );
  if (!winner) {
    throw new Error(`[sdk-vault] could not provision or read a tenant key for ${tenant_id}`);
  }
  return winner;
}

/**
 * Rotates a key: sets state=rotated and rotated_at=now(). The new key material
 * comes from KMS via the caller's rotation flow; this layer only updates the
 * registry and writes a `rotate` operation row.
 */
export async function rotateKey(key_id: string, operator: OperatorContext, reason?: string): Promise<KeyRecord> {
  try {
    const rows = await dataService.rows<KeyRecord>(
      `UPDATE vault.key
          SET state = 'rotated', rotated_at = now()
        WHERE key_id = $1 AND state IN ('issued', 'active')
        RETURNING key_id, tier, scope_id, parent_key_id, kms_ref, state, algorithm,
                  issued_at, rotated_at, shredded_at, tenant_id, region`,
      [key_id],
    );
    if (rows.length === 0) {
      throw new Error(`Key ${key_id} not found or not in a rotatable state`);
    }
    await logOperation(key_id, 'rotate', operator, reason);
    return rows[0];
  } catch (err) {
    throw err;
  }
}

/**
 * Cryptographic-shred per P1-Foundation-Spine §6.3: sets state=shredded,
 * clears kms_ref (the trigger then deletes the KMS-side material out-of-band),
 * and stamps shredded_at. After this returns, every ciphertext wrapped under
 * this key is unrecoverable.
 */
export async function shredKey(key_id: string, operator: OperatorContext, reason: string): Promise<KeyRecord> {
  try {
    const rows = await dataService.rows<KeyRecord>(
      `UPDATE vault.key
          SET state = 'shredded', shredded_at = now(), kms_ref = NULL
        WHERE key_id = $1 AND state <> 'shredded'
        RETURNING key_id, tier, scope_id, parent_key_id, kms_ref, state, algorithm,
                  issued_at, rotated_at, shredded_at, tenant_id, region`,
      [key_id],
    );
    if (rows.length === 0) {
      throw new Error(`Key ${key_id} not found or already shredded`);
    }
    await logOperation(key_id, 'shred', operator, reason);
    return rows[0];
  } catch (err) {
    throw err;
  }
}

/**
 * Lists keys due for rotation per a max-age policy. Used by the rotation
 * scheduler. Returns keys with state='active' whose issued_at is older than
 * `max_age_days`.
 */
export async function listKeysDueForRotation(max_age_days: number): Promise<KeyRecord[]> {
  try {
    return await dataService.rows<KeyRecord>(
      `SELECT key_id, tier, scope_id, parent_key_id, kms_ref, state, algorithm,
              issued_at, rotated_at, shredded_at, tenant_id, region
         FROM vault.key
        WHERE state = 'active'
          AND issued_at < now() - ($1::text || ' days')::interval
          AND tier IN ('tenant','person','device','encounter')`,
      [String(max_age_days)],
    );
  } catch (err) {
    throw err;
  }
}
