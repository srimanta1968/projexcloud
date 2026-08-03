import { dataService } from '@projexlight/db-runtime';
import { emitEvent } from '@projexlight/sdk-audit';
import { publish } from '@projexlight/redis-runtime';
import { cacheEvict } from './keyCache';
import { API_KEY_REVOKE_CHANNEL } from './apiKeyService';
import {
  APPLICATION_COLUMNS,
  KEY_COLUMNS,
  type ApplicationRecord,
  type ApiKeyRecord,
  type CreateApplicationInput,
} from '../models/apiKey.model';

/**
 * Tenant applications — the thing a credential belongs to.
 *
 * A tenant runs several things against the platform (a web backend, a nightly
 * job, a staging copy), and giving them one shared key means a leak forces all
 * of them to rotate together, nothing can be attributed to the caller that did
 * it, and least privilege is impossible because the key must hold the union of
 * every caller's scopes. One application, one credential, one blast radius.
 */

export class SlugConflictError extends Error {
  constructor(public readonly slug: string) {
    super(`An application with slug '${slug}' already exists in this tenant`);
    this.name = 'SlugConflictError';
  }
}

/** URL/config-safe, stable, and what a customer types as client_id. */
export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  // A name of only punctuation would otherwise yield an empty slug, which would
  // collide with every other such name in the tenant.
  return base || 'app';
}

export async function createApplication(input: CreateApplicationInput): Promise<ApplicationRecord> {
  const slug = slugify(input.slug || input.name);
  const rows = await dataService.rows<ApplicationRecord>(
    `INSERT INTO api_keys.application (
        tenant_id, name, slug, description, environment, owner_persona_id, created_by_persona_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (tenant_id, slug) DO NOTHING
     RETURNING ${APPLICATION_COLUMNS}`,
    [
      input.tenant_id,
      input.name,
      slug,
      input.description ?? null,
      input.environment ?? 'live',
      input.owner_persona_id ?? null,
      input.created_by_persona_id ?? null,
    ],
  );
  // DO NOTHING returns no row on conflict, which is the collision case. Raised
  // as a typed error so the route answers 409 rather than a bare 500.
  if (rows.length === 0) throw new SlugConflictError(slug);
  const app = rows[0];
  await emitEvent({
    event_type: 'api-key.application.created.v1',
    payload: {
      application_id: app.application_id,
      tenant_id: app.tenant_id,
      slug: app.slug,
      environment: app.environment,
    },
    pool_index: 'admin',
    actor_kind: 'service',
    actor_id: 'sdk-api-keys.application.create',
    tenant_id: app.tenant_id,
    subject_kind: 'api-key-application',
    subject_id: app.application_id,
  });
  return app;
}

export async function listApplications(tenant_id: string): Promise<ApplicationRecord[]> {
  return dataService.rows<ApplicationRecord>(
    `SELECT ${APPLICATION_COLUMNS} FROM api_keys.application
      WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [tenant_id],
  );
}

/**
 * Reads one application. Tenant-constrained, and returns null for both "no such
 * application" and "belongs to someone else" so the caller cannot distinguish.
 */
export async function getApplication(
  application_id: string,
  tenant_id: string,
): Promise<ApplicationRecord | null> {
  return dataService.one<ApplicationRecord>(
    `SELECT ${APPLICATION_COLUMNS} FROM api_keys.application
      WHERE application_id = $1 AND tenant_id = $2`,
    [application_id, tenant_id],
  );
}

/** Accepts a slug OR a uuid, because client_id may legitimately be either. */
export async function findApplicationByClientId(
  client_id: string,
  tenant_id?: string,
): Promise<ApplicationRecord | null> {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(client_id);
  const where = isUuid ? 'application_id = $1::uuid' : 'slug = $1';
  const params: unknown[] = [client_id];
  let sql = `SELECT ${APPLICATION_COLUMNS} FROM api_keys.application WHERE ${where}`;
  if (tenant_id) {
    sql += ' AND tenant_id = $2';
    params.push(tenant_id);
  }
  return dataService.one<ApplicationRecord>(sql, params);
}

export async function updateApplication(
  application_id: string,
  tenant_id: string,
  patch: { name?: string; description?: string; owner_persona_id?: string },
): Promise<ApplicationRecord | null> {
  return dataService.one<ApplicationRecord>(
    `UPDATE api_keys.application
        SET name = COALESCE($3, name),
            description = COALESCE($4, description),
            owner_persona_id = COALESCE($5, owner_persona_id)
      WHERE application_id = $1 AND tenant_id = $2
      RETURNING ${APPLICATION_COLUMNS}`,
    [
      application_id,
      tenant_id,
      patch.name ?? null,
      patch.description ?? null,
      patch.owner_persona_id ?? null,
    ],
  );
}

/**
 * Disables an application AND revokes every key it owns, in one transaction.
 *
 * Doing these separately would leave a window — and, on a failure between them,
 * a permanent state — where an application an operator believes they switched
 * off still has live credentials calling the platform. The atomicity is the
 * point of the operation, not an implementation detail.
 */
export async function disableApplication(
  application_id: string,
  tenant_id: string,
): Promise<{ application: ApplicationRecord; revoked: ApiKeyRecord[] } | null> {
  const result = await dataService.tx(async (q) => {
    const appRes = await q<ApplicationRecord>(
      `UPDATE api_keys.application
          SET status = 'disabled', disabled_at = now()
        WHERE application_id = $1 AND tenant_id = $2 AND status <> 'disabled'
        RETURNING ${APPLICATION_COLUMNS}`,
      [application_id, tenant_id],
    );
    if (appRes.rowCount === 0) return null;

    const keyRes = await q<ApiKeyRecord>(
      `UPDATE api_keys.key
          SET status = 'revoked', revoked_at = now()
        WHERE application_id = $1 AND tenant_id = $2 AND status <> 'revoked'
        RETURNING ${KEY_COLUMNS}`,
      [application_id, tenant_id],
    );
    return { application: appRes.rows[0], revoked: keyRes.rows };
  });

  if (!result) return null;

  // Evict here AND broadcast, so peers drop the credentials too — a disable
  // that only takes effect on the replica that served it is not a disable.
  for (const key of result.revoked) {
    cacheEvict(key.key_id);
    try {
      await publish(
        API_KEY_REVOKE_CHANNEL,
        JSON.stringify({ key_id: key.key_id, prefix: key.prefix, tenant_id: key.tenant_id }),
      );
    } catch {
      // No Redis in this process: local eviction stands, peers fail closed on
      // their next database read once their short TTL lapses.
    }
  }
  await emitEvent({
    event_type: 'api-key.application.disabled.v1',
    payload: {
      application_id: result.application.application_id,
      tenant_id: result.application.tenant_id,
      revoked_key_ids: result.revoked.map((k) => k.key_id),
    },
    pool_index: 'admin',
    actor_kind: 'service',
    actor_id: 'sdk-api-keys.application.disable',
    tenant_id: result.application.tenant_id,
    subject_kind: 'api-key-application',
    subject_id: result.application.application_id,
  });
  return result;
}
