/**
 * @projexlight/sdk-deliverability — suppression, opt-out & DNC (P14·E3).
 *
 * v0 surface (TK-3623): migrationsDir + the suppression/opt-out data-access
 * service. The pre-send enforcement HTTP API + Fastify routes land with TK-3624;
 * provider bounce/complaint webhooks with TK-3625; IMAP reply-sync with TK-3626.
 */
export { migrationsDir } from './db';
export * as server from './server';
export * as suppressionService from './services/suppressionService';
export * as webhookService from './services/webhookService';
export * as replyService from './services/replyService';
export { startReplySyncWorker, setImapFetcher, setReplyNotifier } from './services/replyService';
