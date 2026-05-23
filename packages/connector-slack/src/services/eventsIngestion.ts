import crypto from 'crypto';
import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';

/**
 * Slack Events API receiver per FR-SLK-5.
 *
 * Two request shapes Slack sends:
 *   1. URL verification ({type:"url_verification", challenge:"..."}) — echo back.
 *   2. Event callback ({type:"event_callback", event:{...}, team_id:"..."}) —
 *      validate signature, persist as connector.inbound_event, map to canonical
 *      event_type (slack.message.posted.v1 / slack.thread.message.v1 / etc),
 *      emit audit entry.
 *
 * Signature: HMAC-SHA256 over `v0:${timestamp}:${raw_body}` with the
 * signing secret from the Slack app config. Reject if |now - timestamp| > 5min.
 */

const SLACK_AUDIT_POOL = process.env.CONNECTOR_SLACK_AUDIT_POOL || 'admin-default';

export interface VerifyArgs {
  signing_secret: string;
  x_slack_request_timestamp: string;
  x_slack_signature: string;
  raw_body: string;
}

export function verifySlackSignature(args: VerifyArgs): boolean {
  const ts = Number(args.x_slack_request_timestamp);
  if (!Number.isFinite(ts)) return false;
  const skew = Math.abs(Math.floor(Date.now() / 1000) - ts);
  if (skew > 300) return false;

  const base = `v0:${args.x_slack_request_timestamp}:${args.raw_body}`;
  const computed = 'v0=' + crypto.createHmac('sha256', args.signing_secret).update(base).digest('hex');
  const a = Buffer.from(computed);
  const b = Buffer.from(args.x_slack_signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Map Slack event subtypes to canonical EVENT_TYPE_REGISTRY entries. */
function mapEventType(slack_event: Record<string, unknown>): string | null {
  const type = slack_event.type;
  if (type === 'message') {
    return slack_event.thread_ts ? 'slack.thread.message.v1' : 'slack.message.posted.v1';
  }
  if (type === 'member_joined_channel') return 'slack.member.joined.v1';
  if (type === 'reaction_added') return 'slack.reaction.added.v1';
  return null;
}

export interface IngestResult {
  status: 'verified' | 'event_received' | 'ignored' | 'invalid_signature';
  challenge?: string;
  inbound_event_id?: string;
}

export async function handleSlackEvent(args: {
  body: Record<string, unknown>;
  signing_secret?: string;
  x_slack_request_timestamp?: string;
  x_slack_signature?: string;
  raw_body?: string;
}): Promise<IngestResult> {
  // 1. URL verification handshake — no signature needed for this one.
  if (args.body.type === 'url_verification') {
    return { status: 'verified', challenge: String(args.body.challenge ?? '') };
  }

  // 2. Signature check for everything else.
  if (args.signing_secret && args.x_slack_signature && args.x_slack_request_timestamp && args.raw_body) {
    const ok = verifySlackSignature({
      signing_secret: args.signing_secret,
      x_slack_request_timestamp: args.x_slack_request_timestamp,
      x_slack_signature: args.x_slack_signature,
      raw_body: args.raw_body,
    });
    if (!ok) return { status: 'invalid_signature' };
  }

  if (args.body.type !== 'event_callback') {
    return { status: 'ignored' };
  }

  const event = (args.body.event ?? {}) as Record<string, unknown>;
  const team_id = String(args.body.team_id ?? '');
  if (!team_id) return { status: 'ignored' };

  // Look up the install via slack_team_id.
  const ws = await dataService.one<{ install_id: string; tenant_id: string }>(
    `SELECT install_id, tenant_id FROM connector_slack.workspace WHERE slack_team_id = $1`,
    [team_id],
  );
  if (!ws) return { status: 'ignored' };

  const mapped = mapEventType(event);

  const rows = await dataService.rows<{ event_id: string }>(
    `INSERT INTO connector.inbound_event
       (install_id, source_event_type, raw_payload, mapped_event_type)
     VALUES ($1, $2, $3::jsonb, $4)
     RETURNING event_id`,
    [ws.install_id, String(event.type ?? 'unknown'), JSON.stringify(args.body), mapped],
  );
  const inbound_event_id = rows[0]?.event_id;

  // Emit audit entry for traceability.
  if (mapped) {
    try {
      await appendAuditEntry({
        pool_index: SLACK_AUDIT_POOL,
        event_type: mapped,
        actor_kind: 'service',
        actor_id: 'connector-slack.events',
        tenant_id: ws.tenant_id,
        subject_kind: 'slack.event',
        subject_id: inbound_event_id ?? team_id,
        retention_class: 'operational',
        payload: { team_id, event_type: event.type, channel: event.channel ?? null },
      });
    } catch (err) {
      console.error('[connector-slack] audit emit failed', mapped, (err as Error).message);
    }
  }

  return { status: 'event_received', inbound_event_id };
}
