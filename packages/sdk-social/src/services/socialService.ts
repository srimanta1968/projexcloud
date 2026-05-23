import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import type {
  AuthorizeHandleInput,
  HandleRecord,
  IngestInteractionInput,
  InteractionRecord,
} from '../models/social.model';

const SOCIAL_AUDIT_POOL = process.env.SOCIAL_AUDIT_POOL || 'admin-default';

async function emitSocialAudit(opts: {
  event_type: 'social.handle.authorized.v1' | 'social.interaction.ingested.v1' | 'social.lead.captured.v1';
  tenant_id: string;
  subject_kind: string;
  subject_id: string;
  payload: Record<string, unknown>;
  retention_class?: 'operational' | 'regulated';
}): Promise<void> {
  try {
    await appendAuditEntry({
      pool_index: SOCIAL_AUDIT_POOL,
      event_type: opts.event_type,
      actor_kind: 'service',
      actor_id: `sdk-social.${opts.event_type}`,
      tenant_id: opts.tenant_id,
      subject_kind: opts.subject_kind,
      subject_id: opts.subject_id,
      retention_class: opts.retention_class ?? 'regulated',
      payload: opts.payload,
    });
  } catch (err) {
    console.error('[sdk-social] audit emit failed', opts.event_type, (err as Error).message);
  }
}

export async function authorizeHandle(input: AuthorizeHandleInput): Promise<HandleRecord> {
  const rows = await dataService.rows<HandleRecord>(
    `INSERT INTO social.handle (tenant_id, network, external_handle_id, authorized_persona_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, network, external_handle_id) DO UPDATE SET
       authorized_persona_id = EXCLUDED.authorized_persona_id,
       authorized_at         = now()
     RETURNING handle_id, tenant_id, network, external_handle_id, authorized_persona_id, authorized_at`,
    [input.tenant_id, input.network, input.external_handle_id, input.authorized_persona_id],
  );
  const handle = rows[0];
  await emitSocialAudit({
    event_type: 'social.handle.authorized.v1',
    tenant_id: handle.tenant_id,
    subject_kind: 'social.handle',
    subject_id: handle.handle_id,
    payload: { network: handle.network, external_handle_id: handle.external_handle_id },
  });
  return handle;
}

export async function ingestInteraction(input: IngestInteractionInput): Promise<InteractionRecord> {
  const rows = await dataService.rows<InteractionRecord>(
    `INSERT INTO social.interaction (handle_id, kind, author_external_id, author_persona_id, body)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING interaction_id, handle_id, kind, author_external_id, author_persona_id,
               body, received_at, captured_lead_contact_id`,
    [
      input.handle_id,
      input.kind,
      input.author_external_id,
      input.author_persona_id ?? null,
      input.body ?? null,
    ],
  );
  const interaction = rows[0];
  const handle = await dataService.one<{ tenant_id: string }>(
    `SELECT tenant_id FROM social.handle WHERE handle_id = $1`,
    [interaction.handle_id],
  );
  await emitSocialAudit({
    event_type: 'social.interaction.ingested.v1',
    tenant_id: handle?.tenant_id ?? 'unknown',
    subject_kind: 'social.interaction',
    subject_id: interaction.interaction_id,
    payload: { kind: interaction.kind, has_persona: interaction.author_persona_id != null },
    retention_class: 'operational',
  });
  return interaction;
}

/**
 * Mark an interaction as a captured lead. sdk-crm subscribes to
 * social.lead.captured.v1 to auto-create the crm.contact row.
 */
export async function captureLead(
  interaction_id: string,
  contact_id: string,
): Promise<InteractionRecord | null> {
  const rows = await dataService.rows<InteractionRecord>(
    `UPDATE social.interaction SET captured_lead_contact_id = $2
      WHERE interaction_id = $1
      RETURNING interaction_id, handle_id, kind, author_external_id, author_persona_id,
                body, received_at, captured_lead_contact_id`,
    [interaction_id, contact_id],
  );
  const interaction = rows[0] ?? null;
  if (interaction) {
    const handle = await dataService.one<{ tenant_id: string }>(
      `SELECT tenant_id FROM social.handle WHERE handle_id = $1`,
      [interaction.handle_id],
    );
    await emitSocialAudit({
      event_type: 'social.lead.captured.v1',
      tenant_id: handle?.tenant_id ?? 'unknown',
      subject_kind: 'social.interaction',
      subject_id: interaction.interaction_id,
      payload: { captured_lead_contact_id: contact_id, kind: interaction.kind },
    });
  }
  return interaction;
}
