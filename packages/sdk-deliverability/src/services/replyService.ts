import { dataService } from '@projexlight/db-runtime';
import { hashAddress } from './suppressionService';

/**
 * @projexlight/sdk-deliverability — IMAP inbound reply sync + reply events (P14·E3, TK-3626).
 *
 * Polls a tenant mailbox over IMAP (incrementally by UID), captures each inbound reply,
 * thread-matches it via In-Reply-To / References, classifies it (human / auto_reply / ooo),
 * and — for a human reply — emits a reply event that PAUSES the subject's active sequence
 * (pause-on-reply). IMAP I/O and the sequence-pause bridge are BOTH pluggable hooks
 * (default no-ops) so the SDK stays free of hard deps and is exercisable without a live
 * mailbox — the app wires the real IMAP client + sdk-sequence bridge.
 */

/* ----------------------------------------------------- pluggable IMAP fetcher */

export interface ImapMessage {
  message_id: string;
  from_address?: string;
  subject?: string;
  snippet?: string;
  in_reply_to?: string;
  references?: string;
  imap_uid?: number;
  /** Raw headers, used for auto-reply detection (Auto-Submitted, X-Autoreply, ...). */
  headers?: Record<string, string>;
}
export interface ImapFetchInput {
  imap_host: string;
  imap_port: number;
  username: string;
  secret_ref: string | null;
  folder: string;
  use_tls: boolean;
  since_uid: number;
}
export interface ImapFetchResult {
  messages: ImapMessage[];
  last_uid: number;
}
export type ImapFetcher = (input: ImapFetchInput) => Promise<ImapFetchResult>;

const defaultFetcher: ImapFetcher = async (input) => ({ messages: [], last_uid: input.since_uid });
let _fetcher: ImapFetcher = defaultFetcher;

/** Install the IMAP fetcher (app bridges to a real IMAP client). */
export function setImapFetcher(fetcher: ImapFetcher): void {
  _fetcher = fetcher;
}
/** Reset to the default no-op fetcher (tests). */
export function _resetImapFetcher(): void {
  _fetcher = defaultFetcher;
}

/* --------------------------------------------------- pluggable reply notifier */

export interface ReplyNotification {
  tenant_id: string;
  reply_event_id: string;
  subject_persona_id: string | null;
  in_reply_to: string | null;
  classification: string;
}
export interface ReplyNotifyOutcome {
  paused: boolean;
  enrollment_id?: string | null;
}
export type ReplyNotifier = (n: ReplyNotification) => Promise<ReplyNotifyOutcome>;

const defaultReplyNotifier: ReplyNotifier = async () => ({ paused: false, enrollment_id: null });
let _replyNotifier: ReplyNotifier = defaultReplyNotifier;

/** Install the reply notifier (app bridges to sdk-sequence pauseEnrollment). */
export function setReplyNotifier(notifier: ReplyNotifier): void {
  _replyNotifier = notifier;
}
export function _resetReplyNotifier(): void {
  _replyNotifier = defaultReplyNotifier;
}

/* ---------------------------------------------------------------- mailboxes */

export interface MailboxRow {
  mailbox_id: string;
  tenant_id: string;
  host_persona_id: string | null;
  imap_host: string;
  imap_port: number;
  username: string;
  secret_ref: string | null;
  folder: string;
  use_tls: boolean;
  last_uid: number;
  status: string;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateMailboxInput {
  tenantId: string;
  imapHost: string;
  username: string;
  hostPersonaId?: string;
  imapPort?: number;
  secretRef?: string;
  folder?: string;
  useTls?: boolean;
}

const MAILBOX_COLS = `mailbox_id, tenant_id, host_persona_id, imap_host, imap_port, username,
  secret_ref, folder, use_tls, last_uid, status, last_synced_at, created_at, updated_at`;

/** Register a mailbox for reply sync (upsert per tenant+username+folder). */
export async function createMailbox(input: CreateMailboxInput): Promise<MailboxRow> {
  const rows = await dataService.rows<MailboxRow>(
    `INSERT INTO deliverability.mailbox
       (tenant_id, host_persona_id, imap_host, imap_port, username, secret_ref, folder, use_tls)
     VALUES ($1,$2,$3,COALESCE($4,993),$5,$6,COALESCE($7,'INBOX'),COALESCE($8,true))
     ON CONFLICT (tenant_id, username, folder)
     DO UPDATE SET imap_host = EXCLUDED.imap_host, imap_port = EXCLUDED.imap_port,
                   secret_ref = EXCLUDED.secret_ref, use_tls = EXCLUDED.use_tls,
                   status = 'active', updated_at = now()
     RETURNING ${MAILBOX_COLS}`,
    [input.tenantId, input.hostPersonaId ?? null, input.imapHost, input.imapPort ?? null,
     input.username, input.secretRef ?? null, input.folder ?? null, input.useTls ?? null],
  );
  return rows[0];
}

/** List a tenant's mailboxes. */
export async function listMailboxes(tenantId: string): Promise<MailboxRow[]> {
  return dataService.rows<MailboxRow>(
    `SELECT ${MAILBOX_COLS} FROM deliverability.mailbox WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [tenantId],
  );
}

/** Fetch one mailbox (tenant-scoped). */
export async function getMailbox(tenantId: string, mailboxId: string): Promise<MailboxRow | null> {
  return dataService.one<MailboxRow>(
    `SELECT ${MAILBOX_COLS} FROM deliverability.mailbox WHERE tenant_id = $1 AND mailbox_id = $2`,
    [tenantId, mailboxId],
  );
}

/* ------------------------------------------------------------ classification */

/** Detect auto-replies / out-of-office from headers + subject (RFC 3834 heuristics). */
export function classifyReply(msg: ImapMessage): 'human' | 'auto_reply' | 'ooo' {
  const h = msg.headers ?? {};
  const lower = (k: string) => String(h[k] ?? h[k.toLowerCase()] ?? '').toLowerCase();
  const autoSubmitted = lower('Auto-Submitted');
  if (autoSubmitted && autoSubmitted !== 'no') return 'auto_reply';
  if (lower('X-Autoreply') === 'yes' || lower('X-Autorespond') || h['Precedence']?.toLowerCase() === 'auto_reply') return 'auto_reply';
  const subject = (msg.subject ?? '').toLowerCase();
  if (/out of office|automatic reply|auto[- ]?reply|on vacation|away from|abwesenheit/.test(subject)) return 'ooo';
  return 'human';
}

/* --------------------------------------------------------- capture a reply */

export interface CaptureReplyInput {
  tenantId: string;
  mailboxId?: string;
  message: ImapMessage;
  subjectPersonaId?: string;
}
export interface CaptureReplyResult {
  reply_event_id: string;
  classification: string;
  paused_sequence: boolean;
  duplicate: boolean;
}

/**
 * Capture one inbound reply: classify it, record the reply_event (idempotent per
 * mailbox+message_id), and — for a human reply — fire the pause-on-reply notifier so
 * the app can pause the matched sequence enrollment. Auto-replies/OOO never pause.
 */
export async function captureReply(input: CaptureReplyInput): Promise<CaptureReplyResult> {
  const msg = input.message;
  const classification = classifyReply(msg);
  const rows = await dataService.rows<{ reply_event_id: string }>(
    `INSERT INTO deliverability.reply_event
       (tenant_id, mailbox_id, from_address_hash, subject_persona_id, message_id, in_reply_to,
        references_ids, subject, snippet, classification, imap_uid)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (mailbox_id, message_id) DO NOTHING
     RETURNING reply_event_id`,
    [input.tenantId, input.mailboxId ?? null,
     msg.from_address ? hashAddress('email', msg.from_address) : null,
     input.subjectPersonaId ?? null, msg.message_id, msg.in_reply_to ?? null,
     msg.references ?? null, msg.subject ?? null, msg.snippet ?? null, classification, msg.imap_uid ?? null],
  );
  if (!rows[0]) {
    // Already captured (idempotent re-poll).
    const existing = await dataService.one<{ reply_event_id: string; classification: string; paused_sequence: boolean }>(
      `SELECT reply_event_id, classification, paused_sequence FROM deliverability.reply_event
        WHERE mailbox_id IS NOT DISTINCT FROM $1 AND message_id = $2`,
      [input.mailboxId ?? null, msg.message_id],
    );
    return {
      reply_event_id: existing?.reply_event_id ?? '',
      classification: existing?.classification ?? classification,
      paused_sequence: existing?.paused_sequence ?? false,
      duplicate: true,
    };
  }

  let pausedSequence = false;
  if (classification === 'human') {
    const outcome = await _replyNotifier({
      tenant_id: input.tenantId,
      reply_event_id: rows[0].reply_event_id,
      subject_persona_id: input.subjectPersonaId ?? null,
      in_reply_to: msg.in_reply_to ?? null,
      classification,
    });
    pausedSequence = outcome.paused;
    if (outcome.paused) {
      await dataService.rows(
        `UPDATE deliverability.reply_event SET paused_sequence = true, matched_enrollment_id = $2 WHERE reply_event_id = $1`,
        [rows[0].reply_event_id, outcome.enrollment_id ?? null],
      );
    }
  }
  return { reply_event_id: rows[0].reply_event_id, classification, paused_sequence: pausedSequence, duplicate: false };
}

/** List a tenant's captured reply events, newest first. */
export interface ReplyEventRow {
  reply_event_id: string;
  message_id: string | null;
  in_reply_to: string | null;
  subject: string | null;
  classification: string;
  paused_sequence: boolean;
  received_at: string;
}
export async function listReplyEvents(tenantId: string, opts: { classification?: string; limit?: number } = {}): Promise<ReplyEventRow[]> {
  return dataService.rows<ReplyEventRow>(
    `SELECT reply_event_id, message_id, in_reply_to, subject, classification, paused_sequence, received_at
       FROM deliverability.reply_event
      WHERE tenant_id = $1 AND ($2::text IS NULL OR classification = $2)
      ORDER BY received_at DESC LIMIT $3`,
    [tenantId, opts.classification ?? null, opts.limit ?? 100],
  );
}

/* --------------------------------------------------------------- sync tick */

export interface ReplySyncResult {
  mailbox_id: string;
  fetched: number;
  captured: number;
  paused: number;
}

/**
 * Poll a mailbox once: fetch messages after last_uid via the IMAP fetcher, capture each
 * as a reply_event, and advance the mailbox cursor. Idempotent — already-captured
 * messages are skipped. With the default no-op fetcher this returns zero (no live IMAP).
 */
export async function runReplySync(tenantId: string, mailboxId: string): Promise<ReplySyncResult> {
  const mb = await getMailbox(tenantId, mailboxId);
  if (!mb) throw new Error(`[sdk-deliverability] mailbox ${mailboxId} not found`);
  let fetched = 0;
  let captured = 0;
  let paused = 0;
  try {
    const res = await _fetcher({
      imap_host: mb.imap_host, imap_port: mb.imap_port, username: mb.username,
      secret_ref: mb.secret_ref, folder: mb.folder, use_tls: mb.use_tls, since_uid: mb.last_uid,
    });
    fetched = res.messages.length;
    for (const msg of res.messages) {
      const r = await captureReply({ tenantId, mailboxId, message: msg });
      if (!r.duplicate) captured += 1;
      if (r.paused_sequence) paused += 1;
    }
    await dataService.rows(
      `UPDATE deliverability.mailbox SET last_uid = GREATEST(last_uid, $2), last_synced_at = now(),
              status = 'active', updated_at = now() WHERE mailbox_id = $1`,
      [mailboxId, res.last_uid],
    );
  } catch (err) {
    await dataService.rows(
      `UPDATE deliverability.mailbox SET status = 'error', last_error = $2, updated_at = now() WHERE mailbox_id = $1`,
      [mailboxId, (err as Error).message],
    ).catch(() => undefined);
    throw err;
  }
  return { mailbox_id: mailboxId, fetched, captured, paused };
}

/* --------------------------------------------------------------- worker */

export interface ReplyWorkerOptions {
  enabled?: boolean;
  intervalMs?: number;
}
export interface ReplyWorkerHandle {
  stop: () => void;
}

/** Start the IMAP reply-sync worker: polls every active mailbox each tick. Opt-in. */
export function startReplySyncWorker(opts: ReplyWorkerOptions = {}): ReplyWorkerHandle {
  const { enabled = false, intervalMs = 120000 } = opts;
  if (!enabled) return { stop: () => undefined };
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const boxes = await dataService.rows<{ tenant_id: string; mailbox_id: string }>(
        `SELECT tenant_id, mailbox_id FROM deliverability.mailbox WHERE status = 'active' LIMIT 100`,
      );
      for (const b of boxes) {
        await runReplySync(b.tenant_id, b.mailbox_id).catch((e) =>
          console.warn(`[sdk-deliverability] reply sync ${b.mailbox_id} failed:`, (e as Error).message));
      }
    } catch (err) {
      console.warn('[sdk-deliverability] reply worker tick failed:', (err as Error).message);
    } finally {
      running = false;
    }
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return { stop: () => clearInterval(timer) };
}
