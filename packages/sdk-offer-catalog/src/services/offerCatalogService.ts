import { dataService } from '@projexlight/db-runtime';
import { emitEvent } from '@projexlight/sdk-audit';

/**
 * @projexlight/sdk-offer-catalog — publish / activate / resolve-current (P15·E1, TK-3641).
 *
 * activateOfferVersion atomically demotes the prior live version (-> retired) and promotes
 * the target version (-> live, activated_at now), emitting an audit event. resolveCurrent
 * returns the live version for the tenant, with a fallback chain (live -> beta -> most
 * recent draft) so a caller always gets the best-available truth. Cloned from
 * sdk-taxonomy's activate/lookup. Offers are immutable-versioned (never updated in place).
 */

export interface OfferRow {
  offer_id: string; tenant_id: string; name: string; slug: string; description: string | null;
  owner_persona_id: string | null; created_at: string;
}
export interface OfferVersionRow {
  offer_version_id: string; tenant_id: string; offer_id: string; version: string; status: string;
  parent_version_id: string | null; title: string | null; price: string | null; currency: string | null;
  activated_at: string | null; created_at: string;
}

const OFFER_COLS = `offer_id, tenant_id, name, slug, description, owner_persona_id, created_at`;
const VER_COLS = `offer_version_id, tenant_id, offer_id, version, status, parent_version_id, title, price, currency, activated_at, created_at`;

/* ------------------------------------------------------------------- offers */

export interface CreateOfferInput {
  tenantId: string; name: string; slug: string; description?: string; ownerPersonaId?: string;
}
/** Create a stable offer identity (content lives in immutable versions). */
export async function createOffer(input: CreateOfferInput): Promise<OfferRow> {
  const rows = await dataService.rows<OfferRow>(
    `INSERT INTO offer_catalog.offer (tenant_id, name, slug, description, owner_persona_id)
     VALUES ($1,$2,$3,$4,$5) RETURNING ${OFFER_COLS}`,
    [input.tenantId, input.name, input.slug, input.description ?? null, input.ownerPersonaId ?? null],
  );
  return rows[0];
}

export async function getOffer(tenantId: string, offerId: string): Promise<OfferRow | null> {
  return dataService.one<OfferRow>(
    `SELECT ${OFFER_COLS} FROM offer_catalog.offer WHERE tenant_id = $1 AND offer_id = $2`,
    [tenantId, offerId],
  );
}

/* ---------------------------------------------------------------- versions */

export interface CreateVersionInput {
  tenantId: string; offerId: string; version: string; title?: string;
  price?: number; currency?: string; parentVersionId?: string; createdByPersonaId?: string;
  body?: Record<string, unknown>;
}
/** Create an immutable offer version (starts in 'draft'). */
export async function createOfferVersion(input: CreateVersionInput): Promise<OfferVersionRow> {
  const rows = await dataService.rows<OfferVersionRow>(
    `INSERT INTO offer_catalog.offer_version
       (tenant_id, offer_id, version, title, price, currency, parent_version_id, created_by_persona_id, body)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING ${VER_COLS}`,
    [input.tenantId, input.offerId, input.version, input.title ?? null, input.price ?? null,
     input.currency ?? null, input.parentVersionId ?? null, input.createdByPersonaId ?? null,
     JSON.stringify(input.body ?? {})],
  );
  return rows[0];
}

export async function getOfferVersion(tenantId: string, versionId: string): Promise<OfferVersionRow | null> {
  return dataService.one<OfferVersionRow>(
    `SELECT ${VER_COLS} FROM offer_catalog.offer_version WHERE tenant_id = $1 AND offer_version_id = $2`,
    [tenantId, versionId],
  );
}

/** Raised when an offer/version id doesn't resolve for the tenant. */
export class OfferVersionNotFoundError extends Error {
  constructor() { super('OFFER_VERSION_NOT_FOUND'); this.name = 'OfferVersionNotFoundError'; }
}

/**
 * Activate a version: atomically demote the prior live version for this offer (-> retired)
 * and promote the target (-> live, activated_at). Emits offer_catalog.version.activated.v1.
 * Runs in one transaction so at most one live version ever exists (backs the one-live index).
 */
export async function activateOfferVersion(tenantId: string, offerId: string, versionId: string): Promise<OfferVersionRow> {
  const result = await dataService.tx<OfferVersionRow>(async (q) => {
    const target = await q<{ offer_version_id: string }>(
      `SELECT offer_version_id FROM offer_catalog.offer_version
        WHERE tenant_id = $1 AND offer_id = $2 AND offer_version_id = $3 FOR UPDATE`,
      [tenantId, offerId, versionId],
    );
    if (!target.rows[0]) throw new OfferVersionNotFoundError();
    // Demote the current live version (if any, and not the target itself).
    await q(
      `UPDATE offer_catalog.offer_version SET status = 'retired'
        WHERE tenant_id = $1 AND offer_id = $2 AND status = 'live' AND offer_version_id <> $3`,
      [tenantId, offerId, versionId],
    );
    const promoted = await q<OfferVersionRow>(
      `UPDATE offer_catalog.offer_version SET status = 'live', activated_at = now()
        WHERE tenant_id = $1 AND offer_version_id = $2
        RETURNING ${VER_COLS}`,
      [tenantId, versionId],
    );
    return promoted.rows[0];
  });
  await emitEvent({
    event_type: 'offer_catalog.version.activated.v1',
    tenant_id: tenantId,
    payload: { offer_id: offerId, offer_version_id: versionId, version: result.version },
  } as never).catch(() => undefined);
  return result;
}

export interface ResolveCurrentResult {
  version: OfferVersionRow | null;
  source: 'live' | 'beta' | 'draft' | 'none';
}

/**
 * Resolve the current version for an offer with a fallback chain: the live version if one
 * exists, else the most recent beta, else the most recent draft (so a caller always gets
 * the best-available truth). Returns {version, source}.
 */
export async function resolveCurrentVersion(tenantId: string, offerId: string): Promise<ResolveCurrentResult> {
  const live = await dataService.one<OfferVersionRow>(
    `SELECT ${VER_COLS} FROM offer_catalog.offer_version
      WHERE tenant_id = $1 AND offer_id = $2 AND status = 'live' LIMIT 1`,
    [tenantId, offerId],
  );
  if (live) return { version: live, source: 'live' };
  for (const status of ['beta', 'draft'] as const) {
    const v = await dataService.one<OfferVersionRow>(
      `SELECT ${VER_COLS} FROM offer_catalog.offer_version
        WHERE tenant_id = $1 AND offer_id = $2 AND status = $3
        ORDER BY created_at DESC LIMIT 1`,
      [tenantId, offerId, status],
    );
    if (v) return { version: v, source: status };
  }
  return { version: null, source: 'none' };
}

/** List an offer's versions, newest first. */
export async function listOfferVersions(tenantId: string, offerId: string): Promise<OfferVersionRow[]> {
  return dataService.rows<OfferVersionRow>(
    `SELECT ${VER_COLS} FROM offer_catalog.offer_version
      WHERE tenant_id = $1 AND offer_id = $2 ORDER BY created_at DESC`,
    [tenantId, offerId],
  );
}
