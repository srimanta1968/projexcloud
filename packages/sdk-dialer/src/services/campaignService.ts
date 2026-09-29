import { dataService } from '@projexlight/db-runtime';
import { emitEvent } from '@projexlight/sdk-audit';
import { conflict, invalidTransition, notFound, validationError } from '../models/errors';

/**
 * Outbound AI-call campaigns (VA·E5 · TK-4479).
 *
 * Lifecycle:  draft --start--> running <--pause/resume--> paused
 *             draft|running|paused --cancel--> cancelled  (terminal; pending contacts cancelled)
 * Starting needs the agent to be able to place calls (outbound or both, published, kill
 * switch off) — checked at start, not create, so a campaign can be drafted while the
 * agent is still being built.
 *
 * Contacts are uploaded in batches and upserted by (campaign, external_ref): re-sending a
 * batch updates contact details instead of duplicating people, and never resets a
 * contact that was already called. One bad row is reported by index; the rest land.
 *
 * Progress is published as voice.campaign.progressed.v1 with per-status contact counts:
 * always on a status change, otherwise at most once per PROGRESS_THROTTLE_MS per campaign,
 * so a 50k-contact upload does not become 50k events.
 */

export const CAMPAIGN_STATUSES = ['draft', 'running', 'paused', 'cancelled', 'completed'] as const;
export const VOICEMAIL_POLICIES = ['hang_up', 'drop_tts', 'drop_recording'] as const;
export const CONTACT_STATUSES = ['pending', 'queued', 'in_progress', 'deferred', 'done', 'failed', 'refused', 'cancelled'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];
export type VoicemailPolicy = (typeof VOICEMAIL_POLICIES)[number];
export type ContactStatus = (typeof CONTACT_STATUSES)[number];
export type CampaignAction = 'start' | 'pause' | 'resume' | 'cancel';

export interface Campaign {
  campaign_id: string;
  tenant_id: string;
  agent_id: string;
  name: string;
  status: CampaignStatus;
  marketing_campaign_id: string | null;
  default_timezone: string;
  window_start: string;
  window_end: string;
  max_concurrency: number;
  max_attempts: number;
  retry_spacing_minutes: number[];
  voicemail_policy: VoicemailPolicy;
  voicemail_message: string | null;
  caller_id_pool: string[];
  context: Record<string, unknown>;
  created_by: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CampaignProgress {
  total: number;
  by_status: Record<ContactStatus, number>;
}

export interface CampaignContact {
  contact_id: string;
  campaign_id: string;
  external_ref: string;
  phone_number: string;
  subject_ref: string | null;
  crm_encounter_id: string | null;
  timezone: string | null;
  context: Record<string, unknown>;
  status: ContactStatus;
  attempts: number;
  next_attempt_at: string | null;
  last_outcome: string | null;
  last_call_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateCampaignInput {
  agent_id?: unknown;
  name?: unknown;
  marketing_campaign_id?: unknown;
  default_timezone?: unknown;
  window_start?: unknown;
  window_end?: unknown;
  max_concurrency?: unknown;
  max_attempts?: unknown;
  retry_spacing_minutes?: unknown;
  voicemail_policy?: unknown;
  voicemail_message?: unknown;
  caller_id_pool?: unknown;
  context?: unknown;
}

export interface ContactInput {
  external_ref?: unknown;
  phone_number?: unknown;
  subject_ref?: unknown;
  crm_encounter_id?: unknown;
  timezone?: unknown;
  context?: unknown;
}

export interface UpsertContactsResult {
  inserted: number;
  updated: number;
  rejected: { index: number; external_ref: string | null; reason: string }[];
  progress: CampaignProgress;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const E164_RE = /^\+[1-9][0-9]{6,14}$/;
const HHMM_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const MAX_BATCH = 1000;
const MAX_CONTEXT_BYTES = 32 * 1024;
const MAX_PAGE = 200;
const PROGRESS_THROTTLE_MS = Number(process.env.DIALER_PROGRESS_THROTTLE_MS || 5000);
const DIALER_AUDIT_POOL = process.env.DIALER_AUDIT_POOL || 'admin-default';

const CAMPAIGN_COLUMNS = `
  campaign_id, tenant_id, agent_id, name, status, marketing_campaign_id, default_timezone,
  to_char(window_start, 'HH24:MI') AS window_start, to_char(window_end, 'HH24:MI') AS window_end,
  max_concurrency, max_attempts, retry_spacing_minutes, voicemail_policy, voicemail_message,
  caller_id_pool, context, created_by, started_at, finished_at, created_at, updated_at`;

const CONTACT_COLUMNS = `
  contact_id, campaign_id, external_ref, phone_number, subject_ref, crm_encounter_id, timezone,
  context, status, attempts, next_attempt_at, last_outcome, last_call_id, created_at, updated_at`;

type Row<T> = Omit<T, 'started_at' | 'finished_at' | 'created_at' | 'updated_at' | 'next_attempt_at'> & Record<string, unknown>;
const iso = (d: unknown): string | null => (d ? new Date(d as string).toISOString() : null);
const normalise = <T>(row: Row<T>): T => {
  const out: Record<string, unknown> = { ...row };
  for (const k of ['started_at', 'finished_at', 'created_at', 'updated_at', 'next_attempt_at']) if (k in out) out[k] = iso(out[k]);
  return out as T;
};

/** True for a timezone the runtime can compute local time in (IANA name). */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const contextOk = (v: unknown): boolean => isObject(v) && Buffer.byteLength(JSON.stringify(v), 'utf8') <= MAX_CONTEXT_BYTES;

function intIn(v: unknown, field: string, min: number, max: number): number {
  if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) throw validationError(`${field} must be an integer between ${min} and ${max}`);
  return v as number;
}

// ---------------------------------------------------------------------------------------------
// Campaigns

/**
 * Creates a draft campaign.
 *
 * @throws DialerError 400 invalid input, 404 unknown agent, 409 duplicate name.
 */
export async function createCampaign(tenantId: string, input: CreateCampaignInput, actorId: string | null): Promise<Campaign> {
  if (typeof input.agent_id !== 'string' || !UUID_RE.test(input.agent_id)) throw validationError('agent_id must be a uuid');
  if (typeof input.name !== 'string' || input.name.trim().length === 0 || input.name.length > 120) throw validationError('name is required (1-120 characters)');
  if (input.marketing_campaign_id !== undefined && input.marketing_campaign_id !== null
    && (typeof input.marketing_campaign_id !== 'string' || !UUID_RE.test(input.marketing_campaign_id))) {
    throw validationError('marketing_campaign_id must be a uuid');
  }
  const tz = input.default_timezone ?? 'UTC';
  if (typeof tz !== 'string' || !isValidTimezone(tz)) throw validationError('default_timezone must be an IANA timezone, e.g. America/New_York');
  const ws = input.window_start ?? '08:00';
  const we = input.window_end ?? '21:00';
  if (typeof ws !== 'string' || !HHMM_RE.test(ws) || typeof we !== 'string' || !HHMM_RE.test(we)) throw validationError('window_start and window_end must be HH:MM');
  if (ws >= we) throw validationError('window_start must be before window_end');
  const maxConcurrency = intIn(input.max_concurrency ?? 5, 'max_concurrency', 1, 1000);
  const maxAttempts = intIn(input.max_attempts ?? 3, 'max_attempts', 1, 10);
  const spacing = input.retry_spacing_minutes ?? [60, 240, 1440];
  if (!Array.isArray(spacing) || spacing.length === 0 || spacing.length > 10
    || !spacing.every((m) => Number.isInteger(m) && m >= 1 && m <= 10080)) {
    throw validationError('retry_spacing_minutes must be 1-10 integers between 1 and 10080');
  }
  const vmPolicy = input.voicemail_policy ?? 'hang_up';
  if (!(VOICEMAIL_POLICIES as readonly unknown[]).includes(vmPolicy)) throw validationError(`voicemail_policy must be one of ${VOICEMAIL_POLICIES.join(', ')}`);
  const vmMessage = input.voicemail_message ?? null;
  if (vmMessage !== null && (typeof vmMessage !== 'string' || vmMessage.length === 0 || vmMessage.length > 2000)) throw validationError('voicemail_message must be 1-2000 characters');
  if (vmPolicy !== 'hang_up' && !vmMessage) throw validationError(`voicemail_message is required when voicemail_policy is ${vmPolicy as string}`);
  const pool = input.caller_id_pool ?? [];
  if (!Array.isArray(pool) || pool.length > 100 || !pool.every((n) => typeof n === 'string' && E164_RE.test(n))) {
    throw validationError('caller_id_pool must be up to 100 E.164 numbers');
  }
  const context = input.context ?? {};
  if (!contextOk(context)) throw validationError(`context must be a JSON object of at most ${MAX_CONTEXT_BYTES} bytes`);

  const agent = await dataService.one<{ agent_id: string }>(
    `SELECT agent_id FROM voice_agent.agent WHERE tenant_id = $1 AND agent_id = $2`,
    [tenantId, input.agent_id],
  );
  if (!agent) throw notFound('agent not found');

  try {
    const row = await dataService.one<Row<Campaign>>(
      `INSERT INTO dialer.campaign
         (tenant_id, agent_id, name, marketing_campaign_id, default_timezone, window_start, window_end,
          max_concurrency, max_attempts, retry_spacing_minutes, voicemail_policy, voicemail_message,
          caller_id_pool, context, created_by)
       VALUES ($1, $2, $3, $4, $5, $6::time, $7::time, $8, $9, $10::int[], $11, $12, $13::text[], $14::jsonb, $15)
       RETURNING ${CAMPAIGN_COLUMNS}`,
      [tenantId, input.agent_id, input.name.trim(), input.marketing_campaign_id ?? null, tz, ws, we, maxConcurrency, maxAttempts,
        spacing, vmPolicy, vmMessage, [...new Set(pool as string[])], JSON.stringify(context), actorId],
    );
    return normalise<Campaign>(row as Row<Campaign>);
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw conflict('a campaign with this name already exists');
    throw err;
  }
}

async function progressOf(tenantId: string, campaignId: string): Promise<CampaignProgress> {
  const rows = await dataService.rows<{ status: ContactStatus; n: number }>(
    `SELECT status, count(*)::int AS n FROM dialer.campaign_contact WHERE tenant_id = $1 AND campaign_id = $2 GROUP BY status`,
    [tenantId, campaignId],
  );
  const by_status = Object.fromEntries(CONTACT_STATUSES.map((s) => [s, 0])) as Record<ContactStatus, number>;
  for (const r of rows) by_status[r.status] = r.n;
  return { total: rows.reduce((a, r) => a + r.n, 0), by_status };
}

/** One campaign with its progress, or null when it is not this tenant's. */
export async function getCampaign(tenantId: string, campaignId: string): Promise<(Campaign & { progress: CampaignProgress }) | null> {
  if (!UUID_RE.test(campaignId)) return null;
  const row = await dataService.one<Row<Campaign>>(
    `SELECT ${CAMPAIGN_COLUMNS} FROM dialer.campaign WHERE tenant_id = $1 AND campaign_id = $2`,
    [tenantId, campaignId],
  );
  if (!row) return null;
  return { ...normalise<Campaign>(row), progress: await progressOf(tenantId, campaignId) };
}

/** Newest first, optionally by status / agent. */
export async function listCampaigns(
  tenantId: string,
  filter: { status?: string; agent_id?: string; limit?: number; offset?: number } = {},
): Promise<{ campaigns: Campaign[]; limit: number; offset: number }> {
  if (filter.status !== undefined && !(CAMPAIGN_STATUSES as readonly string[]).includes(filter.status)) {
    throw validationError(`status must be one of ${CAMPAIGN_STATUSES.join(', ')}`);
  }
  if (filter.agent_id !== undefined && !UUID_RE.test(filter.agent_id)) throw validationError('agent_id must be a uuid');
  const limit = filter.limit ?? 50;
  const offset = filter.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) throw validationError(`limit must be an integer between 1 and ${MAX_PAGE}`);
  if (!Number.isInteger(offset) || offset < 0) throw validationError('offset must be a non-negative integer');
  const rows = await dataService.rows<Row<Campaign>>(
    `SELECT ${CAMPAIGN_COLUMNS} FROM dialer.campaign
      WHERE tenant_id = $1 AND ($2::text IS NULL OR status = $2) AND ($3::uuid IS NULL OR agent_id = $3::uuid)
      ORDER BY created_at DESC, campaign_id LIMIT $4 OFFSET $5`,
    [tenantId, filter.status ?? null, filter.agent_id ?? null, limit, offset],
  );
  return { campaigns: rows.map((r) => normalise<Campaign>(r)), limit, offset };
}

// ---------------------------------------------------------------------------------------------
// Lifecycle

const TRANSITIONS: Record<CampaignAction, { from: CampaignStatus[]; to: CampaignStatus }> = {
  start: { from: ['draft'], to: 'running' },
  pause: { from: ['running'], to: 'paused' },
  resume: { from: ['paused'], to: 'running' },
  cancel: { from: ['draft', 'running', 'paused'], to: 'cancelled' },
};

/**
 * Moves a campaign through its lifecycle. Repeating the action that produced the
 * current status is a no-op (pause twice = paused), so a retried request is safe.
 *
 * @throws DialerError 404, 409 InvalidTransition, 409 Conflict (agent cannot place calls).
 */
export async function transitionCampaign(tenantId: string, campaignId: string, action: CampaignAction, actorId: string | null): Promise<Campaign & { progress: CampaignProgress }> {
  const current = await getCampaign(tenantId, campaignId);
  if (!current) throw notFound('campaign not found');
  const rule = TRANSITIONS[action];
  if (current.status === rule.to) return current;
  if (!rule.from.includes(current.status)) throw invalidTransition(`cannot ${action} a campaign that is ${current.status}`);

  if (action === 'start' || action === 'resume') {
    const agent = await dataService.one<{ direction: string; status: string; published_version_id: string | null; kill_switch_engaged: boolean }>(
      `SELECT direction, status, published_version_id, kill_switch_engaged FROM voice_agent.agent WHERE tenant_id = $1 AND agent_id = $2`,
      [tenantId, current.agent_id],
    );
    if (!agent) throw conflict("the campaign's agent no longer exists");
    if (agent.direction === 'inbound') throw conflict('the agent is inbound-only and cannot place outbound calls');
    if (agent.status !== 'published' || !agent.published_version_id) throw conflict('the agent has no published version');
    if (agent.kill_switch_engaged) throw conflict("the agent's kill switch is engaged");
  }

  await dataService.tx(async (q) => {
    await q(
      `UPDATE dialer.campaign
          SET status = $3,
              started_at  = CASE WHEN $3 = 'running' THEN COALESCE(started_at, now()) ELSE started_at END,
              finished_at = CASE WHEN $3 = 'cancelled' THEN now() ELSE finished_at END,
              updated_at  = now()
        WHERE tenant_id = $1 AND campaign_id = $2`,
      [tenantId, campaignId, rule.to],
    );
    if (action === 'cancel') {
      // People not yet reached are never called now; calls already under way finish.
      await q(
        `UPDATE dialer.campaign_contact SET status = 'cancelled', next_attempt_at = NULL, updated_at = now()
          WHERE tenant_id = $1 AND campaign_id = $2 AND status IN ('pending','queued','deferred')`,
        [tenantId, campaignId],
      );
      await q(
        `UPDATE dialer.dispatch_queue SET state = 'cancelled', updated_at = now()
          WHERE tenant_id = $1 AND campaign_id = $2 AND state IN ('queued','deferred')`,
        [tenantId, campaignId],
      );
    }
  });
  const updated = (await getCampaign(tenantId, campaignId))!;
  await publishProgress(tenantId, updated, { force: true, actorId, action });
  return updated;
}

// ---------------------------------------------------------------------------------------------
// Contacts

/**
 * Upserts a batch of up to 1000 contacts by external_ref. Invalid rows are rejected
 * individually (reported by index); valid rows land in one transaction. A contact that
 * was already worked keeps its status and attempts — only its details are refreshed.
 *
 * @throws DialerError 400 (batch shape), 404 unknown campaign, 409 campaign cancelled/completed.
 */
export async function upsertContacts(tenantId: string, campaignId: string, input: { contacts?: unknown }, actorId: string | null): Promise<UpsertContactsResult> {
  if (!Array.isArray(input.contacts) || input.contacts.length === 0 || input.contacts.length > MAX_BATCH) {
    throw validationError(`contacts must be an array of 1-${MAX_BATCH} entries`);
  }
  const campaign = await getCampaign(tenantId, campaignId);
  if (!campaign) throw notFound('campaign not found');
  if (campaign.status === 'cancelled' || campaign.status === 'completed') throw conflict(`campaign is ${campaign.status}; contacts can no longer be added`);

  const rejected: UpsertContactsResult['rejected'] = [];
  const valid: { index: number; c: Required<Pick<ContactInput, 'external_ref' | 'phone_number'>> & ContactInput }[] = [];
  const seen = new Set<string>();
  (input.contacts as ContactInput[]).forEach((c, index) => {
    const ref = c && typeof c.external_ref === 'string' ? c.external_ref : null;
    const reject = (reason: string): void => { rejected.push({ index, external_ref: ref, reason }); };
    if (!c || typeof c !== 'object') return reject('contact must be an object');
    if (!ref || ref.length > 200) return reject('external_ref is required (1-200 characters)');
    if (seen.has(ref)) return reject('external_ref appears more than once in this batch');
    if (typeof c.phone_number !== 'string' || !E164_RE.test(c.phone_number)) return reject('phone_number must be E.164, e.g. +14155550100');
    if (c.subject_ref !== undefined && c.subject_ref !== null && (typeof c.subject_ref !== 'string' || c.subject_ref.length === 0 || c.subject_ref.length > 256)) return reject('subject_ref must be 1-256 characters');
    if (c.crm_encounter_id !== undefined && c.crm_encounter_id !== null && (typeof c.crm_encounter_id !== 'string' || !UUID_RE.test(c.crm_encounter_id))) return reject('crm_encounter_id must be a uuid');
    if (c.timezone !== undefined && c.timezone !== null && (typeof c.timezone !== 'string' || !isValidTimezone(c.timezone))) return reject('timezone must be an IANA timezone');
    if (c.context !== undefined && c.context !== null && !contextOk(c.context)) return reject(`context must be a JSON object of at most ${MAX_CONTEXT_BYTES} bytes`);
    seen.add(ref);
    valid.push({ index, c: c as typeof valid[number]['c'] });
  });

  let inserted = 0;
  let updated = 0;
  if (valid.length > 0) {
    await dataService.tx(async (q) => {
      for (const { c } of valid) {
        const res = await q<{ inserted: boolean }>(
          `INSERT INTO dialer.campaign_contact
             (campaign_id, tenant_id, external_ref, phone_number, subject_ref, crm_encounter_id, timezone, context)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
           ON CONFLICT (campaign_id, external_ref) DO UPDATE SET
             phone_number = EXCLUDED.phone_number, subject_ref = EXCLUDED.subject_ref,
             crm_encounter_id = EXCLUDED.crm_encounter_id, timezone = EXCLUDED.timezone,
             context = EXCLUDED.context, updated_at = now()
           RETURNING (xmax = 0) AS inserted`,
          [campaignId, tenantId, c.external_ref, c.phone_number, c.subject_ref ?? null, c.crm_encounter_id ?? null,
            c.timezone ?? null, JSON.stringify(c.context ?? {})],
        );
        if (res.rows[0]?.inserted) inserted += 1; else updated += 1;
      }
    });
  }
  const progress = await progressOf(tenantId, campaignId);
  await publishProgress(tenantId, { ...campaign, progress }, { force: false, actorId, action: 'contacts_upserted' });
  return { inserted, updated, rejected, progress };
}

/** A page of a campaign's contacts, optionally by status. */
export async function listContacts(
  tenantId: string,
  campaignId: string,
  filter: { status?: string; limit?: number; offset?: number } = {},
): Promise<{ contacts: CampaignContact[]; limit: number; offset: number }> {
  if (!UUID_RE.test(campaignId)) throw notFound('campaign not found');
  if (filter.status !== undefined && !(CONTACT_STATUSES as readonly string[]).includes(filter.status)) {
    throw validationError(`status must be one of ${CONTACT_STATUSES.join(', ')}`);
  }
  const limit = filter.limit ?? 100;
  const offset = filter.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) throw validationError(`limit must be an integer between 1 and ${MAX_PAGE}`);
  if (!Number.isInteger(offset) || offset < 0) throw validationError('offset must be a non-negative integer');
  const exists = await dataService.one(`SELECT 1 FROM dialer.campaign WHERE tenant_id = $1 AND campaign_id = $2`, [tenantId, campaignId]);
  if (!exists) throw notFound('campaign not found');
  const rows = await dataService.rows<Row<CampaignContact>>(
    `SELECT ${CONTACT_COLUMNS} FROM dialer.campaign_contact
      WHERE tenant_id = $1 AND campaign_id = $2 AND ($3::text IS NULL OR status = $3)
      ORDER BY created_at, contact_id LIMIT $4 OFFSET $5`,
    [tenantId, campaignId, filter.status ?? null, limit, offset],
  );
  return { contacts: rows.map((r) => normalise<CampaignContact>(r)), limit, offset };
}

// ---------------------------------------------------------------------------------------------
// Progress events

const lastPublished = new Map<string, number>();

/**
 * Emits voice.campaign.progressed.v1. `force` (status changes) always emits; otherwise at
 * most one event per campaign per PROGRESS_THROTTLE_MS on this instance.
 */
export async function publishProgress(
  tenantId: string,
  campaign: Campaign & { progress: CampaignProgress },
  opts: { force: boolean; actorId: string | null; action: string },
): Promise<boolean> {
  const now = Date.now();
  const last = lastPublished.get(campaign.campaign_id) ?? 0;
  if (!opts.force && now - last < PROGRESS_THROTTLE_MS) return false;
  lastPublished.set(campaign.campaign_id, now);
  await emitEvent({
    event_type: 'voice.campaign.progressed.v1',
    pool_index: DIALER_AUDIT_POOL,
    actor_kind: opts.actorId ? 'human' : 'service',
    actor_id: opts.actorId ?? 'sdk-dialer',
    tenant_id: tenantId,
    subject_kind: 'dialer.campaign',
    subject_id: campaign.campaign_id,
    payload: {
      campaign_id: campaign.campaign_id,
      agent_id: campaign.agent_id,
      status: campaign.status,
      trigger: opts.action,
      total: campaign.progress.total,
      by_status: campaign.progress.by_status,
    },
  });
  return true;
}
