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
/** Raised when a version's publish request is not approved (pending/rejected). */
export class PublishNotApprovedError extends Error {
  constructor(status: string) { super(`publish gate not satisfied: approval is '${status}'`); this.name = 'PublishNotApprovedError'; }
}

/* ----------------------------------------------- publish gate (sdk-approval) */

export interface PublishApprovalContext { tenant_id: string; offer_id: string; offer_version_id: string; }
/** Creates the approval request (subject = offer_version_id) and returns its ref. */
export type PublishApprovalCreator = (ctx: PublishApprovalContext) => Promise<{ approval_ref: string }>;
// Default: a synthetic ref, request stays 'pending' until decided. The gateway wires this
// to sdk-approval (a route targeting subject_kind='offer_version').
let _approvalCreator: PublishApprovalCreator = async (ctx) => ({ approval_ref: `offerpub:${ctx.offer_version_id}` });
export function setPublishApprovalCreator(creator: PublishApprovalCreator): void { _approvalCreator = creator; }
export function _resetPublishApprovalCreator(): void {
  _approvalCreator = async (ctx) => ({ approval_ref: `offerpub:${ctx.offer_version_id}` });
}

/** File a publish request for a version (subject = version): status -> pending, ref stored. */
export async function requestPublishApproval(tenantId: string, offerId: string, versionId: string): Promise<{ approval_ref: string; approval_status: string }> {
  const target = await getOfferVersion(tenantId, versionId);
  if (!target) throw new OfferVersionNotFoundError();
  const { approval_ref } = await _approvalCreator({ tenant_id: tenantId, offer_id: offerId, offer_version_id: versionId });
  await dataService.rows(
    `UPDATE offer_catalog.offer_version
        SET approval_status = 'pending', approval_ref = $3, approval_requested_at = now()
      WHERE tenant_id = $1 AND offer_version_id = $2`,
    [tenantId, versionId, approval_ref],
  );
  return { approval_ref, approval_status: 'pending' };
}

/** Record the approval decision for a version (from sdk-approval): approved | rejected. */
export async function recordPublishDecision(tenantId: string, versionId: string, decision: 'approved' | 'rejected'): Promise<OfferVersionRow> {
  const rows = await dataService.rows<OfferVersionRow>(
    `UPDATE offer_catalog.offer_version
        SET approval_status = $3, approval_decided_at = now()
      WHERE tenant_id = $1 AND offer_version_id = $2
      RETURNING ${VER_COLS}`,
    [tenantId, versionId, decision],
  );
  if (!rows[0]) throw new OfferVersionNotFoundError();
  return rows[0];
}

/**
 * Activate a version: atomically demote the prior live version for this offer (-> retired)
 * and promote the target (-> live, activated_at). Emits offer_catalog.version.activated.v1.
 * Runs in one transaction so at most one live version ever exists (backs the one-live index).
 */
export async function activateOfferVersion(tenantId: string, offerId: string, versionId: string): Promise<OfferVersionRow> {
  const result = await dataService.tx<OfferVersionRow>(async (q) => {
    const target = await q<{ offer_version_id: string; approval_status: string }>(
      `SELECT offer_version_id, approval_status FROM offer_catalog.offer_version
        WHERE tenant_id = $1 AND offer_id = $2 AND offer_version_id = $3 FOR UPDATE`,
      [tenantId, offerId, versionId],
    );
    if (!target.rows[0]) throw new OfferVersionNotFoundError();
    // Publish gate: only an approved (or not-required) request may activate.
    const approval = target.rows[0].approval_status;
    if (approval === 'pending' || approval === 'rejected') throw new PublishNotApprovedError(approval);
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

/* ------------------------------------ version-stamp + stale-reference guard (TK-3643) */

export interface VersionStamp {
  offer_id: string;
  offer_version_id: string;
  version: string;
  status: string;
  stamped_at: string;
}
/** Raised when an offer has no current (live/beta/draft) version to stamp. */
export class NoCurrentVersionError extends Error {
  constructor() { super('NO_CURRENT_VERSION'); this.name = 'NoCurrentVersionError'; }
}

/**
 * Return the version another record should pin (version-stamp): the current version via
 * resolveCurrentVersion (live, else fallback). A consumer stores offer_version_id in its
 * reference and later revalidates it with checkVersionReference.
 */
export async function stampVersion(tenantId: string, offerId: string): Promise<VersionStamp> {
  const resolved = await resolveCurrentVersion(tenantId, offerId);
  if (!resolved.version) throw new NoCurrentVersionError();
  const v = resolved.version;
  return { offer_id: offerId, offer_version_id: v.offer_version_id, version: v.version, status: v.status, stamped_at: new Date(v.activated_at ?? v.created_at).toISOString() };
}

export interface StaleReferenceResult {
  stale: boolean;
  reason: string;
  referenced_offer_version_id: string;
  current_offer_version_id: string | null;
  current_source: string;
}

/**
 * The net-new stale-reference guard: given a pinned offer_version_id, report whether it is
 * still the current version. A reference to a superseded (retired/older) version is stale.
 * Callable by CRM at quote/version-stamp time to reject a stale pin.
 */
export async function checkVersionReference(tenantId: string, offerId: string, referencedVersionId: string): Promise<StaleReferenceResult> {
  const resolved = await resolveCurrentVersion(tenantId, offerId);
  const currentId = resolved.version?.offer_version_id ?? null;
  const stale = currentId !== referencedVersionId;
  return {
    stale,
    reason: stale
      ? (currentId ? `referenced version is superseded by the current version` : `offer has no current version`)
      : `referenced version is current`,
    referenced_offer_version_id: referencedVersionId,
    current_offer_version_id: currentId,
    current_source: resolved.source,
  };
}

/* ------------------------------------------------- feature-status matrix (TK-3644) */

export interface OfferFeatureRow {
  offer_feature_id: string; tenant_id: string; offer_version_id: string; feature_key: string;
  name: string; status: string; value: string | null; sort_order: number;
}
export interface SetFeatureInput {
  tenantId: string; versionId: string; featureKey: string; name: string;
  status?: string; value?: string; sortOrder?: number;
}
const FEAT_COLS = `offer_feature_id, tenant_id, offer_version_id, feature_key, name, status, value, sort_order`;

/** Set (upsert) one feature's status within a version (matrix cell). Idempotent per (version, feature_key). */
export async function setOfferFeature(input: SetFeatureInput): Promise<OfferFeatureRow> {
  const target = await getOfferVersion(input.tenantId, input.versionId);
  if (!target) throw new OfferVersionNotFoundError();
  const rows = await dataService.rows<OfferFeatureRow>(
    `INSERT INTO offer_catalog.offer_feature (tenant_id, offer_version_id, feature_key, name, status, value, sort_order)
     VALUES ($1,$2,$3,$4,COALESCE($5,'included'),$6,COALESCE($7,0))
     ON CONFLICT (offer_version_id, feature_key)
     DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status, value = EXCLUDED.value, sort_order = EXCLUDED.sort_order
     RETURNING ${FEAT_COLS}`,
    [input.tenantId, input.versionId, input.featureKey, input.name, input.status ?? null, input.value ?? null, input.sortOrder ?? null],
  );
  return rows[0];
}

/** List a version's feature-status matrix (by sort order). */
export async function listOfferFeatures(tenantId: string, versionId: string): Promise<OfferFeatureRow[]> {
  return dataService.rows<OfferFeatureRow>(
    `SELECT ${FEAT_COLS} FROM offer_catalog.offer_feature
      WHERE tenant_id = $1 AND offer_version_id = $2 ORDER BY sort_order ASC, feature_key ASC`,
    [tenantId, versionId],
  );
}

/** List an offer's versions, newest first. */
export async function listOfferVersions(tenantId: string, offerId: string): Promise<OfferVersionRow[]> {
  return dataService.rows<OfferVersionRow>(
    `SELECT ${VER_COLS} FROM offer_catalog.offer_version
      WHERE tenant_id = $1 AND offer_id = $2 ORDER BY created_at DESC`,
    [tenantId, offerId],
  );
}
