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
export * as reputationService from './services/reputationService';
export { isChannelPaused } from './services/reputationService';

/**
 * Address verification — "can this address receive mail at all", asked before a
 * send rather than discovered from a bounce.
 *
 * Exported as named functions rather than only as a namespace because the
 * gateway's pre-send guard and sdk-notification both call them directly, and a
 * send path should not have to reach through a namespace to ask the one
 * question that decides whether it may proceed.
 */
export * as addressVerification from './services/addressVerification';
export {
  verifyAddress,
  verifyAddresses,
  sendDecision,
  checkBeforeSending,
  describeConfiguration as describeAddressCheck,
  validationMode,
  clearVerificationCache,
  maskAddress,
} from './services/addressVerification';
export type {
  AddressVerification,
  SendDecision,
  Verdict,
  VerificationCode,
  StageResult,
  ValidationMode,
} from './services/addressVerification';
