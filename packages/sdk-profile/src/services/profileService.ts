import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import { touchResidency } from '@projexlight/sdk-data-rights';
import type {
  BandKind,
  BandL2Record,
  FieldShredLogRecord,
  SecureDataRecord,
  SetSecureFieldInput,
  ShredSecureFieldInput,
  UpsertBandInput,
} from '../models/profile.model';

const PROFILE_AUDIT_POOL = process.env.PROFILE_AUDIT_POOL || 'admin-default';

/**
 * Fire-and-forget audit + residency wiring. Best-effort by design — a failure
 * in the audit append or residency upsert must not roll back the primary
 * profile write (the row is the local source of truth; audit + residency are
 * downstream observability/compliance).
 */
async function emitProfileSideEffects(opts: {
  event_type:
    | 'profile.band.updated.v1'
    | 'profile.field.shredded.v1';
  tenant_id: string | null;
  person_id?: string;
  actor_id: string;
  payload: Record<string, unknown>;
  retention_class: 'operational' | 'regulated';
  residency_classes?: string[];
}): Promise<string | null> {
  let audit_entry_id: string | null = null;
  try {
    const entry = await appendAuditEntry({
      pool_index: PROFILE_AUDIT_POOL,
      event_type: opts.event_type,
      actor_kind: 'service',
      actor_id: opts.actor_id,
      tenant_id: opts.tenant_id,
      subject_kind: opts.person_id ? 'identity.person' : 'profile.band',
      subject_id: opts.person_id ?? null,
      retention_class: opts.retention_class,
      payload: opts.payload,
    });
    audit_entry_id = entry.entry_id;
  } catch (err) {
     
    console.error('[sdk-profile] audit emit failed', (err as Error).message);
  }
  if (opts.person_id && opts.tenant_id && opts.residency_classes?.length) {
    try {
      await touchResidency({
        person_id: opts.person_id,
        pool_index: PROFILE_AUDIT_POOL,
        tenant_id: opts.tenant_id,
        data_classes: opts.residency_classes,
      });
    } catch (err) {
       
      console.error('[sdk-profile] residency touch failed', (err as Error).message);
    }
  }
  return audit_entry_id;
}

/**
 * sdk-profile service per P3 PRD §5.1 / FR-PRF-1..6.
 *
 * Bands live on L2 App Identity. Secure Data lives on L1 Master Person with
 * per-field envelopes. Field envelopes are opaque base64 strings here — actual
 * encryption happens in sdk-vault (per-field salt under Person Key).
 */

export async function upsertBand(input: UpsertBandInput): Promise<BandL2Record> {
  const rows = await dataService.rows<BandL2Record>(
    `INSERT INTO profile.band_l2 (app_identity_id, band_kind, tenant_id, fields_envelope)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (app_identity_id, band_kind) DO UPDATE SET
       fields_envelope = EXCLUDED.fields_envelope,
       tenant_id       = EXCLUDED.tenant_id,
       updated_at      = now()
     RETURNING band_id, app_identity_id, band_kind, tenant_id, fields_envelope, updated_at`,
    [
      input.app_identity_id,
      input.band_kind,
      input.tenant_id,
      JSON.stringify(input.fields_envelope ?? {}),
    ],
  );
  const band = rows[0];
  await emitProfileSideEffects({
    event_type: 'profile.band.updated.v1',
    tenant_id: band.tenant_id,
    actor_id: 'sdk-profile.upsertBand',
    payload: { band_id: band.band_id, app_identity_id: band.app_identity_id, band_kind: band.band_kind },
    retention_class: 'operational',
  });
  return band;
}

export async function readBand(
  app_identity_id: string,
  band_kind: BandKind,
): Promise<BandL2Record | null> {
  return dataService.one<BandL2Record>(
    `SELECT band_id, app_identity_id, band_kind, tenant_id, fields_envelope, updated_at
       FROM profile.band_l2
      WHERE app_identity_id = $1 AND band_kind = $2`,
    [app_identity_id, band_kind],
  );
}

export async function setSecureField(input: SetSecureFieldInput): Promise<SecureDataRecord> {
  const rows = await dataService.rows<SecureDataRecord>(
    `INSERT INTO profile.secure_data (person_id, field_envelopes, field_states)
     VALUES (
       $1,
       jsonb_build_object($2::text, $3::text),
       jsonb_build_object($2::text, jsonb_build_object('state','active'))
     )
     ON CONFLICT (person_id) DO UPDATE SET
       field_envelopes = profile.secure_data.field_envelopes || jsonb_build_object($2::text, $3::text),
       field_states    = profile.secure_data.field_states    || jsonb_build_object($2::text, jsonb_build_object('state','active')),
       updated_at      = now()
     RETURNING person_id, field_envelopes, field_states, updated_at`,
    [input.person_id, input.field_name, input.envelope],
  );
  const record = rows[0];
  // FR-DR-1: every data-bearing SDK records person_pool_residency on first
  // touch so DSAR fan-out can find this row. data_classes includes 'profile'
  // (the band kind) — the registry merges classes on conflict.
  await emitProfileSideEffects({
    event_type: 'profile.band.updated.v1',
    tenant_id: null,
    person_id: input.person_id,
    actor_id: 'sdk-profile.setSecureField',
    payload: { person_id: input.person_id, field_name: input.field_name },
    retention_class: 'regulated',
    residency_classes: ['profile'],
  });
  return record;
}

export async function readSecureData(person_id: string): Promise<SecureDataRecord | null> {
  return dataService.one<SecureDataRecord>(
    `SELECT person_id, field_envelopes, field_states, updated_at
       FROM profile.secure_data WHERE person_id = $1`,
    [person_id],
  );
}

/**
 * Per-field shred (FR-PRF-6). Removes the envelope bytes, updates field_states
 * to shredded, and writes an append-only log row.
 */
export async function shredSecureField(input: ShredSecureFieldInput): Promise<FieldShredLogRecord> {
  await dataService.query(
    `UPDATE profile.secure_data
        SET field_envelopes = field_envelopes - $2::text,
            field_states    = field_states || jsonb_build_object(
              $2::text, jsonb_build_object('state','shredded','shredded_at', now()::text)
            ),
            updated_at      = now()
      WHERE person_id = $1`,
    [input.person_id, input.field_name],
  );

  const audit_entry_id =
    input.audit_entry_id ??
    (await emitProfileSideEffects({
      event_type: 'profile.field.shredded.v1',
      tenant_id: null,
      person_id: input.person_id,
      actor_id: 'sdk-profile.shredSecureField',
      payload: { person_id: input.person_id, field_name: input.field_name, reason: input.reason },
      retention_class: 'regulated',
    }));
  const rows = await dataService.rows<FieldShredLogRecord>(
    `INSERT INTO profile.field_shred_log (person_id, field_name, reason, audit_entry_id)
     VALUES ($1, $2, $3, $4)
     RETURNING shred_id, person_id, field_name, reason, audit_entry_id, occurred_at`,
    [input.person_id, input.field_name, input.reason, audit_entry_id],
  );
  return rows[0];
}

export async function listShredHistory(person_id: string): Promise<FieldShredLogRecord[]> {
  return dataService.rows<FieldShredLogRecord>(
    `SELECT shred_id, person_id, field_name, reason, audit_entry_id, occurred_at
       FROM profile.field_shred_log
      WHERE person_id = $1
      ORDER BY occurred_at DESC`,
    [person_id],
  );
}
