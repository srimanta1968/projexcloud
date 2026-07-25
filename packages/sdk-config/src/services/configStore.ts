import { dataService } from '@projexlight/db-runtime';
import type { ConfigScope, ConfigValueRef } from '../index';
import { invalidateConfig } from './resolveConfig';

/**
 * config.config_value CRUD (EP-341). setConfig upserts on the
 * (scope, scope_id, key) unique key; a non-secret value goes inline in `value`,
 * a secret keeps only its sdk-secrets envelope pointer in `secret_ref`. revoke
 * is a soft delete (status='revoked') so resolution stops without losing the
 * audit trail; rotate swaps a secret_ref in place. All writes bump updated_at.
 */

const COLS = `config_id, scope, scope_id, key, value, secret_ref, status, set_by, created_at, updated_at`;

function normScopeId(scope: ConfigScope, scope_id?: string | null): string {
  // platform is global — its scope_id is always '' so the unique key is stable.
  if (scope === 'platform') return '';
  return scope_id ?? '';
}

export interface SetConfigInput {
  scope: ConfigScope;
  scope_id?: string | null;
  key: string;
  /** Non-secret JSON value. Mutually exclusive with secret_ref. */
  value?: Record<string, unknown> | null;
  /** sdk-secrets envelope pointer for a secret value. */
  secret_ref?: string | null;
  set_by?: string | null;
}

export async function setConfig(input: SetConfigInput): Promise<ConfigValueRef> {
  const scope_id = normScopeId(input.scope, input.scope_id);
  const row = await dataService.one<ConfigValueRef>(
    `INSERT INTO config.config_value (scope, scope_id, key, value, secret_ref, status, set_by)
     VALUES ($1, $2, $3, $4::jsonb, $5, 'active', $6)
     ON CONFLICT (scope, scope_id, key) DO UPDATE
       SET value = EXCLUDED.value, secret_ref = EXCLUDED.secret_ref,
           status = 'active', set_by = EXCLUDED.set_by
     RETURNING ${COLS}`,
    [
      input.scope,
      scope_id,
      input.key,
      input.value != null ? JSON.stringify(input.value) : null,
      input.secret_ref ?? null,
      input.set_by ?? null,
    ],
  );
  if (!row) throw new Error('[sdk-config] setConfig upsert failed');
  invalidateConfig(input.key);
  return row;
}

export async function getConfig(
  scope: ConfigScope,
  scope_id: string | null,
  key: string,
): Promise<ConfigValueRef | null> {
  return dataService.one<ConfigValueRef>(
    `SELECT ${COLS} FROM config.config_value
      WHERE scope = $1 AND scope_id = $2 AND key = $3`,
    [scope, normScopeId(scope, scope_id), key],
  );
}

export async function listConfig(
  scope: ConfigScope,
  scope_id: string | null,
): Promise<ConfigValueRef[]> {
  return dataService.rows<ConfigValueRef>(
    `SELECT ${COLS} FROM config.config_value
      WHERE scope = $1 AND scope_id = $2 AND status = 'active'
      ORDER BY key`,
    [scope, normScopeId(scope, scope_id)],
  );
}

/** Soft-delete: stop resolving this (scope, scope_id, key) without dropping the row. */
export async function revokeConfig(
  scope: ConfigScope,
  scope_id: string | null,
  key: string,
  set_by?: string | null,
): Promise<ConfigValueRef | null> {
  const row = await dataService.one<ConfigValueRef>(
    `UPDATE config.config_value
        SET status = 'revoked', set_by = COALESCE($4, set_by)
      WHERE scope = $1 AND scope_id = $2 AND key = $3
    RETURNING ${COLS}`,
    [scope, normScopeId(scope, scope_id), key, set_by ?? null],
  );
  invalidateConfig(key);
  return row;
}

/** Swap a secret's envelope pointer in place (re-activates if revoked). */
export async function rotateConfigSecret(
  scope: ConfigScope,
  scope_id: string | null,
  key: string,
  new_secret_ref: string,
  set_by?: string | null,
): Promise<ConfigValueRef | null> {
  const row = await dataService.one<ConfigValueRef>(
    `UPDATE config.config_value
        SET secret_ref = $4, value = NULL, status = 'active', set_by = COALESCE($5, set_by)
      WHERE scope = $1 AND scope_id = $2 AND key = $3
    RETURNING ${COLS}`,
    [scope, normScopeId(scope, scope_id), key, new_secret_ref, set_by ?? null],
  );
  invalidateConfig(key);
  return row;
}
