import { dataService } from '@projexlight/db-runtime';
import { emitEvent } from '@projexlight/sdk-audit';
import { getTwilioVoiceProvider, TwilioVoiceProviderError } from '../provider';
import type { ProvisionNumberInput, TrackingNumberRecord } from '../models/voice.model';

/**
 * Tracking-number provisioning for connector-twilio-voice (P15·E4, TK-3652).
 *
 * A tracking number is a Twilio number pinned to a tenant so inbound calls can
 * be attributed to the campaign / source / persona that owns it. Provisioning
 * goes through the pluggable provider, so an unconfigured environment still gets
 * a usable (synthetic) number rather than an error.
 */

const VOICE_AUDIT_POOL = process.env.TWILIO_VOICE_AUDIT_POOL || 'admin-default';

const NUMBER_COLS = `
  tracking_number_id, install_id, tenant_id, external_id, phone_number,
  friendly_name, capabilities, purpose, assigned_persona_id, status,
  provisioned_at, released_at, payload, last_sync_at`;

/** Thrown when the tenant already holds an active claim on the same number. */
export class NumberAlreadyProvisioned extends Error {
  constructor(public phone_number: string) {
    super(`[connector-twilio-voice] ${phone_number} is already provisioned and active for this tenant`);
    this.name = 'NumberAlreadyProvisioned';
  }
}

/**
 * Provision a tracking number and store it against the tenant.
 *
 * The provider is called first (it mints/claims the number upstream), then the
 * mirror row is written. Re-provisioning the SAME upstream number for the same
 * install is idempotent via UNIQUE(install_id, external_id) — the existing row
 * is returned rather than a duplicate created. A different upstream id that
 * resolves to a phone number the tenant already holds ACTIVE is a conflict, since
 * the partial unique index permits only one active claim per (tenant, number).
 *
 * @throws TwilioVoiceProviderError when the upstream provisioning call fails.
 * @throws NumberAlreadyProvisioned when the tenant already holds that number.
 */
export async function provisionTrackingNumber(input: ProvisionNumberInput): Promise<TrackingNumberRecord> {
  let provisioned;
  try {
    provisioned = await getTwilioVoiceProvider().provisionNumber({
      phone_number: input.phone_number || null,
      area_code: input.area_code ?? null,
      friendly_name: input.friendly_name ?? null,
      voice_url: process.env.TWILIO_VOICE_INBOUND_URL ?? null,
      status_callback_url: statusCallbackUrl(),
    });
  } catch (err) {
    throw new TwilioVoiceProviderError(
      `number provisioning failed: ${(err as Error).message}`,
      'Verify the Twilio account SID/auth token and that the account may purchase numbers in this region.',
    );
  }

  const existingActive = await dataService.one<TrackingNumberRecord>(
    `SELECT ${NUMBER_COLS} FROM connector_twilio_voice.tracking_number
      WHERE tenant_id = $1 AND phone_number = $2 AND status = 'active'`,
    [input.tenant_id, provisioned.phone_number],
  );
  if (existingActive && existingActive.external_id !== provisioned.sid) {
    throw new NumberAlreadyProvisioned(provisioned.phone_number);
  }

  const rec = await dataService.one<TrackingNumberRecord>(
    `INSERT INTO connector_twilio_voice.tracking_number
       (install_id, tenant_id, external_id, phone_number, friendly_name,
        capabilities, purpose, assigned_persona_id, payload)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6::jsonb, '{}'::jsonb), $7, $8,
             COALESCE($9::jsonb, '{}'::jsonb))
     ON CONFLICT (install_id, external_id) DO UPDATE SET
       friendly_name       = COALESCE(EXCLUDED.friendly_name, connector_twilio_voice.tracking_number.friendly_name),
       purpose             = COALESCE(EXCLUDED.purpose, connector_twilio_voice.tracking_number.purpose),
       assigned_persona_id = COALESCE(EXCLUDED.assigned_persona_id, connector_twilio_voice.tracking_number.assigned_persona_id),
       last_sync_at        = now()
     RETURNING ${NUMBER_COLS}`,
    [
      input.install_id,
      input.tenant_id,
      provisioned.sid,
      provisioned.phone_number,
      input.friendly_name ?? null,
      provisioned.capabilities ? JSON.stringify(provisioned.capabilities) : null,
      input.purpose ?? null,
      input.assigned_persona_id ?? null,
      JSON.stringify({ provisioned_via: 'connector-twilio-voice' }),
    ],
  );
  if (!rec) throw new Error('[connector-twilio-voice] tracking_number insert returned no row');

  await emitEvent({
    event_type: 'twilio-voice.number.provisioned.v1',
    pool_index: VOICE_AUDIT_POOL,
    actor_kind: 'service',
    actor_id: 'connector-twilio-voice',
    tenant_id: rec.tenant_id,
    subject_kind: 'connector_twilio_voice.tracking_number',
    subject_id: rec.tracking_number_id,
    payload: { phone_number: rec.phone_number, external_id: rec.external_id, purpose: rec.purpose },
  });
  return rec;
}

/** List a tenant's tracking numbers, optionally filtered by status. */
export async function listTrackingNumbers(
  tenant_id: string,
  opts: { status?: string; limit?: number; offset?: number } = {},
): Promise<TrackingNumberRecord[]> {
  return dataService.rows<TrackingNumberRecord>(
    `SELECT ${NUMBER_COLS} FROM connector_twilio_voice.tracking_number
      WHERE tenant_id = $1
        AND ($2::text IS NULL OR status = $2)
      ORDER BY provisioned_at DESC
      LIMIT $3 OFFSET $4`,
    [tenant_id, opts.status ?? null, opts.limit ?? 50, opts.offset ?? 0],
  );
}

/** Fetch one tenant-scoped tracking number, or null. */
export async function getTrackingNumber(tenant_id: string, tracking_number_id: string): Promise<TrackingNumberRecord | null> {
  return dataService.one<TrackingNumberRecord>(
    `SELECT ${NUMBER_COLS} FROM connector_twilio_voice.tracking_number
      WHERE tenant_id = $1 AND tracking_number_id = $2`,
    [tenant_id, tracking_number_id],
  );
}

/**
 * Release a tracking number back to Twilio and mark the row 'released'. The row
 * is kept (not deleted) so historical calls stay attributable. Releasing an
 * already-released number is a no-op that returns the current row.
 */
export async function releaseTrackingNumber(tenant_id: string, tracking_number_id: string): Promise<TrackingNumberRecord | null> {
  const existing = await getTrackingNumber(tenant_id, tracking_number_id);
  if (!existing) return null;
  if (existing.status === 'released') return existing;

  try {
    await getTwilioVoiceProvider().releaseNumber(existing.external_id);
  } catch (err) {
    throw new TwilioVoiceProviderError(
      `number release failed: ${(err as Error).message}`,
      'Confirm the number still exists upstream; if it was already released in the Twilio console, retry to reconcile the mirror.',
    );
  }

  const rec = await dataService.one<TrackingNumberRecord>(
    `UPDATE connector_twilio_voice.tracking_number
        SET status = 'released', released_at = now(), last_sync_at = now()
      WHERE tenant_id = $1 AND tracking_number_id = $2
      RETURNING ${NUMBER_COLS}`,
    [tenant_id, tracking_number_id],
  );
  if (rec) {
    await emitEvent({
      event_type: 'twilio-voice.number.released.v1',
      pool_index: VOICE_AUDIT_POOL,
      actor_kind: 'service',
      actor_id: 'connector-twilio-voice',
      tenant_id: rec.tenant_id,
      subject_kind: 'connector_twilio_voice.tracking_number',
      subject_id: rec.tracking_number_id,
      payload: { phone_number: rec.phone_number },
    });
  }
  return rec;
}

/** Public base URL Twilio should call back on. */
export function callbackBaseUrl(): string {
  return (process.env.TWILIO_VOICE_CALLBACK_BASE_URL || process.env.PUBLIC_BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
}
export function statusCallbackUrl(): string {
  return `${callbackBaseUrl()}/api/voice/webhooks/twilio/status`;
}
export function recordingCallbackUrl(): string {
  return `${callbackBaseUrl()}/api/voice/webhooks/twilio/recording`;
}
